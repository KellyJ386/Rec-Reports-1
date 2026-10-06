-- Verification intent: TR-09 / TR-10 / TR-11 (0066_training_automation.sql).
-- Covers:
--   1. training_assignment_rules RLS: a training.manage holder creates/updates
--      rules; a training.read employee reads but cannot write; another
--      facility's manager sees nothing and cannot reference this facility's
--      course/cert type/role (fn_assert_same_facility); the shape, gap_status
--      and identity-uniqueness constraints; the config audit trigger.
--   2. fn_training_assignment_rule_guard: a rule-sourced assignment must name
--      a real rule of its own facility whose type/course match, for an
--      employee/course of that facility -- proven under the service-role
--      stand-in (no JWT claims, RLS bypassed) so "never across facilities"
--      is a database invariant and not only an evaluator habit. Idempotent
--      via the existing (employee, course, source_type, source_ref_id) key.
--      Manual / incident_rule assignments are untouched.
--   3. TR-10: a training manager WITHOUT incidents.read can read pending
--      incident_training_triggers (additive policy) while a bare member
--      cannot; incident_training_trigger_conversions (UNIQUE(trigger_id), the
--      conversion guard, cross-facility rejection, employee denied).
--      0058's own two trigger policies and its three notification_jobs
--      policies are asserted unchanged (no widening).
--   4. TR-11 training_cert_notices: managers read, no authenticated writes,
--      the service role claims (unique per cert/kind/lead/expiry), the
--      facility guard, and the claim-revert delete path.
--   5. Function privileges for the definer trigger functions.
-- Runs inside a transaction that is rolled back, so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('66000000-0000-0000-0000-0000000000a1', 'ta-manager@test'),
  ('66000000-0000-0000-0000-0000000000a2', 'ta-employee@test'),
  ('66000000-0000-0000-0000-0000000000a3', 'ta-manager-b@test'),
  ('66000000-0000-0000-0000-0000000000a4', 'ta-bare-member@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('66000000-0000-0000-0000-0000000000a1', 'TA Manager', 'ta-manager@test'),
  ('66000000-0000-0000-0000-0000000000a2', 'TA Employee', 'ta-employee@test'),
  ('66000000-0000-0000-0000-0000000000a3', 'TA Manager B', 'ta-manager-b@test'),
  ('66000000-0000-0000-0000-0000000000a4', 'TA Bare Member', 'ta-bare-member@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('66111111-1111-1111-1111-111111111111', 'TA Org')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66111111-1111-1111-1111-111111111111', 'TA Facility A'),
  ('66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '66111111-1111-1111-1111-111111111111', 'TA Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('66c00000-0000-0000-0000-0000000000c1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TA Manager Role'),
  ('66c00000-0000-0000-0000-0000000000c2', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TA Employee Role'),
  ('66c00000-0000-0000-0000-0000000000c3', '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TA Manager B Role'),
  ('66c00000-0000-0000-0000-0000000000c4', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TA Bare Role')
on conflict (id) do nothing;

-- The bare role carries a permission that is NOT training.* so the member
-- belongs to the facility without any training or incident access.
insert into role_permissions (role_id, permission_code) values
  ('66c00000-0000-0000-0000-0000000000c1', 'training.manage'),
  ('66c00000-0000-0000-0000-0000000000c1', 'training.read'),
  ('66c00000-0000-0000-0000-0000000000c2', 'training.read'),
  ('66c00000-0000-0000-0000-0000000000c3', 'training.manage'),
  ('66c00000-0000-0000-0000-0000000000c3', 'training.read'),
  ('66c00000-0000-0000-0000-0000000000c4', 'reports.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('66d10000-0000-0000-0000-0000000000d1', '66000000-0000-0000-0000-0000000000a1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66c00000-0000-0000-0000-0000000000c1', 'active'),
  ('66d10000-0000-0000-0000-0000000000d2', '66000000-0000-0000-0000-0000000000a2', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66c00000-0000-0000-0000-0000000000c2', 'active'),
  ('66d10000-0000-0000-0000-0000000000d3', '66000000-0000-0000-0000-0000000000a3', '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '66c00000-0000-0000-0000-0000000000c3', 'active'),
  ('66d10000-0000-0000-0000-0000000000d4', '66000000-0000-0000-0000-0000000000a4', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66c00000-0000-0000-0000-0000000000c4', 'active')
on conflict (id) do nothing;

insert into employees (id, facility_id, user_id, first_name, last_name, status) values
  ('66e10000-0000-0000-0000-0000000000e1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66000000-0000-0000-0000-0000000000a2', 'Emp', 'One', 'active'),
  ('66e10000-0000-0000-0000-0000000000e2', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'Emp', 'Two', 'active'),
  ('66e10000-0000-0000-0000-0000000000e3', '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'Emp', 'B', 'active')
on conflict (id) do nothing;

insert into certification_types (id, facility_id, code, name) values
  ('66710000-0000-0000-0000-000000000001', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CPR', 'CPR'),
  ('66710000-0000-0000-0000-000000000002', '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CPR', 'CPR B')
on conflict (id) do nothing;

insert into courses (id, facility_id, code, title, status) values
  ('66f00000-0000-0000-0000-0000000000f1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TA-1', 'TA Course 1', 'published'),
  ('66f00000-0000-0000-0000-0000000000f2', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TA-2', 'TA Course 2', 'published'),
  ('66f00000-0000-0000-0000-0000000000f3', '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TA-B', 'TA Course B', 'published')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. training_assignment_rules RLS and constraints.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into training_assignment_rules (id, facility_id, rule_type, certification_type_id, course_id, due_days)
  values ('66a10000-0000-0000-0000-000000000001', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'certification',
    '66710000-0000-0000-0000-000000000001', '66f00000-0000-0000-0000-0000000000f1', 14);
  insert into training_assignment_rules (id, facility_id, rule_type, role_id, course_id)
  values ('66a10000-0000-0000-0000-000000000002', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'role',
    '66c00000-0000-0000-0000-0000000000c2', '66f00000-0000-0000-0000-0000000000f2');
  update training_assignment_rules set active = false where id = '66a10000-0000-0000-0000-000000000002';
  update training_assignment_rules set active = true where id = '66a10000-0000-0000-0000-000000000002';
exception
  when others then
    raise exception 'TA FAIL: manager could not manage rules: % %', sqlstate, sqlerrm;
end;
$$;

-- A rule referencing another facility's course / cert type / role is denied
-- by the WITH CHECK (fn_assert_same_facility on all three parents).
do $$
begin
  begin
    insert into training_assignment_rules (facility_id, rule_type, certification_type_id, course_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'certification',
      '66710000-0000-0000-0000-000000000001', '66f00000-0000-0000-0000-0000000000f3');
    raise exception 'TA FAIL: a rule pointing at another facility''s course was accepted';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into training_assignment_rules (facility_id, rule_type, certification_type_id, course_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'certification',
      '66710000-0000-0000-0000-000000000002', '66f00000-0000-0000-0000-0000000000f2');
    raise exception 'TA FAIL: a rule pointing at another facility''s cert type was accepted';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into training_assignment_rules (facility_id, rule_type, role_id, course_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'role',
      '66c00000-0000-0000-0000-0000000000c3', '66f00000-0000-0000-0000-0000000000f2');
    raise exception 'TA FAIL: a rule pointing at another facility''s role was accepted';
  exception
    when insufficient_privilege then null; -- expected
  end;
  -- shape / enum / uniqueness constraints
  begin
    insert into training_assignment_rules (facility_id, rule_type, course_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'role', '66f00000-0000-0000-0000-0000000000f2');
    raise exception 'TA FAIL: a role rule without a role was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin
    insert into training_assignment_rules (facility_id, rule_type, certification_type_id, course_id, gap_statuses)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'certification',
      '66710000-0000-0000-0000-000000000001', '66f00000-0000-0000-0000-0000000000f2', array['bogus']);
    raise exception 'TA FAIL: an unknown gap status was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin
    insert into training_assignment_rules (facility_id, rule_type, certification_type_id, course_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'certification',
      '66710000-0000-0000-0000-000000000001', '66f00000-0000-0000-0000-0000000000f1');
    raise exception 'TA FAIL: a duplicate rule was accepted';
  exception
    when unique_violation then null; -- expected
  end;
end;
$$;
reset role;

-- The audit trail captured rule changes.
do $$
begin
  if not exists (select 1 from audit_events where entity_table = 'training_assignment_rules') then
    raise exception 'TA FAIL: rule changes produced no config.changed audit events';
  end if;
end;
$$;

-- A training.read employee reads rules but cannot write them.
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from training_assignment_rules) <> 2 then
    raise exception 'TA FAIL: employee sees % rules, expected 2', (select count(*) from training_assignment_rules);
  end if;
  begin
    insert into training_assignment_rules (facility_id, rule_type, role_id, course_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'role', '66c00000-0000-0000-0000-0000000000c1', '66f00000-0000-0000-0000-0000000000f2');
    raise exception 'TA FAIL: an employee created a rule';
  exception
    when insufficient_privilege then null; -- expected
  end;
  update training_assignment_rules set active = false where id = '66a10000-0000-0000-0000-000000000001';
  if (select active from training_assignment_rules where id = '66a10000-0000-0000-0000-000000000001') is not true then
    raise exception 'TA FAIL: an employee deactivated a rule';
  end if;
end;
$$;
reset role;

-- Another facility's manager sees no rules, notices or conversions.
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from training_assignment_rules) <> 0 then
    raise exception 'TA FAIL: facility B''s manager can read facility A''s rules';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. fn_training_assignment_rule_guard under the service-role stand-in (no
-- JWT claims: auth.uid() is null, RLS bypassed -- the evaluator's position).
-- ---------------------------------------------------------------------------
do $$
begin
  -- the happy path: a role_rule assignment from rule 2 for an employee/course of facility A
  insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id, reason_code)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
    '66f00000-0000-0000-0000-0000000000f2', 'role_rule', '66a10000-0000-0000-0000-000000000002', 'auto_role_rule');
  -- the happy path for a certification_rule
  insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
    '66f00000-0000-0000-0000-0000000000f1', 'certification_rule', '66a10000-0000-0000-0000-000000000001');

  -- idempotency: the (employee, course, source_type, source_ref_id) key
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
      '66f00000-0000-0000-0000-0000000000f2', 'role_rule', '66a10000-0000-0000-0000-000000000002');
    raise exception 'TA FAIL: a duplicate rule assignment was accepted';
  exception
    when unique_violation then null; -- expected
  end;
  insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
    '66f00000-0000-0000-0000-0000000000f2', 'role_rule', '66a10000-0000-0000-0000-000000000002')
  on conflict (employee_id, course_id, source_type, source_ref_id) do nothing;
  if (select count(*) from training_assignments where source_type = 'role_rule') <> 1 then
    raise exception 'TA FAIL: ON CONFLICT DO NOTHING did not stay idempotent';
  end if;

  -- Guard 1: no rule id
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
      '66f00000-0000-0000-0000-0000000000f2', 'role_rule');
    raise exception 'TA FAIL: a role_rule assignment without a rule id was accepted';
  exception
    when check_violation then null; -- expected
  end;
  -- Guard 2: a rule id that does not exist
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
      '66f00000-0000-0000-0000-0000000000f2', 'role_rule', '66a1ffff-0000-0000-0000-000000000000');
    raise exception 'TA FAIL: an assignment naming a non-existent rule was accepted';
  exception
    when check_violation then null; -- expected
  end;
  -- Guard 2: a rule of ANOTHER facility
  insert into training_assignment_rules (id, facility_id, rule_type, role_id, course_id)
  values ('66a10000-0000-0000-0000-0000000000b1', '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'role',
    '66c00000-0000-0000-0000-0000000000c3', '66f00000-0000-0000-0000-0000000000f3');
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
      '66f00000-0000-0000-0000-0000000000f2', 'role_rule', '66a10000-0000-0000-0000-0000000000b1');
    raise exception 'TA FAIL: an assignment naming another facility''s rule was accepted';
  exception
    when check_violation then null; -- expected
  end;
  -- Guard 3: rule type / course mismatch
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
      '66f00000-0000-0000-0000-0000000000f2', 'certification_rule', '66a10000-0000-0000-0000-000000000002');
    raise exception 'TA FAIL: a certification_rule assignment naming a role rule was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
      '66f00000-0000-0000-0000-0000000000f1', 'role_rule', '66a10000-0000-0000-0000-000000000002');
    raise exception 'TA FAIL: an assignment for a course other than the rule''s course was accepted';
  exception
    when check_violation then null; -- expected
  end;
  -- Guard 4: an employee of another facility
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e3',
      '66f00000-0000-0000-0000-0000000000f2', 'role_rule', '66a10000-0000-0000-0000-000000000002');
    raise exception 'TA FAIL: a rule assignment for another facility''s employee was accepted';
  exception
    when check_violation then null; -- expected
  end;
  -- Manual assignments are untouched by the guard.
  insert into training_assignments (facility_id, employee_id, course_id, source_type)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
    '66f00000-0000-0000-0000-0000000000f1', 'manual');
end;
$$;

-- A signed-in manager cannot forge a rule assignment either.
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e2',
      '66f00000-0000-0000-0000-0000000000f2', 'certification_rule', '66a1ffff-0000-0000-0000-000000000000');
    raise exception 'TA FAIL: a manager forged a rule-sourced assignment';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. TR-10: pending triggers + conversions.
-- ---------------------------------------------------------------------------
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('66b00000-0000-0000-0000-0000000000b1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-TA-1', 'incident', 'under_review', 'high', now(), 'Deck', 'Slip on deck')
on conflict (id) do nothing;

insert into incident_training_triggers (id, facility_id, incident_id, employee_id, target, reason) values
  ('66b10000-0000-0000-0000-0000000000b1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b00000-0000-0000-0000-0000000000b1',
    '66e10000-0000-0000-0000-0000000000e1', '{"certificationTypeId":"66710000-0000-0000-0000-000000000001"}'::jsonb, 'Refresh CPR'),
  ('66b10000-0000-0000-0000-0000000000b2', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b00000-0000-0000-0000-0000000000b1',
    '66e10000-0000-0000-0000-0000000000e2', '{"trainingModuleId":"66a1aaaa-0000-0000-0000-000000000000"}'::jsonb, 'Second trigger')
on conflict (id) do nothing;

-- The training manager (no incidents.* permission at all) can read triggers.
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from incident_training_triggers) <> 2 then
    raise exception 'TA FAIL: training manager sees % triggers, expected 2', (select count(*) from incident_training_triggers);
  end if;
  -- ...but still cannot write one (0058's insert policy needs incidents.manage/review).
  begin
    insert into incident_training_triggers (facility_id, incident_id, employee_id, reason)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b00000-0000-0000-0000-0000000000b1', '66e10000-0000-0000-0000-0000000000e1', 'forged');
    raise exception 'TA FAIL: a training manager created an incident training trigger';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- Convert trigger 1: create the incident_rule assignment, then the conversion.
do $$
begin
  insert into training_assignments (id, facility_id, employee_id, course_id, source_type, source_ref_id, assigned_by, reason_code)
  values ('66a60000-0000-0000-0000-000000000001', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
    '66f00000-0000-0000-0000-0000000000f1', 'incident_rule', '66b10000-0000-0000-0000-0000000000b1',
    '66000000-0000-0000-0000-0000000000a1', 'incident_training_trigger');
  insert into incident_training_trigger_conversions (facility_id, trigger_id, assignment_id, converted_by)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b10000-0000-0000-0000-0000000000b1',
    '66a60000-0000-0000-0000-000000000001', '66000000-0000-0000-0000-0000000000a1');
exception
  when others then
    raise exception 'TA FAIL: manager could not convert a trigger: % %', sqlstate, sqlerrm;
end;
$$;

-- Idempotency: a second conversion row for the same trigger is a
-- unique_violation, and so is a second incident_rule assignment for it.
do $$
begin
  begin
    insert into incident_training_trigger_conversions (facility_id, trigger_id, assignment_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b10000-0000-0000-0000-0000000000b1', '66a60000-0000-0000-0000-000000000001');
    raise exception 'TA FAIL: a trigger was converted twice';
  exception
    when unique_violation then null; -- expected
  end;
  begin
    insert into training_assignments (facility_id, employee_id, course_id, source_type, source_ref_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
      '66f00000-0000-0000-0000-0000000000f1', 'incident_rule', '66b10000-0000-0000-0000-0000000000b1');
    raise exception 'TA FAIL: a duplicate incident_rule assignment was accepted';
  exception
    when unique_violation then null; -- expected
  end;
  -- Conversion guard: the assignment must be THIS trigger's incident_rule assignment.
  begin
    insert into incident_training_trigger_conversions (facility_id, trigger_id, assignment_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b10000-0000-0000-0000-0000000000b2', '66a60000-0000-0000-0000-000000000001');
    raise exception 'TA FAIL: a trigger was linked to another trigger''s assignment';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;
reset role;

-- The conversion is audited (fn_audit_admin_change -> audit_events), with the
-- acting manager recorded.
do $$
begin
  if not exists (
    select 1 from audit_events
    where entity_table = 'incident_training_trigger_conversions'
      and facility_id = '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and actor_user_id = '66000000-0000-0000-0000-0000000000a1'
  ) then
    raise exception 'TA FAIL: converting a trigger produced no audit event for the acting manager';
  end if;
end;
$$;

-- A bare member (no training/incident permission), an employee and facility
-- B's manager see no triggers and no conversions, and cannot convert.
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from incident_training_triggers) <> 0 or (select count(*) from incident_training_trigger_conversions) <> 0 then
    raise exception 'TA FAIL: a bare member can read triggers or conversions';
  end if;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from incident_training_trigger_conversions) <> 0 then
    raise exception 'TA FAIL: an employee can read trigger conversions';
  end if;
  begin
    insert into incident_training_trigger_conversions (facility_id, trigger_id, assignment_id)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66b10000-0000-0000-0000-0000000000b2', '66a60000-0000-0000-0000-000000000001');
    raise exception 'TA FAIL: an employee created a conversion';
  exception
    when insufficient_privilege or check_violation then null; -- expected
  end;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from incident_training_triggers) <> 0 or (select count(*) from incident_training_trigger_conversions) <> 0 then
    raise exception 'TA FAIL: facility B''s manager can read facility A''s triggers/conversions';
  end if;
  begin
    insert into incident_training_trigger_conversions (facility_id, trigger_id, assignment_id)
    values ('66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '66b10000-0000-0000-0000-0000000000b2', '66a60000-0000-0000-0000-000000000001');
    raise exception 'TA FAIL: facility B''s manager converted facility A''s trigger';
  exception
    when insufficient_privilege or check_violation then null; -- expected
  end;
end;
$$;
reset role;

-- 0058's incident-scoped policies are untouched; the notification_jobs
-- policy set is exactly 0006's + 0058's three (nothing widened by 0066).
do $$
begin
  if (select count(*) from pg_policies where tablename = 'incident_training_triggers') <> 3 then
    raise exception 'TA FAIL: expected exactly 3 policies on incident_training_triggers (0058 x2 + 0066 additive read)';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'incident_training_triggers'
                 and policyname = 'incident readers can read training triggers')
     or not exists (select 1 from pg_policies where tablename = 'incident_training_triggers'
                    and policyname = 'incident managers can create training triggers') then
    raise exception 'TA FAIL: a 0058 incident_training_triggers policy was lost';
  end if;
  if (select count(*) from pg_policies where tablename = 'notification_jobs') <> 3
     or not exists (select 1 from pg_policies where tablename = 'notification_jobs'
                    and policyname = 'incident actors can insert incident notification jobs'
                    and cmd = 'INSERT') then
    raise exception 'TA FAIL: the notification_jobs policy set changed (expected 0006 + 0058 x2 only)';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. TR-11 training_cert_notices.
-- ---------------------------------------------------------------------------
insert into employee_certifications (id, facility_id, employee_id, certification_type_id, expires_at, status) values
  ('66cc0000-0000-0000-0000-0000000000c1', '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66e10000-0000-0000-0000-0000000000e1',
    '66710000-0000-0000-0000-000000000001', current_date + 10, 'active')
on conflict (id) do nothing;

-- Service-role stand-in claims a notice; a duplicate claim is a conflict; the
-- claim can be reverted (deleted) and re-taken.
do $$
begin
  insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 14, current_date + 10);
  begin
    insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 14, current_date + 10);
    raise exception 'TA FAIL: a cert notice was claimed twice';
  exception
    when unique_violation then null; -- expected
  end;
  -- a different lead, a different kind, and a renewed expiry date are all distinct claims
  insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 7, current_date + 10);
  insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expired', 0, current_date + 10);
  insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 14, current_date + 400);
  -- revert (the evaluator's claim-revert path) and re-claim
  delete from training_cert_notices
  where employee_certification_id = '66cc0000-0000-0000-0000-0000000000c1' and notice_kind = 'expiring' and lead_days = 14
    and cert_expires_at = current_date + 10;
  insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
  values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 14, current_date + 10);
  -- the facility guard: a notice whose facility is not its certification's
  begin
    insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
    values ('66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 30, current_date + 10);
    raise exception 'TA FAIL: a cross-facility cert notice was accepted';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- A manager reads the ledger; nobody authenticated can write it.
select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from training_cert_notices) <> 4 then
    raise exception 'TA FAIL: manager sees % notices, expected 4', (select count(*) from training_cert_notices);
  end if;
  begin
    insert into training_cert_notices (facility_id, employee_certification_id, notice_kind, lead_days, cert_expires_at)
    values ('66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '66cc0000-0000-0000-0000-0000000000c1', 'expiring', 30, current_date + 10);
    raise exception 'TA FAIL: an authenticated manager wrote the cert notice ledger';
  exception
    when insufficient_privilege then null; -- expected: no insert policy
  end;
  delete from training_cert_notices;
  if (select count(*) from training_cert_notices) <> 4 then
    raise exception 'TA FAIL: an authenticated manager deleted cert notices';
  end if;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"66000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from training_cert_notices) <> 0 then
    raise exception 'TA FAIL: an employee can read the cert notice ledger';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 5. Function privileges.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'fn_training_assignment_rule_guard()', 'fn_trigger_conversion_guard()', 'fn_cert_notice_facility_guard()'
  ] loop
    if has_function_privilege('authenticated', 'public.' || v_fn, 'execute') then
      raise exception 'TA FAIL: authenticated can execute the definer trigger function %', v_fn;
    end if;
  end loop;
end;
$$;

rollback;
