-- 0010_audit_backbone.sql
-- Append-only audit backbone (idempotent throughout).
-- Builds on the audit_events (0002) and incident_audit_events (0004) tables:
--   * append-only enforcement: BEFORE UPDATE OR DELETE triggers that raise
--   * INSERT policies so authorized members/server paths can write audit rows
--   * SELECT restricted to admin.manage (audit_events) / incidents.manage (incident_audit_events)
--   * config-change auto-audit: fn_audit_admin_change() attached to every admin
--     config table, writing a 'config.changed' row with before/after payload
--   * audit_events widened to accept org-scoped rows (nullable organization_id,
--     facility_id relaxed to nullable so org-scope mutations carry no facility)
--
-- Idempotency conventions (mirroring 0009): drop policy/trigger if exists before
-- every create; create or replace for functions; DO-block guards for ALTERs.

-- ---------------------------------------------------------------------------
-- (e) Widen audit_events to accept org-scoped rows.
--   * add nullable organization_id referencing organizations
--   * relax facility_id to nullable (org-scope mutations have no facility)
-- Both guarded so the migration re-runs cleanly.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'audit_events'
      and column_name = 'organization_id'
  ) then
    alter table audit_events
      add column organization_id uuid references organizations(id) on delete cascade;
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'audit_events'
      and a.attname = 'facility_id'
      and a.attnotnull
  ) then
    alter table audit_events alter column facility_id drop not null;
  end if;
end;
$$;

create index if not exists audit_events_organization_created_idx
  on audit_events(organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- (a) Append-only enforcement.
-- A single trigger function raises on any UPDATE/DELETE of an audit row; it is
-- attached BEFORE UPDATE OR DELETE to both audit tables. errcode
-- insufficient_privilege lets callers/tests distinguish a policy block from an
-- ordinary error.
-- ---------------------------------------------------------------------------
create or replace function fn_block_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Audit records are append-only; % on % is not permitted.', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_events_block_mutation on audit_events;
create trigger audit_events_block_mutation
  before update or delete on audit_events
  for each row execute function fn_block_audit_mutation();

drop trigger if exists incident_audit_events_block_mutation on incident_audit_events;
create trigger incident_audit_events_block_mutation
  before update or delete on incident_audit_events
  for each row execute function fn_block_audit_mutation();

-- ---------------------------------------------------------------------------
-- (b) INSERT policies. RLS-bypassing service paths (and the security-definer
-- config trigger) can always write, but explicit INSERT policies let authorized
-- members write facility-/org-scoped audit rows under RLS.
-- ---------------------------------------------------------------------------
drop policy if exists "members can write audit events" on audit_events;
create policy "members can write audit events" on audit_events
  for insert with check (
    (facility_id is not null and facility_id in (select current_facility_ids()))
    or (
      facility_id is null
      and organization_id is not null
      and organization_id in (
        select organization_id from facilities where id in (select current_facility_ids())
      )
    )
  );

drop policy if exists "incident managers can write incident audit" on incident_audit_events;
create policy "incident managers can write incident audit" on incident_audit_events
  for insert with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));

-- ---------------------------------------------------------------------------
-- (c) Restrict audit reads.
-- audit_events: previously readable by any facility member (0002:120). Recreate
-- gated on admin.manage for facility rows and org-admin for org-scoped rows.
-- incident_audit_events: previously readable by incidents.read (0004:133).
-- Incident audit trails are for incident managers, so gate on incidents.manage.
-- ---------------------------------------------------------------------------
drop policy if exists "members can read audit events" on audit_events;
drop policy if exists "admins can read audit events" on audit_events;
create policy "admins can read audit events" on audit_events
  for select using (
    (facility_id is not null and has_permission(auth.uid(), facility_id, 'admin.manage'))
    or (
      facility_id is null
      and organization_id is not null
      and is_organization_admin(auth.uid(), organization_id)
    )
  );

drop policy if exists "incident readers can read audit" on incident_audit_events;
drop policy if exists "incident managers can read audit" on incident_audit_events;
create policy "incident managers can read audit" on incident_audit_events
  for select using (has_permission(auth.uid(), facility_id, 'incidents.manage'));

-- ---------------------------------------------------------------------------
-- (d) Config-change auto-audit.
-- fn_audit_admin_change() writes a 'config.changed' audit_events row on every
-- INSERT/UPDATE/DELETE of an admin config table. It derives scope from the row:
--   * organizations                -> organization_id = row.id, facility_id null
--   * organization_module_settings -> organization_id = row.organization_id, facility_id null
--   * facilities                   -> facility_id = row.id, organization_id = row.organization_id
--   * every other config table     -> facility_id = row.facility_id
-- References whose parent no longer exists (cascade deletes) are nulled so the
-- audit insert never fails an FK. The actor is auth.uid() when it maps to a
-- provisioned app_user, else null (service-role / system writes).
-- ---------------------------------------------------------------------------
create or replace function fn_audit_admin_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec jsonb;
  before_json jsonb;
  after_json jsonb;
  v_entity_id uuid;
  v_facility_id uuid;
  v_organization_id uuid;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    before_json := null;
    after_json := to_jsonb(new);
    rec := to_jsonb(new);
  elsif tg_op = 'DELETE' then
    before_json := to_jsonb(old);
    after_json := null;
    rec := to_jsonb(old);
  else
    before_json := to_jsonb(old);
    after_json := to_jsonb(new);
    rec := to_jsonb(new);
  end if;

  v_entity_id := nullif(rec->>'id', '')::uuid;

  if tg_table_name = 'organizations' then
    v_organization_id := nullif(rec->>'id', '')::uuid;
    v_facility_id := null;
  elsif tg_table_name = 'organization_module_settings' then
    v_organization_id := nullif(rec->>'organization_id', '')::uuid;
    v_facility_id := null;
  elsif tg_table_name = 'facilities' then
    v_facility_id := nullif(rec->>'id', '')::uuid;
    v_organization_id := nullif(rec->>'organization_id', '')::uuid;
  else
    v_facility_id := nullif(rec->>'facility_id', '')::uuid;
    v_organization_id := null;
  end if;

  -- Null references whose parent has already been removed (cascade deletes),
  -- so the audit insert can never violate an FK.
  if v_facility_id is not null and not exists (select 1 from facilities where id = v_facility_id) then
    v_facility_id := null;
  end if;
  if v_organization_id is not null and not exists (select 1 from organizations where id = v_organization_id) then
    v_organization_id := null;
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not exists (select 1 from app_users where id = v_actor) then
    v_actor := null;
  end if;

  insert into audit_events (
    facility_id, organization_id, actor_user_id, event_type, entity_table, entity_id, event_payload
  ) values (
    v_facility_id,
    v_organization_id,
    v_actor,
    'config.changed',
    tg_table_name,
    v_entity_id,
    jsonb_build_object('before', before_json, 'after', after_json)
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Attach the config-change trigger to every admin config table.
drop trigger if exists organizations_audit_change on organizations;
create trigger organizations_audit_change
  after insert or update or delete on organizations
  for each row execute function fn_audit_admin_change();

drop trigger if exists facilities_audit_change on facilities;
create trigger facilities_audit_change
  after insert or update or delete on facilities
  for each row execute function fn_audit_admin_change();

drop trigger if exists organization_module_settings_audit_change on organization_module_settings;
create trigger organization_module_settings_audit_change
  after insert or update or delete on organization_module_settings
  for each row execute function fn_audit_admin_change();

drop trigger if exists facility_module_overrides_audit_change on facility_module_overrides;
create trigger facility_module_overrides_audit_change
  after insert or update or delete on facility_module_overrides
  for each row execute function fn_audit_admin_change();

drop trigger if exists facility_settings_audit_change on facility_settings;
create trigger facility_settings_audit_change
  after insert or update or delete on facility_settings
  for each row execute function fn_audit_admin_change();

drop trigger if exists department_settings_audit_change on department_settings;
create trigger department_settings_audit_change
  after insert or update or delete on department_settings
  for each row execute function fn_audit_admin_change();

drop trigger if exists branding_profiles_audit_change on branding_profiles;
create trigger branding_profiles_audit_change
  after insert or update or delete on branding_profiles
  for each row execute function fn_audit_admin_change();

drop trigger if exists admin_change_requests_audit_change on admin_change_requests;
create trigger admin_change_requests_audit_change
  after insert or update or delete on admin_change_requests
  for each row execute function fn_audit_admin_change();

drop trigger if exists organization_admins_audit_change on organization_admins;
create trigger organization_admins_audit_change
  after insert or update or delete on organization_admins
  for each row execute function fn_audit_admin_change();
