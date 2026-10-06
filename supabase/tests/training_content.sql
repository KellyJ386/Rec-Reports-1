-- Verification intent: TR-07 / TR-08 (0065_training_content.sql). Covers:
--   1. Quiz authoring RLS: a training.manage holder creates a quiz, questions,
--      options and keys; a training.read-only employee cannot; a manager of
--      facility B cannot attach a quiz to facility A's module, and a quiz can
--      only hang off a quiz-type module (fn_quiz_module_guard).
--   2. Answer keys are hidden: an employee reads option labels but gets ZERO
--      rows from quiz_option_keys and cannot insert one; a manager reads them.
--   3. internal.submit_quiz_attempt / public.submit_quiz_attempt: server-side
--      scoring (partial score, pass threshold), own-assignment-only (another
--      employee and a manager are both refused 42501), max_attempts and
--      already-passed refusals (PT409), no direct quiz_attempts writes for
--      any authenticated caller, training_progress written by the RPC.
--   4. quiz_attempts is append-only for every role (UPDATE/DELETE blocked).
--   5. Completion gating: an employee cannot write progress state='completed'
--      for a quiz module without a passing attempt, a 'passed' completion is
--      refused while a required quiz is unpassed, 'waived' still works.
--   6. Attempt visibility: own attempts only for employees, all for managers.
--   7. TR-08 training_content_items: RLS (manager writes, reader reads, cross
--      facility module rejected), the path guard's negative cases (wrong
--      facility, wrong module, dot segment, extra level, kind mismatch).
--   8. TR-08 storage.objects read policy: the training branch (training.read
--      sees facilities/<fid>/training/..., a reports-only member and another
--      facility's manager do not), the four pre-existing branches still
--      present in pg_policies with every guard of 0040's definition.
--   9. Function privileges: the public RPC wrapper is executable by
--      authenticated, every definer trigger function is not.
-- Runs inside a transaction that is rolled back, so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('65000000-0000-0000-0000-0000000000a1', 'tc-manager@test'),
  ('65000000-0000-0000-0000-0000000000a2', 'tc-employee1@test'),
  ('65000000-0000-0000-0000-0000000000a3', 'tc-employee2@test'),
  ('65000000-0000-0000-0000-0000000000a4', 'tc-reports-reader@test'),
  ('65000000-0000-0000-0000-0000000000a5', 'tc-manager-b@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('65000000-0000-0000-0000-0000000000a1', 'TC Manager', 'tc-manager@test'),
  ('65000000-0000-0000-0000-0000000000a2', 'TC Employee 1', 'tc-employee1@test'),
  ('65000000-0000-0000-0000-0000000000a3', 'TC Employee 2', 'tc-employee2@test'),
  ('65000000-0000-0000-0000-0000000000a4', 'TC Reports Reader', 'tc-reports-reader@test'),
  ('65000000-0000-0000-0000-0000000000a5', 'TC Manager B', 'tc-manager-b@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('65111111-1111-1111-1111-111111111111', 'TC Org')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65111111-1111-1111-1111-111111111111', 'TC Facility A'),
  ('65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '65111111-1111-1111-1111-111111111111', 'TC Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('65c00000-0000-0000-0000-0000000000c1', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC Manager Role'),
  ('65c00000-0000-0000-0000-0000000000c2', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC Employee Role'),
  ('65c00000-0000-0000-0000-0000000000c3', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC Reports Reader Role'),
  ('65c00000-0000-0000-0000-0000000000c4', '65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TC Manager B Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('65c00000-0000-0000-0000-0000000000c1', 'training.manage'),
  ('65c00000-0000-0000-0000-0000000000c1', 'training.read'),
  ('65c00000-0000-0000-0000-0000000000c2', 'training.read'),
  ('65c00000-0000-0000-0000-0000000000c3', 'reports.read'),
  ('65c00000-0000-0000-0000-0000000000c4', 'training.manage'),
  ('65c00000-0000-0000-0000-0000000000c4', 'training.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('65d10000-0000-0000-0000-0000000000d1', '65000000-0000-0000-0000-0000000000a1', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65c00000-0000-0000-0000-0000000000c1', 'active'),
  ('65d10000-0000-0000-0000-0000000000d2', '65000000-0000-0000-0000-0000000000a2', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65c00000-0000-0000-0000-0000000000c2', 'active'),
  ('65d10000-0000-0000-0000-0000000000d3', '65000000-0000-0000-0000-0000000000a3', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65c00000-0000-0000-0000-0000000000c2', 'active'),
  ('65d10000-0000-0000-0000-0000000000d4', '65000000-0000-0000-0000-0000000000a4', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65c00000-0000-0000-0000-0000000000c3', 'active'),
  ('65d10000-0000-0000-0000-0000000000d5', '65000000-0000-0000-0000-0000000000a5', '65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '65c00000-0000-0000-0000-0000000000c4', 'active')
on conflict (id) do nothing;

insert into employees (id, facility_id, user_id, first_name, last_name, status) values
  ('65e10000-0000-0000-0000-0000000000e1', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65000000-0000-0000-0000-0000000000a2', 'Emp', 'One', 'active'),
  ('65e10000-0000-0000-0000-0000000000e2', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65000000-0000-0000-0000-0000000000a3', 'Emp', 'Two', 'active')
on conflict (id) do nothing;

-- Course A (quiz module QM1, video module VM, pdf module PM) and course A2
-- (quiz module QM2, max_attempts 2), plus a facility-B quiz module.
insert into courses (id, facility_id, code, title, status) values
  ('65f00000-0000-0000-0000-0000000000f1', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC-A', 'TC Course A', 'published'),
  ('65f00000-0000-0000-0000-0000000000f2', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TC-A2', 'TC Course A2', 'published'),
  ('65f00000-0000-0000-0000-0000000000f3', '65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TC-B', 'TC Course B', 'published')
on conflict (id) do nothing;

insert into course_modules (id, facility_id, course_id, module_type, title, order_no, required) values
  ('65f10000-0000-0000-0000-000000000001', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f00000-0000-0000-0000-0000000000f1', 'quiz', 'QM1', 1, true),
  ('65f10000-0000-0000-0000-000000000002', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f00000-0000-0000-0000-0000000000f2', 'quiz', 'QM2', 1, true),
  ('65f10000-0000-0000-0000-000000000003', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f00000-0000-0000-0000-0000000000f1', 'video', 'VM', 2, true),
  ('65f10000-0000-0000-0000-000000000004', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f00000-0000-0000-0000-0000000000f1', 'pdf', 'PM', 3, true),
  ('65f10000-0000-0000-0000-000000000005', '65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '65f00000-0000-0000-0000-0000000000f3', 'quiz', 'BM', 1, true)
on conflict (id) do nothing;

insert into training_assignments (id, facility_id, employee_id, course_id) values
  ('65a50000-0000-0000-0000-000000000001', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65e10000-0000-0000-0000-0000000000e1', '65f00000-0000-0000-0000-0000000000f1'),
  ('65a50000-0000-0000-0000-000000000002', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65e10000-0000-0000-0000-0000000000e2', '65f00000-0000-0000-0000-0000000000f1'),
  ('65a50000-0000-0000-0000-000000000003', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65e10000-0000-0000-0000-0000000000e1', '65f00000-0000-0000-0000-0000000000f2')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Quiz authoring RLS.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into quizzes (id, facility_id, module_id, title, pass_score_pct, max_attempts)
  values ('65a10000-0000-0000-0000-000000000001', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000001', 'Quiz 1', 60, null);
  insert into quizzes (id, facility_id, module_id, title, pass_score_pct, max_attempts)
  values ('65a10000-0000-0000-0000-000000000002', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000002', 'Quiz 2', 50, 2);

  insert into quiz_questions (id, facility_id, quiz_id, prompt, question_type, points, order_no) values
    ('65a20000-0000-0000-0000-000000000001', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a10000-0000-0000-0000-000000000001', 'Q1 single', 'single', 1, 1),
    ('65a20000-0000-0000-0000-000000000002', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a10000-0000-0000-0000-000000000001', 'Q2 multiple', 'multiple', 1, 2),
    ('65a20000-0000-0000-0000-000000000003', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a10000-0000-0000-0000-000000000002', 'Q3 single', 'single', 1, 1);

  insert into quiz_options (id, facility_id, question_id, label, order_no) values
    ('65a30000-0000-0000-0000-00000000001a', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000001', 'Q1 right', 1),
    ('65a30000-0000-0000-0000-00000000001b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000001', 'Q1 wrong', 2),
    ('65a30000-0000-0000-0000-00000000002a', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000002', 'Q2 right A', 1),
    ('65a30000-0000-0000-0000-00000000002b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000002', 'Q2 right B', 2),
    ('65a30000-0000-0000-0000-00000000002c', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000002', 'Q2 wrong', 3),
    ('65a30000-0000-0000-0000-00000000003a', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000003', 'Q3 right', 1),
    ('65a30000-0000-0000-0000-00000000003b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a20000-0000-0000-0000-000000000003', 'Q3 wrong', 2);

  insert into quiz_option_keys (option_id, facility_id, is_correct) values
    ('65a30000-0000-0000-0000-00000000001a', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true),
    ('65a30000-0000-0000-0000-00000000001b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false),
    ('65a30000-0000-0000-0000-00000000002a', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true),
    ('65a30000-0000-0000-0000-00000000002b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true),
    ('65a30000-0000-0000-0000-00000000002c', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false),
    ('65a30000-0000-0000-0000-00000000003a', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true),
    ('65a30000-0000-0000-0000-00000000003b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
exception
  when others then
    raise exception 'TC FAIL: manager could not author a quiz: % %', sqlstate, sqlerrm;
end;
$$;

-- A cross-facility module: facility A's manager cannot attach a quiz to
-- facility B's module (RLS WITH CHECK via fn_assert_same_facility)...
do $$
begin
  begin
    insert into quizzes (facility_id, module_id, title)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000005', 'Cross-facility quiz');
    raise exception 'TC FAIL: manager created a quiz on another facility''s module';
  exception
    -- BEFORE triggers run ahead of RLS WITH CHECK, so the module guard
    -- (check_violation) normally fires first; the policy's
    -- fn_assert_same_facility (insufficient_privilege) is the backstop.
    when insufficient_privilege or check_violation then null; -- expected
  end;
  -- ...and a quiz cannot hang off a non-quiz module even in the same facility
  -- (fn_quiz_module_guard).
  begin
    insert into quizzes (facility_id, module_id, title)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'Quiz on a video module');
    raise exception 'TC FAIL: a quiz was attached to a video module';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;
reset role;

-- An employee (training.read only) cannot author anything.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into quizzes (facility_id, module_id, title)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000001', 'Employee quiz');
    raise exception 'TC FAIL: an employee created a quiz';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into quiz_questions (facility_id, quiz_id, prompt, order_no)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a10000-0000-0000-0000-000000000001', 'Sneaky', 9);
    raise exception 'TC FAIL: an employee created a quiz question';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Answer keys are hidden from an employee.
-- ---------------------------------------------------------------------------
do $$
declare
  v_options integer;
  v_keys integer;
begin
  select count(*) into v_options from quiz_options;
  select count(*) into v_keys from quiz_option_keys;
  if v_options <> 7 then
    raise exception 'TC FAIL: employee sees % quiz options, expected 7', v_options;
  end if;
  if v_keys <> 0 then
    raise exception 'TC FAIL: employee can read % answer-key rows', v_keys;
  end if;
  begin
    insert into quiz_option_keys (option_id, facility_id, is_correct)
    values ('65a30000-0000-0000-0000-00000000001b', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
    raise exception 'TC FAIL: employee inserted an answer key';
  exception
    when unique_violation then
      raise exception 'TC FAIL: employee insert reached the unique constraint (RLS should deny first)';
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_keys integer;
begin
  select count(*) into v_keys from quiz_option_keys;
  if v_keys <> 7 then
    raise exception 'TC FAIL: manager sees % answer-key rows, expected 7', v_keys;
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. Server-side scoring through the RPC.
-- ---------------------------------------------------------------------------
-- 3a. Employee 2 (assignment 2): Q1 right, Q2 wrong -> 50% < 60 -> failed.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.submit_quiz_attempt(
    '65a50000-0000-0000-0000-000000000002',
    '65a10000-0000-0000-0000-000000000001',
    jsonb_build_object(
      '65a20000-0000-0000-0000-000000000001', jsonb_build_array('65a30000-0000-0000-0000-00000000001a'),
      '65a20000-0000-0000-0000-000000000002', jsonb_build_array('65a30000-0000-0000-0000-00000000002a')
    )
  );
  if (v_result ->> 'passed')::boolean is distinct from false
     or (v_result ->> 'score_pct')::numeric <> 50
     or (v_result ->> 'attempt_no')::integer <> 1
     or (v_result ->> 'correct_count')::integer <> 1 then
    raise exception 'TC FAIL: unexpected failing-attempt result %', v_result;
  end if;
  -- The answer key never appears in the result.
  if v_result::text like '%is_correct%' or v_result::text like '%65a30000%' then
    raise exception 'TC FAIL: the RPC result leaks answer-key detail: %', v_result;
  end if;
end;
$$;

-- The progress row is failed (RPC wrote it) and visible to the employee.
do $$
declare
  v_state text;
  v_attempts integer;
begin
  select state, attempts into v_state, v_attempts from training_progress
  where assignment_id = '65a50000-0000-0000-0000-000000000002' and module_id = '65f10000-0000-0000-0000-000000000001';
  if v_state is distinct from 'failed' or v_attempts is distinct from 1 then
    raise exception 'TC FAIL: expected failed/1 progress, got %/%', v_state, v_attempts;
  end if;
end;
$$;

-- 5a. The employee cannot self-report the quiz module as completed.
do $$
begin
  begin
    update training_progress set state = 'completed', completed_at = now(), score_pct = 100
    where assignment_id = '65a50000-0000-0000-0000-000000000002' and module_id = '65f10000-0000-0000-0000-000000000001';
    raise exception 'TC FAIL: employee self-completed a quiz module without a passing attempt';
  exception
    when check_violation then null; -- expected: fn_training_progress_quiz_guard
  end;
  begin
    insert into training_progress (facility_id, assignment_id, module_id, state)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a50000-0000-0000-0000-000000000003', '65f10000-0000-0000-0000-000000000002', 'completed');
    raise exception 'TC FAIL: employee inserted a completed quiz-module progress row';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- 5b. A 'passed' completion is refused while the required quiz is unpassed.
do $$
begin
  begin
    insert into training_completions (facility_id, assignment_id, completion_status)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a50000-0000-0000-0000-000000000002', 'passed');
    raise exception 'TC FAIL: a passed completion was recorded without a passing quiz attempt';
  exception
    when check_violation then null; -- expected: fn_training_completion_quiz_guard
  end;
end;
$$;

-- ...and cannot dodge the quiz by waiving it for themselves (waiving is a
-- supervisor override that needs training.manage).
do $$
begin
  begin
    insert into training_completions (facility_id, assignment_id, completion_status)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a50000-0000-0000-0000-000000000002', 'waived');
    raise exception 'TC FAIL: an employee waived their own quiz-gated assignment';
  exception
    when insufficient_privilege then null; -- expected: guard 2
  end;
end;
$$;

-- 3b. Employee 2 cannot submit for employee 1's assignment; a quiz that is
-- not part of the assignment's course is a 404.
do $$
begin
  begin
    perform public.submit_quiz_attempt(
      '65a50000-0000-0000-0000-000000000001', '65a10000-0000-0000-0000-000000000001', '{}'::jsonb);
    raise exception 'TC FAIL: employee 2 submitted an attempt for employee 1''s assignment';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    perform public.submit_quiz_attempt(
      '65a50000-0000-0000-0000-000000000002', '65a10000-0000-0000-0000-000000000002', '{}'::jsonb);
    raise exception 'TC FAIL: a quiz from another course was accepted for the assignment';
  exception
    when sqlstate 'PT404' then null; -- expected
  end;
  begin
    perform public.submit_quiz_attempt(
      '65a50000-0000-0000-0000-000000000002', '65a10000-0000-0000-0000-000000000001', '[]'::jsonb);
    raise exception 'TC FAIL: a non-object answers payload was accepted';
  exception
    when sqlstate 'PT400' then null; -- expected
  end;
end;
$$;

-- 6a. Employee 2 sees exactly their own attempt, not employee 1's (none yet).
do $$
declare
  v_visible integer;
begin
  select count(*) into v_visible from quiz_attempts;
  if v_visible <> 1 then
    raise exception 'TC FAIL: employee 2 sees % attempts, expected exactly their own 1', v_visible;
  end if;
end;
$$;

-- No direct writes to quiz_attempts for an authenticated caller, even with
-- fabricated passing data for their own assignment.
do $$
begin
  begin
    insert into quiz_attempts (
      facility_id, quiz_id, assignment_id, employee_id, attempt_no, answers_jsonb, score_pct, correct_count, total_questions, passed
    ) values (
      '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a10000-0000-0000-0000-000000000001',
      '65a50000-0000-0000-0000-000000000002', '65e10000-0000-0000-0000-0000000000e2', 99, '{}'::jsonb, 100, 2, 2, true);
    raise exception 'TC FAIL: an employee inserted a fabricated passing attempt';
  exception
    when insufficient_privilege then null; -- expected: no insert policy
  end;
end;
$$;
reset role;

-- 3c. A manager (not the assignment's employee) cannot submit on their behalf.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.submit_quiz_attempt(
      '65a50000-0000-0000-0000-000000000002', '65a10000-0000-0000-0000-000000000001', '{}'::jsonb);
    raise exception 'TC FAIL: a manager submitted an attempt on an employee''s behalf';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into quiz_attempts (
      facility_id, quiz_id, assignment_id, employee_id, attempt_no, answers_jsonb, score_pct, correct_count, total_questions, passed
    ) values (
      '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a10000-0000-0000-0000-000000000001',
      '65a50000-0000-0000-0000-000000000002', '65e10000-0000-0000-0000-0000000000e2', 98, '{}'::jsonb, 100, 2, 2, true);
    raise exception 'TC FAIL: a manager inserted an attempt row directly';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
-- 6b. The manager sees every attempt.
do $$
declare
  v_visible integer;
begin
  select count(*) into v_visible from quiz_attempts;
  if v_visible <> 1 then
    raise exception 'TC FAIL: manager sees % attempts, expected 1', v_visible;
  end if;
end;
$$;
-- A manager can still record a 'waived' completion for the unpassed quiz.
do $$
begin
  insert into training_completions (facility_id, assignment_id, completion_status)
  values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a50000-0000-0000-0000-000000000002', 'waived');
exception
  when others then
    raise exception 'TC FAIL: manager waived completion refused: % %', sqlstate, sqlerrm;
end;
$$;
reset role;

-- 3d. Employee 1 passes quiz 1 (Q1 right, Q2 both rights) -> 100%, completed.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.submit_quiz_attempt(
    '65a50000-0000-0000-0000-000000000001',
    '65a10000-0000-0000-0000-000000000001',
    jsonb_build_object(
      '65a20000-0000-0000-0000-000000000001', jsonb_build_array('65a30000-0000-0000-0000-00000000001a'),
      '65a20000-0000-0000-0000-000000000002', jsonb_build_array('65a30000-0000-0000-0000-00000000002b', '65a30000-0000-0000-0000-00000000002a')
    )
  );
  if (v_result ->> 'passed')::boolean is distinct from true or (v_result ->> 'score_pct')::numeric <> 100 then
    raise exception 'TC FAIL: unexpected passing-attempt result %', v_result;
  end if;
  if (select state from training_progress
      where assignment_id = '65a50000-0000-0000-0000-000000000001' and module_id = '65f10000-0000-0000-0000-000000000001') is distinct from 'completed' then
    raise exception 'TC FAIL: a passing attempt did not complete the module';
  end if;
  -- A second attempt after passing is refused (PT409).
  begin
    perform public.submit_quiz_attempt(
      '65a50000-0000-0000-0000-000000000001', '65a10000-0000-0000-0000-000000000001', '{}'::jsonb);
    raise exception 'TC FAIL: a second attempt was accepted after passing';
  exception
    when sqlstate 'PT409' then null; -- expected
  end;
  -- With the quiz passed, the (self-service) passed completion is allowed.
  insert into training_completions (facility_id, assignment_id, completion_status)
  values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65a50000-0000-0000-0000-000000000001', 'passed');
end;
$$;

-- 3e. max_attempts: quiz 2 allows 2 attempts; the third is a PT409.
do $$
declare
  v_answers jsonb := jsonb_build_object(
    '65a20000-0000-0000-0000-000000000003', jsonb_build_array('65a30000-0000-0000-0000-00000000003b'));
  v_result jsonb;
begin
  v_result := public.submit_quiz_attempt('65a50000-0000-0000-0000-000000000003', '65a10000-0000-0000-0000-000000000002', v_answers);
  if (v_result ->> 'attempts_remaining')::integer <> 1 or (v_result ->> 'passed')::boolean then
    raise exception 'TC FAIL: unexpected first max_attempts result %', v_result;
  end if;
  v_result := public.submit_quiz_attempt('65a50000-0000-0000-0000-000000000003', '65a10000-0000-0000-0000-000000000002', v_answers);
  if (v_result ->> 'attempts_remaining')::integer <> 0 then
    raise exception 'TC FAIL: unexpected second max_attempts result %', v_result;
  end if;
  begin
    perform public.submit_quiz_attempt('65a50000-0000-0000-0000-000000000003', '65a10000-0000-0000-0000-000000000002', v_answers);
    raise exception 'TC FAIL: an attempt beyond max_attempts was accepted';
  exception
    when sqlstate 'PT409' then null; -- expected
  end;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 4. quiz_attempts is append-only for every role (superuser here).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update quiz_attempts set passed = true where assignment_id = '65a50000-0000-0000-0000-000000000002';
    raise exception 'TC FAIL: a quiz attempt was updated';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    delete from quiz_attempts where assignment_id = '65a50000-0000-0000-0000-000000000002';
    raise exception 'TC FAIL: a quiz attempt was deleted';
  exception
    when insufficient_privilege then null; -- expected
  end;
  if (select count(*) from quiz_attempts) <> 4 then
    raise exception 'TC FAIL: expected 4 recorded attempts (1 + 1 + 2), got %', (select count(*) from quiz_attempts);
  end if;
end;
$$;

-- Employee 1 sees only their own three attempts, employee 2 sees theirs.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from quiz_attempts) <> 3 then
    raise exception 'TC FAIL: employee 1 sees % attempts, expected 3', (select count(*) from quiz_attempts);
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 7. training_content_items: RLS + path guard.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into training_content_items (id, facility_id, module_id, kind, title, storage_path, mime_type, size_bytes)
  values (
    '65a60000-0000-0000-0000-000000000001', '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '65f10000-0000-0000-0000-000000000003', 'video', 'Intro video',
    'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000003/uuid-intro.mp4',
    'video/mp4', 1024);
exception
  when others then
    raise exception 'TC FAIL: manager could not attach a valid video item: % %', sqlstate, sqlerrm;
end;
$$;
reset role;

-- Path-guard negative cases (superuser: the trigger binds every role, not
-- just RLS-subject ones).
do $$
begin
  begin -- wrong facility segment
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/training/65f10000-0000-0000-0000-000000000003/uuid-x.mp4', 'video/mp4');
    raise exception 'TC FAIL: a content item pointing at another facility''s path was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin -- wrong module id segment
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000004/uuid-x.mp4', 'video/mp4');
    raise exception 'TC FAIL: a content item naming another module''s path was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin -- wrong module segment (module folder other than training)
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/reports/65f10000-0000-0000-0000-000000000003/uuid-x.mp4', 'video/mp4');
    raise exception 'TC FAIL: a content item under the reports module folder was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin -- dot segment traversal
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000003/../../../65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/training/x/y.mp4', 'video/mp4');
    raise exception 'TC FAIL: a dot-segment traversal path was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin -- extra path level
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000003/sub/uuid-x.mp4', 'video/mp4');
    raise exception 'TC FAIL: a path with an extra level was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin -- kind does not match the module type (pdf item on a video module)
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'pdf', 'x',
      'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000003/uuid-x.pdf', 'application/pdf');
    raise exception 'TC FAIL: a pdf item on a video module was accepted';
  exception
    when check_violation then null; -- expected
  end;
  begin -- an UPDATE re-pointing the path is guarded too
    update training_content_items set storage_path =
      'facilities/65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/training/65f10000-0000-0000-0000-000000000003/uuid-x.mp4'
    where id = '65a60000-0000-0000-0000-000000000001';
    raise exception 'TC FAIL: a content item was re-pointed at another facility''s path';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- RLS: an employee can read the item but cannot write; facility B's manager
-- cannot read or attach to facility A's module.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from training_content_items) <> 1 then
    raise exception 'TC FAIL: employee cannot read the content item';
  end if;
  begin
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000003/uuid-y.mp4', 'video/mp4');
    raise exception 'TC FAIL: an employee attached a content item';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from training_content_items) <> 0 or (select count(*) from quizzes) <> 0
     or (select count(*) from quiz_questions) <> 0 or (select count(*) from quiz_option_keys) <> 0 then
    raise exception 'TC FAIL: facility B''s manager can read facility A''s training content';
  end if;
  begin
    insert into training_content_items (facility_id, module_id, kind, title, storage_path, mime_type)
    values ('65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '65f10000-0000-0000-0000-000000000003', 'video', 'x',
      'facilities/65bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/training/65f10000-0000-0000-0000-000000000003/uuid-z.mp4', 'video/mp4');
    raise exception 'TC FAIL: facility B''s manager attached an item to facility A''s module';
  exception
    when insufficient_privilege or check_violation then null; -- expected (path guard / fn_assert_same_facility)
  end;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 8. storage.objects read policy: the training branch + carried-forward
-- branches.
-- ---------------------------------------------------------------------------
insert into storage.objects (id, bucket_id, name) values
  ('65b00000-0000-0000-0000-000000000001', 'attachments', 'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/training/65f10000-0000-0000-0000-000000000003/uuid-intro.mp4'),
  ('65b00000-0000-0000-0000-000000000002', 'attachments', 'facilities/65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/reports/rec-1/uuid-report.pdf')
on conflict (id) do nothing;

-- training.read (employee 1) sees the training object, not the reports one.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from storage.objects where id = '65b00000-0000-0000-0000-000000000001') then
    raise exception 'TC FAIL: training.read member cannot read the training-module object';
  end if;
  if exists (select 1 from storage.objects where id = '65b00000-0000-0000-0000-000000000002') then
    raise exception 'TC FAIL: training.read-only member can read the reports-module object';
  end if;
end;
$$;
reset role;

-- reports.read-only member: reports object yes, training object no.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from storage.objects where id = '65b00000-0000-0000-0000-000000000001') then
    raise exception 'TC FAIL: reports.read-only member can read the training-module object';
  end if;
  if not exists (select 1 from storage.objects where id = '65b00000-0000-0000-0000-000000000002') then
    raise exception 'TC FAIL: the reports branch regressed (reports.read member cannot read reports object)';
  end if;
end;
$$;
reset role;

-- Another facility's training manager: nothing.
select set_config('request.jwt.claims', '{"sub":"65000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from storage.objects where id in ('65b00000-0000-0000-0000-000000000001', '65b00000-0000-0000-0000-000000000002')) then
    raise exception 'TC FAIL: facility B''s member can read facility A''s storage objects';
  end if;
end;
$$;
reset role;

-- Full guarded-branch list of the re-created policy, asserted against
-- pg_policies so a later redefinition cannot drop a branch or a guard
-- silently (the 3C H-1/N-1 lesson).
do $$
declare
  v_qual text;
  v_fragment text;
begin
  select qual into v_qual from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'facility members can read module-scoped attachments';
  if v_qual is null then
    raise exception 'TC FAIL: the module-scoped storage read policy is missing';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'SELECT') <> 1 then
    raise exception 'TC FAIL: expected exactly one SELECT policy on storage.objects';
  end if;
  foreach v_fragment in array array[
    'attachments',
    '''reports''::text', '''reports.read''::text',
    '''incidents''::text', '''incidents.read''::text',
    '''work_orders''::text', '''work_orders.read''::text',
    '''certifications''::text',
    'evidence_path = objects.name',
    'e.user_id = auth.uid()',
    'ec.deleted_at IS NULL',
    '/certifications/',
    '''training''::text'
  ] loop
    if position(v_fragment in v_qual) = 0 then
      raise exception 'TC FAIL: storage read policy lost the guard/branch fragment [%]: %', v_fragment, v_qual;
    end if;
  end loop;
  -- training.read appears in both the certifications branch and the new
  -- training branch.
  if (length(v_qual) - length(replace(v_qual, '''training.read''::text', ''))) / length('''training.read''::text') <> 2 then
    raise exception 'TC FAIL: expected exactly two training.read checks in the storage read policy';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Function privileges.
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if not has_function_privilege('authenticated', 'public.submit_quiz_attempt(uuid,uuid,jsonb)', 'execute') then
    raise exception 'TC FAIL: authenticated cannot execute the quiz attempt RPC';
  end if;
  foreach v_fn in array array[
    'fn_quiz_attempt_append_only()', 'fn_quiz_module_guard()', 'fn_training_progress_quiz_guard()',
    'fn_training_completion_quiz_guard()', 'fn_training_content_path_facility()'
  ] loop
    if has_function_privilege('authenticated', 'public.' || v_fn, 'execute') then
      raise exception 'TC FAIL: authenticated can execute the definer trigger function %', v_fn;
    end if;
  end loop;
end;
$$;

-- The audit trail captured the quiz definition changes (fn_audit_admin_change).
do $$
begin
  if not exists (
    select 1 from audit_events where entity_table = 'quizzes' and facility_id = '65aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ) then
    raise exception 'TC FAIL: quiz creation produced no config.changed audit event';
  end if;
end;
$$;

rollback;
