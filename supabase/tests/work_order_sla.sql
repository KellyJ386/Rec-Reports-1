-- Verification intent: WO-15/WO-16/WO-21 (0060_work_order_sla.sql). Covers:
--   1. sla_due_at/first_response_at/sla_breached_at/resolved_at are ordinary,
--      readable columns for anyone who already holds work_orders.read on the
--      row's facility (no new RLS policy needed -- the existing 0026 "for
--      all" manage/read policies already govern the whole row).
--   2. `authenticated` (any session with a JWT, work_orders.manage included)
--      is REJECTED (42501, via fn_work_orders_guard_sla_breach) on any
--      attempt to set sla_breached_at, on both UPDATE and INSERT.
--   3. A service-role-standing-in session (no request.jwt.claims set, so
--      auth.uid() reads null -- the same simulation
--      supabase/tests/report_workflow_events.sql already uses for its own
--      service-role-only RPCs) CAN set sla_breached_at.
--   4. WO-21: internal.mint_workflow_work_order's per-defect idempotency --
--      two DIFFERENT sourceDefectKey values on the SAME submission each mint
--      their own work order (not collapsed into one); the SAME
--      sourceDefectKey called twice is idempotent (created:false, no second
--      row); created_by is always the submission's own submitted_by.
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
-- 2. `authenticated` -- even a work_orders.manage holder -- is rejected on
-- any attempt to set sla_breached_at, on UPDATE...
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
end;
$$;

-- ...and on INSERT.
do $$
begin
  begin
    insert into work_orders (facility_id, title, description, sla_breached_at)
    values ('60aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Direct insert attempt', 'should be blocked', now());
    raise exception 'WOSLA FAIL: authenticated was able to INSERT a work order with sla_breached_at set';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

-- Verify (RLS bypassed) the rejected UPDATE truly did not apply.
do $$
begin
  if exists (select 1 from work_orders where id = '60e00000-0000-0000-0000-0000000000e1' and sla_breached_at is not null) then
    raise exception 'WOSLA FAIL: sla_breached_at was set despite the rejected UPDATE';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A service-role-standing-in session (no request.jwt.claims -- auth.uid()
-- reads null, matching report_workflow_events.sql's own simulation) CAN set
-- sla_breached_at.
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

rollback;
