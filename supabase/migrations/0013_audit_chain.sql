-- 0013_audit_chain.sql
-- Hash-chain tamper evidence for the audit backbone (idempotent throughout).
-- Builds on audit_events (0002, widened in 0010) and incident_audit_events
-- (0004, append-only since 0010):
--   * prev_hash/row_hash columns (nullable, DO-block guarded) on both tables
--   * fn_audit_chain_link(): a BEFORE INSERT trigger that links every new row
--     to the previous row in its scope partition and stamps a sha256 row hash,
--     using pgcrypto (already enabled in 0001)
--   * fn_assert_same_facility (0009) extended to work_orders.asset_id and
--     schedule_shifts.schedule_period_id, closing two more cross-tenant FK
--     injection paths the same way report_submissions was closed in 0009
--
-- Idempotency conventions (mirroring 0009-0012): drop policy/trigger if exists
-- before every create; create or replace for functions; DO-block guards for
-- ALTERs.

-- Defensive re-declaration; pgcrypto is already enabled by 0001:1, but this
-- migration depends on digest()/encode() so it re-asserts the extension.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- (a) Hash-chain columns. Both nullable: prev_hash is null for the first row
-- in a scope partition (the chain's genesis row); row_hash is populated by
-- fn_audit_chain_link on every insert, so in practice it is never null for a
-- row written through the normal path, but the column stays nullable to keep
-- the migration purely additive (no backfill of pre-existing rows required).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'audit_events' and column_name = 'prev_hash'
  ) then
    alter table audit_events add column prev_hash text;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'audit_events' and column_name = 'row_hash'
  ) then
    alter table audit_events add column row_hash text;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incident_audit_events' and column_name = 'prev_hash'
  ) then
    alter table incident_audit_events add column prev_hash text;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incident_audit_events' and column_name = 'row_hash'
  ) then
    alter table incident_audit_events add column row_hash text;
  end if;
end;
$$;

-- Chain-lookup indexes: fn_audit_chain_link's "find the previous row in this
-- scope partition" query is `where <scope key> = <new scope key> order by
-- created_at desc, id desc limit 1`, run on every insert.
create index if not exists audit_events_chain_scope_idx
  on audit_events (coalesce(facility_id, organization_id), created_at desc, id desc);

create index if not exists incident_audit_events_chain_scope_idx
  on incident_audit_events (facility_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- (b) fn_audit_chain_link(): BEFORE INSERT trigger, one function shared by
-- both audit tables (branches on tg_table_name, the same style as
-- fn_audit_admin_change in 0010).
--
-- Scope partition: a chain is per (facility_id) normally, or per
-- (organization_id) for org-scoped audit_events rows that carry a null
-- facility_id (0010's widening) -- i.e. coalesce(facility_id, organization_id).
-- incident_audit_events has no organization_id column, so its partition key
-- is simply facility_id (always not null on that table). The previous row is
-- the one with the greatest (created_at, id) in that partition; id is the
-- final tiebreaker for rows inserted in the same instant.
--
-- Canonical row representation (the exact formula, mirrored verbatim by
-- computeDbRowHash() in src/lib/audit.mjs so the API can re-verify a chain
-- from rows it fetches back over PostgREST):
--
--   audit_events canonical =
--     event_type || '|' ||
--     entity_table || '|' ||
--     coalesce(entity_id::text, '') || '|' ||
--     coalesce(event_payload::text, '') || '|' ||
--     coalesce(facility_id::text, '') || '|' ||
--     coalesce(organization_id::text, '') || '|' ||
--     coalesce(to_jsonb(created_at) #>> '{}', '')
--
--   incident_audit_events canonical =
--     event_type || '|' ||
--     incident_id::text || '|' ||
--     coalesce(event_payload::text, '') || '|' ||
--     facility_id::text || '|' ||
--     coalesce(to_jsonb(created_at) #>> '{}', '')
--
--   row_hash = encode(digest(coalesce(prev_hash, '') || canonical, 'sha256'), 'hex')
--
-- Two formatting choices are deliberate so the formula stays reproducible
-- from a later SELECT (the whole point of the hash chain):
--   * fields are '|'-joined rather than bare-concatenated, so a value ending
--     in one field's tail can never be mistaken for the start of the next
--     (e.g. event_type='a', entity_table='bc' cannot collide with
--     event_type='ab', entity_table='c').
--   * created_at goes through to_jsonb(...)#>>'{}' rather than a plain
--     ::text cast. jsonb's date/time output is always ISO-8601 with a 'T'
--     separator (RFC 3339), independent of the server's DateStyle setting --
--     which is exactly what PostgREST returns for a timestamptz column in its
--     JSON response. A plain ::text cast would use DateStyle's
--     space-separated format instead and silently diverge from what the API
--     re-reads. event_payload is jsonb already, so casting it straight to
--     text needs no such adjustment -- PostgREST serializes a jsonb column
--     by forwarding its stored text form as-is, so `event_payload::text`
--     here and the JSON the API receives back are the same bytes; the same
--     is true for entity_id/facility_id/organization_id (uuid columns).
-- ---------------------------------------------------------------------------
create or replace function fn_audit_chain_link()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_canonical text;
begin
  if tg_table_name = 'audit_events' then
    select row_hash into v_prev_hash
      from audit_events
     where coalesce(facility_id, organization_id) = coalesce(new.facility_id, new.organization_id)
     order by created_at desc, id desc
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
     where facility_id = new.facility_id
     order by created_at desc, id desc
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

drop trigger if exists audit_events_chain_link on audit_events;
create trigger audit_events_chain_link
  before insert on audit_events
  for each row execute function fn_audit_chain_link();

drop trigger if exists incident_audit_events_chain_link on incident_audit_events;
create trigger incident_audit_events_chain_link
  before insert on incident_audit_events
  for each row execute function fn_audit_chain_link();

-- ---------------------------------------------------------------------------
-- (c) Cross-tenant FK guards: work_orders.asset_id -> assets, and
-- schedule_shifts.schedule_period_id -> schedule_periods. Both policies are
-- recreated verbatim from their current definitions (0005:76, 0003:142;
-- names unchanged) with fn_assert_same_facility appended to with check only,
-- matching the report_submissions precedent in 0009: the using clause (which
-- also governs plain reads/deletes under this "for all" policy) is left
-- alone, and the guard only blocks an insert/update from pointing the FK at a
-- parent row in a different facility.
-- ---------------------------------------------------------------------------
drop policy if exists "work order managers can manage work orders" on work_orders;
create policy "work order managers can manage work orders" on work_orders
  for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'work_orders.manage')
    and fn_assert_same_facility(facility_id, 'assets', asset_id)
  );

drop policy if exists "schedule managers can manage shifts" on schedule_shifts;
create policy "schedule managers can manage shifts" on schedule_shifts
  for all using (has_permission(auth.uid(), facility_id, 'schedule.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.manage')
    and fn_assert_same_facility(facility_id, 'schedule_periods', schedule_period_id)
  );
