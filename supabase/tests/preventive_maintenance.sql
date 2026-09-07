-- Proof for WO-17: RLS on the PM plans family (pm_plans, pm_plan_occurrences)
-- and the work_orders widening (source_type='pm', source_pm_plan_id/
-- source_pm_occurrence_id) added by 0061_preventive_maintenance.sql.
--
-- Covers:
--   1. A work_orders.read holder can SELECT pm_plans/pm_plan_occurrences.
--   2. A work_orders.manage holder can INSERT a pm_plans row.
--   3. A work_orders.read-only holder cannot INSERT a pm_plans row.
--   4. Cross-facility asset_id on a pm_plans INSERT is rejected
--      (fn_assert_same_facility, same shape as work_orders.asset_id).
--   5. Cross-facility isolation: a Facility A manager cannot see Facility B's
--      pm_plans/pm_plan_occurrences rows.
--   6. pm_plan_occurrences' UNIQUE(pm_plan_id, scheduled_for) rejects a
--      second occurrence row for the same plan+date (the idempotency
--      primitive WO-19's generation job relies on).
--   7. work_orders.source_type = 'pm' is now accepted (0061 widened the
--      check constraint), with source_pm_plan_id populated and guarded by
--      fn_assert_same_facility exactly like asset_id already was.
--   8. A cross-facility source_pm_plan_id on a work_orders INSERT is
--      rejected (the same-facility guard 0061 added to the existing
--      "work order managers can manage work orders" policy's WITH CHECK).
--
-- Runs inside begin/rollback so fixtures never persist.
begin;

insert into auth.users (id, email) values
  ('90111111-1111-1111-1111-111111111111', 'pm-manager@test'),
  ('90222222-2222-2222-2222-222222222222', 'pm-reader@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('90111111-1111-1111-1111-111111111111', 'PM Manager', 'pm-manager@test'),
  ('90222222-2222-2222-2222-222222222222', 'PM Reader', 'pm-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('90000000-0000-0000-0000-0000000000b0', 'PM Scope Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('90000000-0000-0000-0000-0000000000c0', '90000000-0000-0000-0000-0000000000b0', 'PM Facility A'),
  ('90000000-0000-0000-0000-0000000000c1', '90000000-0000-0000-0000-0000000000b0', 'PM Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('90000000-0000-0000-0000-0000000000d0', '90000000-0000-0000-0000-0000000000c0', 'PM Manager Role'),
  ('90000000-0000-0000-0000-0000000000d1', '90000000-0000-0000-0000-0000000000c0', 'PM Reader Role')
on conflict (id) do nothing;
-- The manager role carries BOTH codes, matching the real role catalog
-- (supabase/seed.sql pairs work_orders.manage with work_orders.read on
-- every seeded role that has either) -- required for a manage-only actor's
-- own INSERT to remain visible under pm_plans' SELECT policy, which (per
-- WO-17's spec) is gated on work_orders.read alone, not "for all" the way
-- the pre-existing work_orders table's manager policy is. A manage-without-
-- read role is not a real production shape for this module.
insert into role_permissions (role_id, permission_code) values
  ('90000000-0000-0000-0000-0000000000d0', 'work_orders.manage'),
  ('90000000-0000-0000-0000-0000000000d0', 'work_orders.read'),
  ('90000000-0000-0000-0000-0000000000d1', 'work_orders.read')
on conflict do nothing;

-- Both users are members of Facility A ONLY -- neither has any membership in
-- Facility B, so every Facility B check below is a pure isolation check.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('90000000-0000-0000-0000-0000000000e0', '90111111-1111-1111-1111-111111111111', '90000000-0000-0000-0000-0000000000c0', '90000000-0000-0000-0000-0000000000d0', 'active'),
  ('90000000-0000-0000-0000-0000000000e1', '90222222-2222-2222-2222-222222222222', '90000000-0000-0000-0000-0000000000c0', '90000000-0000-0000-0000-0000000000d1', 'active')
on conflict (id) do nothing;

-- Assets: one per facility, for the cross-facility asset_id guard checks.
insert into assets (id, facility_id, name, asset_tag, status) values
  ('90300000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000c0', 'Pool Pump A', 'PM-A-PUMP-1', 'active'),
  ('90300000-0000-0000-0000-0000000000b1', '90000000-0000-0000-0000-0000000000c1', 'Pool Pump B', 'PM-B-PUMP-1', 'active')
on conflict (id) do nothing;

-- Live PM plans: one per facility.
insert into pm_plans (id, facility_id, asset_id, title, description, cadence_type, interval_days, anchor_date) values
  ('90400000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000c0', '90300000-0000-0000-0000-0000000000a1', 'Pump service A', 'Quarterly service', 'interval', 90, '2026-01-01'),
  ('90400000-0000-0000-0000-0000000000b1', '90000000-0000-0000-0000-0000000000c1', '90300000-0000-0000-0000-0000000000b1', 'Pump service B', 'Quarterly service', 'interval', 90, '2026-01-01')
on conflict (id) do nothing;

-- Occurrence rows: one per facility's plan.
insert into pm_plan_occurrences (id, facility_id, pm_plan_id, scheduled_for) values
  ('90500000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000c0', '90400000-0000-0000-0000-0000000000a1', '2026-01-01'),
  ('90500000-0000-0000-0000-0000000000b1', '90000000-0000-0000-0000-0000000000c1', '90400000-0000-0000-0000-0000000000b1', '2026-01-01')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. A work_orders.read holder can SELECT pm_plans/pm_plan_occurrences.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from pm_plans where id = '90400000-0000-0000-0000-0000000000a1') then
    raise exception 'PM SCOPE FAIL: work_orders.read holder cannot read their own facility''s pm plan';
  end if;
  if not exists (select 1 from pm_plan_occurrences where id = '90500000-0000-0000-0000-0000000000a1') then
    raise exception 'PM SCOPE FAIL: work_orders.read holder cannot read their own facility''s pm plan occurrence';
  end if;
end;
$$;

-- 3. A work_orders.read-only holder cannot INSERT a pm_plans row.
do $$
begin
  begin
    insert into pm_plans (facility_id, title, cadence_type, interval_days, anchor_date)
    values ('90000000-0000-0000-0000-0000000000c0', 'Reader insert attempt', 'interval', 30, '2026-01-01');
    raise exception 'PM SCOPE FAIL: a work_orders.read holder inserted a pm_plans row';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 5. Cross-facility isolation: the Facility A manager cannot see Facility B's
-- pm_plans/pm_plan_occurrences rows.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  visible int;
begin
  select count(*) into visible from pm_plans where facility_id = '90000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'PM SCOPE FAIL: Facility A manager can read Facility B pm plans (% row(s))', visible;
  end if;

  select count(*) into visible from pm_plan_occurrences where facility_id = '90000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'PM SCOPE FAIL: Facility A manager can read Facility B pm plan occurrences (% row(s))', visible;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A work_orders.manage holder can INSERT a pm_plans row for their own
-- facility.
-- ---------------------------------------------------------------------------
do $$
declare
  new_id uuid;
begin
  insert into pm_plans (facility_id, title, cadence_type, interval_days, anchor_date)
  values ('90000000-0000-0000-0000-0000000000c0', 'Filter change', 'interval', 30, '2026-02-01')
  returning id into new_id;
  if new_id is null then
    raise exception 'PM SCOPE FAIL: a work_orders.manage holder could not insert a pm_plans row for their own facility';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-facility asset_id on a pm_plans INSERT is rejected
-- (fn_assert_same_facility).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into pm_plans (facility_id, asset_id, title, cadence_type, interval_days, anchor_date)
    values ('90000000-0000-0000-0000-0000000000c0', '90300000-0000-0000-0000-0000000000b1', 'Cross-tenant asset injection', 'interval', 30, '2026-01-01');
    raise exception 'PM SCOPE FAIL: Facility A manager attached a Facility B asset to a Facility A pm plan';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. pm_plan_occurrences' UNIQUE(pm_plan_id, scheduled_for) rejects a second
-- occurrence row for the same plan+date -- the idempotency primitive WO-19's
-- generation job relies on.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into pm_plan_occurrences (facility_id, pm_plan_id, scheduled_for)
    values ('90000000-0000-0000-0000-0000000000c0', '90400000-0000-0000-0000-0000000000a1', '2026-01-01');
    raise exception 'PM SCOPE FAIL: a duplicate (pm_plan_id, scheduled_for) occurrence row was inserted';
  exception
    when unique_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. work_orders.source_type = 'pm' is now accepted, with source_pm_plan_id
-- populated and guarded like asset_id already was.
-- ---------------------------------------------------------------------------
do $$
declare
  new_id uuid;
begin
  insert into work_orders (facility_id, source_type, source_pm_plan_id, title, description)
  values ('90000000-0000-0000-0000-0000000000c0', 'pm', '90400000-0000-0000-0000-0000000000a1', 'PM-generated work order', 'Quarterly pump service')
  returning id into new_id;
  if new_id is null then
    raise exception 'PM SCOPE FAIL: a work_orders.manage holder could not insert a source_type=pm work order';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. A cross-facility source_pm_plan_id on a work_orders INSERT is rejected.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into work_orders (facility_id, source_type, source_pm_plan_id, title, description)
    values ('90000000-0000-0000-0000-0000000000c0', 'pm', '90400000-0000-0000-0000-0000000000b1', 'Cross-tenant pm plan injection', 'should be blocked');
    raise exception 'PM SCOPE FAIL: a work_orders.manage holder attached a Facility B pm plan to a Facility A work order';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;
reset role;

rollback;
