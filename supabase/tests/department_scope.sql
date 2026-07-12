-- Proof for 0023: department-level permission scoping. A department-scoped
-- membership must NOT pass facility-scope (3-arg) has_permission, must pass
-- the 4-arg overload only for its own department, and must be able to write
-- department_settings rows only for that department. Facility-wide
-- memberships are unaffected, and a membership's department must belong to
-- the membership's facility. Runs inside begin/rollback.
begin;

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-0000000000aa', 'deptadmin@test'),
  ('d0000000-0000-0000-0000-0000000000ab', 'facadmin@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('d0000000-0000-0000-0000-0000000000aa', 'Dept Scoped Admin', 'deptadmin@test'),
  ('d0000000-0000-0000-0000-0000000000ab', 'Facility Admin', 'facadmin@test')
on conflict (id) do nothing;
insert into organizations (id, name) values
  ('d0000000-0000-0000-0000-0000000000b0', 'Dept Scope Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000b0', 'Dept Scope Facility'),
  ('d0000000-0000-0000-0000-0000000000c1', 'd0000000-0000-0000-0000-0000000000b0', 'Other Facility')
on conflict (id) do nothing;
insert into departments (id, facility_id, name) values
  ('d0000000-0000-0000-0000-0000000000da', 'd0000000-0000-0000-0000-0000000000c0', 'Aquatics'),
  ('d0000000-0000-0000-0000-0000000000db', 'd0000000-0000-0000-0000-0000000000c0', 'Fitness'),
  ('d0000000-0000-0000-0000-0000000000dc', 'd0000000-0000-0000-0000-0000000000c1', 'Foreign Dept')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('d0000000-0000-0000-0000-0000000000d0', 'd0000000-0000-0000-0000-0000000000c0', 'Dept Scope Admin Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('d0000000-0000-0000-0000-0000000000d0', 'admin.manage')
on conflict do nothing;
-- User A: admin.manage scoped to the Aquatics department only.
insert into memberships (id, user_id, facility_id, role_id, status, department_id) values
  ('d0000000-0000-0000-0000-0000000000e0', 'd0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d0', 'active', 'd0000000-0000-0000-0000-0000000000da')
on conflict (id) do nothing;
-- User B: facility-wide admin.manage (department_id null, the pre-0023 shape).
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('d0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-0000000000ab', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d0', 'active')
on conflict (id) do nothing;

-- Scope semantics of both overloads.
do $$
begin
  if has_permission('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'DEPT FAIL: department-scoped membership passed a facility-scope check';
  end if;
  if not has_permission('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000da', 'admin.manage') then
    raise exception 'DEPT FAIL: department-scoped membership denied its own department';
  end if;
  if has_permission('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'admin.manage') then
    raise exception 'DEPT FAIL: department-scoped membership granted a sibling department';
  end if;
  if not has_permission('d0000000-0000-0000-0000-0000000000ab', 'd0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'DEPT FAIL: facility-wide membership lost its facility-scope grant';
  end if;
  if not has_permission('d0000000-0000-0000-0000-0000000000ab', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'admin.manage') then
    raise exception 'DEPT FAIL: facility-wide membership denied a department-scoped check';
  end if;
end;
$$;

-- Concrete consequence: the department-scoped admin can write settings for
-- their own department, not for a sibling department; they remain a facility
-- member for member-level reads.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into department_settings (facility_id, department_id, settings_jsonb)
  values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000da', '{"note":"own dept"}'::jsonb);
  begin
    insert into department_settings (facility_id, department_id, settings_jsonb)
    values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', '{"note":"sibling dept"}'::jsonb);
    raise exception 'DEPT FAIL: department-scoped admin wrote a sibling department''s settings';
  exception
    when insufficient_privilege then null; -- expected: 4-arg policy denies it
  end;
  if not exists (select 1 from facilities where id = 'd0000000-0000-0000-0000-0000000000c0') then
    raise exception 'DEPT FAIL: department-scoped member lost member-level facility read';
  end if;
end;
$$;
reset role;

-- Integrity: a membership cannot be scoped to a department of another
-- facility (fn_membership_department_facility raises check_violation).
do $$
begin
  begin
    insert into memberships (user_id, facility_id, role_id, status, department_id)
    values ('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d0', 'active', 'd0000000-0000-0000-0000-0000000000dc');
    raise exception 'DEPT FAIL: membership accepted a department from another facility';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

rollback;
