-- ===========================================================================
-- 0019_review_hardening.sql
-- Fixes for confirmed cross-model review findings against the admin build.
-- Idempotent throughout (drop-before-create, create or replace, is not distinct).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (1) Audit hash-chain integrity.
--   a. fn_audit_chain_link is recreated as SECURITY DEFINER so the previous-row
--      lookup always sees the true latest row regardless of the caller's SELECT
--      policy. Under the prior SECURITY INVOKER definition a non-admin member
--      (who cannot SELECT audit_events) saw zero prior rows, so every row they
--      inserted was stamped as a chain genesis (prev_hash null), forking the
--      chain and driving verifyDbChain into a false "tampered" state.
--   b. The scope-partition lookup uses `is not distinct from` instead of `=` so
--      that rows whose facility_id AND organization_id are both null (produced
--      when an organization is deleted) chain to each other instead of each
--      becoming an unlinked genesis row (NULL = NULL is NULL, never true).
--   c. A monotonic `chain_seq` (bigint, from a dedicated sequence, assigned by
--      column default before the BEFORE INSERT trigger runs) is the definitive
--      chain order and tiebreak. created_at is transaction-start time, so a
--      burst of same-transaction audit rows (e.g. a bulk role_permissions change
--      in the null scope partition) shares a created_at; the previous tiebreak
--      of `id desc` over random UUIDs could link those rows out of insertion
--      order both when writing and when verifying. Ordering by chain_seq makes
--      the linkage and its later verification reproduce insertion order exactly.
--      chain_seq is NOT part of the row hash, so it does not affect verification
--      digests, only the order rows are walked in.
-- ---------------------------------------------------------------------------
create sequence if not exists audit_events_chain_seq;
create sequence if not exists incident_audit_events_chain_seq;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'audit_events' and column_name = 'chain_seq'
  ) then
    alter table audit_events add column chain_seq bigint not null default nextval('audit_events_chain_seq');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'incident_audit_events' and column_name = 'chain_seq'
  ) then
    alter table incident_audit_events add column chain_seq bigint not null default nextval('incident_audit_events_chain_seq');
  end if;
end $$;

create index if not exists audit_events_chain_seq_idx on audit_events(chain_seq);
create index if not exists incident_audit_events_chain_seq_idx on incident_audit_events(chain_seq);

create or replace function fn_audit_chain_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_hash text;
  v_canonical text;
begin
  if tg_table_name = 'audit_events' then
    select row_hash into v_prev_hash
      from audit_events
     where coalesce(facility_id, organization_id) is not distinct from coalesce(new.facility_id, new.organization_id)
       and chain_seq < new.chain_seq
     order by chain_seq desc
     limit 1;

    v_canonical :=
      new.event_type || '|' ||
      new.entity_table || '|' ||
      coalesce(new.entity_id::text, '') || '|' ||
      coalesce(new.event_payload::text, '') || '|' ||
      coalesce(new.facility_id::text, '') || '|' ||
      coalesce(new.organization_id::text, '') || '|' ||
      coalesce(to_jsonb(new.created_at) #>> '{}', '');
  elsif tg_table_name = 'incident_audit_events' then
    select row_hash into v_prev_hash
      from incident_audit_events
     where facility_id is not distinct from new.facility_id
       and chain_seq < new.chain_seq
     order by chain_seq desc
     limit 1;

    v_canonical :=
      new.event_type || '|' ||
      new.incident_id::text || '|' ||
      coalesce(new.event_payload::text, '') || '|' ||
      new.facility_id::text || '|' ||
      coalesce(to_jsonb(new.created_at) #>> '{}', '');
  else
    raise exception 'fn_audit_chain_link: unsupported table %', tg_table_name;
  end if;

  new.prev_hash := v_prev_hash;
  new.row_hash := encode(digest(coalesce(v_prev_hash, '') || v_canonical, 'sha256'), 'hex');
  return new;
end;
$$;

-- Tighten the audit_events INSERT policy: writers must be the same principals
-- allowed to read (admin.manage / org-admin), matching incident_audit_events.
-- The config auto-audit path (fn_audit_admin_change) is SECURITY DEFINER and
-- bypasses RLS, so legitimate audit writes are unaffected; this only removes the
-- ability of a low-privilege member to inject forged rows via direct PostgREST.
drop policy if exists "members can write audit events" on audit_events;
drop policy if exists "admins can write audit events" on audit_events;
create policy "admins can write audit events" on audit_events
  for insert with check (
    (facility_id is not null and has_permission(auth.uid(), facility_id, 'admin.manage'))
    or (
      facility_id is null
      and organization_id is not null
      and is_organization_admin(auth.uid(), organization_id)
    )
  );

-- ---------------------------------------------------------------------------
-- (2) is_organization_admin: require an explicit organization_admins row.
-- The prior definition also returned true for anyone holding admin.manage on
-- ANY single facility of the org, which silently promoted a facility-scoped
-- admin to org-wide write authority over sibling facilities, org module toggles,
-- org-scoped feature flags, and org audit reads. Org-level authority is now
-- granted only by explicit membership in organization_admins.
-- ---------------------------------------------------------------------------
create or replace function is_organization_admin(check_user_id uuid, check_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from organization_admins oa
    where oa.user_id = check_user_id
      and oa.organization_id = check_organization_id
  );
$$;

-- ---------------------------------------------------------------------------
-- (3) distribution_list_members.member_ref_id same-facility guard.
-- The write policy already guarded the parent list's facility but not the
-- referenced member, so a publisher could point member_ref_id at an employee or
-- role in another facility. Add a member_type-dispatched fn_assert_same_facility
-- check, consistent with every other child table's cross-facility guard.
-- ---------------------------------------------------------------------------
drop policy if exists "publishers can manage distribution list members" on distribution_list_members;
create policy "publishers can manage distribution list members" on distribution_list_members
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish'))
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'distribution_lists', distribution_list_id)
    and (
      (member_type = 'employee' and fn_assert_same_facility(facility_id, 'employees', member_ref_id))
      or (member_type = 'role' and fn_assert_same_facility(facility_id, 'roles', member_ref_id))
    )
  );
