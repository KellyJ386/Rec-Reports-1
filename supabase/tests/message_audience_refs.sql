-- Proof for S-8: message_audiences.audience_ref_id is polymorphic (0006:
-- 32-41), no FK, and (before 0047) the "communication publishers can manage
-- audiences" WITH CHECK (0038:409-416) only guarded message_id, not the
-- audience_ref_id itself -- a Facility A publisher could point an audience
-- at another facility's employee/department/shift/role. 0047 closes this
-- two independent ways and both are proven here:
--   1. The WITH CHECK dispatch, for an RLS-subject `authenticated` writer:
--      a cross-facility ref is rejected. Proven with the new
--      fn_message_audience_ref_facility trigger temporarily disabled so the
--      policy alone is on the hook (SQLSTATE 42501 insufficient_privilege).
--   2. The fn_message_audience_ref_facility BEFORE trigger, for the
--      service-role/worker path that bypasses RLS entirely: run with RLS
--      bypassed (this file's own connecting role, which -- like
--      service_role -- is not subject to RLS), the same cross-facility ref
--      is still rejected (SQLSTATE 23514 check_violation).
--   3. Same-facility refs, for all four audience_type values, are accepted
--      under RLS as the publisher.
--
-- Runs inside begin/rollback so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('26000000-0000-0000-0000-0000000000a1', 'mar-publisher@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('26000000-0000-0000-0000-0000000000a1', 'MAR Publisher', 'mar-publisher@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('26111111-1111-1111-1111-111111111111', 'MAR Org A'),
  ('26222222-2222-2222-2222-222222222222', 'MAR Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26111111-1111-1111-1111-111111111111', 'MAR Facility A'),
  ('26bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '26222222-2222-2222-2222-222222222222', 'MAR Facility B')
on conflict (id) do nothing;

-- Publisher role/membership in Facility A only.
insert into roles (id, facility_id, name) values
  ('26000000-0000-0000-0000-0000000000d1', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MAR Publisher Role'),
  ('26000000-0000-0000-0000-0000000000d2', '26bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'MAR Facility B Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('26000000-0000-0000-0000-0000000000d1', 'communications.read'),
  ('26000000-0000-0000-0000-0000000000d1', 'communications.publish')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('26000000-0000-0000-0000-0000000000b1', '26000000-0000-0000-0000-0000000000a1', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000d1', 'active')
on conflict (id) do nothing;

-- One channel + message in Facility A, owned by the publisher.
insert into communication_channels (id, facility_id, channel_type, name) values
  ('26000000-0000-0000-0000-0000000000c1', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facility', 'MAR Channel A')
on conflict (id) do nothing;
insert into messages (id, facility_id, channel_id, subject, body_text) values
  ('26000000-0000-0000-0000-0000000000f1', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000c1', 'MAR Notice', 'Body')
on conflict (id) do nothing;

-- Same-facility referents (Facility A): employee, department, role, shift.
insert into employees (id, facility_id, first_name, last_name) values
  ('26000000-0000-0000-0000-0000000000e1', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'Employee')
on conflict (id) do nothing;
insert into departments (id, facility_id, name) values
  ('26000000-0000-0000-0000-0000000000e3', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MAR Dept A')
on conflict (id) do nothing;
insert into schedule_periods (id, facility_id, week_start_date, week_end_date) values
  ('26000000-0000-0000-0000-0000000000e5', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-09-07', '2026-09-13')
on conflict (id) do nothing;
insert into schedule_shifts (id, facility_id, schedule_period_id, role_code, shift_date, starts_at, ends_at) values
  ('26000000-0000-0000-0000-0000000000e7', '26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000e5', 'lifeguard', '2026-09-07', '2026-09-07T08:00:00Z', '2026-09-07T16:00:00Z')
on conflict (id) do nothing;

-- Cross-facility referents (Facility B): one of each type, same shape.
insert into employees (id, facility_id, first_name, last_name) values
  ('26000000-0000-0000-0000-0000000000e2', '26bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B', 'Employee')
on conflict (id) do nothing;
insert into departments (id, facility_id, name) values
  ('26000000-0000-0000-0000-0000000000e4', '26bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'MAR Dept B')
on conflict (id) do nothing;
insert into schedule_periods (id, facility_id, week_start_date, week_end_date) values
  ('26000000-0000-0000-0000-0000000000e6', '26bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-09-07', '2026-09-13')
on conflict (id) do nothing;
insert into schedule_shifts (id, facility_id, schedule_period_id, role_code, shift_date, starts_at, ends_at) values
  ('26000000-0000-0000-0000-0000000000e8', '26bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '26000000-0000-0000-0000-0000000000e6', 'lifeguard', '2026-09-07', '2026-09-07T08:00:00Z', '2026-09-07T16:00:00Z')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. WITH CHECK alone: disable the 0047 trigger for this block so a rejected
--    insert can only be the policy's doing, then act as the Facility A
--    publisher and try each audience_type against its Facility B referent.
-- ---------------------------------------------------------------------------
alter table message_audiences disable trigger message_audiences_ref_facility_consistency;

select set_config('request.jwt.claims', '{"sub":"26000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'employee', '26000000-0000-0000-0000-0000000000e2');
    raise exception 'MAR FAIL (policy): Facility A publisher inserted an audience pointing at a Facility B employee';
  exception
    when insufficient_privilege then null; -- expected: WITH CHECK's fn_assert_same_facility('employees', ...) blocked it
  end;
end;
$$;

do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'department', '26000000-0000-0000-0000-0000000000e4');
    raise exception 'MAR FAIL (policy): Facility A publisher inserted an audience pointing at a Facility B department';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'shift', '26000000-0000-0000-0000-0000000000e8');
    raise exception 'MAR FAIL (policy): Facility A publisher inserted an audience pointing at a Facility B shift';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'role', '26000000-0000-0000-0000-0000000000d2');
    raise exception 'MAR FAIL (policy): Facility A publisher inserted an audience pointing at a Facility B role';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;
alter table message_audiences enable trigger message_audiences_ref_facility_consistency;

-- ---------------------------------------------------------------------------
-- 2. The trigger alone: the service-role/worker path bypasses RLS entirely
--    (mirrors service_role's BYPASSRLS attribute on a real Supabase
--    project) -- this file's own connecting role already bypasses RLS the
--    same way once `reset role` above returns it to the migration-owning
--    role, which is exactly the scenario the fn_work_order_child_facility
--    precedent (0035) exists to cover. No set_config/set local role here:
--    the point is that this rejection happens with RLS out of the picture.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'employee', '26000000-0000-0000-0000-0000000000e2');
    raise exception 'MAR FAIL (trigger): a cross-facility employee ref was accepted with RLS bypassed';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'MAR FAIL (trigger): unexpected sqlstate % (%), expected 23514 check_violation', sqlstate, sqlerrm;
      end if;
      -- expected: fn_message_audience_ref_facility raised check_violation
  end;
end;
$$;

do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'shift', '26000000-0000-0000-0000-0000000000e8');
    raise exception 'MAR FAIL (trigger): a cross-facility shift ref was accepted with RLS bypassed';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'MAR FAIL (trigger): unexpected sqlstate % (%), expected 23514 check_violation', sqlstate, sqlerrm;
      end if;
  end;
end;
$$;

-- Confirm neither rejected insert above persisted.
do $$
begin
  if exists (
    select 1 from message_audiences
    where message_id = '26000000-0000-0000-0000-0000000000f1'
      and audience_ref_id in ('26000000-0000-0000-0000-0000000000e2', '26000000-0000-0000-0000-0000000000e8')
  ) then
    raise exception 'MAR FAIL: a cross-facility message_audiences row was persisted despite the rejected INSERTs';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Same-facility refs, all four audience_type values, accepted as the
--    Facility A publisher (both the policy and the trigger allow them).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"26000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
    ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'employee', '26000000-0000-0000-0000-0000000000e1'),
    ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'department', '26000000-0000-0000-0000-0000000000e3'),
    ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'shift', '26000000-0000-0000-0000-0000000000e7'),
    ('26aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '26000000-0000-0000-0000-0000000000f1', 'role', '26000000-0000-0000-0000-0000000000d1');
exception
  when insufficient_privilege then
    raise exception 'MAR FAIL: Facility A publisher was denied same-facility audience refs';
end;
$$;

do $$
declare
  inserted int;
begin
  select count(*) into inserted from message_audiences
  where message_id = '26000000-0000-0000-0000-0000000000f1'
    and audience_ref_id in (
      '26000000-0000-0000-0000-0000000000e1',
      '26000000-0000-0000-0000-0000000000e3',
      '26000000-0000-0000-0000-0000000000e7',
      '26000000-0000-0000-0000-0000000000d1'
    );
  if inserted <> 4 then
    raise exception 'MAR FAIL: expected 4 same-facility audience rows, found %', inserted;
  end if;
end;
$$;

reset role;

rollback;
