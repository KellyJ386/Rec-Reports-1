-- Verification intent: SC-07 (plans/SCHEDULING_PLAN.md) write-side RLS for
-- schedule_publications (0034) -- the table's first INSERT policy. Covers:
--   1. A schedule.publish holder can insert a publication for a schedule
--      period in their own facility.
--   2a. Cross-facility insert denial (insufficient_privilege): facility_id
--       names a facility the caller has no membership in at all.
--   2b. Cross-tenant FK injection: facility_id = the caller's own facility
--       (where they DO hold schedule.publish), but schedule_period_id points
--       at another facility's period -- fn_assert_same_facility must reject
--       this even though the top-level has_permission check alone would pass.
--   3. A schedule.manage holder WITHOUT schedule.publish is denied -- the two
--      permissions are deliberately separate governance surfaces (SC-07).
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('34000000-0000-0000-0000-000000000a01', 'sp-publisher@test'),
  ('34000000-0000-0000-0000-000000000a02', 'sp-manageonly@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('34000000-0000-0000-0000-000000000a01', 'SP Publisher', 'sp-publisher@test'),
  ('34000000-0000-0000-0000-000000000a02', 'SP Manage-Only', 'sp-manageonly@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('34111111-1111-1111-1111-111111111111', 'SP Org A'),
  ('34222222-2222-2222-2222-222222222222', 'SP Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '34111111-1111-1111-1111-111111111111', 'SP Facility A'),
  ('34bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '34222222-2222-2222-2222-222222222222', 'SP Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('34c00000-0000-0000-0000-0000000000c1', '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SP Publisher Role'),
  ('34c00000-0000-0000-0000-0000000000c2', '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SP Manage-Only Role')
on conflict (id) do nothing;

-- Publisher role holds both schedule.manage and schedule.publish (the usual
-- shape per 0034's grant matrix). Manage-only role holds schedule.manage
-- (and schedule.read) but deliberately NOT schedule.publish.
insert into role_permissions (role_id, permission_code) values
  ('34c00000-0000-0000-0000-0000000000c1', 'schedule.read'),
  ('34c00000-0000-0000-0000-0000000000c1', 'schedule.manage'),
  ('34c00000-0000-0000-0000-0000000000c1', 'schedule.publish'),
  ('34c00000-0000-0000-0000-0000000000c2', 'schedule.read'),
  ('34c00000-0000-0000-0000-0000000000c2', 'schedule.manage')
on conflict do nothing;

-- Both users are members of Facility A ONLY -- neither has any membership in
-- Facility B, so the cross-facility cases below are a real foreign tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('34d00000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-000000000a01', '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '34c00000-0000-0000-0000-0000000000c1', 'active'),
  ('34d00000-0000-0000-0000-0000000000d2', '34000000-0000-0000-0000-000000000a02', '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '34c00000-0000-0000-0000-0000000000c2', 'active')
on conflict (id) do nothing;

-- Schedule periods in both facilities, seeded with RLS bypassed (owner
-- role). Facility B's period is only ever used as an FK-injection target
-- below.
insert into schedule_periods (id, facility_id, week_start_date, week_end_date, status) values
  ('34e00000-0000-0000-0000-0000000000e1', '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-08-10', '2026-08-16', 'review'),
  ('34e00000-0000-0000-0000-0000000000e2', '34bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-08-10', '2026-08-16', 'review')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Act as the publisher: insert a publication for the Facility A period.
-- Allowed.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"34000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into schedule_publications (id, facility_id, schedule_period_id, publish_version, published_by, change_summary) values
    ('34100000-0000-0000-0000-000000001001', '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '34e00000-0000-0000-0000-0000000000e1', 1, '34000000-0000-0000-0000-000000000a01', '{}'::jsonb);
exception
  when insufficient_privilege then
    raise exception 'SP FAIL: schedule.publish holder was denied inserting a publication for their own facility''s period';
end;
$$;

do $$
begin
  if not exists (
    select 1 from schedule_publications
    where id = '34100000-0000-0000-0000-000000001001'
      and facility_id = '34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and schedule_period_id = '34e00000-0000-0000-0000-0000000000e1'
      and publish_version = 1
  ) then
    raise exception 'SP FAIL: the allowed publication insert did not persist as expected';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2a. Cross-facility insert denial: the publisher has no membership in
-- Facility B, so inserting a publication there (facility_id = B, and even
-- naming B's own period) must fail.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into schedule_publications (facility_id, schedule_period_id, publish_version, published_by, change_summary) values
      ('34bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '34e00000-0000-0000-0000-0000000000e2', 1, '34000000-0000-0000-0000-000000000a01', '{}'::jsonb);
    raise exception 'SP FAIL: publisher inserted a schedule_publications row into a facility they are not a member of';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. Cross-tenant FK injection: facility_id = A (where the publisher DOES
-- hold schedule.publish), but schedule_period_id names Facility B's period --
-- fn_assert_same_facility must reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into schedule_publications (facility_id, schedule_period_id, publish_version, published_by, change_summary) values
      ('34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '34e00000-0000-0000-0000-0000000000e2', 1, '34000000-0000-0000-0000-000000000a01', '{}'::jsonb);
    raise exception 'SP FAIL: publisher injected a Facility B schedule_period_id into a Facility A publication row';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. A schedule.manage holder WITHOUT schedule.publish cannot insert a
-- publication, even for a period in their own facility.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"34000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into schedule_publications (facility_id, schedule_period_id, publish_version, published_by, change_summary) values
      ('34aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '34e00000-0000-0000-0000-0000000000e1', 2, '34000000-0000-0000-0000-000000000a02', '{}'::jsonb);
    raise exception 'SP FAIL: a schedule.manage holder without schedule.publish inserted a schedule_publications row';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

rollback;
