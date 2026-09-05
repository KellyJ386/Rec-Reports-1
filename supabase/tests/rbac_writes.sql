-- Verification intent: the RBAC write path (0012) is gated on admin.manage for
-- the row's facility, role_permissions grants resolve their facility through the
-- parent role, and seeded system roles cannot be deleted. Runs against a migrated
-- database; everything lives inside a transaction that is rolled back, so no
-- fixture persists. Each assertion RAISEs on failure so psql -v ON_ERROR_STOP=1
-- turns any regression into a non-zero exit. RLS denials surface as
-- insufficient_privilege (SQLSTATE 42501), as does the system-role guard.
begin;

insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'admin-a@rbac.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('77777777-7777-7777-7777-777777777777', 'RBAC Admin A', 'admin-a@rbac.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('71111111-1111-1111-1111-111111111111', 'Org RBAC A'),
  ('72222222-2222-2222-2222-222222222222', 'Org RBAC B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '71111111-1111-1111-1111-111111111111', 'RBAC Facility A'),
  ('7bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '72222222-2222-2222-2222-222222222222', 'RBAC Facility B')
on conflict (id) do nothing;

-- Admin A holds admin.manage in Facility A only.
insert into roles (id, facility_id, name) values
  ('7c000000-0000-0000-0000-0000000000c1', '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RBAC Admin Role A')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('7c000000-0000-0000-0000-0000000000c1', 'admin.manage')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('7d000000-0000-0000-0000-0000000000d1', '77777777-7777-7777-7777-777777777777', '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '7c000000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- A deletion-protected system role in Facility A.
insert into roles (id, facility_id, name, is_system_role) values
  ('7c000000-0000-0000-0000-0000000000c9', '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RBAC System Role A', true)
on conflict (id) do nothing;

-- A role in foreign Facility B, for the cross-facility grant-denial test.
insert into roles (id, facility_id, name) values
  ('7c000000-0000-0000-0000-0000000000cb', '7bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'RBAC Role B')
on conflict (id) do nothing;

-- Act as Admin A.
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);
set local role authenticated;

-- Allowed: create a custom role in own Facility A.
do $$
begin
  insert into roles (id, facility_id, name) values
    ('7c000000-0000-0000-0000-0000000000c2', '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RBAC Created A');
exception
  when insufficient_privilege then
    raise exception 'RBAC FAIL: Admin A was denied creating a role in own Facility A';
end;
$$;

-- Allowed: assign a permission to that role (facility resolved via the role).
do $$
begin
  insert into role_permissions (role_id, permission_code) values
    ('7c000000-0000-0000-0000-0000000000c2', 'reports.read');
exception
  when insufficient_privilege then
    raise exception 'RBAC FAIL: Admin A was denied granting a permission to its own role';
end;
$$;

-- Denied: create a role in foreign Facility B.
do $$
begin
  begin
    insert into roles (id, facility_id, name) values
      ('7c000000-0000-0000-0000-0000000000c3', '7bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'RBAC Cross B');
    raise exception 'RBAC FAIL: Admin A created a role in foreign Facility B';
  exception
    when insufficient_privilege then null; -- expected: RLS blocked the insert
  end;
end;
$$;

-- Denied: grant a permission on a role in foreign Facility B.
do $$
begin
  begin
    insert into role_permissions (role_id, permission_code) values
      ('7c000000-0000-0000-0000-0000000000cb', 'reports.read');
    raise exception 'RBAC FAIL: Admin A granted a permission on a foreign Facility B role';
  exception
    when insufficient_privilege then null; -- expected: role_permissions policy resolved facility B
  end;
end;
$$;

-- Denied: delete a system role (BEFORE DELETE guard raises even for an admin).
do $$
begin
  begin
    delete from roles where id = '7c000000-0000-0000-0000-0000000000c9';
    raise exception 'RBAC FAIL: a system role was deleted';
  exception
    when insufficient_privilege then null; -- expected: fn_protect_system_role raised
  end;
end;
$$;

-- Allowed: a custom (non-system) role can be deleted by the facility admin.
do $$
begin
  delete from roles where id = '7c000000-0000-0000-0000-0000000000c2';
  if exists (select 1 from roles where id = '7c000000-0000-0000-0000-0000000000c2') then
    raise exception 'RBAC FAIL: Admin A could not delete a custom role in own facility';
  end if;
exception
  when insufficient_privilege then
    raise exception 'RBAC FAIL: Admin A was denied deleting a custom role in own facility';
end;
$$;

reset role;
rollback;
