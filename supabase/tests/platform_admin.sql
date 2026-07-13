-- Proof for 0022: platform super-admin scope. A platform_admins roster row
-- (and nothing else -- no memberships) must pass has_permission for any
-- facility and code, and current_facility_ids must return every facility for
-- the platform admin. A regular member must NOT gain anything from the
-- migration, must not see the roster, and must not be able to write to it
-- (grants are service-role-only). Runs inside begin/rollback.
begin;

insert into auth.users (id, email) values
  ('f0000000-0000-0000-0000-0000000000aa', 'platform@test'),
  ('f0000000-0000-0000-0000-0000000000ab', 'plain@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('f0000000-0000-0000-0000-0000000000aa', 'Platform Admin', 'platform@test'),
  ('f0000000-0000-0000-0000-0000000000ab', 'Plain Member', 'plain@test')
on conflict (id) do nothing;
insert into organizations (id, name) values
  ('f0000000-0000-0000-0000-0000000000b0', 'Platform Org A'),
  ('f0000000-0000-0000-0000-0000000000b1', 'Platform Org B')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('f0000000-0000-0000-0000-0000000000c0', 'f0000000-0000-0000-0000-0000000000b0', 'Platform Facility A'),
  ('f0000000-0000-0000-0000-0000000000c1', 'f0000000-0000-0000-0000-0000000000b1', 'Platform Facility B')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('f0000000-0000-0000-0000-0000000000d0', 'f0000000-0000-0000-0000-0000000000c0', 'Platform Plain Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('f0000000-0000-0000-0000-0000000000d0', 'reports.read')
on conflict do nothing;
-- The plain user is an active member of facility A only.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('f0000000-0000-0000-0000-0000000000e0', 'f0000000-0000-0000-0000-0000000000ab', 'f0000000-0000-0000-0000-0000000000c0', 'f0000000-0000-0000-0000-0000000000d0', 'active')
on conflict (id) do nothing;
-- The platform admin has NO memberships at all -- only the roster row.
insert into platform_admins (id, user_id, note) values
  ('f0000000-0000-0000-0000-0000000000f0', 'f0000000-0000-0000-0000-0000000000aa', 'test grant')
on conflict (id) do nothing;

-- has_permission: bypass for the platform admin, unchanged for everyone else.
do $$
begin
  if not is_platform_admin('f0000000-0000-0000-0000-0000000000aa') then
    raise exception 'PLATFORM FAIL: roster row not recognized by is_platform_admin';
  end if;
  if is_platform_admin('f0000000-0000-0000-0000-0000000000ab') then
    raise exception 'PLATFORM FAIL: plain member reported as platform admin';
  end if;
  if not has_permission('f0000000-0000-0000-0000-0000000000aa', 'f0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'PLATFORM FAIL: platform admin denied admin.manage on facility A';
  end if;
  if not has_permission('f0000000-0000-0000-0000-0000000000aa', 'f0000000-0000-0000-0000-0000000000c1', 'training.manage') then
    raise exception 'PLATFORM FAIL: platform admin denied training.manage on cross-org facility B';
  end if;
  if has_permission('f0000000-0000-0000-0000-0000000000ab', 'f0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'PLATFORM FAIL: plain member gained admin.manage from the migration';
  end if;
  if has_permission('f0000000-0000-0000-0000-0000000000ab', 'f0000000-0000-0000-0000-0000000000c1', 'reports.read') then
    raise exception 'PLATFORM FAIL: plain member gained cross-facility reports.read';
  end if;
end;
$$;

-- current_facility_ids: every facility for the platform admin, membership
-- facilities only for the plain member.
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from current_facility_ids() f(id) where id = 'f0000000-0000-0000-0000-0000000000c1') then
    raise exception 'PLATFORM FAIL: current_facility_ids missing cross-org facility for platform admin';
  end if;
  -- Concrete consequence: the platform admin can read both organizations.
  if (select count(*) from organizations where id in ('f0000000-0000-0000-0000-0000000000b0','f0000000-0000-0000-0000-0000000000b1')) <> 2 then
    raise exception 'PLATFORM FAIL: platform admin cannot read both organizations';
  end if;
  -- And can see the roster.
  if not exists (select 1 from platform_admins) then
    raise exception 'PLATFORM FAIL: platform admin cannot read the roster';
  end if;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-0000000000ab","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from current_facility_ids() f(id) where id = 'f0000000-0000-0000-0000-0000000000c1') then
    raise exception 'PLATFORM FAIL: plain member sees a facility they are not a member of';
  end if;
  -- The roster is invisible to non-platform users.
  if exists (select 1 from platform_admins) then
    raise exception 'PLATFORM FAIL: plain member can read the platform roster';
  end if;
  -- And not writable by any client role (no INSERT policy exists).
  begin
    insert into platform_admins (user_id, note)
    values ('f0000000-0000-0000-0000-0000000000ab', 'self-grant');
    raise exception 'PLATFORM FAIL: plain member inserted a platform_admins row';
  exception
    when insufficient_privilege then null; -- expected: no client write policy
  end;
end;
$$;
reset role;

rollback;
