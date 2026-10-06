-- Proof for Wave 3 Slice 3D (SC-10 .. SC-17): 0062_scheduling_self_service.sql.
--
--  1. Grant shape: the decide_* RPCs are executable by `authenticated` only
--     (a PUBLIC stand-in cannot); every helper/guard/trigger function the RPCs
--     lean on is NOT callable by `authenticated`.
--  2. Self-service: an employee creates, reads and cancels only THEIR OWN
--     claims / swaps / time off / availability; a colleague cannot read them.
--  3. Cross-facility FK injection is rejected on every new INSERT policy
--     (fn_assert_same_facility), and the structural pg_policy assertion lists
--     every guarded column so a redefinition cannot drop one silently.
--  4. Guards: illegal transitions, decided states without the RPC marker,
--     identity-column edits, missing denial reasons, closed claim window,
--     claims on non-published shifts are all rejected.
--  5. Approvals: a manager without the SPECIFIC approve code cannot approve
--     (and schedule.manage satisfies claims + swaps but NOT time off); the
--     RPCs deny the wrong role, require a denial reason, are idempotent on
--     replay, re-validate (stale / cert / overlap), assign atomically and
--     auto-deny competing claims.
--  6. Audit rows and decision notifications land; publishing notifies every
--     assigned employee exactly once per publication.
--  7. opened_at is server-owned; fn_notification_job_dedupe_key is NOT
--     redefined (schedule jobs are written with a null dedupe_key, so no
--     caller-influenced key exists).
--
-- Fixtures live in the 62xxxxxx uuid namespace; everything runs inside
-- begin/rollback.
begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('62000000-0000-0000-0000-0000000000a1', 'sss-alice@test'),
  ('62000000-0000-0000-0000-0000000000a2', 'sss-bob@test'),
  ('62000000-0000-0000-0000-0000000000a3', 'sss-mgr-all@test'),
  ('62000000-0000-0000-0000-0000000000a4', 'sss-mgr-swaps@test'),
  ('62000000-0000-0000-0000-0000000000a5', 'sss-mgr-manage@test'),
  ('62000000-0000-0000-0000-0000000000a6', 'sss-mgr-timeoff@test'),
  ('62000000-0000-0000-0000-0000000000a7', 'sss-outsider@test'),
  ('62000000-0000-0000-0000-0000000000a8', 'sss-reader@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('62000000-0000-0000-0000-0000000000a1', 'SSS Alice', 'sss-alice@test'),
  ('62000000-0000-0000-0000-0000000000a2', 'SSS Bob', 'sss-bob@test'),
  ('62000000-0000-0000-0000-0000000000a3', 'SSS Manager All', 'sss-mgr-all@test'),
  ('62000000-0000-0000-0000-0000000000a4', 'SSS Manager Swaps', 'sss-mgr-swaps@test'),
  ('62000000-0000-0000-0000-0000000000a5', 'SSS Manager Manage', 'sss-mgr-manage@test'),
  ('62000000-0000-0000-0000-0000000000a6', 'SSS Manager TimeOff', 'sss-mgr-timeoff@test'),
  ('62000000-0000-0000-0000-0000000000a7', 'SSS Outsider', 'sss-outsider@test'),
  ('62000000-0000-0000-0000-0000000000a8', 'SSS Reader', 'sss-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('62000000-0000-0000-0000-0000000000b0', 'SSS Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000b0', 'SSS Facility A'),
  ('62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '62000000-0000-0000-0000-0000000000b0', 'SSS Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('62000000-0000-0000-0000-0000000000d1', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SSS Staff'),
  ('62000000-0000-0000-0000-0000000000d2', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SSS Manager All'),
  ('62000000-0000-0000-0000-0000000000d3', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SSS Manager Swaps'),
  ('62000000-0000-0000-0000-0000000000d4', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SSS Manager Manage'),
  ('62000000-0000-0000-0000-0000000000d5', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SSS Manager TimeOff'),
  ('62000000-0000-0000-0000-0000000000d6', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SSS Reader'),
  ('62000000-0000-0000-0000-0000000000d7', '62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SSS Outsider Manager')
on conflict (id) do nothing;
-- d1 (staff) deliberately holds NO permission at all: every self-service path
-- below must work for a plain facility member.
insert into role_permissions (role_id, permission_code) values
  ('62000000-0000-0000-0000-0000000000d2', 'schedule.read'),
  ('62000000-0000-0000-0000-0000000000d2', 'schedule.manage'),
  ('62000000-0000-0000-0000-0000000000d2', 'schedule.publish'),
  ('62000000-0000-0000-0000-0000000000d2', 'schedule.approve.swaps'),
  ('62000000-0000-0000-0000-0000000000d2', 'schedule.approve.time_off'),
  ('62000000-0000-0000-0000-0000000000d2', 'schedule.manage.open_shifts'),
  ('62000000-0000-0000-0000-0000000000d3', 'schedule.read'),
  ('62000000-0000-0000-0000-0000000000d3', 'schedule.approve.swaps'),
  ('62000000-0000-0000-0000-0000000000d4', 'schedule.read'),
  ('62000000-0000-0000-0000-0000000000d4', 'schedule.manage'),
  ('62000000-0000-0000-0000-0000000000d5', 'schedule.read'),
  ('62000000-0000-0000-0000-0000000000d5', 'schedule.approve.time_off'),
  ('62000000-0000-0000-0000-0000000000d6', 'schedule.read'),
  ('62000000-0000-0000-0000-0000000000d7', 'schedule.read'),
  ('62000000-0000-0000-0000-0000000000d7', 'schedule.manage'),
  ('62000000-0000-0000-0000-0000000000d7', 'schedule.approve.swaps'),
  ('62000000-0000-0000-0000-0000000000d7', 'schedule.approve.time_off'),
  ('62000000-0000-0000-0000-0000000000d7', 'schedule.manage.open_shifts')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('62000000-0000-0000-0000-0000000000e1', '62000000-0000-0000-0000-0000000000a1', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d1', 'active'),
  ('62000000-0000-0000-0000-0000000000e2', '62000000-0000-0000-0000-0000000000a2', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d1', 'active'),
  ('62000000-0000-0000-0000-0000000000e3', '62000000-0000-0000-0000-0000000000a3', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d2', 'active'),
  ('62000000-0000-0000-0000-0000000000e4', '62000000-0000-0000-0000-0000000000a4', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d3', 'active'),
  ('62000000-0000-0000-0000-0000000000e5', '62000000-0000-0000-0000-0000000000a5', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d4', 'active'),
  ('62000000-0000-0000-0000-0000000000e6', '62000000-0000-0000-0000-0000000000a6', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d5', 'active'),
  ('62000000-0000-0000-0000-0000000000e7', '62000000-0000-0000-0000-0000000000a7', '62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '62000000-0000-0000-0000-0000000000d7', 'active'),
  ('62000000-0000-0000-0000-0000000000e8', '62000000-0000-0000-0000-0000000000a8', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000d6', 'active')
on conflict (id) do nothing;

-- Employees: Alice/Bob have logins (their own rows are the self-service
-- keys); Carol has none; Eve belongs to facility B.
insert into employees (id, facility_id, user_id, first_name, last_name, status) values
  ('62e00000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000a1', 'Alice', 'SSS', 'active'),
  ('62e00000-0000-0000-0000-000000000002', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62000000-0000-0000-0000-0000000000a2', 'Bob', 'SSS', 'active'),
  ('62e00000-0000-0000-0000-000000000003', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'Carol', 'SSS', 'active'),
  ('62e00000-0000-0000-0000-0000000000b1', '62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'Eve', 'SSS', 'active')
on conflict (id) do nothing;

-- One certification type; Alice holds it, Bob and Carol do not.
insert into certification_types (id, facility_id, code, name) values
  ('62c10000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'sss-lifeguard', 'SSS Lifeguard')
on conflict (id) do nothing;
insert into employee_certifications (id, facility_id, employee_id, certification_type_id, status, expires_at) values
  ('62c20000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', '62c10000-0000-0000-0000-000000000001', 'active', '2040-01-01')
on conflict (id) do nothing;

-- Periods: one published + one draft in A, one published in B.
insert into schedule_periods (id, facility_id, week_start_date, week_end_date, status) values
  ('62f00000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2035-03-05', '2035-03-11', 'published'),
  ('62f00000-0000-0000-0000-000000000002', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2035-03-12', '2035-03-18', 'draft'),
  ('62f00000-0000-0000-0000-0000000000b1', '62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2035-03-05', '2035-03-11', 'published')
on conflict (id) do nothing;

-- Shifts. SO* = open shifts for claim scenarios; W* = assigned shifts for
-- swap scenarios; SB1 = facility B's open shift (cross-facility injection).
insert into schedule_shifts (id, facility_id, schedule_period_id, role_code, shift_date, starts_at, ends_at, status, required_certification_ids) values
  ('62500000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-05', '2035-03-05T09:00:00Z', '2035-03-05T17:00:00Z', 'open', '{}'),
  ('62500000-0000-0000-0000-000000000002', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-06', '2035-03-06T09:00:00Z', '2035-03-06T17:00:00Z', 'open', array['62c10000-0000-0000-0000-000000000001']::uuid[]),
  ('62500000-0000-0000-0000-000000000003', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-07', '2035-03-07T09:00:00Z', '2035-03-07T17:00:00Z', 'open', '{}'),
  ('62500000-0000-0000-0000-000000000004', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000002', 'guard', '2035-03-13', '2035-03-13T09:00:00Z', '2035-03-13T17:00:00Z', 'open', '{}'),
  ('62500000-0000-0000-0000-000000000005', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-08', '2035-03-08T09:00:00Z', '2035-03-08T17:00:00Z', 'open', '{}'),
  ('62500000-0000-0000-0000-000000000006', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-09', '2035-03-09T09:00:00Z', '2035-03-09T17:00:00Z', 'open', '{}'),
  ('62500000-0000-0000-0000-000000000007', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-09', '2035-03-09T12:00:00Z', '2035-03-09T20:00:00Z', 'assigned', '{}'),
  ('62500000-0000-0000-0000-000000000008', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-10', '2035-03-10T20:00:00Z', '2035-03-10T23:00:00Z', 'open', '{}'),
  ('62500000-0000-0000-0000-0000000000b1', '62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '62f00000-0000-0000-0000-0000000000b1', 'guard', '2035-03-05', '2035-03-05T09:00:00Z', '2035-03-05T17:00:00Z', 'open', '{}'),
  ('62510000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-06', '2035-03-06T18:00:00Z', '2035-03-06T22:00:00Z', 'assigned', '{}'),
  ('62510000-0000-0000-0000-000000000002', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-07', '2035-03-07T18:00:00Z', '2035-03-07T22:00:00Z', 'assigned', '{}'),
  ('62510000-0000-0000-0000-000000000003', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-08', '2035-03-08T18:00:00Z', '2035-03-08T22:00:00Z', 'assigned', '{}'),
  ('62510000-0000-0000-0000-000000000004', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-09', '2035-03-09T23:00:00Z', '2035-03-10T03:00:00Z', 'assigned', '{}'),
  ('62510000-0000-0000-0000-000000000005', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-10', '2035-03-10T09:00:00Z', '2035-03-10T13:00:00Z', 'assigned', array['62c10000-0000-0000-0000-000000000001']::uuid[]),
  ('62510000-0000-0000-0000-000000000006', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-11', '2035-03-11T09:00:00Z', '2035-03-11T13:00:00Z', 'assigned', '{}'),
  ('62510000-0000-0000-0000-000000000007', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-11', '2035-03-11T15:00:00Z', '2035-03-11T19:00:00Z', 'assigned', '{}'),
  ('62510000-0000-0000-0000-000000000008', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 'guard', '2035-03-11', '2035-03-11T17:00:00Z', '2035-03-11T21:00:00Z', 'assigned', '{}')
on conflict (id) do nothing;

-- Assignments (all approved). AW1/AW2: Alice<->Bob direct swap. AW3: drop to
-- Carol. AW4: drop to open pool. AW5/AW6: Alice (cert-gated shift) <-> Bob.
-- AW7: stale scenario. AW8 + AC1: overlap scenario. AO1: Alice already works
-- shift 7 which overlaps open shift 6 (claim-overlap scenario).
insert into shift_assignments (id, facility_id, shift_id, employee_id, status) values
  ('62a00000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000001', 'approved'),
  ('62a00000-0000-0000-0000-000000000002', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000002', '62e00000-0000-0000-0000-000000000002', 'approved'),
  ('62a00000-0000-0000-0000-000000000003', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000003', '62e00000-0000-0000-0000-000000000001', 'approved'),
  ('62a00000-0000-0000-0000-000000000004', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000004', '62e00000-0000-0000-0000-000000000001', 'approved'),
  ('62a00000-0000-0000-0000-000000000005', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000005', '62e00000-0000-0000-0000-000000000001', 'approved'),
  ('62a00000-0000-0000-0000-000000000006', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000006', '62e00000-0000-0000-0000-000000000002', 'approved'),
  ('62a00000-0000-0000-0000-000000000007', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000007', '62e00000-0000-0000-0000-000000000001', 'approved'),
  ('62a00000-0000-0000-0000-000000000008', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000008', '62e00000-0000-0000-0000-000000000001', 'approved'),
  ('62a00000-0000-0000-0000-0000000000c1', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62510000-0000-0000-0000-000000000007', '62e00000-0000-0000-0000-000000000003', 'approved'),
  ('62a00000-0000-0000-0000-0000000000d1', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000007', '62e00000-0000-0000-0000-000000000001', 'approved')
on conflict (id) do nothing;

-- ===========================================================================
-- 1. Grant shape (superuser view of pg_proc privileges).
-- ===========================================================================
do $$
begin
  if not has_function_privilege('authenticated', 'public.decide_open_shift_claim(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.decide_shift_swap(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.decide_time_off_request(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'internal.decide_open_shift_claim(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'internal.decide_shift_swap(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'internal.decide_time_off_request(uuid,text,text)', 'execute') then
    raise exception 'SSS FAIL (1): authenticated cannot execute a decide_* RPC';
  end if;
  if has_function_privilege('authenticated', 'internal.fn_assignment_blockers(uuid,uuid,uuid[])', 'execute')
     or has_function_privilege('authenticated', 'internal.fn_assign_employee_to_shift(uuid,uuid,uuid,text,uuid)', 'execute')
     or has_function_privilege('authenticated', 'internal.fn_enqueue_schedule_notification(uuid,text,uuid,uuid,text,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'internal.fn_scheduling_setting(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'internal.fn_scheduling_setting_int(uuid,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.fn_open_shift_claim_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.fn_shift_swap_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.fn_time_off_request_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.fn_employee_availability_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.fn_schedule_publication_notify()', 'execute')
     or has_function_privilege('authenticated', 'public.fn_schedule_shift_opened_at()', 'execute') then
    raise exception 'SSS FAIL (1): authenticated can execute an internal helper / guard / trigger function';
  end if;
end;
$$;

-- ===========================================================================
-- 2. Structural pg_policy assertions (no `for all`, every FK guarded).
-- ===========================================================================
do $$
declare
  v_check text;
  v_col text;
  r record;
begin
  -- No FOR ALL policy anywhere on the four new tables.
  if exists (
    select 1 from pg_policy p
    where p.polrelid in ('open_shift_claims'::regclass, 'shift_swap_requests'::regclass,
                         'time_off_requests'::regclass, 'employee_availability'::regclass)
      and p.polcmd = '*'
  ) then
    raise exception 'SSS FAIL (2): a for-all policy exists on a 3D table';
  end if;

  -- Request tables have NO manager UPDATE policy: the only UPDATE policy is
  -- the employee's own cancel/withdraw.
  for r in
    select c.relname, count(*) as n
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where p.polcmd = 'w'
      and c.relname in ('open_shift_claims', 'shift_swap_requests', 'time_off_requests')
    group by c.relname
  loop
    if r.n <> 1 then
      raise exception 'SSS FAIL (2): % has % UPDATE policies (expected exactly the employee one)', r.relname, r.n;
    end if;
  end loop;
  if exists (
    select 1 from pg_policy p
    where p.polcmd = 'w'
      and p.polrelid in ('open_shift_claims'::regclass, 'shift_swap_requests'::regclass, 'time_off_requests'::regclass)
      and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%has_permission%'
  ) then
    raise exception 'SSS FAIL (2): a request-table UPDATE policy grants a permission holder direct decision rights';
  end if;

  -- Full guarded-column lists per INSERT/UPDATE policy WITH CHECK.
  for r in
    select * from (values
      ('open_shift_claims', 'employees can create their own open shift claims', array['schedule_shifts|shift_id', 'employees|claimant_employee_id']),
      ('open_shift_claims', 'claimants can withdraw their own open shift claims', array['schedule_shifts|shift_id', 'employees|claimant_employee_id']),
      ('shift_swap_requests', 'employees can create their own swap requests', array['shift_assignments|offered_assignment_id', 'shift_assignments|requested_assignment_id', 'employees|requester_employee_id', 'employees|target_employee_id']),
      ('shift_swap_requests', 'requesters can cancel their own swap requests', array['shift_assignments|offered_assignment_id', 'shift_assignments|requested_assignment_id', 'employees|requester_employee_id', 'employees|target_employee_id']),
      ('time_off_requests', 'employees can create their own time off requests', array['employees|employee_id']),
      ('time_off_requests', 'employees can cancel their own time off requests', array['employees|employee_id']),
      ('employee_availability', 'employees can create their own availability', array['employees|employee_id']),
      ('employee_availability', 'employees can update their own availability', array['employees|employee_id'])
    ) as t(tbl, pol, guards)
  loop
    select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p
    where p.polrelid = r.tbl::regclass and p.polname = r.pol;
    if v_check is null then
      raise exception 'SSS FAIL (2): policy % on % missing or has no WITH CHECK', r.pol, r.tbl;
    end if;
    foreach v_col in array r.guards loop
      if v_check not like '%fn_assert_same_facility(facility_id, ''' || split_part(v_col, '|', 1) || '''::text, ' || split_part(v_col, '|', 2) || ')%' then
        raise exception 'SSS FAIL (2): policy % does not assert same-facility on %', r.pol, v_col;
      end if;
    end loop;
  end loop;

  -- 0062 does not redefine the dedupe-key trigger function (the communications
  -- slice re-creates it too; keeping a single definition keeps the merge
  -- clean): it still has only the 0058 incident-key behaviour.
  select prosrc into v_check from pg_proc where proname = 'fn_notification_job_dedupe_key';
  if v_check not like '%incidentId%' or v_check not like '%escalationId%' or v_check like '%schedule.%' or v_check like '%sourceId%' then
    raise exception 'SSS FAIL (2): fn_notification_job_dedupe_key was redefined by the scheduling migration';
  end if;

  -- 0058's incident-scoped notification_jobs INSERT policy is untouched.
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
  from pg_policy p where p.polrelid = 'notification_jobs'::regclass and p.polname = 'incident actors can insert incident notification jobs';
  if v_check is null or v_check like '%schedule.%' or v_check not like '%quietHoursBypass%' then
    raise exception 'SSS FAIL (2): the incident notification_jobs INSERT policy was altered';
  end if;
end;
$$;

-- ===========================================================================
-- 3. opened_at is server-owned.
-- ===========================================================================
do $$
declare
  v_opened timestamptz;
begin
  select opened_at into v_opened from schedule_shifts where id = '62500000-0000-0000-0000-000000000001';
  if v_opened is null then
    raise exception 'SSS FAIL (3): an open shift got no opened_at';
  end if;
  update schedule_shifts set opened_at = '2000-01-01' where id = '62500000-0000-0000-0000-000000000001';
  if (select opened_at from schedule_shifts where id = '62500000-0000-0000-0000-000000000001') <> v_opened then
    raise exception 'SSS FAIL (3): a client-sent opened_at replaced the server value';
  end if;
  if (select opened_at from schedule_shifts where id = '62510000-0000-0000-0000-000000000001') is not null then
    raise exception 'SSS FAIL (3): a non-open shift carries opened_at';
  end if;
end;
$$;

-- ===========================================================================
-- 4. Publish notifications: one job per assigned employee per publication.
-- (Run BEFORE any approval changes the assignment set.)
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
insert into schedule_publications (id, facility_id, schedule_period_id, publish_version, published_by) values
  ('62b00000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62f00000-0000-0000-0000-000000000001', 1, '62000000-0000-0000-0000-0000000000a3');
reset role;

do $$
declare
  v_jobs integer;
  v_distinct integer;
begin
  select count(*) into v_jobs from notification_jobs
   where event_type = 'schedule.published' and payload_jsonb ->> 'sourceId' = '62b00000-0000-0000-0000-000000000001';
  select count(distinct payload_jsonb -> 'recipients' ->> 0) into v_distinct from notification_jobs
   where event_type = 'schedule.published' and payload_jsonb ->> 'sourceId' = '62b00000-0000-0000-0000-000000000001';
  -- Alice, Bob and Carol hold live assignments in the published period.
  if v_jobs <> 3 or v_distinct <> 3 then
    raise exception 'SSS FAIL (4): expected 3 publish notification jobs (one per assigned employee), got % rows / % recipients', v_jobs, v_distinct;
  end if;
  if exists (
    select 1 from notification_jobs
    where event_type = 'schedule.published' and payload_jsonb ->> 'sourceId' = '62b00000-0000-0000-0000-000000000001'
      and dedupe_key is not null
  ) then
    raise exception 'SSS FAIL (4): a publish job carries a dedupe_key (it must be null: no caller-influenced key)';
  end if;
  -- Facility B's assignee (none) and non-assigned employees never get one.
  if exists (
    select 1 from notification_jobs
    where event_type = 'schedule.published' and payload_jsonb ->> 'sourceId' = '62b00000-0000-0000-0000-000000000001'
      and payload_jsonb -> 'recipients' ->> 0 = '62e00000-0000-0000-0000-0000000000b1'
  ) then
    raise exception 'SSS FAIL (4): a facility B employee was notified of a facility A publication';
  end if;
end;
$$;

-- The definer-written schedule jobs never carry a key; and the unchanged
-- 0058 trigger still overwrites a caller-chosen key (incident behaviour).
do $$
declare
  v_key text;
begin
  insert into notification_jobs (facility_id, event_type, dedupe_key, payload_jsonb)
  values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'schedule.swap_decided', 'attacker-chosen',
          jsonb_build_object('sourceId', '62b00000-0000-0000-0000-0000000000ee', 'recipients', jsonb_build_array('62e00000-0000-0000-0000-000000000001')))
  returning dedupe_key into v_key;
  if v_key = 'attacker-chosen' then
    raise exception 'SSS FAIL (4): a caller-chosen dedupe_key survived';
  end if;
  insert into notification_jobs (facility_id, event_type, dedupe_key, payload_jsonb)
  values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'incident.submitted', 'attacker-chosen',
          jsonb_build_object('incidentId', 'inc-1', 'recipients', jsonb_build_array('emp-1')))
  returning dedupe_key into v_key;
  if v_key <> '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:incident.submitted:inc-1:n/a:emp-1' then
    raise exception 'SSS FAIL (4): incident dedupe_key behaviour changed (%)', v_key;
  end if;
end;
$$;

-- ===========================================================================
-- 5. Self-service as Alice (plain member, no schedule permission at all).
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

-- 5a. Alice sees her own published assignments and the published open shifts,
-- but not draft-period shifts and not facility B.
do $$
begin
  if not exists (select 1 from shift_assignments where id = '62a00000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (5a): Alice cannot read her own published assignment';
  end if;
  if exists (select 1 from shift_assignments where id = '62a00000-0000-0000-0000-000000000002') then
    raise exception 'SSS FAIL (5a): Alice can read Bob''s assignment without schedule.read';
  end if;
  if not exists (select 1 from schedule_shifts where id = '62500000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (5a): Alice cannot read a published open shift';
  end if;
  if not exists (select 1 from schedule_shifts where id = '62510000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (5a): Alice cannot read the shift she is assigned to';
  end if;
  if exists (select 1 from schedule_shifts where id = '62500000-0000-0000-0000-000000000004') then
    raise exception 'SSS FAIL (5a): Alice can read an open shift of a DRAFT period';
  end if;
  if exists (select 1 from schedule_shifts where id = '62510000-0000-0000-0000-000000000002') then
    raise exception 'SSS FAIL (5a): Alice can read a colleague''s assigned shift';
  end if;
  if exists (select 1 from schedule_shifts where id = '62500000-0000-0000-0000-0000000000b1') then
    raise exception 'SSS FAIL (5a): Alice can read facility B''s open shift';
  end if;
end;
$$;

-- 5b. Alice files claims on shifts 1, 2, 5, 6; time off; swaps; availability.
insert into open_shift_claims (id, facility_id, shift_id, claimant_employee_id) values
  ('62d00000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000001'),
  ('62d00000-0000-0000-0000-000000000005', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000005', '62e00000-0000-0000-0000-000000000001'),
  ('62d00000-0000-0000-0000-000000000006', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000006', '62e00000-0000-0000-0000-000000000001'),
  ('62d00000-0000-0000-0000-000000000009', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000008', '62e00000-0000-0000-0000-000000000001');

-- 5c. Alice cannot create a claim for Bob, cannot pre-decide, cannot inject a
-- facility-B shift into her facility-A claim.
do $$
begin
  begin
    insert into open_shift_claims (facility_id, shift_id, claimant_employee_id)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000003', '62e00000-0000-0000-0000-000000000002');
    raise exception 'SSS FAIL (5c): Alice created a claim on Bob''s behalf';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into open_shift_claims (facility_id, shift_id, claimant_employee_id, claim_status, decided_at)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000003', '62e00000-0000-0000-0000-000000000001', 'approved', now());
    raise exception 'SSS FAIL (5c): Alice created an already-approved claim';
  exception when check_violation or insufficient_privilege then null;
  end;
  begin
    insert into open_shift_claims (facility_id, shift_id, claimant_employee_id)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-0000000000b1', '62e00000-0000-0000-0000-000000000001');
    raise exception 'SSS FAIL (5c): cross-facility shift injection into a claim was accepted';
  exception when check_violation or insufficient_privilege then null;
  end;
  -- Guards (check_violation): draft-period shift, already-assigned shift.
  begin
    insert into open_shift_claims (facility_id, shift_id, claimant_employee_id)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000004', '62e00000-0000-0000-0000-000000000001');
    raise exception 'SSS FAIL (5c): a claim on a draft-period shift was accepted';
  exception when check_violation or insufficient_privilege then null;
  end;
  -- A second live claim on the same shift is a unique violation.
  begin
    insert into open_shift_claims (facility_id, shift_id, claimant_employee_id)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000001');
    raise exception 'SSS FAIL (5c): a duplicate live claim was accepted';
  exception when unique_violation then null;
  end;
end;
$$;

-- 5d. Swaps: direct (AW1 <-> AW2), drop to Carol (AW3), drop to open (AW4),
-- cert-gated direct (AW5 <-> AW6), stale (AW7 drop), overlap (AW8 -> Carol).
insert into shift_swap_requests (id, facility_id, offered_assignment_id, requested_assignment_id, requester_employee_id, target_employee_id, swap_type, reason) values
  ('62d10000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000001', '62a00000-0000-0000-0000-000000000002', '62e00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000002', 'direct', 'family event'),
  ('62d10000-0000-0000-0000-000000000005', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000005', '62a00000-0000-0000-0000-000000000006', '62e00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000002', 'direct', 'prefer afternoon');
insert into shift_swap_requests (id, facility_id, offered_assignment_id, requester_employee_id, target_employee_id, swap_type) values
  ('62d10000-0000-0000-0000-000000000003', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000003', '62e00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000003', 'drop_pickup'),
  ('62d10000-0000-0000-0000-000000000007', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000007', '62e00000-0000-0000-0000-000000000001', null, 'drop_pickup'),
  ('62d10000-0000-0000-0000-000000000008', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000008', '62e00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000003', 'drop_pickup'),
  ('62d10000-0000-0000-0000-000000000004', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000004', '62e00000-0000-0000-0000-000000000001', null, 'drop_pickup');

do $$
begin
  -- Cannot offer someone else's assignment.
  begin
    insert into shift_swap_requests (facility_id, offered_assignment_id, requester_employee_id, swap_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000002', '62e00000-0000-0000-0000-000000000001', 'drop_pickup');
    raise exception 'SSS FAIL (5d): Alice offered Bob''s assignment';
  exception when check_violation or insufficient_privilege then null;
  end;
  -- Cannot request a swap as Bob.
  begin
    insert into shift_swap_requests (facility_id, offered_assignment_id, requester_employee_id, swap_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000002', '62e00000-0000-0000-0000-000000000002', 'drop_pickup');
    raise exception 'SSS FAIL (5d): Alice created a swap request as Bob';
  exception when insufficient_privilege then null;
  end;
  -- Cross-facility FK injection: facility-B employee as target.
  begin
    insert into shift_swap_requests (facility_id, offered_assignment_id, requester_employee_id, target_employee_id, swap_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-0000000000b1', 'drop_pickup');
    raise exception 'SSS FAIL (5d): cross-facility target injection was accepted';
  exception when check_violation or insufficient_privilege then null;
  end;
  -- A second pending swap on the same offered assignment is a unique violation.
  begin
    insert into shift_swap_requests (facility_id, offered_assignment_id, requester_employee_id, swap_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62a00000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000001', 'drop_pickup');
    raise exception 'SSS FAIL (5d): duplicate pending swap on one assignment was accepted';
  exception when unique_violation then null;
  end;
end;
$$;

-- 5e. Time off + availability.
insert into time_off_requests (id, facility_id, employee_id, starts_at, ends_at, request_type, reason) values
  ('62d20000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', '2035-04-01T00:00:00Z', '2035-04-04T00:00:00Z', 'vacation', 'trip'),
  ('62d20000-0000-0000-0000-000000000002', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', '2035-05-01T00:00:00Z', '2035-05-02T00:00:00Z', 'sick', null),
  ('62d20000-0000-0000-0000-000000000003', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', '2035-06-01T00:00:00Z', '2035-06-02T00:00:00Z', 'other', null);
insert into employee_availability (id, facility_id, employee_id, weekday, available_start_local, available_end_local, effective_from) values
  ('62d30000-0000-0000-0000-000000000001', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', 3, '10:00', '14:00', '2030-01-01');

do $$
begin
  begin
    insert into time_off_requests (facility_id, employee_id, starts_at, ends_at, request_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000002', '2035-04-01T00:00:00Z', '2035-04-02T00:00:00Z', 'vacation');
    raise exception 'SSS FAIL (5e): Alice filed time off for Bob';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into time_off_requests (facility_id, employee_id, starts_at, ends_at, request_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-0000000000b1', '2035-04-01T00:00:00Z', '2035-04-02T00:00:00Z', 'vacation');
    raise exception 'SSS FAIL (5e): cross-facility employee injection in time off was accepted';
  exception when check_violation or insufficient_privilege then null;
  end;
  begin
    insert into time_off_requests (facility_id, employee_id, starts_at, ends_at, request_type)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', '2035-04-05T00:00:00Z', '2035-04-04T00:00:00Z', 'vacation');
    raise exception 'SSS FAIL (5e): a backwards time-off window was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into employee_availability (facility_id, employee_id, weekday, unavailable, effective_from)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000002', 1, true, '2030-01-01');
    raise exception 'SSS FAIL (5e): Alice wrote Bob''s availability';
  exception when insufficient_privilege then null;
  end;
  begin
    update employee_availability set employee_id = '62e00000-0000-0000-0000-000000000002'
     where id = '62d30000-0000-0000-0000-000000000001';
    raise exception 'SSS FAIL (5e): Alice re-pointed her availability row at Bob';
  exception when insufficient_privilege or check_violation then null;
  end;
end;
$$;

-- 5f. Alice cannot decide anything herself: not by direct UPDATE...
do $$
declare
  v_n integer;
begin
  begin
    update open_shift_claims set claim_status = 'approved', decided_at = now()
     where id = '62d00000-0000-0000-0000-000000000005';
    raise exception 'SSS FAIL (5f): Alice approved her own claim by direct UPDATE';
  exception when check_violation or insufficient_privilege then null;
  end;
  begin
    update shift_swap_requests set status = 'approved', decided_at = now()
     where id = '62d10000-0000-0000-0000-000000000003';
    raise exception 'SSS FAIL (5f): Alice approved her own swap by direct UPDATE';
  exception when check_violation or insufficient_privilege then null;
  end;
  begin
    update time_off_requests set status = 'approved', decided_at = now()
     where id = '62d20000-0000-0000-0000-000000000002';
    raise exception 'SSS FAIL (5f): Alice approved her own time off by direct UPDATE';
  exception when check_violation or insufficient_privilege then null;
  end;
  -- ...nor by the RPCs (no approver code).
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'approve', null);
    raise exception 'SSS FAIL (5f): Alice approved a claim through the RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000003', 'approve', null);
    raise exception 'SSS FAIL (5f): Alice approved a swap through the RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'approve', null);
    raise exception 'SSS FAIL (5f): Alice approved time off through the RPC';
  exception when insufficient_privilege then null;
  end;
  -- Alice CAN withdraw her own pending claim and cancel her own time off.
  update open_shift_claims set claim_status = 'withdrawn' where id = '62d00000-0000-0000-0000-000000000009';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SSS FAIL (5f): Alice could not withdraw her own pending claim';
  end if;
  update time_off_requests set status = 'cancelled' where id = '62d20000-0000-0000-0000-000000000003';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SSS FAIL (5f): Alice could not cancel her own pending time off';
  end if;
  -- A withdrawn claim is terminal (no re-open).
  update open_shift_claims set claim_status = 'pending' where id = '62d00000-0000-0000-0000-000000000009';
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'SSS FAIL (5f): a withdrawn claim was re-opened';
  end if;
end;
$$;
reset role;

-- ===========================================================================
-- 6. Bob and the read policies.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from open_shift_claims where id = '62d00000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): Bob can read Alice''s claim';
  end if;
  if exists (select 1 from shift_swap_requests where id = '62d10000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): Bob (target) can read Alice''s swap request';
  end if;
  if exists (select 1 from time_off_requests where id = '62d20000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): Bob can read Alice''s time off';
  end if;
  if exists (select 1 from employee_availability where id = '62d30000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): Bob can read Alice''s availability';
  end if;
end;
$$;
-- Bob competes for shift 1 (becomes Alice's auto-denied sibling later) and
-- for the cert-gated shift 2 (he lacks the certification).
insert into open_shift_claims (id, facility_id, shift_id, claimant_employee_id) values
  ('62d00000-0000-0000-0000-0000000000b1', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000001', '62e00000-0000-0000-0000-000000000002'),
  ('62d00000-0000-0000-0000-0000000000b2', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000002', '62e00000-0000-0000-0000-000000000002'),
  ('62d00000-0000-0000-0000-0000000000b3', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000003', '62e00000-0000-0000-0000-000000000002');
reset role;

-- Window scenario: shift 3 (Bob's claim above was inside the window). Age the
-- window on shift 5... (Alice's claim already exists) -- instead prove the
-- window on a brand-new claimant attempt: age shift 3's opened_at, then Carol
-- (no login) cannot be used, so use Alice.
alter table schedule_shifts disable trigger schedule_shifts_opened_at;
update schedule_shifts set opened_at = now() - interval '72 hours' where id = '62500000-0000-0000-0000-000000000003';
alter table schedule_shifts enable trigger schedule_shifts_opened_at;

select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into open_shift_claims (facility_id, shift_id, claimant_employee_id)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62500000-0000-0000-0000-000000000003', '62e00000-0000-0000-0000-000000000001');
    raise exception 'SSS FAIL (6): a claim outside the 48h claim window was accepted';
  exception when check_violation then null;
  end;
end;
$$;
reset role;

-- Read-side as managers.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  -- schedule.manage: reads claims + swaps + time off (read only for the last).
  if not exists (select 1 from open_shift_claims where id = '62d00000-0000-0000-0000-000000000001')
     or not exists (select 1 from shift_swap_requests where id = '62d10000-0000-0000-0000-000000000001')
     or not exists (select 1 from time_off_requests where id = '62d20000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): schedule.manage cannot read the request queues';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a8","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from open_shift_claims) or exists (select 1 from shift_swap_requests) or exists (select 1 from time_off_requests) then
    raise exception 'SSS FAIL (6): a schedule.read-only member can read request rows';
  end if;
  if not exists (select 1 from employee_availability where id = '62d30000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): schedule.read cannot read availability';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from time_off_requests) or exists (select 1 from open_shift_claims where id = '62d00000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): the swaps-only approver can read time off or claims';
  end if;
  if not exists (select 1 from shift_swap_requests where id = '62d10000-0000-0000-0000-000000000001') then
    raise exception 'SSS FAIL (6): the swaps approver cannot read swap requests';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a7","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from open_shift_claims) or exists (select 1 from shift_swap_requests) or exists (select 1 from time_off_requests) then
    raise exception 'SSS FAIL (6): a facility B manager can read facility A request rows';
  end if;
end;
$$;
reset role;

-- ===========================================================================
-- 7. Guards, exercised as the table owner (RLS bypassed -- the guard triggers
-- themselves must hold).
-- ===========================================================================
set local request.jwt.claims = '';
do $$
begin
  -- Decided status without the RPC marker.
  begin
    update open_shift_claims set claim_status = 'approved', decided_at = now() where id = '62d00000-0000-0000-0000-000000000005';
    raise exception 'SSS FAIL (7): Guard 9 (claim) did not reject a marker-less approval';
  exception when check_violation then null;
  end;
  begin
    update shift_swap_requests set status = 'approved', decided_at = now() where id = '62d10000-0000-0000-0000-000000000003';
    raise exception 'SSS FAIL (7): Guard 7 (swap) did not reject a marker-less approval';
  exception when check_violation then null;
  end;
  begin
    update time_off_requests set status = 'approved', decided_at = now() where id = '62d20000-0000-0000-0000-000000000002';
    raise exception 'SSS FAIL (7): Guard 6 (time off) did not reject a marker-less approval';
  exception when check_violation then null;
  end;
  -- A forged marker for a DIFFERENT row does not help.
  perform set_config('rr.schedule_decision', '62d00000-0000-0000-0000-000000000001', true);
  begin
    update open_shift_claims set claim_status = 'approved', decided_at = now() where id = '62d00000-0000-0000-0000-000000000005';
    raise exception 'SSS FAIL (7): a marker naming another row unlocked a decision';
  exception when check_violation then null;
  end;
  perform set_config('rr.schedule_decision', '', true);
  -- Terminal states: withdrawn -> pending, cancelled -> approved.
  begin
    update open_shift_claims set claim_status = 'pending' where id = '62d00000-0000-0000-0000-000000000009';
    raise exception 'SSS FAIL (7): Guard 8 allowed withdrawn -> pending';
  exception when check_violation then null;
  end;
  begin
    update time_off_requests set status = 'approved', decided_at = now() where id = '62d20000-0000-0000-0000-000000000003';
    raise exception 'SSS FAIL (7): Guard 5 allowed cancelled -> approved';
  exception when check_violation then null;
  end;
  -- Identity columns.
  begin
    update open_shift_claims set shift_id = '62500000-0000-0000-0000-000000000003' where id = '62d00000-0000-0000-0000-000000000005';
    raise exception 'SSS FAIL (7): Guard 7 allowed re-pointing a claim at another shift';
  exception when check_violation then null;
  end;
  begin
    update shift_swap_requests set target_employee_id = '62e00000-0000-0000-0000-000000000002' where id = '62d10000-0000-0000-0000-000000000003';
    raise exception 'SSS FAIL (7): Guard 5 allowed changing a swap target';
  exception when check_violation then null;
  end;
  begin
    update time_off_requests set ends_at = ends_at + interval '30 days' where id = '62d20000-0000-0000-0000-000000000002';
    raise exception 'SSS FAIL (7): Guard 4 allowed extending a time-off window';
  exception when check_violation then null;
  end;
  begin
    update open_shift_claims set deleted_at = now() where id = '62d00000-0000-0000-0000-000000000005';
    raise exception 'SSS FAIL (7): a claim was soft-deleted';
  exception when check_violation then null;
  end;
  -- Insert-time decision data.
  begin
    insert into time_off_requests (facility_id, employee_id, starts_at, ends_at, request_type, status, decided_at)
    values ('62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', '2035-07-01', '2035-07-02', 'other', 'approved', now());
    raise exception 'SSS FAIL (7): Guard 1 allowed an insert born approved';
  exception when check_violation then null;
  end;
  -- Availability identity.
  begin
    update employee_availability set facility_id = '62bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where id = '62d30000-0000-0000-0000-000000000001';
    raise exception 'SSS FAIL (7): availability was re-pointed at another facility';
  exception when check_violation then null;
  end;
end;
$$;

-- ===========================================================================
-- 8. Approvals: wrong role, missing reason, invalid decision.
-- ===========================================================================
-- timeoff-only approver cannot decide claims or swaps; swaps-only cannot
-- decide claims or time off; manage-only cannot decide time off; the facility
-- B manager cannot decide facility A rows at all.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'approve', null);
    raise exception 'SSS FAIL (8): the time-off approver decided a claim';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000003', 'approve', null);
    raise exception 'SSS FAIL (8): the time-off approver decided a swap';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'approve', null);
    raise exception 'SSS FAIL (8): the swaps approver decided a claim';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'approve', null);
    raise exception 'SSS FAIL (8): the swaps approver decided time off';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'approve', null);
    raise exception 'SSS FAIL (8): schedule.manage alone decided time off';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'deny', 'no');
    raise exception 'SSS FAIL (8): schedule.manage alone denied time off';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a7","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'approve', null);
    raise exception 'SSS FAIL (8): a facility B manager decided a facility A claim';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000003', 'approve', null);
    raise exception 'SSS FAIL (8): a facility B manager decided a facility A swap';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'approve', null);
    raise exception 'SSS FAIL (8): a facility B manager decided facility A time off';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- Full manager: invalid decision / missing reason / unknown request.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'maybe', null);
    raise exception 'SSS FAIL (8): an unknown decision was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'deny', null);
    raise exception 'SSS FAIL (8): a claim denial without a reason was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000003', 'deny', '   ');
    raise exception 'SSS FAIL (8): a swap denial with a blank reason was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'deny', null);
    raise exception 'SSS FAIL (8): a time-off denial without a reason was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-0000000000ff', 'approve', null);
    raise exception 'SSS FAIL (8): an unknown claim id was accepted';
  exception when no_data_found then null;
  end;
end;
$$;
reset role;

-- Nothing above may have changed a row.
do $$
begin
  if exists (select 1 from open_shift_claims where claim_status in ('approved', 'denied'))
     or exists (select 1 from shift_swap_requests where status in ('approved', 'denied'))
     or exists (select 1 from time_off_requests where status in ('approved', 'denied')) then
    raise exception 'SSS FAIL (8): a rejected decision attempt mutated a request';
  end if;
end;
$$;

-- ===========================================================================
-- 9. Claim approval (SC-11).
-- ===========================================================================
-- 9a. Cert-gated claim (Bob lacks the certification) is blocked while the
-- facility mode is hard-block, approved with a warning in 'warning' mode.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-0000000000b2', 'approve', null);
    raise exception 'SSS FAIL (9a): a claim by an uncertified employee was approved in hard-block mode';
  exception when sqlstate 'PT409' then null;
  end;
end;
$$;
reset role;
do $$
begin
  if (select claim_status from open_shift_claims where id = '62d00000-0000-0000-0000-0000000000b2') <> 'pending'
     or exists (select 1 from shift_assignments where shift_id = '62500000-0000-0000-0000-000000000002') then
    raise exception 'SSS FAIL (9a): the blocked approval left partial writes behind';
  end if;
end;
$$;

insert into facility_module_overrides (facility_id, module_id, config_patch_jsonb)
select '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', m.id, '{"scheduling.certEnforcementMode":"warning"}'::jsonb
from modules m where m.code = 'scheduling'
on conflict (facility_id, module_id) do update set config_patch_jsonb = excluded.config_patch_jsonb;

select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.decide_open_shift_claim('62d00000-0000-0000-0000-0000000000b2', 'approve', 'covered by training plan');
  if (v_result ->> 'decided') <> 'true' or jsonb_array_length(v_result -> 'warnings') <> 1
     or (v_result -> 'warnings' -> 0 ->> 'code') <> 'missing_certification' then
    raise exception 'SSS FAIL (9a): warning-mode approval returned %', v_result;
  end if;
end;
$$;
reset role;
delete from facility_module_overrides where facility_id = '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- 9b. Overlap: shift 6 overlaps Alice's assignment AO1 on shift 7 -> blocked.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000006', 'approve', null);
    raise exception 'SSS FAIL (9b): a claim creating a double booking was approved';
  exception when sqlstate 'PT409' or check_violation then null;
  end;
end;
$$;
reset role;

-- 9c. Stale: shift 5 was cancelled after the claim was filed.
update schedule_shifts set status = 'cancelled' where id = '62500000-0000-0000-0000-000000000005';
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000005', 'approve', null);
    raise exception 'SSS FAIL (9c): a claim on a cancelled shift was approved';
  exception when sqlstate 'PT409' then null;
  end;
end;
$$;
reset role;

-- 9d. Happy path with a competing claim: approve Alice on shift 1 (full
-- manager). Bob's competing claim is auto-denied, the assignment exists, the
-- shift is assigned, the audit trail and notifications landed.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000001', 'approve', null);
  if (v_result ->> 'decided') <> 'true' or (v_result ->> 'replay') <> 'false'
     or jsonb_array_length(v_result -> 'denied_claim_ids') <> 1 then
    raise exception 'SSS FAIL (9d): unexpected result %', v_result;
  end if;
end;
$$;
reset role;
do $$
declare
  v_audit integer;
  v_jobs integer;
begin
  if (select claim_status from open_shift_claims where id = '62d00000-0000-0000-0000-000000000001') <> 'approved'
     or (select manager_id from open_shift_claims where id = '62d00000-0000-0000-0000-000000000001') <> '62000000-0000-0000-0000-0000000000a3'
     or (select decided_at from open_shift_claims where id = '62d00000-0000-0000-0000-000000000001') is null then
    raise exception 'SSS FAIL (9d): the winning claim is not decided by the manager';
  end if;
  if (select claim_status from open_shift_claims where id = '62d00000-0000-0000-0000-0000000000b1') <> 'denied'
     or (select decision_reason from open_shift_claims where id = '62d00000-0000-0000-0000-0000000000b1') is null then
    raise exception 'SSS FAIL (9d): the competing claim was not auto-denied with a reason';
  end if;
  if not exists (
    select 1 from shift_assignments
    where shift_id = '62500000-0000-0000-0000-000000000001' and employee_id = '62e00000-0000-0000-0000-000000000001' and status = 'approved'
  ) or (select status from schedule_shifts where id = '62500000-0000-0000-0000-000000000001') <> 'assigned' then
    raise exception 'SSS FAIL (9d): assignment/shift state not written';
  end if;
  select count(*) into v_audit from audit_events
   where entity_table = 'open_shift_claims' and entity_id = '62d00000-0000-0000-0000-000000000001' and event_type = 'config.changed';
  if v_audit < 2 then
    raise exception 'SSS FAIL (9d): expected the claim''s insert + decision in audit_events, got % row(s)', v_audit;
  end if;
  select count(*) into v_jobs from notification_jobs
   where event_type = 'schedule.claim_decided'
     and payload_jsonb ->> 'sourceId' in ('62d00000-0000-0000-0000-000000000001', '62d00000-0000-0000-0000-0000000000b1');
  if v_jobs <> 2 then
    raise exception 'SSS FAIL (9d): expected 2 decision notifications (winner + loser), got %', v_jobs;
  end if;
end;
$$;

-- 9e. Replay: the same decision again is a no-op returning replay=true; the
-- opposite decision is a conflict.
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000001', 'approve', null);
  if (v_result ->> 'replay') <> 'true' or (v_result ->> 'decided') <> 'false' then
    raise exception 'SSS FAIL (9e): replay returned %', v_result;
  end if;
  begin
    perform public.decide_open_shift_claim('62d00000-0000-0000-0000-000000000001', 'deny', 'changed my mind');
    raise exception 'SSS FAIL (9e): an approved claim was denied afterwards';
  exception when sqlstate 'PT409' then null;
  end;
  -- Denying the already-auto-denied sibling again is also a replay.
  v_result := public.decide_open_shift_claim('62d00000-0000-0000-0000-0000000000b1', 'deny', 'again');
  if (v_result ->> 'replay') <> 'true' then
    raise exception 'SSS FAIL (9e): sibling deny replay returned %', v_result;
  end if;
end;
$$;
reset role;
do $$
begin
  if (select count(*) from shift_assignments where shift_id = '62500000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'SSS FAIL (9e): replay duplicated the assignment';
  end if;
  if (select count(*) from notification_jobs where event_type = 'schedule.claim_decided'
        and payload_jsonb ->> 'sourceId' in ('62d00000-0000-0000-0000-000000000001', '62d00000-0000-0000-0000-0000000000b1')) <> 2 then
    raise exception 'SSS FAIL (9e): replay duplicated a notification';
  end if;
  if (select decision_reason from open_shift_claims where id = '62d00000-0000-0000-0000-0000000000b1') = 'again' then
    raise exception 'SSS FAIL (9e): replay overwrote the stored denial reason';
  end if;
end;
$$;

-- 9f. A manage.open_shifts-only style path: schedule.manage (manager role d4)
-- satisfies claim approval (deny here, a reason is required).
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.decide_open_shift_claim('62d00000-0000-0000-0000-0000000000b3', 'deny', 'Shift needs a certified guard');
  if (v_result ->> 'decided') <> 'true' then
    raise exception 'SSS FAIL (9f): schedule.manage could not deny a claim: %', v_result;
  end if;
end;
$$;
reset role;

-- ===========================================================================
-- 10. Swap approval (SC-12) as the swaps-only approver.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  -- 10a. Direct swap succeeds and exchanges both assignments atomically.
  v_result := public.decide_shift_swap('62d10000-0000-0000-0000-000000000001', 'approve', null);
  if (v_result ->> 'decided') <> 'true' or jsonb_array_length(v_result -> 'assignment_ids') <> 2 then
    raise exception 'SSS FAIL (10a): unexpected result %', v_result;
  end if;
  -- 10b. Replay.
  v_result := public.decide_shift_swap('62d10000-0000-0000-0000-000000000001', 'approve', null);
  if (v_result ->> 'replay') <> 'true' then
    raise exception 'SSS FAIL (10b): swap replay returned %', v_result;
  end if;
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000001', 'deny', 'nope');
    raise exception 'SSS FAIL (10b): an approved swap was denied afterwards';
  exception when sqlstate 'PT409' then null;
  end;
  -- 10c. Drop to Carol.
  v_result := public.decide_shift_swap('62d10000-0000-0000-0000-000000000003', 'approve', null);
  if (v_result ->> 'decided') <> 'true' then
    raise exception 'SSS FAIL (10c): drop-to-Carol failed: %', v_result;
  end if;
  -- 10d. Drop to the open pool reopens the shift.
  v_result := public.decide_shift_swap('62d10000-0000-0000-0000-000000000004', 'approve', null);
  if (v_result ->> 'decided') <> 'true' then
    raise exception 'SSS FAIL (10d): drop-to-open failed: %', v_result;
  end if;
  -- 10e. Cert-ineligible target (Bob lacks the certification the offered
  -- shift needs) is blocked.
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000005', 'approve', null);
    raise exception 'SSS FAIL (10e): a swap to an uncertified employee was approved';
  exception when sqlstate 'PT409' then null;
  end;
  -- 10f. Overlap: Carol already works an overlapping shift (AC1).
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000008', 'approve', null);
    raise exception 'SSS FAIL (10f): a swap creating a double booking was approved';
  exception when sqlstate 'PT409' then null;
  end;
end;
$$;
reset role;

do $$
begin
  -- 10a state.
  if not exists (select 1 from shift_assignments where id = '62a00000-0000-0000-0000-000000000001' and status = 'cancelled')
     or not exists (select 1 from shift_assignments where id = '62a00000-0000-0000-0000-000000000002' and status = 'cancelled') then
    raise exception 'SSS FAIL (10a): the swapped assignments were not cancelled';
  end if;
  if not exists (select 1 from shift_assignments where shift_id = '62510000-0000-0000-0000-000000000001' and employee_id = '62e00000-0000-0000-0000-000000000002' and status = 'approved')
     or not exists (select 1 from shift_assignments where shift_id = '62510000-0000-0000-0000-000000000002' and employee_id = '62e00000-0000-0000-0000-000000000001' and status = 'approved') then
    raise exception 'SSS FAIL (10a): the incoming assignments were not created';
  end if;
  if (select count(*) from shift_assignments where shift_id = '62510000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'SSS FAIL (10b): swap replay created extra assignments';
  end if;
  -- 10c / 10d state.
  if not exists (select 1 from shift_assignments where shift_id = '62510000-0000-0000-0000-000000000003' and employee_id = '62e00000-0000-0000-0000-000000000003' and status = 'approved') then
    raise exception 'SSS FAIL (10c): Carol was not assigned';
  end if;
  if (select status from schedule_shifts where id = '62510000-0000-0000-0000-000000000004') <> 'open'
     or (select opened_at from schedule_shifts where id = '62510000-0000-0000-0000-000000000004') is null then
    raise exception 'SSS FAIL (10d): the dropped shift was not reopened with an opened_at';
  end if;
  -- 10e / 10f left everything pending and untouched.
  if (select status from shift_swap_requests where id = '62d10000-0000-0000-0000-000000000005') <> 'pending'
     or (select status from shift_swap_requests where id = '62d10000-0000-0000-0000-000000000008') <> 'pending'
     or (select status from shift_assignments where id = '62a00000-0000-0000-0000-000000000005') <> 'approved' then
    raise exception 'SSS FAIL (10e/f): a blocked swap left partial writes behind';
  end if;
  -- Notifications: requester + target on 10a (2), requester on 10c (1) + target (1) + 10d (1).
  if (select count(*) from notification_jobs where event_type = 'schedule.swap_decided'
        and payload_jsonb ->> 'sourceId' = '62d10000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'SSS FAIL (10): the direct swap did not notify both parties exactly once';
  end if;
end;
$$;

-- 10g. Stale: the offered assignment is cancelled by someone else first.
update shift_assignments set status = 'cancelled' where id = '62a00000-0000-0000-0000-000000000007';
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  -- 62d1...07 is the stale drop (offered assignment AW7 now cancelled).
  begin
    perform public.decide_shift_swap('62d10000-0000-0000-0000-000000000007', 'approve', null);
    raise exception 'SSS FAIL (10g): a stale swap was approved';
  exception when sqlstate 'PT409' then null;
  end;
  -- A denial is still allowed and needs the reason.
  v_result := public.decide_shift_swap('62d10000-0000-0000-0000-000000000007', 'deny', 'assignment no longer exists');
  if (v_result ->> 'decided') <> 'true' then
    raise exception 'SSS FAIL (10g): deny of a stale swap failed: %', v_result;
  end if;
end;
$$;
reset role;

-- ===========================================================================
-- 11. Time-off approval (SC-13) as the time-off approver.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.decide_time_off_request('62d20000-0000-0000-0000-000000000001', 'approve', 'enjoy');
  if (v_result ->> 'decided') <> 'true' or (v_result -> 'request' ->> 'status') <> 'approved'
     or (v_result -> 'request' ->> 'decision_notes') <> 'enjoy' then
    raise exception 'SSS FAIL (11): approve returned %', v_result;
  end if;
  v_result := public.decide_time_off_request('62d20000-0000-0000-0000-000000000001', 'approve', null);
  if (v_result ->> 'replay') <> 'true' then
    raise exception 'SSS FAIL (11): time-off replay returned %', v_result;
  end if;
  v_result := public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'deny', 'short staffed');
  if (v_result ->> 'decided') <> 'true' then
    raise exception 'SSS FAIL (11): deny returned %', v_result;
  end if;
  begin
    perform public.decide_time_off_request('62d20000-0000-0000-0000-000000000002', 'approve', null);
    raise exception 'SSS FAIL (11): a denied request was approved afterwards';
  exception when sqlstate 'PT409' then null;
  end;
end;
$$;
reset role;

-- An approved FUTURE time-off can be cancelled by its employee; an approved
-- request that has already started cannot.
insert into time_off_requests (id, facility_id, employee_id, starts_at, ends_at, request_type) values
  ('62d20000-0000-0000-0000-0000000000a1', '62aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '62e00000-0000-0000-0000-000000000001', now() - interval '1 hour', now() + interval '2 hours', 'sick');
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
set local role authenticated;
select public.decide_time_off_request('62d20000-0000-0000-0000-0000000000a1', 'approve', null);
reset role;
select set_config('request.jwt.claims', '{"sub":"62000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_n integer;
begin
  update time_off_requests set status = 'cancelled' where id = '62d20000-0000-0000-0000-000000000001';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SSS FAIL (11): Alice could not cancel her approved future time off';
  end if;
  begin
    update time_off_requests set status = 'cancelled' where id = '62d20000-0000-0000-0000-0000000000a1';
    raise exception 'SSS FAIL (11): time off that already started was cancelled';
  exception when check_violation then null;
  end;
end;
$$;
reset role;

-- ===========================================================================
-- 12. Availability reads feed approvals as warnings only.
-- ===========================================================================
do $$
declare
  v_res jsonb;
begin
  -- Shift 3 is on 2035-03-07 (a Wednesday = weekday 3); Alice's rule allows
  -- 10:00-14:00 local, the shift runs 09:00Z-17:00Z (04:00-12:00 / 05:00-13:00
  -- New York) so it falls outside -> a warning, never a blocker.
  v_res := internal.fn_assignment_blockers('62e00000-0000-0000-0000-000000000001', '62500000-0000-0000-0000-000000000003', '{}');
  if jsonb_array_length(v_res -> 'blocking') <> 0 then
    raise exception 'SSS FAIL (12): availability produced a blocker: %', v_res;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_res -> 'warnings') w where w ->> 'code' = 'outside_availability') then
    raise exception 'SSS FAIL (12): no outside_availability warning: %', v_res;
  end if;
end;
$$;

rollback;
