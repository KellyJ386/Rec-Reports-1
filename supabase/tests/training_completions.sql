-- Verification intent: closes the ownership gap plans/RLS_AUDIT.md escalated
-- (training_completions had an INSERT policy gated only on training.read,
-- with no binding to the caller's own employee row) -- 0039 replaces it with
-- a self-service-or-training.manage policy. Covers:
--   1. Self-completion allowed: an employee with training.read inserts a
--      training_completions row for their OWN training_assignments row
--      (joined via training_assignments.employee_id -> employees.id,
--      employees.user_id = auth.uid(), the exact 0036 shape).
--   2. Completing for another employee is DENIED for a training.read-only
--      holder (no training.manage) -- the falsifiable-record gap this
--      migration closes.
--   3. The same completion is ALLOWED for a training.manage holder
--      (supervisor recording completion on someone's behalf).
--   4. Cross-facility denied (FK injection on assignment_id): a
--      training.manage holder on Facility A cannot insert a completion
--      claiming facility_id = A while assignment_id points at a Facility B
--      assignment (fn_assert_same_facility, kept unchanged from 0038).
--   5. Permission-gate denied: a facility member with a real assignment of
--      their own, but whose role lacks training.read entirely, cannot
--      self-complete it -- has_permission must still gate the self-service
--      branch.
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists. RLS denials surface as insufficient_privilege
-- (SQLSTATE 42501).
begin;

insert into auth.users (id, email) values
  ('39000000-0000-0000-0000-000000000a01', 'tc-manager@test'),
  ('39000000-0000-0000-0000-000000000a02', 'tc-employee1@test'),
  ('39000000-0000-0000-0000-000000000a03', 'tc-employee2@test'),
  ('39000000-0000-0000-0000-000000000a04', 'tc-noperm@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('39000000-0000-0000-0000-000000000a01', 'TC Manager', 'tc-manager@test'),
  ('39000000-0000-0000-0000-000000000a02', 'TC Employee One', 'tc-employee1@test'),
  ('39000000-0000-0000-0000-000000000a03', 'TC Employee Two', 'tc-employee2@test'),
  ('39000000-0000-0000-0000-000000000a04', 'TC No Perm', 'tc-noperm@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('39111111-1111-1111-1111-111111111111', 'TC Org A'),
  ('39222222-2222-2222-2222-222222222222', 'TC Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39111111-1111-1111-1111-111111111111', 'TC Facility A'),
  ('39bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '39222222-2222-2222-2222-222222222222', 'TC Facility B')
on conflict (id) do nothing;

-- Roles: manager (training.manage + training.read), employee (training.read
-- only, self-service), no-perm (unrelated permission -- has_permission gate
-- must still block a fully-own-row self-write).
insert into roles (id, facility_id, name) values
  ('39c00000-0000-0000-0000-0000000000c1', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC Manager Role'),
  ('39c00000-0000-0000-0000-0000000000c2', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC Employee Role'),
  ('39c00000-0000-0000-0000-0000000000c3', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC No Perm Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('39c00000-0000-0000-0000-0000000000c1', 'training.manage'),
  ('39c00000-0000-0000-0000-0000000000c1', 'training.read'),
  ('39c00000-0000-0000-0000-0000000000c2', 'training.read'),
  ('39c00000-0000-0000-0000-0000000000c3', 'reports.read')
on conflict do nothing;

-- All four users are members of Facility A only -- Facility B rows below are
-- only ever used as FK-injection targets, never actors.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('39d00000-0000-0000-0000-0000000000d1', '39000000-0000-0000-0000-000000000a01', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39c00000-0000-0000-0000-0000000000c1', 'active'),
  ('39d00000-0000-0000-0000-0000000000d2', '39000000-0000-0000-0000-000000000a02', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39c00000-0000-0000-0000-0000000000c2', 'active'),
  ('39d00000-0000-0000-0000-0000000000d3', '39000000-0000-0000-0000-000000000a03', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39c00000-0000-0000-0000-0000000000c2', 'active'),
  ('39d00000-0000-0000-0000-0000000000d4', '39000000-0000-0000-0000-000000000a04', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

-- Employee rows (id deliberately distinct from the owning user's id, exactly
-- like production). e1/e2/e3 are Facility A, owned by Employee One, Employee
-- Two, and No Perm respectively. e4 is a Facility B employee with no
-- membership of its own -- purely an FK-injection target below.
insert into employees (id, facility_id, user_id, first_name, last_name) values
  ('39e00000-0000-0000-0000-0000000000e1', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39000000-0000-0000-0000-000000000a02', 'Employee', 'One'),
  ('39e00000-0000-0000-0000-0000000000e2', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39000000-0000-0000-0000-000000000a03', 'Employee', 'Two'),
  ('39e00000-0000-0000-0000-0000000000e3', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39000000-0000-0000-0000-000000000a04', 'No', 'Perm'),
  ('39e00000-0000-0000-0000-0000000000e4', '39bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'Blair', 'Facility B')
on conflict (id) do nothing;

-- Courses, one per facility (training_assignments.course_id is NOT NULL).
insert into courses (id, facility_id, code, title, status) values
  ('39f00000-0000-0000-0000-0000000000f1', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'course-a', 'TC Course A', 'published'),
  ('39f00000-0000-0000-0000-0000000000f2', '39bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'course-b', 'TC Course B', 'published')
on conflict (id) do nothing;

-- Assignments: one for Employee One and one for Employee Two in Facility A,
-- one for the Facility B employee (FK-injection target only).
insert into training_assignments (id, facility_id, employee_id, course_id, source_type) values
  ('39200000-0000-0000-0000-000000002001', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39e00000-0000-0000-0000-0000000000e1', '39f00000-0000-0000-0000-0000000000f1', 'manual'),
  ('39200000-0000-0000-0000-000000002002', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39e00000-0000-0000-0000-0000000000e2', '39f00000-0000-0000-0000-0000000000f1', 'manual'),
  ('39200000-0000-0000-0000-000000002003', '39bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '39e00000-0000-0000-0000-0000000000e4', '39f00000-0000-0000-0000-0000000000f2', 'manual')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Self-completion allowed: Employee One inserts a completion row for
-- their OWN assignment.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"39000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into training_completions (id, facility_id, assignment_id, completion_status) values
    ('39300000-0000-0000-0000-000000003001', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39200000-0000-0000-0000-000000002001', 'passed');
exception
  when insufficient_privilege then
    raise exception 'TC FAIL: Employee One was denied self-completing their own assignment';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Other-employee denied: Employee One (training.read only, no
-- training.manage) cannot record a completion against Employee Two's
-- assignment -- the exact falsifiable-record gap this migration closes.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into training_completions (id, facility_id, assignment_id, completion_status) values
      ('39300000-0000-0000-0000-000000003002', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39200000-0000-0000-0000-000000002002', 'passed');
    raise exception 'TC FAIL: a training.read-only holder completed another employee''s assignment';
  exception
    when insufficient_privilege then null; -- expected: assignment does not belong to Employee One and caller lacks training.manage
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. Manager override allowed: a training.manage holder can record a
-- completion for Employee Two's assignment (supervisor acting on someone's
-- behalf, e.g. an in-person session).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"39000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into training_completions (id, facility_id, assignment_id, completion_status) values
    ('39300000-0000-0000-0000-000000003003', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39200000-0000-0000-0000-000000002002', 'passed');
exception
  when insufficient_privilege then
    raise exception 'TC FAIL: a training.manage holder was denied completing Employee Two''s assignment';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-facility denied (FK injection on assignment_id): facility_id = A
-- (where the manager holds training.manage), but assignment_id points at the
-- Facility B assignment.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into training_completions (id, facility_id, assignment_id, completion_status) values
      ('39300000-0000-0000-0000-000000003004', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39200000-0000-0000-0000-000000002003', 'passed');
    raise exception 'TC FAIL: a completion was inserted whose facility_id does not match its assignment''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 5. Permission-gate denied: No Perm is a Facility A member with a real
-- assignment of their own, but their role lacks training.read entirely --
-- has_permission must block even a fully-own-row self-completion.
-- ---------------------------------------------------------------------------
insert into training_assignments (id, facility_id, employee_id, course_id, source_type) values
  ('39200000-0000-0000-0000-000000002004', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39e00000-0000-0000-0000-0000000000e3', '39f00000-0000-0000-0000-0000000000f1', 'manual')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"39000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into training_completions (id, facility_id, assignment_id, completion_status) values
      ('39300000-0000-0000-0000-000000003005', '39aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '39200000-0000-0000-0000-000000002004', 'passed');
    raise exception 'TC FAIL: No Perm (no training.read) self-completed their own assignment';
  exception
    when insufficient_privilege then null; -- expected: has_permission(training.read) failed
  end;
end;
$$;

reset role;

rollback;
