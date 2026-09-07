-- Verification intent: 0038_rls_audit_hardening.sql (plans/RLS_AUDIT.md), the
-- schema-wide RLS audit. Every probe here was first run against the
-- PRE-0038 schema and observed to succeed (a confirmed finding) before this
-- migration closed it; see plans/RLS_AUDIT.md for the full list. Covers:
--   1. Class A: report_submission_attachments now has a working INSERT path
--      (was totally inert -- SELECT-only policy, matching the
--      message_receipts/employee_certifications/incident_amendments bug
--      class found earlier).
--   2. Class A: training_completions now has a working INSERT path (same
--      bug class). 0038's own policy for this ("training readers can insert
--      completions") gated on training.read alone, with no ownership check --
--      flagged in 0038's own comments and plans/RLS_AUDIT.md as a decision to
--      revisit. 0039_training_completion_ownership.sql has since replaced it
--      with a self-service-or-training.manage rule (mirroring 0036's
--      training_progress shape): a training.read holder may INSERT a
--      completion for their OWN training_assignments row (joined via
--      employees.user_id = auth.uid()) but not another employee's, while a
--      training.manage holder may record a completion for anyone. This test
--      asserts THAT (0039) shape, not 0038's superseded, ownership-free one --
--      see supabase/tests/training_completions.sql for the exhaustive version
--      of this same probe (self/other/manager/cross-facility/no-perm).
--   3. Class B (privilege escalation): memberships.role_id can no longer
--      name a role belonging to a DIFFERENT facility than the membership's
--      own claimed facility_id -- closing a path where an admin.manage
--      holder on Facility A could grant a user any other facility's role
--      (and every permission code attached to it) inside Facility A.
--   4. Class B (representative sample across the fix): department_id
--      (assets, work_orders), an employee_id reference (work_orders'
--      assigned_to_employee_id, the explicitly-named known-outstanding
--      gap), and an incident_reports child table (incident_escalations) can
--      no longer reference a row that belongs to a different facility than
--      the one the write claims.
--   5. Positive control: the exact same writes with SAME-facility
--      references still succeed -- 0038 must not have weakened any
--      legitimate write.
--   6. Incidental fix (not Class A/B): a department-scoped reports.read
--      member can now actually SELECT (and therefore INSERT ... RETURNING)
--      report_submissions rows for their own department -- report_templates'
--      version of this same policy was fixed in 0033/DR-11, but
--      report_submissions' own SELECT policy was missed.
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('38000000-0000-0000-0000-000000000a01', 'audit-actor-a@test'),
  ('38000000-0000-0000-0000-000000000a02', 'audit-victim@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('38000000-0000-0000-0000-000000000a01', 'Audit Actor A', 'audit-actor-a@test'),
  ('38000000-0000-0000-0000-000000000a02', 'Audit Victim', 'audit-victim@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('38000000-0000-0000-0000-0000000000b0', 'RLS Audit Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-0000000000b0', 'RLS Audit Facility A'),
  ('38000000-0000-0000-0000-0000000000c1', '38000000-0000-0000-0000-0000000000b0', 'RLS Audit Facility B')
on conflict (id) do nothing;

-- Actor A's role: every permission the probes below need, facility-wide, on
-- Facility A ONLY. No membership at all in Facility B.
insert into roles (id, facility_id, name) values
  ('38000000-0000-0000-0000-0000000000d0', '38000000-0000-0000-0000-0000000000c0', 'Audit Actor Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('38000000-0000-0000-0000-0000000000d0', 'admin.manage'),
  ('38000000-0000-0000-0000-0000000000d0', 'incidents.manage'),
  ('38000000-0000-0000-0000-0000000000d0', 'reports.create'),
  ('38000000-0000-0000-0000-0000000000d0', 'reports.read'),
  ('38000000-0000-0000-0000-0000000000d0', 'reports.submit'),
  ('38000000-0000-0000-0000-0000000000d0', 'training.read'),
  ('38000000-0000-0000-0000-0000000000d0', 'work_orders.manage')
on conflict do nothing;

-- A super-powerful role that lives ONLY in Facility B, used as the
-- cross-facility target for the memberships.role_id privilege-escalation
-- probe (finding 3).
insert into roles (id, facility_id, name) values
  ('38000000-0000-0000-0000-0000000000d1', '38000000-0000-0000-0000-0000000000c1', 'Facility B Super Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('38000000-0000-0000-0000-0000000000d1', 'incidents.legal_hold.manage'),
  ('38000000-0000-0000-0000-0000000000d1', 'incidents.export.pdf')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('38000000-0000-0000-0000-0000000000e0', '38000000-0000-0000-0000-000000000a01', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-0000000000d0', 'active')
on conflict (id) do nothing;

insert into departments (id, facility_id, name) values
  ('38000000-0000-0000-0000-000000000f00', '38000000-0000-0000-0000-0000000000c0', 'Audit Dept A'),
  ('38000000-0000-0000-0000-000000000f01', '38000000-0000-0000-0000-0000000000c1', 'Audit Dept B')
on conflict (id) do nothing;

-- Employee 1000's user_id is deliberately Actor A's own auth.users id -- the
-- training_completions self-service probe below (item 2) needs a real
-- employees.user_id = auth.uid() row for Actor A to own. Employee 1002 is a
-- second Facility A employee NOT owned by Actor A, used as the "another
-- employee's assignment" negative target for that same probe.
insert into employees (id, facility_id, department_id, user_id, employee_no, first_name, last_name) values
  ('38000000-0000-0000-0000-000000001000', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', '38000000-0000-0000-0000-000000000a01', 'RA-1', 'Facility', 'A'),
  ('38000000-0000-0000-0000-000000001001', '38000000-0000-0000-0000-0000000000c1', '38000000-0000-0000-0000-000000000f01', null, 'RB-1', 'Facility', 'B'),
  ('38000000-0000-0000-0000-000000001002', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', null, 'RA-2', 'Other', 'Employee')
on conflict (id) do nothing;

insert into assets (id, facility_id, name) values
  ('38000000-0000-0000-0000-000000001100', '38000000-0000-0000-0000-0000000000c0', 'Audit Asset A')
on conflict (id) do nothing;

insert into courses (id, facility_id, code, title, status) values
  ('38000000-0000-0000-0000-000000001200', '38000000-0000-0000-0000-0000000000c0', 'audit_course', 'Audit Course', 'published')
on conflict (id) do nothing;
insert into training_assignments (id, facility_id, employee_id, course_id) values
  ('38000000-0000-0000-0000-000000001300', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001000', '38000000-0000-0000-0000-000000001200'),
  ('38000000-0000-0000-0000-000000001301', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001002', '38000000-0000-0000-0000-000000001200')
on conflict (id) do nothing;

-- A second actor, holding training.manage (not just training.read) on
-- Facility A, used by the training_completions probe (item 2) to prove a
-- training.manage holder MAY record a completion for someone else's
-- assignment -- the supervisor-override branch of 0039's policy.
insert into auth.users (id, email) values
  ('38000000-0000-0000-0000-000000000a04', 'audit-training-mgr@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('38000000-0000-0000-0000-000000000a04', 'Audit Training Manager', 'audit-training-mgr@test')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('38000000-0000-0000-0000-0000000000d3', '38000000-0000-0000-0000-0000000000c0', 'Audit Training Manager Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('38000000-0000-0000-0000-0000000000d3', 'training.manage'),
  ('38000000-0000-0000-0000-0000000000d3', 'training.read')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('38000000-0000-0000-0000-0000000000e2', '38000000-0000-0000-0000-000000000a04', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-0000000000d3', 'active')
on conflict (id) do nothing;

insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('38000000-0000-0000-0000-000000001400', '38000000-0000-0000-0000-0000000000c0', 'RLS-AUDIT-INC-A', 'incident', 'submitted', 'low', now(), 'Facility A dock', 'Facility A seed incident'),
  ('38000000-0000-0000-0000-000000001401', '38000000-0000-0000-0000-0000000000c1', 'RLS-AUDIT-INC-B', 'incident', 'submitted', 'low', now(), 'Facility B dock', 'Facility B seed incident')
on conflict (id) do nothing;

insert into report_templates (id, facility_id, department_id, code, name, status, active_version) values
  ('38000000-0000-0000-0000-000000001500', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', 'audit_tpl', 'Audit Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('38000000-0000-0000-0000-000000001600', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001500', 1, '{"sections":[]}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '38000000-0000-0000-0000-000000001500' and active_version is null;

-- A draft report submission, owned by Actor A, for the Class A attachment probe.
insert into report_submissions (id, facility_id, department_id, template_id, template_version_id, report_date, status, submitted_by) values
  ('38000000-0000-0000-0000-000000001700', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', '38000000-0000-0000-0000-000000001500', '38000000-0000-0000-0000-000000001600', current_date, 'draft', '38000000-0000-0000-0000-000000000a01')
on conflict (id) do nothing;

-- ===========================================================================
-- Act as Actor A (Facility A only).
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"38000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. Class A: report_submission_attachments INSERT now works.
-- ---------------------------------------------------------------------------
do $$
declare
  new_id uuid;
begin
  -- storage_path must match the full canonical
  -- facilities/{facility}/{module}/{recordId}/{filename} shape (0041's
  -- fn_attachment_path_facility trigger, tightened by the H-1/L-1 fix, now
  -- checks the whole shape -- module included -- not just the facility
  -- prefix).
  insert into report_submission_attachments (facility_id, submission_id, field_key, storage_path, mime_type)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001700', 'attachment', 'facilities/38000000-0000-0000-0000-0000000000c0/reports/38000000-0000-0000-0000-000000001700/y.jpg', 'image/jpeg')
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: report_submission_attachments INSERT is still inert (0038 Class A fix did not apply)';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Class A: training_completions INSERT now works, per 0039's
-- self-service-or-training.manage shape. Actor A (training.read, no
-- training.manage, owns employees row 1000 via user_id) can complete their
-- OWN assignment (1300) but is denied completing employee 1002's assignment
-- (1301), which belongs to someone else.
-- ---------------------------------------------------------------------------
do $$
declare
  new_id uuid;
begin
  insert into training_completions (facility_id, assignment_id, completion_status)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001300', 'passed')
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: training_completions INSERT is still inert (0039 self-service fix did not apply)';
  end if;

  begin
    insert into training_completions (facility_id, assignment_id, completion_status)
    values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001301', 'passed');
    raise exception 'RLS AUDIT FAIL: a training.read-only holder completed another employee''s assignment (0039 ownership check did not apply)';
  exception
    when insufficient_privilege then null; -- expected: assignment 1301 belongs to employee 1002, not Actor A, and Actor A lacks training.manage
  end;
end;
$$;

reset role;

-- Training-manager override: a training.manage holder MAY record a
-- completion for someone else's assignment (the supervisor branch of 0039's
-- policy) -- here, employee 1002's assignment that Actor A was just denied.
select set_config('request.jwt.claims', '{"sub":"38000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  new_id uuid;
begin
  insert into training_completions (facility_id, assignment_id, completion_status)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001301', 'passed')
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: a training.manage holder was denied completing another employee''s assignment';
  end if;
end;
$$;

reset role;

-- Resume as Actor A for the remaining Class B probes below.
select set_config('request.jwt.claims', '{"sub":"38000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 4. Class B positive control: same-facility department_id/employee_id/
-- incident_id references still succeed.
-- ---------------------------------------------------------------------------
do $$
declare
  new_id uuid;
begin
  insert into assets (facility_id, department_id, name)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', 'same-facility asset')
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: same-facility assets.department_id insert was rejected';
  end if;

  insert into work_orders (facility_id, department_id, asset_id, assigned_to_employee_id, title, description)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', '38000000-0000-0000-0000-000000001100', '38000000-0000-0000-0000-000000001000', 'same-facility WO', 'x')
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: same-facility work_orders.department_id/assigned_to_employee_id insert was rejected';
  end if;

  insert into incident_escalations (facility_id, incident_id, reason_code, target_role, due_at)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001400', 'user_escalation', 'manager', now())
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: same-facility incident_escalations.incident_id insert was rejected';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Class B negative: cross-facility department_id/employee_id/incident_id
-- references are rejected.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into assets (facility_id, department_id, name)
    values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f01', 'cross-facility asset');
    raise exception 'RLS AUDIT FAIL: assets.department_id accepted a Facility B department';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    insert into work_orders (facility_id, department_id, title, description)
    values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f01', 'cross-facility WO dept', 'x');
    raise exception 'RLS AUDIT FAIL: work_orders.department_id accepted a Facility B department';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- work_orders.assigned_to_employee_id: the explicitly-named known-
  -- outstanding gap (guarded ONLY at the JS layer before 0038).
  begin
    insert into work_orders (facility_id, assigned_to_employee_id, title, description)
    values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001001', 'cross-facility WO employee', 'x');
    raise exception 'RLS AUDIT FAIL: work_orders.assigned_to_employee_id accepted a Facility B employee';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    insert into incident_escalations (facility_id, incident_id, reason_code, target_role, due_at)
    values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000001401', 'user_escalation', 'manager', now());
    raise exception 'RLS AUDIT FAIL: incident_escalations.incident_id accepted a Facility B incident';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Class B privilege escalation: memberships.role_id can no longer name a
-- role in a different facility than the membership's own claimed facility_id.
-- Actor A holds admin.manage on Facility A only; attempts to grant the
-- victim a Facility-A-claimed membership pointing at Facility B's Super Role.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into memberships (facility_id, user_id, role_id, status)
    values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000a02', '38000000-0000-0000-0000-0000000000d1', 'active');
    raise exception 'RLS AUDIT FAIL: memberships.role_id accepted a Facility B role for a Facility A membership';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'RLS AUDIT FAIL: cross-facility role_id insert failed with unexpected sqlstate % (%), expected 23514 check_violation', sqlstate, sqlerrm;
      end if;
      -- expected: fn_membership_department_facility (widened by 0038) raised check_violation
  end;
end;
$$;

reset role;

-- Verify (RLS bypassed) that the privilege-escalation attempt truly did not
-- persist, and that the victim gained no Facility A permission from it.
do $$
declare
  persisted boolean;
  escalated boolean;
begin
  select exists(
    select 1 from memberships
    where user_id = '38000000-0000-0000-0000-000000000a02'
      and facility_id = '38000000-0000-0000-0000-0000000000c0'
  ) into persisted;
  if persisted then
    raise exception 'RLS AUDIT FAIL: a cross-facility-role membership was persisted despite the rejected INSERT';
  end if;

  select internal.has_permission('38000000-0000-0000-0000-000000000a02', '38000000-0000-0000-0000-0000000000c0', 'incidents.export.pdf') into escalated;
  if escalated then
    raise exception 'RLS AUDIT FAIL: victim gained a Facility B role''s permission inside Facility A';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Incidental fix: a department-scoped reports.read member can read (and
-- therefore INSERT ... RETURNING) report_submissions rows for their own
-- department. Actor A holds reports.read facility-wide above; add a second,
-- department-SCOPED member to prove the 4-arg path specifically.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values ('38000000-0000-0000-0000-000000000a03', 'audit-dept-filer@test') on conflict (id) do nothing;
insert into app_users (id, full_name, email) values ('38000000-0000-0000-0000-000000000a03', 'Audit Dept Filer', 'audit-dept-filer@test') on conflict (id) do nothing;
insert into roles (id, facility_id, name) values ('38000000-0000-0000-0000-0000000000d2', '38000000-0000-0000-0000-0000000000c0', 'Audit Dept Filer Role') on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('38000000-0000-0000-0000-0000000000d2', 'reports.create'),
  ('38000000-0000-0000-0000-0000000000d2', 'reports.read'),
  ('38000000-0000-0000-0000-0000000000d2', 'reports.submit')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status, department_id) values
  ('38000000-0000-0000-0000-0000000000e1', '38000000-0000-0000-0000-000000000a03', '38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-0000000000d2', 'active', '38000000-0000-0000-0000-000000000f00')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"38000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  new_id uuid;
begin
  if not exists (select 1 from report_submissions where id = '38000000-0000-0000-0000-000000001700') then
    raise exception 'RLS AUDIT FAIL: a department-scoped reports.read member cannot read a submission in their own department (0038 SELECT-policy fix did not apply)';
  end if;

  insert into report_submissions (facility_id, department_id, template_id, template_version_id, report_date, status, submitted_by)
  values ('38000000-0000-0000-0000-0000000000c0', '38000000-0000-0000-0000-000000000f00', '38000000-0000-0000-0000-000000001500', '38000000-0000-0000-0000-000000001600', current_date, 'draft', '38000000-0000-0000-0000-000000000a03')
  returning id into new_id;
  if new_id is null then
    raise exception 'RLS AUDIT FAIL: a department-scoped reports.create/submit member could not INSERT ... RETURNING a report_submissions row (SELECT policy still blocks RETURNING visibility)';
  end if;
end;
$$;
reset role;

rollback;
