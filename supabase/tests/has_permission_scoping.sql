-- Regression for the 0020 name-shadowing fix: has_permission must return true
-- ONLY for a permission the member actually holds, and false for others. Before
-- 0020 the parameter `permission_code` was shadowed by role_permissions'
-- column of the same name, so has_permission returned true for every code once
-- a member held any single permission. Runs inside begin/rollback.
begin;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-0000000000aa', 'scope@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('a0000000-0000-0000-0000-0000000000aa', 'Scope User', 'scope@test')
on conflict (id) do nothing;
insert into organizations (id, name) values
  ('a0000000-0000-0000-0000-0000000000b0', 'Scope Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('a0000000-0000-0000-0000-0000000000c0', 'a0000000-0000-0000-0000-0000000000b0', 'Scope Facility')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('a0000000-0000-0000-0000-0000000000d0', 'a0000000-0000-0000-0000-0000000000c0', 'Scope Member')
on conflict (id) do nothing;
-- The member holds exactly one permission: reports.create.
insert into role_permissions (role_id, permission_code) values
  ('a0000000-0000-0000-0000-0000000000d0', 'reports.create')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('a0000000-0000-0000-0000-0000000000e0', 'a0000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-0000000000c0', 'a0000000-0000-0000-0000-0000000000d0', 'active')
on conflict (id) do nothing;

do $$
begin
  if not has_permission('a0000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-0000000000c0', 'reports.create') then
    raise exception 'SCOPE FAIL: member with reports.create was denied reports.create';
  end if;
  if has_permission('a0000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'SCOPE FAIL: member without admin.manage was granted admin.manage (parameter shadowing regressed)';
  end if;
  if has_permission('a0000000-0000-0000-0000-0000000000aa', 'a0000000-0000-0000-0000-0000000000c0', 'training.manage') then
    raise exception 'SCOPE FAIL: member without training.manage was granted training.manage';
  end if;
end;
$$;

-- And the concrete consequence: a member without admin.manage cannot insert a
-- forged audit row (the 0019 INSERT policy is gated on admin.manage, which only
-- holds now that has_permission distinguishes codes).
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into audit_events (facility_id, event_type, entity_table, event_payload)
    values ('a0000000-0000-0000-0000-0000000000c0', 'config.changed', 'forged', '{}'::jsonb);
    raise exception 'SCOPE FAIL: a non-admin member inserted an audit row';
  exception
    when insufficient_privilege then null; -- expected: admin.manage-gated INSERT policy denied it
  end;
end;
$$;
reset role;

rollback;
