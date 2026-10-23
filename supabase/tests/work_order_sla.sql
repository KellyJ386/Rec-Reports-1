-- Verification intent: WO-15/WO-16/WO-21 (0060_work_order_sla.sql), plus the
-- M-1/H-1 fixes from the wave3-slice-3c security review. Covers:
--   1. sla_due_at/first_response_at/sla_breached_at/resolved_at are ordinary,
--      readable columns for anyone who already holds work_orders.read on the
--      row's facility (no new RLS policy needed -- the existing 0026 "for
--      all" manage/read policies already govern the whole row).
--   2. M-1: `authenticated` (any session with a JWT, work_orders.manage
--      included) is REJECTED (42501, via fn_work_orders_guard_sla_breach) on
--      any attempt to set ANY of sla_due_at/first_response_at/resolved_at/
--      sla_breached_at, on both UPDATE and INSERT -- not just
--      sla_breached_at, which is all the pre-fix trigger covered.
--   3. A service-role-standing-in session (no request.jwt.claims set, so
--      auth.uid() reads null -- the same simulation
--      supabase/tests/report_workflow_events.sql already uses for its own
--      service-role-only RPCs) CAN set sla_breached_at directly, and CAN
--      stamp sla_due_at/first_response_at/resolved_at through the new
--      internal.set_work_order_sla_fields RPC -- which `authenticated` has
--      no EXECUTE on at all.
--   4. WO-21: internal.mint_workflow_work_order's per-defect idempotency --
--      two DIFFERENT sourceDefectKey values on the SAME submission each mint
--      their own work order (not collapsed into one); the SAME
--      sourceDefectKey called twice is idempotent (created:false, no second
--      row); created_by is always the submission's own submitted_by.
--   5. H-1: a work_orders.manage holder in facility A cannot INSERT a work
--      order whose source_submission_id names a facility-B submission (the
--      new fn_assert_same_facility guard on the manage WITH CHECK); and even
--      when a foreign-facility row squats on that (facility, submission,
--      defect) key some other way, facility B's own mint still creates its
--      own row (the facility-scoped lookup + unique index).
-- Runs inside a transaction that is rolled back, so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('60000000-0000-0000-0000-000000000a01', 'wosla-manager@test'),
  ('60000000-0000-0000-0000-000000000a02', 'wosla-reader@test'),
  ('60000000-0000-0000-0000-000000000a03', 'wosla-submitter@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('60000000-0000-0000-0000-000000000a01', 'WOSLA Manager', 'wosla-manager@test'),
  ('60000000-0000-0000-0000-000000000a02', 'WOSLA Reader', 'wosla-reader@test'),
  ('60000000-0000-0000-0000-000000000a03', 'WOSLA Submitter', 'wosla-submitter@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('60111111-1111-1111-1111-111111111111', 'WOSLA Org')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '60111111-1111-1111-1111-111111111111', 'WOSLA Facility A')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('60c00000-0000-0000-0000-0000000000c1', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'WOSLA Manager Role'),
  ('60c00000-0000-0000-0000-0000000000c2', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'WOSLA Reader Role'),
  ('60c00000-0000-0000-0000-0000000000c3', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'WOSLA Submitter Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('60c00000-0000-0000-0000-0000000000c1', 'work_orders.manage'),
  ('60c00000-0000-0000-0000-0000000000c1', 'work_orders.read'),
  ('60c00000-0000-0000-0000-0000000000c2', 'work_orders.read'),
  ('60c00000-0000-0000-0000-0000000000c3', 'reports.create'),
  ('60c00000-0000-0000-0000-0000000000c3', 'reports.submit'),
  ('60c00000-0000-0000-0000-0000000000c3', 'reports.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('60d10000-0000-0000-0000-0000000000d1', '60000000-0000-0000-0000-000000000a01', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '60c00000-0000-0000-0000-0000000000c1', 'active'),
  ('60d10000-0000-0000-0000-0000000000d2', '60000000-0000-0000-0000-000000000a02', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '60c00000-0000-0000-0000-0000000000c2', 'active'),
  ('60d10000-0000-0000-0000-0000000000d3', '60000000-0000-0000-0000-000000000a03', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '60c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

insert into work_orders (id, facility_id, title, description, priority, status, sla_due_at)
values (
  '60e00000-0000-0000-0000-0000000000e1', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'Fix pump', 'Pump is leaking', 'high', 'open', now() - interval '1 hour'
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. sla_due_at/first_response_at/sla_breached_at/resolved_at are ordinary
-- readable columns for a work_orders.read holder.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_sla_due_at timestamptz;
begin
  select sla_due_at into v_sla_due_at from work_orders where id = '60e00000-0000-0000-0000-0000000000e1';
  if v_sla_due_at is null then
    raise exception 'WOSLA FAIL: work_orders.read holder could not read sla_due_at';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. M-1: `authenticated` -- even a work_orders.manage holder -- is rejected
-- on any attempt to set ANY of the four SLA columns, on UPDATE...
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    update work_orders set sla_breached_at = now() where id = '60e00000-0000-0000-0000-0000000000e1';
    raise exception 'WOSLA FAIL: authenticated (work_orders.manage) was able to UPDATE sla_breached_at';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    update work_orders set sla_due_at = now() + interval '30 days' where id = '60e00000-0000-0000-0000-0000000000e1';
    raise exception 'WOSLA FAIL: authenticated (work_orders.manage) was able to UPDATE sla_due_at';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    update work_orders set first_response_at = now() where id = '60e00000-0000-0000-0000-0000000000e1';
    raise exception 'WOSLA FAIL: authenticated (work_orders.manage) was able to UPDATE first_response_at';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    update work_orders set resolved_at = now() where id = '60e00000-0000-0000-0000-0000000000e1';
    raise exception 'WOSLA FAIL: authenticated (work_orders.manage) was able to UPDATE resolved_at';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ...and on INSERT, for each of the four columns individually.
do $$
begin
  begin
    insert into work_orders (facility_id, title, description, sla_breached_at)
    values ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Direct insert attempt', 'should be blocked', now());
    raise exception 'WOSLA FAIL: authenticated was able to INSERT a work order with sla_breached_at set';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into work_orders (facility_id, title, description, sla_due_at)
    values ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Direct insert attempt', 'should be blocked', now() + interval '1 day');
    raise exception 'WOSLA FAIL: authenticated was able to INSERT a work order with sla_due_at set';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into work_orders (facility_id, title, description, first_response_at)
    values ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Direct insert attempt', 'should be blocked', now());
    raise exception 'WOSLA FAIL: authenticated was able to INSERT a work order with first_response_at set';
  exception
    when insufficient_privilege then null; -- expected
  end;
  begin
    insert into work_orders (facility_id, title, description, resolved_at)
    values ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Direct insert attempt', 'should be blocked', now());
    raise exception 'WOSLA FAIL: authenticated was able to INSERT a work order with resolved_at set';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- `authenticated` also has no EXECUTE at all on the service-role-only RPC
-- these stamps now go through -- calling it should fail on privilege, not on
-- some downstream validation.
do $$
begin
  begin
    perform public.set_work_order_sla_fields('60e00000-0000-0000-0000-0000000000e1', jsonb_build_object('sla_due_at', now()));
    raise exception 'WOSLA FAIL: authenticated was able to EXECUTE set_work_order_sla_fields';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

-- Verify (RLS bypassed) none of the rejected writes actually applied.
do $$
begin
  if exists (
    select 1 from work_orders
    where id = '60e00000-0000-0000-0000-0000000000e1'
      and (sla_breached_at is not null or first_response_at is not null or resolved_at is not null)
  ) then
    raise exception 'WOSLA FAIL: an SLA column was set despite the rejected write(s)';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A service-role-standing-in session (no request.jwt.claims -- auth.uid()
-- reads null, matching report_workflow_events.sql's own simulation) CAN set
-- sla_breached_at directly, and CAN stamp sla_due_at/first_response_at/
-- resolved_at through internal.set_work_order_sla_fields -- including
-- explicitly clearing resolved_at back to null (the reopen case), which a
-- key OMITTED from p_fields must NOT do to the other two columns.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
do $$
declare
  v_breached_at timestamptz;
begin
  update work_orders set sla_breached_at = now() where id = '60e00000-0000-0000-0000-0000000000e1';
  select sla_breached_at into v_breached_at from work_orders where id = '60e00000-0000-0000-0000-0000000000e1';
  if v_breached_at is null then
    raise exception 'WOSLA FAIL: a service-role session could not set sla_breached_at';
  end if;
end;
$$;

do $$
declare
  v_row work_orders%rowtype;
begin
  -- Plain assignment (`v_row := func();`), NOT `select func() into v_row` --
  -- for a function returning a single composite value, plpgsql's `SELECT
  -- ... INTO row_var` positionally maps the query's ONE column onto
  -- row_var's fields (feeding the whole composite's text form into row_var's
  -- FIRST column, id uuid, and raising exactly the "invalid input syntax for
  -- type uuid" error this comment is here to head off) rather than
  -- recognizing "one column already of a matching composite type" as a
  -- special case. `:=` assignment has no such ambiguity.
  v_row := internal.set_work_order_sla_fields(
    '60e00000-0000-0000-0000-0000000000e1',
    jsonb_build_object('first_response_at', now(), 'resolved_at', now())
  );
  if v_row.first_response_at is null or v_row.resolved_at is null then
    raise exception 'WOSLA FAIL: set_work_order_sla_fields did not stamp first_response_at/resolved_at';
  end if;

  -- A key OMITTED from p_fields leaves that column untouched: stamping only
  -- sla_due_at here must not disturb the first_response_at/resolved_at just
  -- set above.
  v_row := internal.set_work_order_sla_fields(
    '60e00000-0000-0000-0000-0000000000e1',
    jsonb_build_object('sla_due_at', now() + interval '3 days')
  );
  if v_row.first_response_at is null or v_row.resolved_at is null then
    raise exception 'WOSLA FAIL: set_work_order_sla_fields touched an omitted column';
  end if;

  -- Explicitly clearing resolved_at (key present, value null) -- the reopen
  -- case -- must actually null it out, distinct from omitting the key.
  v_row := internal.set_work_order_sla_fields(
    '60e00000-0000-0000-0000-0000000000e1',
    jsonb_build_object('resolved_at', null)
  );
  if v_row.resolved_at is not null then
    raise exception 'WOSLA FAIL: set_work_order_sla_fields did not clear resolved_at when explicitly set to null';
  end if;
  if v_row.first_response_at is null then
    raise exception 'WOSLA FAIL: clearing resolved_at should not have disturbed first_response_at';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. WO-21: internal.mint_workflow_work_order per-defect idempotency +
-- created_by attribution. Submitter (reports.submit, NO work_orders.manage)
-- submits a draft; the mint RPC is exercised directly (standing in for the
-- service-role drain -- see report_workflow_events.sql's own precedent for
-- why this is a faithful simulation).
-- ---------------------------------------------------------------------------
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('60f00000-0000-0000-0000-000000000f00', '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'wosla_tpl', 'WOSLA Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, workflow_json, is_published) values
  (
    '60f00000-0000-0000-0000-000000000f01',
    '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '60f00000-0000-0000-0000-000000000f00',
    1,
    '{"sections":[]}'::jsonb,
    '{}'::jsonb,
    true
  )
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '60f00000-0000-0000-0000-000000000f00' and active_version is null;

select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_submission_id uuid;
begin
  insert into report_submissions (facility_id, template_id, template_version_id, report_date, status)
  values ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '60f00000-0000-0000-0000-000000000f00', '60f00000-0000-0000-0000-000000000f01', '2026-08-13', 'draft')
  returning id into v_submission_id;

  update report_submissions
    set status = 'submitted', submitted_by = '60000000-0000-0000-0000-000000000a03', submitted_at = now()
    where id = v_submission_id;

  perform set_config('wosla_test.submission_id', v_submission_id::text, true);
end;
$$;
reset role;

-- The outsider-style request.jwt.claims set above is transaction-scoped and
-- otherwise stays active even after `reset role` -- clear it explicitly so
-- the direct internal.mint_workflow_work_order calls below genuinely
-- simulate a service-role call with auth.uid() reading null.
select set_config('request.jwt.claims', '', true);

do $$
declare
  v_submission_id uuid := current_setting('wosla_test.submission_id')::uuid;
  v_action_gate jsonb := '{"type":"create_work_order","params":{"priority":"high","sourceDefectKey":"gate_broken"}}'::jsonb;
  v_action_chem jsonb := '{"type":"create_work_order","params":{"priority":"medium","sourceDefectKey":"chemical_level"}}'::jsonb;
  v_result_gate jsonb;
  v_result_gate_retry jsonb;
  v_result_chem jsonb;
  v_gate_id uuid;
  v_chem_id uuid;
  v_wo_count int;
begin
  -- Two DIFFERENT defects on the same submission -> two distinct work orders.
  select internal.mint_workflow_work_order(v_submission_id, v_action_gate) into v_result_gate;
  if (v_result_gate ->> 'created') <> 'true' then
    raise exception 'WOSLA FAIL: first defect mint did not report created:true (saw %)', v_result_gate;
  end if;
  if (v_result_gate -> 'work_order' ->> 'source_defect_key') <> 'gate_broken' then
    raise exception 'WOSLA FAIL: source_defect_key was not persisted on the first defect work order';
  end if;
  if (v_result_gate -> 'work_order' ->> 'created_by') <> '60000000-0000-0000-0000-000000000a03' then
    raise exception 'WOSLA FAIL: created_by was not the report submitter (saw %)', v_result_gate -> 'work_order' ->> 'created_by';
  end if;
  v_gate_id := (v_result_gate -> 'work_order' ->> 'id')::uuid;

  select internal.mint_workflow_work_order(v_submission_id, v_action_chem) into v_result_chem;
  if (v_result_chem ->> 'created') <> 'true' then
    raise exception 'WOSLA FAIL: second (different) defect mint did not report created:true (saw %)', v_result_chem;
  end if;
  v_chem_id := (v_result_chem -> 'work_order' ->> 'id')::uuid;
  if v_chem_id = v_gate_id then
    raise exception 'WOSLA FAIL: two different defects on the same submission collapsed into one work order';
  end if;

  -- The SAME defect key called again is idempotent (created:false, same id).
  select internal.mint_workflow_work_order(v_submission_id, v_action_gate) into v_result_gate_retry;
  if (v_result_gate_retry ->> 'created') <> 'false' then
    raise exception 'WOSLA FAIL: a retried mint for the SAME defect key did not report created:false (saw %)', v_result_gate_retry;
  end if;
  if (v_result_gate_retry -> 'work_order' ->> 'id') <> v_gate_id::text then
    raise exception 'WOSLA FAIL: a retried mint for the SAME defect key returned a different work order id';
  end if;

  select count(*) into v_wo_count from work_orders where source_submission_id = v_submission_id;
  if v_wo_count <> 2 then
    raise exception 'WOSLA FAIL: expected exactly 2 workflow-minted work orders for this submission (one per defect), saw %', v_wo_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. H-1: a work_orders.manage holder in facility A cannot INSERT a work
-- order that names a facility-B submission as source_submission_id (the new
-- fn_assert_same_facility guard on the manage WITH CHECK), and even a
-- foreign-facility row that squats on the (facility, submission, defect) key
-- some other way does not stop facility B's own mint from creating its own
-- row (the facility-scoped lookup + unique index in 0060).
-- ---------------------------------------------------------------------------
insert into organizations (id, name) values
  ('60222222-2222-2222-2222-222222222222', 'WOSLA Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '60222222-2222-2222-2222-222222222222', 'WOSLA Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('60c00000-0000-0000-0000-0000000000c4', '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'WOSLA B Submitter Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('60c00000-0000-0000-0000-0000000000c4', 'reports.create'),
  ('60c00000-0000-0000-0000-0000000000c4', 'reports.submit'),
  ('60c00000-0000-0000-0000-0000000000c4', 'reports.read')
on conflict do nothing;

insert into auth.users (id, email) values
  ('60000000-0000-0000-0000-000000000a04', 'wosla-submitter-b@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('60000000-0000-0000-0000-000000000a04', 'WOSLA Submitter B', 'wosla-submitter-b@test')
on conflict (id) do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('60d10000-0000-0000-0000-0000000000d4', '60000000-0000-0000-0000-000000000a04', '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '60c00000-0000-0000-0000-0000000000c4', 'active')
on conflict (id) do nothing;

insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('60f00000-0000-0000-0000-000000000f10', '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'wosla_b_tpl', 'WOSLA B Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, workflow_json, is_published) values
  (
    '60f00000-0000-0000-0000-000000000f11',
    '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '60f00000-0000-0000-0000-000000000f10',
    1,
    '{"sections":[]}'::jsonb,
    '{}'::jsonb,
    true
  )
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '60f00000-0000-0000-0000-000000000f10' and active_version is null;

select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_submission_b_id uuid;
begin
  insert into report_submissions (facility_id, template_id, template_version_id, report_date, status)
  values ('60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '60f00000-0000-0000-0000-000000000f10', '60f00000-0000-0000-0000-000000000f11', '2026-08-14', 'draft')
  returning id into v_submission_b_id;
  perform set_config('wosla_test.submission_b_id', v_submission_b_id::text, true);
end;
$$;
reset role;

-- 5a: facility A's manage holder cannot INSERT a work order naming facility
-- B's submission as source_submission_id.
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_submission_b_id uuid := current_setting('wosla_test.submission_b_id')::uuid;
begin
  begin
    insert into work_orders (facility_id, title, description, source_type, source_submission_id, source_defect_key)
    values (
      '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Squat', 'Facility A squatting on B''s submission',
      'report', v_submission_b_id, 'gate_broken'
    );
    raise exception 'WOSLA FAIL: facility A manage holder inserted a work order naming facility B''s source_submission_id';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

-- 5b: even when a foreign-facility row squats on that key some other way
-- (simulated here with an RLS-bypassing insert under the transaction's own
-- owner role, standing in for any writer that isn't the fixed WITH CHECK),
-- facility B's own mint still creates its OWN row rather than adopting it.
select set_config('request.jwt.claims', '', true);
do $$
declare
  v_submission_b_id uuid := current_setting('wosla_test.submission_b_id')::uuid;
begin
  insert into work_orders (facility_id, title, description, source_type, source_submission_id, source_defect_key)
  values (
    '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Squat', 'Facility A squatting on B''s submission',
    'report', v_submission_b_id, 'gate_broken'
  );
end;
$$;

do $$
declare
  v_submission_b_id uuid := current_setting('wosla_test.submission_b_id')::uuid;
  v_action jsonb := '{"type":"create_work_order","params":{"priority":"high","sourceDefectKey":"gate_broken"}}'::jsonb;
  v_result jsonb;
  v_wo_facility uuid;
begin
  select internal.mint_workflow_work_order(v_submission_b_id, v_action) into v_result;
  if (v_result ->> 'created') <> 'true' then
    raise exception 'WOSLA FAIL: facility B mint returned created:false despite only a facility-A squat existing (saw %)', v_result;
  end if;
  v_wo_facility := (v_result -> 'work_order' ->> 'facility_id')::uuid;
  if v_wo_facility <> '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' then
    raise exception 'WOSLA FAIL: facility B mint produced a work order on the wrong facility (%)', v_wo_facility;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5c. N-1 (security re-verification): the work_orders manage policy must
-- carry EVERY guard of its latest prior definition. 0061's first version
-- re-created it from 0038's list and dropped 0058's source_followup_id
-- guard, reopening the squatting bypass for incident follow-ups. Two
-- checks: the behavioural one (facility A cannot name a facility-B
-- follow-up) and a structural one against pg_policies listing all seven
-- guarded columns, so a future redefinition cannot drop one silently.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('60e00000-0000-0000-0000-000000000e0b', '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'INC-2026-WOSLAB', 'incident', 'under_review', 'medium', '2026-08-01T00:00:00Z', 'Pool B', 'Facility B incident')
on conflict (id) do nothing;
insert into incident_followup_actions (id, facility_id, incident_id, action_type, status, description) values
  ('60e10000-0000-0000-0000-000000000f0b', '60bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '60e00000-0000-0000-0000-000000000e0b', 'corrective_action', 'open', 'Facility B follow-up')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into work_orders (facility_id, title, description, source_type, source_followup_id)
    values (
      '60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Squat follow-up', 'Facility A squatting on B''s follow-up',
      'incident', '60e10000-0000-0000-0000-000000000f0b'
    );
    raise exception 'WOSLA FAIL (N-1): facility A manage holder inserted a work order naming facility B''s source_followup_id';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

do $$
declare
  v_check text;
  v_col text;
begin
  select pg_get_expr(polwithcheck, polrelid) into v_check
    from pg_policy
    where polrelid = 'work_orders'::regclass and polname = 'work order managers can manage work orders';
  if v_check is null then
    raise exception 'WOSLA FAIL (N-1): the work_orders manage policy is missing';
  end if;
  foreach v_col in array array['asset_id', 'department_id', 'assigned_to_employee_id', 'source_pm_plan_id', 'source_pm_occurrence_id', 'source_submission_id', 'source_followup_id'] loop
    if position(v_col in v_check) = 0 then
      raise exception 'WOSLA FAIL (N-1): the work_orders manage policy no longer guards % -- carry every guard of the latest prior definition forward', v_col;
    end if;
  end loop;
end;
$$;

rollback;
