-- Proof for 0045_read_and_audit_policies.sql (S-6):
--   (1) an admin.manage holder can no longer forge an audit_events row via a
--       direct client INSERT (the policy that allowed it is dropped; only
--       the SECURITY DEFINER triggers, which bypass RLS, can write one), but
--   (2) a trigger-driven write (updating facilities as an org admin) still
--       lands an audit_events row via fn_audit_admin_change -- proving the
--       drop did not also break legitimate audit writes.
--   (3) employee_certifications: a training.read holder reads every
--       employee's certifications in the facility, a plain member reads only
--       their OWN row (the self-read clause the certification wallet route
--       relies on), and an outsider (no membership at all) reads none.
-- Runs inside begin/rollback; no roles created/dropped outside the txn.

begin;

insert into auth.users (id, email) values
  ('f5000000-0000-0000-0000-0000000000a0', 'ra-admin@test'),
  ('f5000000-0000-0000-0000-0000000000a1', 'ra-trainingreader@test'),
  ('f5000000-0000-0000-0000-0000000000a2', 'ra-plainmember@test'),
  ('f5000000-0000-0000-0000-0000000000a3', 'ra-outsider@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('f5000000-0000-0000-0000-0000000000a0', 'RA Admin', 'ra-admin@test'),
  ('f5000000-0000-0000-0000-0000000000a1', 'RA Training Reader', 'ra-trainingreader@test'),
  ('f5000000-0000-0000-0000-0000000000a2', 'RA Plain Member', 'ra-plainmember@test'),
  ('f5000000-0000-0000-0000-0000000000a3', 'RA Outsider', 'ra-outsider@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('f5000000-0000-0000-0000-0000000000b0', 'Read/Audit Policies Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000b0', 'Read/Audit Policies Facility')
on conflict (id) do nothing;

-- Org-admin grant for the admin user: facilities UPDATE (0009) requires
-- is_organization_admin, not just admin.manage on the facility.
insert into organization_admins (organization_id, user_id) values
  ('f5000000-0000-0000-0000-0000000000b0', 'f5000000-0000-0000-0000-0000000000a0')
on conflict do nothing;

insert into roles (id, facility_id, name) values
  ('f5000000-0000-0000-0000-0000000000d0', 'f5000000-0000-0000-0000-0000000000c0', 'RA Admin Role'),
  ('f5000000-0000-0000-0000-0000000000d1', 'f5000000-0000-0000-0000-0000000000c0', 'RA Training Reader Role'),
  ('f5000000-0000-0000-0000-0000000000d2', 'f5000000-0000-0000-0000-0000000000c0', 'RA Plain Member Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('f5000000-0000-0000-0000-0000000000d0', 'admin.manage'),
  ('f5000000-0000-0000-0000-0000000000d1', 'training.read'),
  ('f5000000-0000-0000-0000-0000000000d2', 'reports.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('f5000000-0000-0000-0000-0000000000e0', 'f5000000-0000-0000-0000-0000000000a0', 'f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000d0', 'active'),
  ('f5000000-0000-0000-0000-0000000000e1', 'f5000000-0000-0000-0000-0000000000a1', 'f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000d1', 'active'),
  ('f5000000-0000-0000-0000-0000000000e2', 'f5000000-0000-0000-0000-0000000000a2', 'f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000d2', 'active')
on conflict (id) do nothing;
-- The outsider (a3) gets no membership row at all -- current_facility_ids()
-- and has_permission both resolve to "nothing" for them, the same as any
-- caller with zero rows in memberships.

-- One employee row owned by the plain member (self-read target), one owned
-- by nobody-in-particular (the "someone else's" row a plain member must NOT
-- see).
insert into employees (id, facility_id, user_id, first_name, last_name) values
  ('f5000000-0000-0000-0000-0000000000ee', 'f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000a2', 'Plain', 'Member'),
  ('f5000000-0000-0000-0000-0000000000ef', 'f5000000-0000-0000-0000-0000000000c0', null, 'Other', 'Employee')
on conflict (id) do nothing;

insert into certification_types (id, facility_id, code, name) values
  ('f5000000-0000-0000-0000-0000000000f0', 'f5000000-0000-0000-0000-0000000000c0', 'RA-CPR', 'CPR')
on conflict (id) do nothing;

insert into employee_certifications (id, facility_id, employee_id, certification_type_id, status) values
  ('f5000000-0000-0000-0000-000000000100', 'f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000ee', 'f5000000-0000-0000-0000-0000000000f0', 'active'),
  ('f5000000-0000-0000-0000-000000000101', 'f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000ef', 'f5000000-0000-0000-0000-0000000000f0', 'active')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- (1) Audit forgery: even an admin.manage holder cannot INSERT audit_events
-- directly now that "admins can write audit events" is dropped and nothing
-- replaces it.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-0000-0000-0000000000a0","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into audit_events (facility_id, actor_user_id, event_type, entity_table, entity_id, event_payload) values
      ('f5000000-0000-0000-0000-0000000000c0', 'f5000000-0000-0000-0000-0000000000a0', 'forged.event', 'facilities', 'f5000000-0000-0000-0000-0000000000c0', '{}'::jsonb);
    raise exception 'RA FAIL: an admin.manage holder forged a direct audit_events INSERT';
  exception
    when insufficient_privilege then null; -- expected: no INSERT policy remains on audit_events
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- (2) A legitimate, trigger-driven audit write still lands: the same admin,
-- who IS an org admin, updates facilities (allowed by "org admins can update
-- facilities"), and the AFTER UPDATE fn_audit_admin_change trigger -- SECURITY
-- DEFINER, bypasses RLS -- inserts a 'config.changed' audit_events row despite
-- there being no client INSERT policy at all.
-- ---------------------------------------------------------------------------
update facilities
   set name = 'Read/Audit Policies Facility (renamed)'
 where id = 'f5000000-0000-0000-0000-0000000000c0';

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from audit_events
   where entity_table = 'facilities'
     and entity_id = 'f5000000-0000-0000-0000-0000000000c0'
     and event_type = 'config.changed';
  if v_count < 1 then
    raise exception 'RA FAIL: fn_audit_admin_change did not land an audit_events row on facilities UPDATE';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- (3) employee_certifications reads.
-- ---------------------------------------------------------------------------

-- training.read holder sees both certification rows in the facility.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from employee_certifications
   where facility_id = 'f5000000-0000-0000-0000-0000000000c0';
  if v_count <> 2 then
    raise exception 'RA FAIL: training.read holder saw % employee_certifications row(s), expected 2', v_count;
  end if;
end;
$$;
reset role;

-- Plain member (no training.read) sees only their OWN certification row --
-- this is the self-read clause the certification wallet route
-- (training-routes.mjs GET /facilities/:facilityId/employee-certifications
-- without ?employeeId=) depends on.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_ids uuid[];
begin
  select array_agg(id order by id) into v_ids
    from employee_certifications
   where facility_id = 'f5000000-0000-0000-0000-0000000000c0';
  if v_ids is distinct from array['f5000000-0000-0000-0000-000000000100'::uuid] then
    raise exception 'RA FAIL: plain member saw % (expected only their own cert row 100)', v_ids;
  end if;
end;
$$;
reset role;

-- Outsider (no membership on this facility at all) sees none.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from employee_certifications
   where facility_id = 'f5000000-0000-0000-0000-0000000000c0';
  if v_count <> 0 then
    raise exception 'RA FAIL: outsider saw % employee_certifications row(s), expected 0', v_count;
  end if;
end;
$$;
reset role;

rollback;
