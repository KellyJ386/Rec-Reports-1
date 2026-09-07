-- Verification intent: DR-19/DR-20 (0053_report_workflow_events.sql). Covers:
--   1. A submitter (reports.submit, NO incidents.manage/work_orders.manage)
--      can submit a draft and call public.enqueue_report_workflow, which
--      persists one report_workflow_events row per action (idempotent via
--      unique(submission_id, event_type) -- a second identical call adds no
--      new rows) plus one outbox_events 'report.submitted' row.
--   2. A reports.read-only reader can SELECT report_workflow_events.
--   3. `authenticated` cannot INSERT into report_workflow_events directly --
--      no such policy exists; only the two RPC pairs write it.
--   4. public.enqueue_report_workflow is denied (42501) to a caller who
--      lacks reports.submit, and to an outsider from a DIFFERENT facility
--      (cross-facility rejection) even though the outsider holds
--      reports.submit at their OWN facility.
--   5. internal.mint_workflow_incident/mint_workflow_work_order: grants are
--      service_role ONLY -- not authenticated, not public -- closing the
--      exact privilege-elevation path DR-20's Opus review targets.
--   6. Calling internal.mint_workflow_incident (standing in for the
--      service-role drain) mints a 'draft' incident attributed to the
--      report's submitter, with provenance ({source:'report_workflow',
--      submission_id}) landing in the audit_events row via
--      fn_incident_report_audit's session-setting hook, actor_user_id NULL.
--      A second call is idempotent (created:false, row count unchanged).
--   7. The SAME submitter who triggered that workflow-minted incident
--      CANNOT insert an incident_reports row directly (no incidents.manage)
--      -- proving "workflow via service role, never directly" end to end.
--   8. internal.mint_workflow_work_order mints a work order (source_type
--      'report', source_submission_id set) and is equally idempotent.
-- Runs inside a transaction that is rolled back, so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('53000000-0000-0000-0000-000000000a01', 'rwe-submitter@test'),
  ('53000000-0000-0000-0000-000000000a02', 'rwe-reader@test'),
  ('53000000-0000-0000-0000-000000000a03', 'rwe-outsider@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('53000000-0000-0000-0000-000000000a01', 'RWE Submitter', 'rwe-submitter@test'),
  ('53000000-0000-0000-0000-000000000a02', 'RWE Reader', 'rwe-reader@test'),
  ('53000000-0000-0000-0000-000000000a03', 'RWE Outsider', 'rwe-outsider@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('53111111-1111-1111-1111-111111111111', 'RWE Org')
on conflict (id) do nothing;

-- Facility A holds the submission under test; Facility B is a different
-- tenant, used only to prove cross-facility rejection (#4).
insert into facilities (id, organization_id, name) values
  ('53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '53111111-1111-1111-1111-111111111111', 'RWE Facility A'),
  ('53bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '53111111-1111-1111-1111-111111111111', 'RWE Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('53c00000-0000-0000-0000-0000000000c1', '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RWE Filer Role'),
  ('53c00000-0000-0000-0000-0000000000c2', '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RWE Reader Role'),
  ('53c00000-0000-0000-0000-0000000000c3', '53bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'RWE Outsider Filer Role')
on conflict (id) do nothing;

-- The submitter deliberately holds NO incidents.manage/work_orders.manage --
-- the whole point of this fixture is that a plain report filer still ends up
-- with a workflow-minted incident/work order without ever holding either.
insert into role_permissions (role_id, permission_code) values
  ('53c00000-0000-0000-0000-0000000000c1', 'reports.create'),
  ('53c00000-0000-0000-0000-0000000000c1', 'reports.submit'),
  ('53c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('53c00000-0000-0000-0000-0000000000c2', 'reports.read'),
  ('53c00000-0000-0000-0000-0000000000c3', 'reports.create'),
  ('53c00000-0000-0000-0000-0000000000c3', 'reports.submit'),
  ('53c00000-0000-0000-0000-0000000000c3', 'reports.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('53d10000-0000-0000-0000-0000000000d1', '53000000-0000-0000-0000-000000000a01', '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '53c00000-0000-0000-0000-0000000000c1', 'active'),
  ('53d10000-0000-0000-0000-0000000000d2', '53000000-0000-0000-0000-000000000a02', '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '53c00000-0000-0000-0000-0000000000c2', 'active'),
  ('53d10000-0000-0000-0000-0000000000d3', '53000000-0000-0000-0000-000000000a03', '53bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '53c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

-- Template + published version (active_version set only AFTER the matching
-- version row exists -- fn_report_template_active_version_published, 0028
-- -- same two-step insert order as supabase/tests/report_audit.sql).
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('53e00000-0000-0000-0000-000000000e00', '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rwe_tpl', 'RWE Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, workflow_json, is_published) values
  (
    '53e00000-0000-0000-0000-000000000e01',
    '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '53e00000-0000-0000-0000-000000000e00',
    1,
    '{"sections":[]}'::jsonb,
    '{"on_submit":[{"type":"queue_pdf"},{"type":"create_incident","params":{"severity":"high"}},{"type":"create_work_order","params":{"priority":"high"}}]}'::jsonb,
    true
  )
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '53e00000-0000-0000-0000-000000000e00' and active_version is null;

-- ---------------------------------------------------------------------------
-- 1a. Submitter: draft create -> submit, under their own RLS-scoped session
-- (mirrors report_audit.sql's real-API-shaped flow).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"53000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_submission_id uuid;
begin
  insert into report_submissions (facility_id, template_id, template_version_id, report_date, status)
  values ('53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '53e00000-0000-0000-0000-000000000e00', '53e00000-0000-0000-0000-000000000e01', '2026-08-13', 'draft')
  returning id into v_submission_id;

  update report_submissions
    set status = 'submitted', submitted_by = '53000000-0000-0000-0000-000000000a01', submitted_at = now()
    where id = v_submission_id;

  perform set_config('rwe_test.submission_id', v_submission_id::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1b. public.enqueue_report_workflow: succeeds for the submitter, persisting
-- 3 pending events (idempotent -- a second identical call adds no new rows)
-- plus the outbox_events row.
-- ---------------------------------------------------------------------------
do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
  v_actions jsonb := '[{"type":"queue_pdf","params":{}},{"type":"create_incident","params":{"severity":"high"}},{"type":"create_work_order","params":{"priority":"high"}}]'::jsonb;
  v_result jsonb;
  v_event_count int;
begin
  select public.enqueue_report_workflow(v_submission_id, v_actions) into v_result;
  if jsonb_array_length(v_result -> 'event_ids') <> 3 then
    raise exception 'RWE FAIL: expected 3 event_ids from enqueue_report_workflow, saw %', v_result -> 'event_ids';
  end if;

  -- Idempotent re-call: same (submission_id, event_type) pairs -> ON
  -- CONFLICT DO NOTHING, no new report_workflow_events rows.
  perform public.enqueue_report_workflow(v_submission_id, v_actions);

  select count(*) into v_event_count from report_workflow_events where submission_id = v_submission_id;
  if v_event_count <> 3 then
    raise exception 'RWE FAIL: expected exactly 3 report_workflow_events rows after two enqueue calls, saw %', v_event_count;
  end if;
exception
  when insufficient_privilege then
    raise exception 'RWE FAIL: a reports.submit holder was denied public.enqueue_report_workflow';
end;
$$;

do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
  v_outbox_count int;
begin
  select count(*) into v_outbox_count
    from outbox_events
    where facility_id = '53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and event_type = 'report.submitted'
      and (payload ->> 'submission_id')::uuid = v_submission_id;
  if v_outbox_count < 1 then
    raise exception 'RWE FAIL: expected at least 1 report.submitted outbox_events row, saw %', v_outbox_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. `authenticated` cannot INSERT into report_workflow_events directly --
-- no INSERT policy exists for it at all.
-- ---------------------------------------------------------------------------
do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
begin
  begin
    insert into report_workflow_events (facility_id, submission_id, event_type, action)
    values ('53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v_submission_id, 'notify:99', '{"type":"notify"}'::jsonb);
    raise exception 'RWE FAIL: authenticated was able to INSERT into report_workflow_events directly';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7 (part 1). The submitter, who holds NO incidents.manage, cannot INSERT an
-- incident_reports row directly -- this is the OTHER half of "workflow-
-- minted only", proven before we mint anything through the RPC below.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_reports (facility_id, incident_no, report_type, severity, occurred_at, location_text, summary)
    values ('53aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-RWE1', 'incident', 'high', now(), 'n/a', 'direct attempt');
    raise exception 'RWE FAIL: a submitter without incidents.manage was able to INSERT incident_reports directly';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. public.enqueue_report_workflow denied to a caller who lacks
-- reports.submit (the reader, reports.read only).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"53000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
begin
  begin
    perform public.enqueue_report_workflow(v_submission_id, '[{"type":"queue_pdf"}]'::jsonb);
    raise exception 'RWE FAIL: a reports.read-only caller was able to call enqueue_report_workflow';
  exception
    when insufficient_privilege then null; -- expected (42501)
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The reader CAN read report_workflow_events (reports.read).
-- ---------------------------------------------------------------------------
do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
  v_count int;
begin
  select count(*) into v_count from report_workflow_events where submission_id = v_submission_id;
  if v_count <> 3 then
    raise exception 'RWE FAIL: reports.read holder saw % report_workflow_events rows, expected 3', v_count;
  end if;
exception
  when insufficient_privilege then
    raise exception 'RWE FAIL: a reports.read holder was denied SELECT on report_workflow_events';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. Cross-facility rejection: the outsider (facility B) holds
-- reports.submit at THEIR OWN facility, but calling enqueue_report_workflow
-- against facility A's submission is still denied -- the RPC re-derives
-- facility_id/department_id from the submission row itself, not from the
-- caller's own membership.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"53000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
begin
  begin
    perform public.enqueue_report_workflow(v_submission_id, '[{"type":"queue_pdf"}]'::jsonb);
    raise exception 'RWE FAIL: an outsider from a different facility was able to call enqueue_report_workflow for facility A''s submission';
  exception
    when insufficient_privilege then null; -- expected (42501)
  end;
end;
$$;

reset role;

-- The outsider's request.jwt.claims was set with is_local=true (transaction-
-- scoped), so it otherwise stays active for the rest of THIS transaction
-- even after `reset role` -- clear it explicitly so the direct
-- internal.mint_workflow_incident/work_order calls below genuinely simulate
-- a service-role call with no acting user (auth.uid() reading null), not an
-- accidental continuation of the outsider's session.
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 5. Grant shape: internal.mint_workflow_incident / internal.mint_workflow_
-- work_order and their public.* wrappers are executable by service_role ONLY
-- -- not authenticated, not a no-grant role standing in for PUBLIC/anon.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'probe_rwe') then
    create role probe_rwe nologin;
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('authenticated', 'public.mint_workflow_incident(uuid,jsonb)', 'execute') then
    raise exception 'RWE FAIL: authenticated can execute public.mint_workflow_incident';
  end if;
  if has_function_privilege('authenticated', 'internal.mint_workflow_incident(uuid,jsonb)', 'execute') then
    raise exception 'RWE FAIL: authenticated can execute internal.mint_workflow_incident';
  end if;
  if has_function_privilege('authenticated', 'public.mint_workflow_work_order(uuid,jsonb)', 'execute') then
    raise exception 'RWE FAIL: authenticated can execute public.mint_workflow_work_order';
  end if;
  if has_function_privilege('probe_rwe', 'public.mint_workflow_incident(uuid,jsonb)', 'execute') then
    raise exception 'RWE FAIL: a no-grant role (standing in for PUBLIC) can execute public.mint_workflow_incident';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.mint_workflow_incident(uuid,jsonb)', 'execute') then
    raise exception 'RWE FAIL: anon can execute public.mint_workflow_incident';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    if not has_function_privilege('service_role', 'public.mint_workflow_incident(uuid,jsonb)', 'execute') then
      raise exception 'RWE FAIL: service_role cannot execute public.mint_workflow_incident';
    end if;
    if not has_function_privilege('service_role', 'public.mint_workflow_work_order(uuid,jsonb)', 'execute') then
      raise exception 'RWE FAIL: service_role cannot execute public.mint_workflow_work_order';
    end if;
  end if;
  -- enqueue_report_workflow, by contrast, IS meant for authenticated (the
  -- submitting user's own session) -- assert the opposite shape here so a
  -- future edit cannot silently swap the two RPC pairs' grants.
  if not has_function_privilege('authenticated', 'public.enqueue_report_workflow(uuid,jsonb)', 'execute') then
    raise exception 'RWE FAIL: authenticated cannot execute public.enqueue_report_workflow';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6/7 (part 2). Calling internal.mint_workflow_incident directly (standing
-- in for the service-role drain -- this transaction runs as the table
-- owner/superuser, with no request.jwt.claims set, so auth.uid() is null
-- exactly like a real service-role-authenticated PostgREST call) mints a
-- 'draft' incident attributed to the submitter, with workflow provenance in
-- its audit_events row, and is idempotent on a second call.
-- ---------------------------------------------------------------------------
do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
  v_action jsonb := '{"type":"create_incident","params":{"severity":"high"}}'::jsonb;
  v_result jsonb;
  v_incident_id uuid;
  v_incident_count int;
  v_audit_source text;
  v_audit_submission_id text;
  v_audit_actor uuid;
begin
  select internal.mint_workflow_incident(v_submission_id, v_action) into v_result;
  if (v_result ->> 'created') <> 'true' then
    raise exception 'RWE FAIL: mint_workflow_incident did not report created:true on first call (saw %)', v_result;
  end if;
  if (v_result -> 'incident' ->> 'status') <> 'draft' then
    raise exception 'RWE FAIL: workflow-minted incident status was not draft (saw %)', v_result -> 'incident' ->> 'status';
  end if;
  if (v_result -> 'incident' ->> 'severity') <> 'high' then
    raise exception 'RWE FAIL: workflow-minted incident severity was not high (saw %)', v_result -> 'incident' ->> 'severity';
  end if;
  if (v_result -> 'incident' ->> 'submitted_by') <> '53000000-0000-0000-0000-000000000a01' then
    raise exception 'RWE FAIL: workflow-minted incident submitted_by was not the report''s submitter (saw %)', v_result -> 'incident' ->> 'submitted_by';
  end if;
  if (v_result -> 'incident' ->> 'source_submission_id') <> v_submission_id::text then
    raise exception 'RWE FAIL: workflow-minted incident source_submission_id did not match the submission';
  end if;

  v_incident_id := (v_result -> 'incident' ->> 'id')::uuid;

  select event_payload ->> 'source', event_payload ->> 'submission_id', actor_user_id
    into v_audit_source, v_audit_submission_id, v_audit_actor
    from audit_events
    where entity_table = 'incident_reports' and entity_id = v_incident_id and event_type = 'incident.created';
  if v_audit_source is distinct from 'report_workflow' then
    raise exception 'RWE FAIL: audit_events for the workflow-minted incident did not carry source=report_workflow (saw %)', v_audit_source;
  end if;
  if v_audit_submission_id is distinct from v_submission_id::text then
    raise exception 'RWE FAIL: audit_events for the workflow-minted incident did not carry the submission_id';
  end if;
  if v_audit_actor is not null then
    raise exception 'RWE FAIL: audit_events actor_user_id was not null for a service-role-minted incident (saw %)', v_audit_actor;
  end if;

  -- Idempotency: a second mint call for the same submission returns the
  -- existing row and creates nothing new.
  select internal.mint_workflow_incident(v_submission_id, v_action) into v_result;
  if (v_result ->> 'created') <> 'false' then
    raise exception 'RWE FAIL: a second mint_workflow_incident call did not report created:false (saw %)', v_result;
  end if;
  if (v_result -> 'incident' ->> 'id') <> v_incident_id::text then
    raise exception 'RWE FAIL: a second mint_workflow_incident call returned a different incident id';
  end if;

  select count(*) into v_incident_count from incident_reports where source_submission_id = v_submission_id;
  if v_incident_count <> 1 then
    raise exception 'RWE FAIL: expected exactly 1 workflow-minted incident for this submission, saw %', v_incident_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. internal.mint_workflow_work_order: same shape (created via the
-- service-role-standing-in call, source_type='report', idempotent).
-- ---------------------------------------------------------------------------
do $$
declare
  v_submission_id uuid := current_setting('rwe_test.submission_id')::uuid;
  v_action jsonb := '{"type":"create_work_order","params":{"priority":"high"}}'::jsonb;
  v_result jsonb;
  v_wo_count int;
begin
  select internal.mint_workflow_work_order(v_submission_id, v_action) into v_result;
  if (v_result ->> 'created') <> 'true' then
    raise exception 'RWE FAIL: mint_workflow_work_order did not report created:true on first call (saw %)', v_result;
  end if;
  if (v_result -> 'work_order' ->> 'source_type') <> 'report' then
    raise exception 'RWE FAIL: workflow-minted work order source_type was not report (saw %)', v_result -> 'work_order' ->> 'source_type';
  end if;
  if (v_result -> 'work_order' ->> 'priority') <> 'high' then
    raise exception 'RWE FAIL: workflow-minted work order priority was not high (saw %)', v_result -> 'work_order' ->> 'priority';
  end if;

  select internal.mint_workflow_work_order(v_submission_id, v_action) into v_result;
  if (v_result ->> 'created') <> 'false' then
    raise exception 'RWE FAIL: a second mint_workflow_work_order call did not report created:false (saw %)', v_result;
  end if;

  select count(*) into v_wo_count from work_orders where source_submission_id = v_submission_id;
  if v_wo_count <> 1 then
    raise exception 'RWE FAIL: expected exactly 1 workflow-minted work order for this submission, saw %', v_wo_count;
  end if;
end;
$$;

rollback;
