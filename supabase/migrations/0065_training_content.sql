-- ===========================================================================
-- 0065_training_content.sql
-- Wave 3, Slice 3F: TR-07 (quizzes + pass-threshold enforcement) and TR-08
-- (video/PDF module content) -- plans/TRAINING_PLAN.md.
--
-- TR-07 -- quizzes, questions, options, answer keys, attempts:
--   quizzes              one quiz per quiz-type course module (pass score,
--                        optional attempt cap).
--   quiz_questions       ordered questions ('single' | 'multiple' choice).
--   quiz_options         the visible choices of a question. NO answer key
--                        lives here.
--   quiz_option_keys     the answer key (option_id -> is_correct), split into
--                        its own table so a plain SELECT policy can hide it:
--                        only training.manage can read it. An employee taking
--                        the quiz can read quizzes/questions/options but
--                        never a key, and scoring happens inside the
--                        SECURITY DEFINER RPC below -- the key never leaves
--                        the database (the RPC returns counts, never which
--                        option was right).
--   quiz_attempts        append-only ledger of every attempt. There is NO
--                        insert/update/delete policy for any authenticated
--                        caller: the ONLY writer is internal.submit_quiz_attempt
--                        (definer), which (a) re-checks that the caller is the
--                        assignment's own employee, (b) enforces max_attempts,
--                        (c) computes the score from the keys server-side,
--                        and (d) writes the attempt and the module's
--                        training_progress row in one transaction. A BEFORE
--                        UPDATE OR DELETE trigger (Guard 1 of
--                        fn_quiz_attempt_append_only) makes the table
--                        immutable for every role, service role included.
--
--   Completion gating (Guards on EXISTING tables, no policy re-created):
--     * fn_training_progress_quiz_guard -- a training_progress row for a
--       module that carries a quiz may move to state 'completed' only when a
--       passing quiz_attempts row exists for that assignment. This closes the
--       self-service hole 0036 left open (an employee could previously write
--       state='completed' for any module directly).
--     * fn_training_completion_quiz_guard -- a training_completions row with
--       completion_status = 'passed' is refused while any REQUIRED quiz
--       module of the assignment's course has no passing attempt. A 'waived'
--       completion is the supervisor override: it now requires training.manage
--       (0039 let an employee record ANY status for their own assignment, which
--       would have made "waive it yourself" a way around a quiz); 'failed'
--       completions are unaffected.
--
-- TR-08 -- training_content_items: video/PDF files attached to a course
-- module, stored under facilities/{facilityId}/training/{moduleId}/{file}.
--   * fn_training_content_path_facility (BEFORE INSERT OR UPDATE) mirrors
--     0041/0056's fn_attachment_path_facility but binds the path to the ROW'S
--     OWN facility AND module id (the L1-style record binding 0056 added for
--     signatures), and requires the item's kind to match its module's type.
--     It is a separate function on purpose: the shared 0041/0056 function is
--     not touched.
--   * storage.objects read policy: the LATEST prior definition is 0040's
--     "facility members can read module-scoped attachments" (grepped every
--     migration; nothing after 0040 redefines it). It is re-created here with
--     all four existing branches carried forward verbatim (reports, incidents,
--     work_orders, certifications -- including the certifications owner
--     branch with all four of its M-1 conditions) plus a new `training`
--     branch gated on training.read. supabase/tests/training_content.sql
--     asserts the full branch list against pg_policies.
--
-- Idempotency conventions (mirroring 0009-0061): `create table if not
-- exists`, drop-policy-if-exists immediately before every create policy,
-- split per-operation policies (never `for all`), definer functions carry
-- `set search_path = public` and have EXECUTE revoked from public and
-- authenticated (anon guarded through pg_roles), every internal.* helper call
-- is schema-qualified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) quizzes
-- ---------------------------------------------------------------------------
create table if not exists quizzes (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  module_id uuid not null references course_modules(id) on delete cascade,
  title text not null,
  pass_score_pct numeric(5, 2) not null default 80 check (pass_score_pct >= 1 and pass_score_pct <= 100),
  max_attempts integer check (max_attempts is null or max_attempts >= 1),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (module_id)
);

create index if not exists quizzes_facility_idx on quizzes(facility_id) where deleted_at is null;

alter table quizzes enable row level security;

drop policy if exists "training readers can read quizzes" on quizzes;
create policy "training readers can read quizzes" on quizzes
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.read') and deleted_at is null);

drop policy if exists "training managers can create quizzes" on quizzes;
create policy "training managers can create quizzes" on quizzes
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'course_modules', module_id)
  );

drop policy if exists "training managers can update quizzes" on quizzes;
create policy "training managers can update quizzes" on quizzes
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage') and deleted_at is null)
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'course_modules', module_id)
  );

drop policy if exists "training managers can delete quizzes" on quizzes;
create policy "training managers can delete quizzes" on quizzes
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

-- ---------------------------------------------------------------------------
-- (b) quiz_questions
-- ---------------------------------------------------------------------------
create table if not exists quiz_questions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  quiz_id uuid not null references quizzes(id) on delete cascade,
  prompt text not null,
  question_type text not null default 'single' check (question_type in ('single', 'multiple')),
  points integer not null default 1 check (points >= 1),
  order_no integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Partial: a soft-deleted question releases its order_no.
create unique index if not exists quiz_questions_quiz_order_uidx on quiz_questions(quiz_id, order_no) where deleted_at is null;
create index if not exists quiz_questions_quiz_idx on quiz_questions(facility_id, quiz_id, order_no) where deleted_at is null;

alter table quiz_questions enable row level security;

drop policy if exists "training readers can read quiz questions" on quiz_questions;
create policy "training readers can read quiz questions" on quiz_questions
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.read') and deleted_at is null);

drop policy if exists "training managers can create quiz questions" on quiz_questions;
create policy "training managers can create quiz questions" on quiz_questions
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'quizzes', quiz_id)
  );

drop policy if exists "training managers can update quiz questions" on quiz_questions;
create policy "training managers can update quiz questions" on quiz_questions
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage') and deleted_at is null)
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'quizzes', quiz_id)
  );

drop policy if exists "training managers can delete quiz questions" on quiz_questions;
create policy "training managers can delete quiz questions" on quiz_questions
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

-- ---------------------------------------------------------------------------
-- (c) quiz_options -- the visible choices. NO is_correct column on purpose;
-- see quiz_option_keys below.
-- ---------------------------------------------------------------------------
create table if not exists quiz_options (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  question_id uuid not null references quiz_questions(id) on delete cascade,
  label text not null,
  order_no integer not null,
  created_at timestamptz not null default now(),
  unique (question_id, order_no)
);

create index if not exists quiz_options_question_idx on quiz_options(facility_id, question_id, order_no);

alter table quiz_options enable row level security;

drop policy if exists "training readers can read quiz options" on quiz_options;
create policy "training readers can read quiz options" on quiz_options
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.read'));

drop policy if exists "training managers can create quiz options" on quiz_options;
create policy "training managers can create quiz options" on quiz_options
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'quiz_questions', question_id)
  );

drop policy if exists "training managers can update quiz options" on quiz_options;
create policy "training managers can update quiz options" on quiz_options
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'quiz_questions', question_id)
  );

drop policy if exists "training managers can delete quiz options" on quiz_options;
create policy "training managers can delete quiz options" on quiz_options
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

-- ---------------------------------------------------------------------------
-- (d) quiz_option_keys -- the answer key. SELECT is training.manage ONLY:
-- a training.read employee (who can read every option label) can never read
-- is_correct, through PostgREST or otherwise.
-- ---------------------------------------------------------------------------
create table if not exists quiz_option_keys (
  option_id uuid primary key references quiz_options(id) on delete cascade,
  facility_id uuid not null references facilities(id) on delete cascade,
  is_correct boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists quiz_option_keys_facility_idx on quiz_option_keys(facility_id);

alter table quiz_option_keys enable row level security;

drop policy if exists "training managers can read quiz option keys" on quiz_option_keys;
create policy "training managers can read quiz option keys" on quiz_option_keys
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

drop policy if exists "training managers can create quiz option keys" on quiz_option_keys;
create policy "training managers can create quiz option keys" on quiz_option_keys
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'quiz_options', option_id)
  );

drop policy if exists "training managers can update quiz option keys" on quiz_option_keys;
create policy "training managers can update quiz option keys" on quiz_option_keys
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'quiz_options', option_id)
  );

drop policy if exists "training managers can delete quiz option keys" on quiz_option_keys;
create policy "training managers can delete quiz option keys" on quiz_option_keys
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

-- ---------------------------------------------------------------------------
-- (e) quiz_attempts -- append-only. SELECT only: a manager sees every
-- attempt, an employee sees their own. No INSERT/UPDATE/DELETE policy exists
-- for authenticated: internal.submit_quiz_attempt is the single writer.
-- ---------------------------------------------------------------------------
create table if not exists quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id),
  quiz_id uuid not null references quizzes(id),
  assignment_id uuid not null references training_assignments(id),
  employee_id uuid not null references employees(id),
  attempt_no integer not null check (attempt_no >= 1),
  answers_jsonb jsonb not null default '{}'::jsonb,
  score_pct numeric(5, 2) not null check (score_pct >= 0 and score_pct <= 100),
  correct_count integer not null check (correct_count >= 0),
  total_questions integer not null check (total_questions >= 1),
  passed boolean not null,
  submitted_by uuid references app_users(id),
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (assignment_id, quiz_id, attempt_no)
);

create index if not exists quiz_attempts_assignment_idx on quiz_attempts(facility_id, assignment_id, quiz_id);

alter table quiz_attempts enable row level security;

drop policy if exists "training managers can read quiz attempts" on quiz_attempts;
create policy "training managers can read quiz attempts" on quiz_attempts
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

drop policy if exists "employees can read their own quiz attempts" on quiz_attempts;
create policy "employees can read their own quiz attempts" on quiz_attempts
  for select
  using (
    internal.has_permission((select auth.uid()), facility_id, 'training.read')
    and exists (
      select 1 from employees e
      where e.id = quiz_attempts.employee_id
        and e.user_id = (select auth.uid())
    )
  );

-- Guard 1: quiz_attempts is append-only for EVERY role (service role and
-- table owner included): an attempt is the evidence a completion rests on.
create or replace function fn_quiz_attempt_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard 1: no UPDATE and no DELETE, ever.
  raise exception 'quiz attempts are append-only; % on % is not permitted', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists quiz_attempts_append_only on quiz_attempts;
create trigger quiz_attempts_append_only
  before update or delete on quiz_attempts
  for each row execute function fn_quiz_attempt_append_only();

revoke execute on function fn_quiz_attempt_append_only() from public, authenticated;

-- ---------------------------------------------------------------------------
-- (f) Quiz structure guards: a quiz may only hang off a quiz-type module of
-- the same facility.
-- ---------------------------------------------------------------------------
create or replace function fn_quiz_module_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_facility uuid;
begin
  select module_type, facility_id into v_type, v_facility from course_modules where id = new.module_id;
  -- Guard 1: the module must exist and belong to the quiz's own facility.
  if v_facility is null or v_facility <> new.facility_id then
    raise exception 'quiz module % does not belong to facility %', new.module_id, new.facility_id
      using errcode = 'check_violation';
  end if;
  -- Guard 2: only quiz-type modules carry a quiz.
  if v_type <> 'quiz' then
    raise exception 'module % is of type %, not quiz', new.module_id, v_type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists quizzes_module_guard on quizzes;
create trigger quizzes_module_guard
  before insert or update of module_id, facility_id on quizzes
  for each row execute function fn_quiz_module_guard();

revoke execute on function fn_quiz_module_guard() from public, authenticated;

-- ---------------------------------------------------------------------------
-- (g) Completion gating guards on the EXISTING training_progress /
-- training_completions tables.
-- ---------------------------------------------------------------------------
create or replace function fn_training_progress_quiz_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state = 'completed' then
    -- Guard 1: a module that carries a quiz is completed only by passing it.
    if exists (
      select 1 from quizzes q
      where q.module_id = new.module_id and q.deleted_at is null
    ) and not exists (
      select 1
      from quiz_attempts a
      join quizzes q on q.id = a.quiz_id
      where q.module_id = new.module_id
        and a.assignment_id = new.assignment_id
        and a.passed
    ) then
      raise exception 'module % has a quiz: it is completed by a passing attempt, not by a progress write', new.module_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists training_progress_quiz_guard on training_progress;
create trigger training_progress_quiz_guard
  before insert or update on training_progress
  for each row execute function fn_training_progress_quiz_guard();

revoke execute on function fn_training_progress_quiz_guard() from public, authenticated;

create or replace function fn_training_completion_quiz_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard 2: a 'waived' completion is a supervisor's override -- through an
  -- authenticated session it needs training.manage on the facility. (0039
  -- lets an employee record ANY completion_status for their own assignment;
  -- without this an employee could waive a quiz instead of passing it.
  -- Service-role writers, where auth.uid() is null, are not affected.)
  if new.completion_status = 'waived'
     and auth.uid() is not null
     and not internal.has_permission(auth.uid(), new.facility_id, 'training.manage') then
    raise exception 'only a training manager can waive an assignment'
      using errcode = 'insufficient_privilege';
  end if;

  if new.completion_status = 'passed' then
    -- Guard 1: every REQUIRED quiz module of the assignment's course needs a
    -- passing attempt before a 'passed' completion can be recorded.
    if exists (
      select 1
      from training_assignments ta
      join course_modules m on m.course_id = ta.course_id and m.deleted_at is null and m.required
      join quizzes q on q.module_id = m.id and q.deleted_at is null
      where ta.id = new.assignment_id
        and not exists (
          select 1 from quiz_attempts a
          where a.quiz_id = q.id and a.assignment_id = ta.id and a.passed
        )
    ) then
      raise exception 'assignment % has a required quiz without a passing attempt', new.assignment_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists training_completions_quiz_guard on training_completions;
create trigger training_completions_quiz_guard
  before insert on training_completions
  for each row execute function fn_training_completion_quiz_guard();

revoke execute on function fn_training_completion_quiz_guard() from public, authenticated;

-- ---------------------------------------------------------------------------
-- (h) internal.submit_quiz_attempt -- the single server-side scorer.
-- SECURITY DEFINER, granted to authenticated, re-checks everything itself:
--   * caller must be the assignment's own employee (employees.user_id =
--     auth.uid()) AND hold training.read -- a manager cannot submit on an
--     employee's behalf, and an employee cannot submit for anyone else;
--   * the quiz must belong to the assignment's course and facility;
--   * an already-completed assignment, an already-passed quiz, and an
--     exhausted max_attempts are refused (PT409);
--   * the score is computed from quiz_option_keys here, never supplied by the
--     caller; a question counts only when the selected set EQUALS the correct
--     set; the result carries counts, never which option was correct.
-- Error mapping uses PostgREST's PTnnn custom status SQLSTATEs (PT400/PT404/
-- PT409) plus 42501 (403) and 28000 (auth).
-- ---------------------------------------------------------------------------
create or replace function internal.submit_quiz_attempt(
  p_assignment_id uuid,
  p_quiz_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_assignment training_assignments%rowtype;
  v_quiz quizzes%rowtype;
  v_module course_modules%rowtype;
  v_attempt_count integer;
  v_attempt_no integer;
  v_total_points numeric := 0;
  v_earned_points numeric := 0;
  v_correct integer := 0;
  v_questions integer := 0;
  v_score numeric(5, 2);
  v_passed boolean;
  v_question record;
  v_selected uuid[];
  v_correct_ids uuid[];
  v_normalized jsonb := '{}'::jsonb;
  v_attempt quiz_attempts%rowtype;
begin
  if v_actor is null then
    raise exception 'submit_quiz_attempt: authentication required' using errcode = '28000';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'submit_quiz_attempt: answers must be a JSON object keyed by question id' using errcode = 'PT400';
  end if;

  select * into v_assignment from training_assignments where id = p_assignment_id and deleted_at is null;
  if not found then
    raise exception 'submit_quiz_attempt: training assignment not found' using errcode = 'PT404';
  end if;

  if not exists (
    select 1 from employees e where e.id = v_assignment.employee_id and e.user_id = v_actor
  ) or not internal.has_permission(v_actor, v_assignment.facility_id, 'training.read') then
    raise exception 'submit_quiz_attempt: a quiz attempt can only be submitted for your own training assignment'
      using errcode = '42501';
  end if;

  select * into v_quiz from quizzes where id = p_quiz_id and deleted_at is null;
  if not found or v_quiz.facility_id <> v_assignment.facility_id then
    raise exception 'submit_quiz_attempt: quiz not found' using errcode = 'PT404';
  end if;
  select * into v_module from course_modules where id = v_quiz.module_id and deleted_at is null;
  if not found or v_module.course_id <> v_assignment.course_id then
    raise exception 'submit_quiz_attempt: quiz is not part of this assignment''s course' using errcode = 'PT404';
  end if;

  -- Serialise concurrent submissions for one assignment so attempt_no and the
  -- max_attempts check cannot race (the unique constraint is the backstop).
  perform 1 from training_assignments where id = p_assignment_id for update;

  if exists (select 1 from training_completions where assignment_id = p_assignment_id) then
    raise exception 'submit_quiz_attempt: this assignment is already completed' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from quiz_attempts where assignment_id = p_assignment_id and quiz_id = p_quiz_id and passed
  ) then
    raise exception 'submit_quiz_attempt: this quiz has already been passed' using errcode = 'PT409';
  end if;

  select count(*) into v_attempt_count
  from quiz_attempts where assignment_id = p_assignment_id and quiz_id = p_quiz_id;
  if v_quiz.max_attempts is not null and v_attempt_count >= v_quiz.max_attempts then
    raise exception 'submit_quiz_attempt: the maximum number of attempts (%) has been reached', v_quiz.max_attempts
      using errcode = 'PT409';
  end if;
  v_attempt_no := v_attempt_count + 1;

  for v_question in
    select id, points from quiz_questions
    where quiz_id = v_quiz.id and deleted_at is null
    order by order_no
  loop
    v_questions := v_questions + 1;
    v_total_points := v_total_points + v_question.points;

    select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]) into v_selected
    from quiz_options o
    where o.question_id = v_question.id
      and o.id::text in (
        select jsonb_array_elements_text(
          case when jsonb_typeof(p_answers -> v_question.id::text) = 'array'
            then p_answers -> v_question.id::text else '[]'::jsonb end
        )
      );

    select coalesce(array_agg(k.option_id order by k.option_id), '{}'::uuid[]) into v_correct_ids
    from quiz_option_keys k
    join quiz_options o on o.id = k.option_id
    where o.question_id = v_question.id and k.is_correct;

    if cardinality(v_correct_ids) > 0 and v_selected = v_correct_ids then
      v_earned_points := v_earned_points + v_question.points;
      v_correct := v_correct + 1;
    end if;
    v_normalized := v_normalized || jsonb_build_object(v_question.id::text, to_jsonb(v_selected));
  end loop;

  if v_questions = 0 then
    raise exception 'submit_quiz_attempt: this quiz has no questions' using errcode = 'PT400';
  end if;

  v_score := round((v_earned_points / v_total_points) * 100, 2);
  v_passed := v_score >= v_quiz.pass_score_pct;

  begin
    insert into quiz_attempts (
      facility_id, quiz_id, assignment_id, employee_id, attempt_no,
      answers_jsonb, score_pct, correct_count, total_questions, passed, submitted_by
    ) values (
      v_assignment.facility_id, v_quiz.id, v_assignment.id, v_assignment.employee_id, v_attempt_no,
      v_normalized, v_score, v_correct, v_questions, v_passed, v_actor
    )
    returning * into v_attempt;
  exception
    when unique_violation then
      raise exception 'submit_quiz_attempt: a concurrent attempt was recorded; retry' using errcode = 'PT409';
  end;

  insert into training_progress (
    facility_id, assignment_id, module_id, state, started_at, completed_at, score_pct, attempts
  ) values (
    v_assignment.facility_id, v_assignment.id, v_quiz.module_id,
    case when v_passed then 'completed' else 'failed' end,
    now(), case when v_passed then now() else null end, v_score, v_attempt_no
  )
  on conflict (assignment_id, module_id) do update set
    state = excluded.state,
    started_at = coalesce(training_progress.started_at, excluded.started_at),
    completed_at = excluded.completed_at,
    score_pct = excluded.score_pct,
    attempts = excluded.attempts,
    updated_at = now();

  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'attempt_no', v_attempt_no,
    'score_pct', v_score,
    'passed', v_passed,
    'correct_count', v_correct,
    'total_questions', v_questions,
    'pass_score_pct', v_quiz.pass_score_pct,
    'max_attempts', v_quiz.max_attempts,
    'attempts_remaining', case when v_quiz.max_attempts is null then null else greatest(v_quiz.max_attempts - v_attempt_no, 0) end,
    'progress_state', case when v_passed then 'completed' else 'failed' end
  );
end;
$$;

revoke execute on function internal.submit_quiz_attempt(uuid, uuid, jsonb) from public;
grant execute on function internal.submit_quiz_attempt(uuid, uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.submit_quiz_attempt(uuid, uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.submit_quiz_attempt(uuid, uuid, jsonb) to service_role;
  end if;
end
$$;

-- PostgREST only serves `public`; this thin SECURITY INVOKER wrapper is what
-- training-content-routes.mjs's pgRpc call posts to. No logic of its own.
create or replace function public.submit_quiz_attempt(
  p_assignment_id uuid,
  p_quiz_id uuid,
  p_answers jsonb
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.submit_quiz_attempt(p_assignment_id, p_quiz_id, p_answers);
$$;

revoke execute on function public.submit_quiz_attempt(uuid, uuid, jsonb) from public;
grant execute on function public.submit_quiz_attempt(uuid, uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.submit_quiz_attempt(uuid, uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.submit_quiz_attempt(uuid, uuid, jsonb) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (i) TR-08 training_content_items.
-- ---------------------------------------------------------------------------
create table if not exists training_content_items (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  module_id uuid not null references course_modules(id) on delete cascade,
  kind text not null check (kind in ('video', 'pdf')),
  title text not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum_sha256 text,
  order_no integer not null default 0,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists training_content_items_module_idx
  on training_content_items(facility_id, module_id, order_no) where deleted_at is null;

alter table training_content_items enable row level security;

drop policy if exists "training readers can read content items" on training_content_items;
create policy "training readers can read content items" on training_content_items
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.read') and deleted_at is null);

drop policy if exists "training managers can create content items" on training_content_items;
create policy "training managers can create content items" on training_content_items
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'course_modules', module_id)
  );

drop policy if exists "training managers can update content items" on training_content_items;
create policy "training managers can update content items" on training_content_items
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage') and deleted_at is null)
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'course_modules', module_id)
  );

drop policy if exists "training managers can delete content items" on training_content_items;
create policy "training managers can delete content items" on training_content_items
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

-- Mirror of 0041/0056 fn_attachment_path_facility for the new table: the path
-- must be exactly facilities/<row facility>/training/<row module id>/<file>
-- (no dot segments, no extra levels), and the item's kind must match its
-- module's type.
create or replace function fn_training_content_path_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module_type text;
  v_module_facility uuid;
begin
  -- Guard 1: positive, anchored path regex bound to the row's own facility
  -- AND module id.
  if new.storage_path !~ (
    '^facilities/' || new.facility_id::text ||
    '/training/' || new.module_id::text ||
    '/(?!\.\.?$)[^/]+$'
  ) then
    raise exception 'training content path % does not match facilities/%/training/%/<filename>',
      new.storage_path, new.facility_id, new.module_id
      using errcode = 'check_violation';
  end if;

  select module_type, facility_id into v_module_type, v_module_facility
  from course_modules where id = new.module_id;
  -- Guard 2: the module must live in the item's own facility.
  if v_module_facility is null or v_module_facility <> new.facility_id then
    raise exception 'training content module % does not belong to facility %', new.module_id, new.facility_id
      using errcode = 'check_violation';
  end if;
  -- Guard 3: video items live on video modules, pdf items on pdf modules.
  if v_module_type is distinct from new.kind then
    raise exception 'content kind % does not match module type %', new.kind, v_module_type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists training_content_items_path_facility on training_content_items;
create trigger training_content_items_path_facility
  before insert or update on training_content_items
  for each row execute function fn_training_content_path_facility();

revoke execute on function fn_training_content_path_facility() from public, authenticated;

-- ---------------------------------------------------------------------------
-- (j) Audit trail: quiz definitions and content attachments are admin
-- configuration (config.changed rows via fn_audit_admin_change, 0010/0018).
-- Answer keys are deliberately NOT audited row-by-row (the audit ledger is
-- readable by admin.manage holders, who need not hold training.manage).
-- ---------------------------------------------------------------------------
drop trigger if exists quizzes_audit_change on quizzes;
create trigger quizzes_audit_change
  after insert or update or delete on quizzes
  for each row execute function fn_audit_admin_change();

drop trigger if exists training_content_items_audit_change on training_content_items;
create trigger training_content_items_audit_change
  after insert or update or delete on training_content_items
  for each row execute function fn_audit_admin_change();

-- ---------------------------------------------------------------------------
-- (k) Anon revokes for every definer trigger function created above.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_quiz_attempt_append_only() from anon;
    revoke execute on function fn_quiz_module_guard() from anon;
    revoke execute on function fn_training_progress_quiz_guard() from anon;
    revoke execute on function fn_training_completion_quiz_guard() from anon;
    revoke execute on function fn_training_content_path_facility() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (l) storage.objects read policy: 0040's definition (LATEST prior; nothing
-- after 0040 redefines it) carried forward in full, plus the `training`
-- branch. has_permission is called as internal.has_permission (0042 moved it;
-- the policy OID resolution is identical).
--
-- Branches (asserted against pg_policies in supabase/tests/training_content.sql):
--   reports        -> reports.read
--   incidents      -> incidents.read
--   work_orders    -> work_orders.read
--   certifications -> training.read OR the certification's own employee, with
--                     all four M-1 conditions (evidence_path = name,
--                     employees.user_id = auth.uid(), ec.deleted_at is null,
--                     name under the certification's own
--                     facilities/<fid>/certifications/<ec.id>/ prefix)
--   training       -> training.read   (NEW, TR-08)
-- ---------------------------------------------------------------------------
drop policy if exists "facility members can read module-scoped attachments" on storage.objects;
create policy "facility members can read module-scoped attachments"
  on storage.objects
  for select
  using (
    bucket_id = 'attachments'
    and (
      (
        fn_storage_attachment_module(name) = 'reports'
        and internal.has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'reports.read')
      )
      or (
        fn_storage_attachment_module(name) = 'incidents'
        and internal.has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'incidents.read')
      )
      or (
        fn_storage_attachment_module(name) = 'work_orders'
        and internal.has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'work_orders.read')
      )
      or (
        fn_storage_attachment_module(name) = 'certifications'
        and (
          internal.has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'training.read')
          or exists (
            select 1
            from employee_certifications ec
            join employees e on e.id = ec.employee_id
            where ec.evidence_path = name
              and e.user_id = auth.uid()
              and ec.deleted_at is null
              and name like ('facilities/' || ec.facility_id::text || '/certifications/' || ec.id::text || '/%')
          )
        )
      )
      or (
        fn_storage_attachment_module(name) = 'training'
        and internal.has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'training.read')
      )
    )
  );

notify pgrst, 'reload schema';
