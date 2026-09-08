-- Verification intent: IN-17/IN-20 (0058_incident_cross_module.sql). Covers:
--   1. public.create_work_order_from_incident succeeds for a caller who
--      holds incidents.review but NOT work_orders.manage -- the whole point
--      of the elevation RPC -- and mints a work_orders row with
--      source_type='incident', source_followup_id set, plus an
--      incident_audit_events row (event_type 'incident.work_order_created',
--      payload {source:'incident_followup', followup_id, ...}).
--   2. Idempotent: a second call for the SAME follow-up returns the
--      existing row (created:false) -- no second work_orders row, no
--      second audit event.
--   3. Denied (42501/insufficient_privilege) to a caller who holds only
--      incidents.read (neither incidents.manage nor incidents.review).
--   4. Denied to an outsider from a DIFFERENT facility who holds
--      incidents.manage at THEIR OWN facility but not at the follow-up's
--      facility -- the cross-facility rejection.
--   5. incident_training_triggers RLS: an incidents.review holder can
--      INSERT a trigger row; an incidents.read-only caller cannot; SELECT
--      is open to any incidents.read holder; a cross-facility employee_id
--      is rejected by fn_assert_same_facility.
--   6. notification_jobs: the new "incident actors can insert incident
--      notification jobs" policy lets an incidents.review holder insert an
--      'incident.escalated' job through their own client (proving IN-20's
--      real gap -- communications.publish is NOT required), but the SAME
--      caller cannot insert an unrelated event_type through it; the new
--      dedupe_key UNIQUE partial index rejects a bare duplicate INSERT and
--      accepts an ON CONFLICT DO NOTHING retry as a true no-op.
--   7. M2 (security review): quietHoursBypass:true is rejected for a
--      LOW-severity incident (even from an incidents.manage holder) and
--      accepted for a HIGH-severity one -- the RLS policy now enforces the
--      SAME rule buildIncidentNotificationJobs claims to, not just the JS
--      layer. dedupe_key is silently OVERWRITTEN by a BEFORE INSERT trigger
--      regardless of what the client sends, closing the "pre-seed a future
--      genuine emission's key" vector: an escalate-only actor's attempt to
--      set an attacker-chosen dedupe_key never sticks.
-- Runs inside a transaction that is rolled back, so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('58000000-0000-0000-0000-000000000a01', 'icm-reviewer@test'),
  ('58000000-0000-0000-0000-000000000a02', 'icm-reader@test'),
  ('58000000-0000-0000-0000-000000000a03', 'icm-outsider@test'),
  ('58000000-0000-0000-0000-000000000a04', 'icm-escalator@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('58000000-0000-0000-0000-000000000a01', 'ICM Reviewer', 'icm-reviewer@test'),
  ('58000000-0000-0000-0000-000000000a02', 'ICM Reader', 'icm-reader@test'),
  ('58000000-0000-0000-0000-000000000a03', 'ICM Outsider', 'icm-outsider@test'),
  ('58000000-0000-0000-0000-000000000a04', 'ICM Escalator', 'icm-escalator@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('58111111-1111-1111-1111-111111111111', 'ICM Org')
on conflict (id) do nothing;

-- Facility A holds the incident/follow-up under test; Facility B is a
-- different tenant, used only to prove cross-facility rejection (#4).
insert into facilities (id, organization_id, name) values
  ('58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '58111111-1111-1111-1111-111111111111', 'ICM Facility A'),
  ('58bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '58111111-1111-1111-1111-111111111111', 'ICM Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('58c00000-0000-0000-0000-0000000000c1', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ICM Reviewer Role'),
  ('58c00000-0000-0000-0000-0000000000c2', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ICM Reader Role'),
  ('58c00000-0000-0000-0000-0000000000c3', '58bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ICM Outsider Role'),
  ('58c00000-0000-0000-0000-0000000000c4', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ICM Escalator Role')
on conflict (id) do nothing;

-- The reviewer deliberately holds NO work_orders.manage/training.manage --
-- the whole point of #1 is that incidents.review alone reaches the RPC.
-- The escalator (M2/#7 below) deliberately holds ONLY incidents.read +
-- incidents.escalate -- neither incidents.manage nor incidents.review --
-- matching the review's own threat model exactly.
insert into role_permissions (role_id, permission_code) values
  ('58c00000-0000-0000-0000-0000000000c1', 'incidents.read'),
  ('58c00000-0000-0000-0000-0000000000c1', 'incidents.review'),
  ('58c00000-0000-0000-0000-0000000000c2', 'incidents.read'),
  ('58c00000-0000-0000-0000-0000000000c3', 'incidents.manage'),
  ('58c00000-0000-0000-0000-0000000000c4', 'incidents.read'),
  ('58c00000-0000-0000-0000-0000000000c4', 'incidents.escalate')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('58d10000-0000-0000-0000-0000000000d1', '58000000-0000-0000-0000-000000000a01', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '58c00000-0000-0000-0000-0000000000c1', 'active'),
  ('58d10000-0000-0000-0000-0000000000d2', '58000000-0000-0000-0000-000000000a02', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '58c00000-0000-0000-0000-0000000000c2', 'active'),
  ('58d10000-0000-0000-0000-0000000000d3', '58000000-0000-0000-0000-000000000a03', '58bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '58c00000-0000-0000-0000-0000000000c3', 'active'),
  ('58d10000-0000-0000-0000-0000000000d4', '58000000-0000-0000-0000-000000000a04', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '58c00000-0000-0000-0000-0000000000c4', 'active')
on conflict (id) do nothing;

-- One employee per facility -- used both for the cross-facility
-- training-trigger check (#5) and to prove Facility A rows aren't visible
-- from Facility B.
insert into employees (id, facility_id, first_name, last_name, status) values
  ('58e00000-0000-0000-0000-0000000000e1', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex', 'A-Employee', 'active'),
  ('58e00000-0000-0000-0000-0000000000e2', '58bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Blair', 'B-Employee', 'active')
on conflict (id) do nothing;

-- The incident + follow-up under test, both in Facility A, inserted as the
-- superuser fixture-loading role (matches every other supabase/tests/*.sql
-- file's convention of loading fixtures ahead of the `set local role
-- authenticated` sections below).
-- ICM2 is LOW severity, used only by the M2 quietHoursBypass tests (#7)
-- below -- buildIncidentNotificationJobs' own rule only stamps
-- quietHoursBypass:true for high/critical severity, so a low-severity
-- incident is the negative case the RLS policy must now also enforce.
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('58f00000-0000-0000-0000-0000000000f1', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-ICM1', 'incident', 'under_review', 'high', now(), 'Loading dock', 'Forklift near-miss'),
  ('58f00000-0000-0000-0000-0000000000f2', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-ICM2', 'incident', 'under_review', 'low', now(), 'Break room', 'Minor spill, no injury')
on conflict (id) do nothing;

insert into incident_followup_actions (id, facility_id, incident_id, action_type, status, description) values
  ('58f10000-0000-0000-0000-0000000000f1', '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '58f00000-0000-0000-0000-0000000000f1', 'corrective_action', 'open', 'Repaint loading dock lane markings')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. The reviewer (incidents.review, NO work_orders.manage) calls
-- public.create_work_order_from_incident and succeeds.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_result jsonb;
begin
  select public.create_work_order_from_incident('58f10000-0000-0000-0000-0000000000f1') into v_result;
  if (v_result ->> 'created') <> 'true' then
    raise exception 'ICM FAIL: expected created:true on first call, saw %', v_result;
  end if;
  if (v_result -> 'work_order' ->> 'source_type') <> 'incident' then
    raise exception 'ICM FAIL: minted work order source_type was not incident (saw %)', v_result -> 'work_order' ->> 'source_type';
  end if;
  if (v_result -> 'work_order' ->> 'source_followup_id') <> '58f10000-0000-0000-0000-0000000000f1' then
    raise exception 'ICM FAIL: minted work order source_followup_id did not match the follow-up';
  end if;

  perform set_config('icm_test.work_order_id', v_result -> 'work_order' ->> 'id', true);
exception
  when insufficient_privilege then
    raise exception 'ICM FAIL: an incidents.review holder without work_orders.manage was denied create_work_order_from_incident';
end;
$$;

-- Verified via `reset role` (bypasses RLS): the reviewer's OWN session
-- cannot SELECT work_orders at all (they hold no work_orders.read), which
-- is expected and NOT what's under test here -- the RPC call above already
-- proved the write succeeded and returned the row via its own (RLS-bypassing)
-- SECURITY DEFINER return value, matching what the real HTTP route does
-- (it returns rpcResult.work_order directly, never re-queries work_orders
-- through the caller's own client).
reset role;

do $$
declare
  v_wo_count int;
  v_audit_count int;
begin
  select count(*) into v_wo_count from work_orders where source_followup_id = '58f10000-0000-0000-0000-0000000000f1';
  if v_wo_count <> 1 then
    raise exception 'ICM FAIL: expected exactly 1 work_orders row for this follow-up, saw %', v_wo_count;
  end if;

  select count(*) into v_audit_count
    from incident_audit_events
   where incident_id = '58f00000-0000-0000-0000-0000000000f1'
     and event_type = 'incident.work_order_created';
  if v_audit_count <> 1 then
    raise exception 'ICM FAIL: expected exactly 1 incident.work_order_created audit event, saw %', v_audit_count;
  end if;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 2. Idempotent: a second call for the SAME follow-up returns the existing
-- row (created:false) -- no second work_orders row, no second audit event.
-- ---------------------------------------------------------------------------
do $$
declare
  v_result jsonb;
  v_expected_id uuid := current_setting('icm_test.work_order_id')::uuid;
begin
  select public.create_work_order_from_incident('58f10000-0000-0000-0000-0000000000f1') into v_result;
  if (v_result ->> 'created') <> 'false' then
    raise exception 'ICM FAIL: a second call for the same follow-up did not report created:false (saw %)', v_result;
  end if;
  if (v_result -> 'work_order' ->> 'id') <> v_expected_id::text then
    raise exception 'ICM FAIL: the second call returned a different work_order id than the first';
  end if;
end;
$$;

reset role;

do $$
declare
  v_wo_count int;
  v_audit_count int;
begin
  select count(*) into v_wo_count from work_orders where source_followup_id = '58f10000-0000-0000-0000-0000000000f1';
  if v_wo_count <> 1 then
    raise exception 'ICM FAIL: idempotent replay created a SECOND work_orders row (count %)', v_wo_count;
  end if;

  select count(*) into v_audit_count
    from incident_audit_events
   where incident_id = '58f00000-0000-0000-0000-0000000000f1'
     and event_type = 'incident.work_order_created';
  if v_audit_count <> 1 then
    raise exception 'ICM FAIL: idempotent replay wrote a SECOND audit event (count %)', v_audit_count;
  end if;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 5a. incident_training_triggers: the reviewer (incidents.review) can
-- INSERT a trigger row for an employee in their OWN facility.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into incident_training_triggers (facility_id, incident_id, employee_id, target, reason, created_by)
  values (
    '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '58f00000-0000-0000-0000-0000000000f1',
    '58e00000-0000-0000-0000-0000000000e1',
    '{"trainingModuleId":"00000000-0000-0000-0000-000000000000"}'::jsonb,
    'Forklift refresher needed',
    '58000000-0000-0000-0000-000000000a01'
  );
exception
  when insufficient_privilege then
    raise exception 'ICM FAIL: an incidents.review holder was denied inserting incident_training_triggers';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5d. Cross-facility rejection: the SAME reviewer cannot point a trigger row
-- at Facility B's employee -- fn_assert_same_facility on employee_id.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_training_triggers (facility_id, incident_id, employee_id, target, reason)
    values (
      '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '58f00000-0000-0000-0000-0000000000f1',
      '58e00000-0000-0000-0000-0000000000e2', -- Facility B employee
      '{"trainingModuleId":"00000000-0000-0000-0000-000000000000"}'::jsonb,
      'cross-facility attempt'
    );
    raise exception 'ICM FAIL: a training trigger targeting a DIFFERENT facility''s employee was accepted';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6a. notification_jobs: the reviewer can insert an 'incident.escalated' job
-- through their own client -- proving the new incident-scoped INSERT policy
-- closes the gap (communications.publish is NOT held here at all).
-- payload_jsonb.incidentId is included (buildIncidentNotificationJobs' real
-- shape) so the M2 dedupe_key-trigger tests below (7c/7d) exercise a
-- realistic payload; the client-supplied dedupe_key here is deliberately the
-- OLD, pre-M3 three-part shape -- proving the M2 trigger overwrites it
-- regardless of what the client sends (see 6c).
-- ---------------------------------------------------------------------------
do $$
begin
  insert into notification_jobs (facility_id, event_type, payload_jsonb, dedupe_key)
  values (
    '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'incident.escalated',
    '{"incidentId":"58f00000-0000-0000-0000-0000000000f1","recipients":["58e00000-0000-0000-0000-0000000000e1"]}'::jsonb,
    '58f00000-0000-0000-0000-0000000000f1:incident.escalated:58e00000-0000-0000-0000-0000000000e1'
  );
exception
  when insufficient_privilege then
    raise exception 'ICM FAIL: an incidents.review holder was denied inserting an incident.escalated notification_jobs row';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b. The SAME reviewer canNOT use this policy to insert an unrelated
-- event_type (the policy is scoped to the three incident event codes only,
-- not a blanket "incidents.review can write notification_jobs").
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into notification_jobs (facility_id, event_type, payload_jsonb)
    values ('58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'schedule.published', '{}'::jsonb);
    raise exception 'ICM FAIL: an incidents.review holder inserted a notification_jobs row for an unrelated event_type';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6c. M2 (security review): fn_notification_job_dedupe_key silently
-- OVERWRITES the client-supplied dedupe_key with a value computed from
-- facility_id/event_type/payload_jsonb -- so 6a's row does NOT actually
-- carry the old-format literal string it was inserted with. This is the
-- direct proof that a client cannot set an arbitrary, decoupled dedupe_key
-- (the pre-seeding vector M2 flags): whatever string they send is discarded
-- in favor of the DB's own computation. notification_jobs_dedupe_key_uidx:
-- a bare second INSERT whose payload computes to the SAME key raises
-- unique_violation; the same insert with ON CONFLICT (dedupe_key) DO
-- NOTHING is a true no-op (row count unchanged) -- exactly the two shapes
-- pgInsert's plain vs. ignoreDuplicates modes produce over PostgREST.
-- ---------------------------------------------------------------------------
do $$
declare
  v_stored_key text;
begin
  select dedupe_key into v_stored_key from notification_jobs
    where facility_id = '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and event_type = 'incident.escalated'
      and payload_jsonb ->> 'incidentId' = '58f00000-0000-0000-0000-0000000000f1';
  if v_stored_key = '58f00000-0000-0000-0000-0000000000f1:incident.escalated:58e00000-0000-0000-0000-0000000000e1' then
    raise exception 'ICM FAIL: 6a''s client-supplied dedupe_key was stored VERBATIM -- the M2 recompute trigger did not fire';
  end if;
  if v_stored_key is null then
    raise exception 'ICM FAIL: 6a''s row lost its dedupe_key entirely (expected the trigger-computed value, got NULL)';
  end if;
  perform set_config('icm_test.computed_dedupe_key', v_stored_key, true);
end;
$$;

select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_computed_key text := current_setting('icm_test.computed_dedupe_key');
begin
  begin
    -- Same facility/event_type/payload as 6a -- the trigger computes the
    -- IDENTICAL key regardless of what dedupe_key text is supplied here,
    -- so this collides with 6a's row even though the literal string sent
    -- differs.
    insert into notification_jobs (facility_id, event_type, payload_jsonb, dedupe_key)
    values (
      '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'incident.escalated',
      '{"incidentId":"58f00000-0000-0000-0000-0000000000f1","recipients":["58e00000-0000-0000-0000-0000000000e1"]}'::jsonb,
      'attacker-chosen-arbitrary-key'
    );
    raise exception 'ICM FAIL: a bare duplicate (post-recompute) dedupe_key INSERT was accepted (unique index missing, or the recompute trigger is not deterministic)';
  exception
    when unique_violation then null; -- expected
  end;

  insert into notification_jobs (facility_id, event_type, payload_jsonb, dedupe_key)
  values (
    '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'incident.escalated',
    '{"incidentId":"58f00000-0000-0000-0000-0000000000f1","recipients":["58e00000-0000-0000-0000-0000000000e1"]}'::jsonb,
    'another-attacker-chosen-key'
  )
  on conflict (dedupe_key) do nothing;
end;
$$;

reset role;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from notification_jobs
    where dedupe_key = current_setting('icm_test.computed_dedupe_key');
  if v_count <> 1 then
    raise exception 'ICM FAIL: expected exactly 1 notification_jobs row for the trigger-computed dedupe_key after the bare-conflict and ON CONFLICT DO NOTHING attempts, saw %', v_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b/5c. incident_training_triggers: the reader (incidents.read only) can
-- SELECT the trigger row the reviewer created above, but cannot INSERT one.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from incident_training_triggers where incident_id = '58f00000-0000-0000-0000-0000000000f1';
  if v_count <> 1 then
    raise exception 'ICM FAIL: an incidents.read holder could not SELECT the training trigger row (saw % rows)', v_count;
  end if;
end;
$$;

do $$
begin
  begin
    insert into incident_training_triggers (facility_id, incident_id, employee_id, target, reason)
    values (
      '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '58f00000-0000-0000-0000-0000000000f1',
      '58e00000-0000-0000-0000-0000000000e1',
      '{"certificationTypeId":"00000000-0000-0000-0000-000000000000"}'::jsonb,
      'reader attempt'
    );
    raise exception 'ICM FAIL: an incidents.read-only caller was able to INSERT incident_training_triggers';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. public.create_work_order_from_incident is denied (42501) to the reader
-- (incidents.read only -- neither incidents.manage nor incidents.review).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform public.create_work_order_from_incident('58f10000-0000-0000-0000-0000000000f1');
    raise exception 'ICM FAIL: an incidents.read-only caller was able to call create_work_order_from_incident';
  exception
    when insufficient_privilege then null; -- expected (42501)
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-facility rejection: the outsider (incidents.manage at FACILITY B
-- only) is denied create_work_order_from_incident against Facility A's
-- follow-up -- the permission re-check runs against the follow-up's OWN
-- (Facility A) incident, which the outsider holds no permission at.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    perform public.create_work_order_from_incident('58f10000-0000-0000-0000-0000000000f1');
    raise exception 'ICM FAIL: an outsider holding incidents.manage only at a DIFFERENT facility was able to call create_work_order_from_incident against Facility A''s follow-up';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. M2 (security review): quietHoursBypass:true is gated on the REFERENCED
-- incident's own severity, not the caller's permission level -- an actor
-- holding ONLY incidents.escalate (neither incidents.manage nor
-- incidents.review) reaches the INSERT policy either way.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"58000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;

-- 7a. Rejected: quietHoursBypass:true against the LOW-severity incident
-- (ICM2) -- this is the exact probe the review ran (N1): an escalate-only
-- actor paging anyone at 3 AM for a low-severity incident.
do $$
begin
  begin
    insert into notification_jobs (facility_id, event_type, payload_jsonb)
    values (
      '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'incident.escalated',
      jsonb_build_object(
        'incidentId', '58f00000-0000-0000-0000-0000000000f2',
        'recipients', jsonb_build_array('58e00000-0000-0000-0000-0000000000e1'),
        'channels', jsonb_build_array('push', 'email', 'sms'),
        'quietHoursBypass', true,
        'body', 'attacker text'
      )
    );
    raise exception 'ICM FAIL (M2): an incidents.escalate-only actor inserted quietHoursBypass:true against a LOW-severity incident';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- 7b. Accepted: quietHoursBypass:true against the HIGH-severity incident
-- (ICM1) -- the SAME actor, same permission set, only the referenced
-- incident's severity differs. Proves the fix is not simply "no one may
-- ever bypass quiet hours" -- the legitimate high/critical case still
-- works.
do $$
begin
  insert into notification_jobs (facility_id, event_type, payload_jsonb)
  values (
    '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'incident.escalated',
    jsonb_build_object(
      'incidentId', '58f00000-0000-0000-0000-0000000000f1',
      'recipients', jsonb_build_array('58e00000-0000-0000-0000-0000000000e1'),
      'quietHoursBypass', true
    )
  );
exception
  when insufficient_privilege then
    raise exception 'ICM FAIL (M2): quietHoursBypass:true was rejected for a genuinely HIGH-severity incident';
end;
$$;

-- 7c. Rejected: quietHoursBypass:true naming an incidentId that does not
-- resolve to a high/critical row in THIS facility at all (a nonexistent
-- id) -- the exists() sub-select correctly finds no match rather than
-- erroring on a malformed/absent reference.
do $$
begin
  begin
    insert into notification_jobs (facility_id, event_type, payload_jsonb)
    values (
      '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'incident.escalated',
      jsonb_build_object(
        'incidentId', 'not-a-real-incident-id',
        'recipients', jsonb_build_array('58e00000-0000-0000-0000-0000000000e1'),
        'quietHoursBypass', true
      )
    );
    raise exception 'ICM FAIL (M2): quietHoursBypass:true was accepted with a non-resolving/malformed incidentId (expected a clean RLS denial, not a pass)';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- 7d. A quietHoursBypass:false (or absent) row against the LOW-severity
-- incident is unaffected -- the new clause only constrains the bypass flag,
-- never blanket-blocks low-severity notifications.
do $$
begin
  insert into notification_jobs (facility_id, event_type, payload_jsonb)
  values (
    '58aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'incident.escalated',
    jsonb_build_object(
      'incidentId', '58f00000-0000-0000-0000-0000000000f2',
      'recipients', jsonb_build_array('58e00000-0000-0000-0000-0000000000e1')
    )
  );
exception
  when insufficient_privilege then
    raise exception 'ICM FAIL (M2): a normal (non-bypass) notification_jobs insert for a low-severity incident was unexpectedly rejected';
end;
$$;

reset role;

rollback;
