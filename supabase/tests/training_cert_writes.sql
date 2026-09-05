-- Verification intent: TR-04/TR-03 (plans/TRAINING_PLAN.md) write-side RLS for
-- employee_certifications and certification_events (0031). Covers:
--   1. A training.manage holder can insert an employee_certification for an
--      employee + certification_type that both belong to their own facility.
--   2. Cross-facility denial (insufficient_privilege): a direct facility_id
--      mismatch, plus two fn_assert_same_facility FK-injection attempts
--      (employee_id pointing at another facility's employee, and
--      certification_type_id pointing at another facility's cert type).
--   3. A member with training.read only (no training.manage) cannot insert.
--   4. The same manager can insert a certification_events row for that cert
--      (append-only writer path), but cannot UPDATE it afterwards -- with no
--      UPDATE policy at all, RLS filters the row out of the command
--      (deny by omission), so the statement affects zero rows and the row's
--      event_type is unchanged.
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('31000000-0000-0000-0000-000000000a01', 'tcw-manager@test'),
  ('31000000-0000-0000-0000-000000000a02', 'tcw-reader@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('31000000-0000-0000-0000-000000000a01', 'TCW Manager', 'tcw-manager@test'),
  ('31000000-0000-0000-0000-000000000a02', 'TCW Reader', 'tcw-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('31111111-1111-1111-1111-111111111111', 'TCW Org A'),
  ('31222222-2222-2222-2222-222222222222', 'TCW Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31111111-1111-1111-1111-111111111111', 'TCW Facility A'),
  ('31bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '31222222-2222-2222-2222-222222222222', 'TCW Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('31c00000-0000-0000-0000-0000000000c1', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TCW Manager Role'),
  ('31c00000-0000-0000-0000-0000000000c2', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TCW Reader Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('31c00000-0000-0000-0000-0000000000c1', 'training.manage'),
  ('31c00000-0000-0000-0000-0000000000c1', 'training.read'),
  ('31c00000-0000-0000-0000-0000000000c2', 'training.read')
on conflict do nothing;

-- Both users are members of Facility A ONLY -- neither has any membership in
-- Facility B, so the cross-facility cases below are a real foreign tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('31d00000-0000-0000-0000-0000000000d1', '31000000-0000-0000-0000-000000000a01', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31c00000-0000-0000-0000-0000000000c1', 'active'),
  ('31d00000-0000-0000-0000-0000000000d2', '31000000-0000-0000-0000-000000000a02', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31c00000-0000-0000-0000-0000000000c2', 'active')
on conflict (id) do nothing;

-- Employees + certification_types in both facilities, seeded with RLS
-- bypassed (owner role). Facility B's rows are only ever used as
-- FK-injection targets below.
insert into employees (id, facility_id, first_name, last_name) values
  ('31e00000-0000-0000-0000-0000000000e1', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex', 'A'),
  ('31e00000-0000-0000-0000-0000000000e2', '31bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Blair', 'B')
on conflict (id) do nothing;

insert into certification_types (id, facility_id, code, name) values
  ('31f00000-0000-0000-0000-0000000000f1', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cpr_a', 'CPR (Facility A)'),
  ('31f00000-0000-0000-0000-0000000000f2', '31bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cpr_b', 'CPR (Facility B)')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Manager insert allowed: employee + cert type both in Facility A.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"31000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into employee_certifications (id, facility_id, employee_id, certification_type_id, issued_at, expires_at, status) values
    ('31100000-0000-0000-0000-000000001001', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31e00000-0000-0000-0000-0000000000e1', '31f00000-0000-0000-0000-0000000000f1', '2026-01-01', '2027-01-01', 'active');
exception
  when insufficient_privilege then
    raise exception 'TCW FAIL: training.manage holder was denied issuing a certification in their own facility';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2a. Cross-facility insert denial: the manager has no membership in Facility
-- B, so inserting a cert there must fail even naming Facility B's own
-- employee/cert-type (both consistent with facility_id, but the caller
-- lacks training.manage on that facility at all).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into employee_certifications (facility_id, employee_id, certification_type_id, status) values
      ('31bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '31e00000-0000-0000-0000-0000000000e2', '31f00000-0000-0000-0000-0000000000f2', 'active');
    raise exception 'TCW FAIL: manager inserted an employee_certification into a facility they are not a member of';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. Cross-tenant FK injection on employee_id: facility_id = A (where the
-- manager does hold training.manage), but employee_id names a Facility B
-- employee -- fn_assert_same_facility must reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into employee_certifications (facility_id, employee_id, certification_type_id, status) values
      ('31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31e00000-0000-0000-0000-0000000000e2', '31f00000-0000-0000-0000-0000000000f1', 'active');
    raise exception 'TCW FAIL: manager injected a Facility B employee_id into a Facility A certification row';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2c. Cross-tenant FK injection on certification_type_id: same shape, this
-- time the cert type is the foreign row.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into employee_certifications (facility_id, employee_id, certification_type_id, status) values
      ('31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31e00000-0000-0000-0000-0000000000e1', '31f00000-0000-0000-0000-0000000000f2', 'active');
    raise exception 'TCW FAIL: manager injected a Facility B certification_type_id into a Facility A certification row';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. The same manager can append a certification_events row for the cert
-- created in step 1.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into certification_events (id, facility_id, employee_certification_id, event_type, payload_jsonb) values
    ('31200000-0000-0000-0000-000000002001', '31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31100000-0000-0000-0000-000000001001', 'created', '{"source":"test"}'::jsonb);
exception
  when insufficient_privilege then
    raise exception 'TCW FAIL: training.manage holder was denied appending a certification_events row';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. A member with training.read only (no training.manage) cannot insert an
-- employee_certification, even in their own facility.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"31000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into employee_certifications (facility_id, employee_id, certification_type_id, status) values
      ('31aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '31e00000-0000-0000-0000-0000000000e1', '31f00000-0000-0000-0000-0000000000f1', 'active');
    raise exception 'TCW FAIL: a member without training.manage inserted an employee_certification';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4b. certification_events has no UPDATE policy at all -- append-only by
-- omission. Even the training.manage holder who wrote the row cannot UPDATE
-- it: with no permissive UPDATE policy, RLS filters the row out of the
-- command entirely, so it affects zero rows and event_type stays 'created'.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"31000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update certification_events set event_type = 'revoked'
    where id = '31200000-0000-0000-0000-000000002001';
end;
$$;

do $$
declare
  current_type text;
begin
  select event_type into current_type from certification_events
    where id = '31200000-0000-0000-0000-000000002001';
  if current_type is distinct from 'created' then
    raise exception 'TCW FAIL: certification_events event_type was mutated despite no UPDATE policy (now %)', current_type;
  end if;
end;
$$;

reset role;

rollback;
