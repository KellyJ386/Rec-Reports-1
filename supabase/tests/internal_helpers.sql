-- Proof for 0042 (OP-05): the internal schema locks the six scope/permission
-- primitives to `authenticated`/`service_role` only, the ten trigger
-- functions lose EXECUTE from `public`/`authenticated` without affecting
-- their fire-time behavior (EXECUTE is checked at CREATE TRIGGER, not at
-- fire time), and the search_path fix keeps has_permission /
-- current_facility_ids resolving internal.is_platform_admin after the move.
--
-- Roles are NOT transactional the way table rows are: CREATE ROLE / DROP
-- ROLE take effect immediately and are visible to every session regardless
-- of an enclosing begin/rollback, and a role that still exists when this
-- script re-runs would collide with `create role`. So the throwaway probe
-- role is created BEFORE begin and dropped AFTER rollback, outside the
-- transaction that holds the rest of the fixtures.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'probe_1b') then
    create role probe_1b nologin;
  end if;
end
$$;

begin;

-- ---------------------------------------------------------------------------
-- Grant-shape assertions: a role with no explicit grant (probe_1b, standing
-- in for "anyone who is merely PUBLIC") must have no EXECUTE on the internal
-- helper; `authenticated` must. A revoked trigger function must have no
-- EXECUTE for `authenticated` either -- it was never meant to be callable
-- directly, only wired to CREATE TRIGGER.
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('probe_1b', 'internal.has_permission(uuid,uuid,text)', 'execute') then
    raise exception 'INTERNAL FAIL: probe_1b (standing in for PUBLIC) can execute internal.has_permission';
  end if;
  if not has_function_privilege('authenticated', 'internal.has_permission(uuid,uuid,text)', 'execute') then
    raise exception 'INTERNAL FAIL: authenticated cannot execute internal.has_permission';
  end if;
  if has_function_privilege('authenticated', 'public.fn_audit_chain_link()', 'execute') then
    raise exception 'INTERNAL FAIL: authenticated can still execute the revoked trigger function fn_audit_chain_link';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: one org, one facility, one role holding reports.read and
-- admin.manage, one active facility-wide membership, one organization_admins
-- grant (facilities UPDATE requires is_organization_admin, 0009/0019), and a
-- published report_templates row (report_templates SELECT is gated on
-- reports.read via has_permission, 0002:114).
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('42000000-0000-0000-0000-0000000000aa', 'internalhelpers@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('42000000-0000-0000-0000-0000000000aa', 'Internal Helpers Admin', 'internalhelpers@test')
on conflict (id) do nothing;
insert into organizations (id, name) values
  ('42000000-0000-0000-0000-0000000000b0', 'Internal Helpers Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('42000000-0000-0000-0000-0000000000c0', '42000000-0000-0000-0000-0000000000b0', 'Internal Helpers Facility')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('42000000-0000-0000-0000-0000000000d0', '42000000-0000-0000-0000-0000000000c0', 'Internal Helpers Admin Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('42000000-0000-0000-0000-0000000000d0', 'reports.read'),
  ('42000000-0000-0000-0000-0000000000d0', 'admin.manage')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('42000000-0000-0000-0000-0000000000e0', '42000000-0000-0000-0000-0000000000aa', '42000000-0000-0000-0000-0000000000c0', '42000000-0000-0000-0000-0000000000d0', 'active')
on conflict (id) do nothing;
insert into organization_admins (organization_id, user_id) values
  ('42000000-0000-0000-0000-0000000000b0', '42000000-0000-0000-0000-0000000000aa')
on conflict do nothing;

insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('42000000-0000-0000-0000-0000000000f0', '42000000-0000-0000-0000-0000000000c0', 'internal_helpers', 'Internal Helpers Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('42000000-0000-0000-0000-0000000000f1', '42000000-0000-0000-0000-0000000000c0', '42000000-0000-0000-0000-0000000000f0', 1, '{}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '42000000-0000-0000-0000-0000000000f0' and active_version is null;

-- ---------------------------------------------------------------------------
-- Behavioral proof, as `authenticated`: one has_permission-backed SELECT and
-- one write that fires a revoked SECURITY DEFINER trigger function.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"42000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;

-- (1) has_permission-backed SELECT: reaches "report readers can read
-- templates" (0002:114, `has_permission(auth.uid(), facility_id,
-- 'reports.read')`), which after 0042 resolves entirely through
-- internal.has_permission -> internal.is_platform_admin. If the search_path
-- fix in 0042 step 3 were missing, has_permission would raise "function
-- is_platform_admin(uuid) does not exist" the instant it runs, and this
-- SELECT would error instead of returning a row.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from report_templates
   where id = '42000000-0000-0000-0000-0000000000f0';
  if v_count <> 1 then
    raise exception 'INTERNAL FAIL: has_permission-backed SELECT on report_templates returned % row(s), expected 1', v_count;
  end if;
end;
$$;

-- (2) A write that fires a revoked trigger function: updating facilities as
-- an org admin passes the "org admins can update facilities" WITH CHECK
-- (is_organization_admin, itself routed through internal.has_permission),
-- and the AFTER UPDATE trigger fn_audit_admin_change fires and inserts an
-- audit_events row -- even though EXECUTE on fn_audit_admin_change was just
-- revoked from `authenticated` above. This is the concrete proof that
-- EXECUTE is checked at CREATE TRIGGER time, not at fire time.
update facilities
   set name = 'Internal Helpers Facility (renamed)'
 where id = '42000000-0000-0000-0000-0000000000c0';

-- Confirm the trigger actually ran: the resulting audit_events row is
-- readable back under "admins can read audit events" (admin.manage on the
-- row's facility_id), still as `authenticated`, still with no EXECUTE grant
-- on fn_audit_admin_change.
do $$
declare
  v_audit_count int;
begin
  select count(*) into v_audit_count
    from audit_events
   where entity_table = 'facilities'
     and entity_id = '42000000-0000-0000-0000-0000000000c0'
     and event_type = 'config.changed';
  if v_audit_count < 1 then
    raise exception 'INTERNAL FAIL: fn_audit_admin_change did not fire on facilities UPDATE despite EXECUTE being revoked from authenticated';
  end if;
end;
$$;

reset role;

rollback;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'probe_1b') then
    drop role probe_1b;
  end if;
end
$$;
