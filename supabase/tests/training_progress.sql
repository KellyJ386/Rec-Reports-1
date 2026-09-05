-- Verification intent: TR-06 (plans/TRAINING_PLAN.md) self-service RLS on
-- training_progress (0007, hardened by 0036). An authenticated employee with
-- training.read may insert/update ONLY the training_progress row belonging to
-- their OWN training_assignments (joined via
-- training_assignments.employee_id -> employees.id, employees.user_id =
-- auth.uid()), and only when facility_id is consistent with BOTH the parent
-- assignment and the parent module (fn_assert_same_facility, guarding
-- against FK injection on either parent). training.manage holders keep the
-- pre-existing 0007 "for all" override and can write any employee's progress
-- row. Runs against a migrated database inside a rolled-back transaction, so
-- no fixture persists. RLS denials surface as insufficient_privilege
-- (SQLSTATE 42501).
begin;

insert into auth.users (id, email) values
  ('36000000-0000-0000-0000-000000000a01', 'tp-manager@test'),
  ('36000000-0000-0000-0000-000000000a02', 'tp-employee1@test'),
  ('36000000-0000-0000-0000-000000000a03', 'tp-employee2@test'),
  ('36000000-0000-0000-0000-000000000a04', 'tp-noperm@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('36000000-0000-0000-0000-000000000a01', 'TP Manager', 'tp-manager@test'),
  ('36000000-0000-0000-0000-000000000a02', 'TP Employee One', 'tp-employee1@test'),
  ('36000000-0000-0000-0000-000000000a03', 'TP Employee Two', 'tp-employee2@test'),
  ('36000000-0000-0000-0000-000000000a04', 'TP No Perm', 'tp-noperm@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('36111111-1111-1111-1111-111111111111', 'TP Org A'),
  ('36222222-2222-2222-2222-222222222222', 'TP Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36111111-1111-1111-1111-111111111111', 'TP Facility A'),
  ('36bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '36222222-2222-2222-2222-222222222222', 'TP Facility B')
on conflict (id) do nothing;

-- Roles: manager (training.manage + training.read), employee (training.read
-- only, self-service), no-perm (unrelated permission -- has_permission gate
-- must still block a fully-own-row self-write).
insert into roles (id, facility_id, name) values
  ('36c00000-0000-0000-0000-0000000000c1', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TP Manager Role'),
  ('36c00000-0000-0000-0000-0000000000c2', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TP Employee Role'),
  ('36c00000-0000-0000-0000-0000000000c3', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TP No Perm Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('36c00000-0000-0000-0000-0000000000c1', 'training.manage'),
  ('36c00000-0000-0000-0000-0000000000c1', 'training.read'),
  ('36c00000-0000-0000-0000-0000000000c2', 'training.read'),
  ('36c00000-0000-0000-0000-0000000000c3', 'reports.read')
on conflict do nothing;

-- All four users are members of Facility A only -- Facility B rows below are
-- only ever used as FK-injection targets, never actors.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('36d00000-0000-0000-0000-0000000000d1', '36000000-0000-0000-0000-000000000a01', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36c00000-0000-0000-0000-0000000000c1', 'active'),
  ('36d00000-0000-0000-0000-0000000000d2', '36000000-0000-0000-0000-000000000a02', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36c00000-0000-0000-0000-0000000000c2', 'active'),
  ('36d00000-0000-0000-0000-0000000000d3', '36000000-0000-0000-0000-000000000a03', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36c00000-0000-0000-0000-0000000000c2', 'active'),
  ('36d00000-0000-0000-0000-0000000000d4', '36000000-0000-0000-0000-000000000a04', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

-- Employee rows (id deliberately distinct from the owning user's id, exactly
-- like production). e1/e2/e3 are Facility A, owned by Employee One, Employee
-- Two, and No Perm respectively. e4 is a Facility B employee with no
-- membership of its own -- purely an FK-injection target below.
insert into employees (id, facility_id, user_id, first_name, last_name) values
  ('36e00000-0000-0000-0000-0000000000e1', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36000000-0000-0000-0000-000000000a02', 'Employee', 'One'),
  ('36e00000-0000-0000-0000-0000000000e2', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36000000-0000-0000-0000-000000000a03', 'Employee', 'Two'),
  ('36e00000-0000-0000-0000-0000000000e3', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36000000-0000-0000-0000-000000000a04', 'No', 'Perm'),
  ('36e00000-0000-0000-0000-0000000000e4', '36bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'Blair', 'Facility B')
on conflict (id) do nothing;

-- Courses + modules, one pair per facility.
insert into courses (id, facility_id, code, title, status) values
  ('36f00000-0000-0000-0000-0000000000f1', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'course-a', 'TP Course A', 'published'),
  ('36f00000-0000-0000-0000-0000000000f2', '36bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'course-b', 'TP Course B', 'published')
on conflict (id) do nothing;

insert into course_modules (id, facility_id, course_id, module_type, title, order_no, required) values
  ('36f10000-0000-0000-0000-000000001001', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36f00000-0000-0000-0000-0000000000f1', 'sop_link', 'TP Module A1', 1, true),
  ('36f10000-0000-0000-0000-000000001002', '36bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '36f00000-0000-0000-0000-0000000000f2', 'sop_link', 'TP Module B1', 1, true)
on conflict (id) do nothing;

-- Assignments: one for Employee One and one for Employee Two in Facility A,
-- one for the Facility B employee.
insert into training_assignments (id, facility_id, employee_id, course_id, source_type) values
  ('36200000-0000-0000-0000-000000002001', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36e00000-0000-0000-0000-0000000000e1', '36f00000-0000-0000-0000-0000000000f1', 'manual'),
  ('36200000-0000-0000-0000-000000002002', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36e00000-0000-0000-0000-0000000000e2', '36f00000-0000-0000-0000-0000000000f1', 'manual'),
  ('36200000-0000-0000-0000-000000002003', '36bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '36e00000-0000-0000-0000-0000000000e4', '36f00000-0000-0000-0000-0000000000f2', 'manual')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Self-write allowed: Employee One inserts, then updates, the progress
-- row for their OWN assignment.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"36000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into training_progress (id, facility_id, assignment_id, module_id, state, started_at) values
    ('36300000-0000-0000-0000-000000003001', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36200000-0000-0000-0000-000000002001', '36f10000-0000-0000-0000-000000001001', 'in_progress', now());
exception
  when insufficient_privilege then
    raise exception 'TP FAIL: Employee One was denied inserting their own progress row';
end;
$$;

do $$
begin
  update training_progress set state = 'completed', completed_at = now(), attempts = 1
    where id = '36300000-0000-0000-0000-000000003001';
  if not exists (select 1 from training_progress where id = '36300000-0000-0000-0000-000000003001' and state = 'completed') then
    raise exception 'TP FAIL: Employee One''s own-progress update did not apply';
  end if;
exception
  when insufficient_privilege then
    raise exception 'TP FAIL: Employee One was denied updating their own progress row';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Other-employee denied: Employee One cannot write a progress row against
-- Employee Two's assignment, even in the same facility with a real module.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into training_progress (id, facility_id, assignment_id, module_id, state) values
      ('36300000-0000-0000-0000-000000003002', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36200000-0000-0000-0000-000000002002', '36f10000-0000-0000-0000-000000001001', 'in_progress');
    raise exception 'TP FAIL: Employee One inserted a progress row against Employee Two''s assignment';
  exception
    when insufficient_privilege then null; -- expected: assignment does not belong to Employee One
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3a. Cross-facility denied (FK injection on assignment_id): facility_id = A
-- (where Employee One has training.read and owns a real assignment there),
-- but assignment_id points at the Facility B assignment.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into training_progress (id, facility_id, assignment_id, module_id, state) values
      ('36300000-0000-0000-0000-000000003003', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36200000-0000-0000-0000-000000002003', '36f10000-0000-0000-0000-000000001001', 'in_progress');
    raise exception 'TP FAIL: a progress row was inserted whose facility_id does not match its assignment''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Cross-facility denied (FK injection on module_id): facility_id/
-- assignment_id are both Employee One's own valid Facility A row, but
-- module_id points at the Facility B module.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into training_progress (id, facility_id, assignment_id, module_id, state) values
      ('36300000-0000-0000-0000-000000003004', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36200000-0000-0000-0000-000000002001', '36f10000-0000-0000-0000-000000001002', 'in_progress');
    raise exception 'TP FAIL: a progress row was inserted whose module_id belongs to a different facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. Permission-gate denied: No Perm is a Facility A member with a real
-- assignment of their own, but their role lacks training.read entirely --
-- has_permission must block even a fully-own-row insert.
-- ---------------------------------------------------------------------------
insert into training_assignments (id, facility_id, employee_id, course_id, source_type) values
  ('36200000-0000-0000-0000-000000002004', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36e00000-0000-0000-0000-0000000000e3', '36f00000-0000-0000-0000-0000000000f1', 'manual')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"36000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into training_progress (id, facility_id, assignment_id, module_id, state) values
      ('36300000-0000-0000-0000-000000003005', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36200000-0000-0000-0000-000000002004', '36f10000-0000-0000-0000-000000001001', 'in_progress');
    raise exception 'TP FAIL: No Perm (no training.read) inserted their own progress row';
  exception
    when insufficient_privilege then null; -- expected: has_permission(training.read) failed
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 5. Manager override allowed: the pre-existing 0007 training.manage "for
-- all" policy still lets a manager write/correct another employee's progress
-- row (e.g. Employee Two's), coexisting with the new self-service policies.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"36000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into training_progress (id, facility_id, assignment_id, module_id, state, started_at) values
    ('36300000-0000-0000-0000-000000003006', '36aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '36200000-0000-0000-0000-000000002002', '36f10000-0000-0000-0000-000000001001', 'in_progress', now());
exception
  when insufficient_privilege then
    raise exception 'TP FAIL: a training.manage holder was denied inserting Employee Two''s progress row';
end;
$$;

do $$
begin
  update training_progress set state = 'completed', completed_at = now()
    where id = '36300000-0000-0000-0000-000000003006';
  if not exists (select 1 from training_progress where id = '36300000-0000-0000-0000-000000003006' and state = 'completed') then
    raise exception 'TP FAIL: a training.manage holder''s update to Employee Two''s progress row did not apply';
  end if;
exception
  when insufficient_privilege then
    raise exception 'TP FAIL: a training.manage holder was denied updating Employee Two''s progress row';
end;
$$;

reset role;

rollback;
