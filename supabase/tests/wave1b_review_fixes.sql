-- Verification intent: 0048_wave1b_review_fixes.sql, the fixes for the Opus
-- security review of the wave1-security..wave1-security-b diff. Each finding
-- below is reproduced first (proving the pre-0048 behavior would have
-- failed this assertion), then the fix is proven. Runs against a migrated
-- database inside a rolled-back transaction, so no fixture persists.
begin;

insert into auth.users (id, email) values
  ('48000000-0000-0000-0000-000000000a01', 'w1b-template-manager@test'),
  ('48000000-0000-0000-0000-000000000a02', 'w1b-escalator@test'),
  ('48000000-0000-0000-0000-000000000a03', 'w1b-task-creator@test'),
  ('48000000-0000-0000-0000-000000000a04', 'w1b-legal-hold-only@test'),
  ('48000000-0000-0000-0000-000000000a05', 'w1b-admin-manage@test'),
  ('48000000-0000-0000-0000-000000000a06', 'w1b-incident-manager@test'),
  ('48000000-0000-0000-0000-000000000a07', 'w1b-publisher@test'),
  ('48000000-0000-0000-0000-000000000a08', 'w1b-manage-and-legalhold@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('48000000-0000-0000-0000-000000000a01', 'W1B Template Manager', 'w1b-template-manager@test'),
  ('48000000-0000-0000-0000-000000000a02', 'W1B Escalator', 'w1b-escalator@test'),
  ('48000000-0000-0000-0000-000000000a03', 'W1B Task Creator', 'w1b-task-creator@test'),
  ('48000000-0000-0000-0000-000000000a04', 'W1B Legal Hold Only', 'w1b-legal-hold-only@test'),
  ('48000000-0000-0000-0000-000000000a05', 'W1B Admin Manage', 'w1b-admin-manage@test'),
  ('48000000-0000-0000-0000-000000000a06', 'W1B Incident Manager', 'w1b-incident-manager@test'),
  ('48000000-0000-0000-0000-000000000a07', 'W1B Publisher', 'w1b-publisher@test'),
  ('48000000-0000-0000-0000-000000000a08', 'W1B Manage And Legal Hold', 'w1b-manage-and-legalhold@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('48111111-1111-1111-1111-111111111111', 'W1B Org A')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48111111-1111-1111-1111-111111111111', 'W1B Facility A')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('48c00000-0000-0000-0000-0000000000c1', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Template Manager Role'),
  ('48c00000-0000-0000-0000-0000000000c2', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Escalator Role'),
  ('48c00000-0000-0000-0000-0000000000c3', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Task Creator Role'),
  ('48c00000-0000-0000-0000-0000000000c4', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Legal Hold Only Role'),
  ('48c00000-0000-0000-0000-0000000000c5', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Admin Manage Role'),
  ('48c00000-0000-0000-0000-0000000000c6', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Incident Manager Role'),
  ('48c00000-0000-0000-0000-0000000000c7', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Publisher Role'),
  ('48c00000-0000-0000-0000-0000000000c8', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Manage And Legal Hold Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('48c00000-0000-0000-0000-0000000000c1', 'reports.template.manage'),
  ('48c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('48c00000-0000-0000-0000-0000000000c2', 'incidents.escalate'),
  ('48c00000-0000-0000-0000-0000000000c2', 'incidents.read'),
  ('48c00000-0000-0000-0000-0000000000c3', 'incidents.tasks.create'),
  ('48c00000-0000-0000-0000-0000000000c3', 'incidents.read'),
  ('48c00000-0000-0000-0000-0000000000c4', 'incidents.legal_hold.manage'),
  ('48c00000-0000-0000-0000-0000000000c4', 'incidents.read'),
  ('48c00000-0000-0000-0000-0000000000c5', 'admin.manage'),
  ('48c00000-0000-0000-0000-0000000000c6', 'incidents.manage'),
  ('48c00000-0000-0000-0000-0000000000c6', 'incidents.read'),
  ('48c00000-0000-0000-0000-0000000000c7', 'communications.publish'),
  ('48c00000-0000-0000-0000-0000000000c7', 'communications.read'),
  ('48c00000-0000-0000-0000-0000000000c8', 'incidents.manage'),
  ('48c00000-0000-0000-0000-0000000000c8', 'incidents.legal_hold.manage'),
  ('48c00000-0000-0000-0000-0000000000c8', 'incidents.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('48d10000-0000-0000-0000-0000000000d1', '48000000-0000-0000-0000-000000000a01', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c1', 'active'),
  ('48d10000-0000-0000-0000-0000000000d2', '48000000-0000-0000-0000-000000000a02', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c2', 'active'),
  ('48d10000-0000-0000-0000-0000000000d3', '48000000-0000-0000-0000-000000000a03', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c3', 'active'),
  ('48d10000-0000-0000-0000-0000000000d4', '48000000-0000-0000-0000-000000000a04', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c4', 'active'),
  ('48d10000-0000-0000-0000-0000000000d5', '48000000-0000-0000-0000-000000000a05', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c5', 'active'),
  ('48d10000-0000-0000-0000-0000000000d6', '48000000-0000-0000-0000-000000000a06', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c6', 'active'),
  ('48d10000-0000-0000-0000-0000000000d7', '48000000-0000-0000-0000-000000000a07', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c7', 'active'),
  ('48d10000-0000-0000-0000-0000000000d8', '48000000-0000-0000-0000-000000000a08', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48c00000-0000-0000-0000-0000000000c8', 'active')
on conflict (id) do nothing;

-- Fixtures seeded with RLS bypassed (owner role).
insert into report_templates (id, facility_id, code, name, status) values
  ('48e00000-0000-0000-0000-000000000e01', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B-TPL-1', 'W1B Template 1', 'draft')
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('48f00000-0000-0000-0000-000000000f01', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e00000-0000-0000-0000-000000000e01', 1, '{"fields":[]}'::jsonb, false)
on conflict (id) do nothing;

insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary, immediate_actions) values
  ('48e10000-0000-0000-0000-000000000e11', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-W1B1', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock A', 'W1B seed incident summary', 'W1B seed immediate actions'),
  ('48e10000-0000-0000-0000-000000000e12', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-W1B2', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock B', 'W1B seed incident summary', 'W1B seed immediate actions'),
  ('48e10000-0000-0000-0000-000000000e13', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-W1B3', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock C', 'ORIGINAL SUMMARY NEVER EXPOSED', 'ORIGINAL IMMEDIATE ACTIONS NEVER EXPOSED')
on conflict (id) do nothing;

insert into communication_channels (id, facility_id, channel_type, name) values
  ('48000000-0000-0000-0000-0000000000c9', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facility', 'W1B Channel')
on conflict (id) do nothing;
insert into messages (id, facility_id, channel_id, subject, body_text) values
  ('48000000-0000-0000-0000-0000000000f9', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48000000-0000-0000-0000-0000000000c9', 'W1B Notice', 'Body')
on conflict (id) do nothing;
insert into departments (id, facility_id, name) values
  ('48000000-0000-0000-0000-0000000000d9', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B Dept')
on conflict (id) do nothing;
insert into employees (id, facility_id, first_name, last_name) values
  ('48000000-0000-0000-0000-0000000000e9', '48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'W1B', 'Employee')
on conflict (id) do nothing;

-- ===========================================================================
-- H1: report_template_versions INSERT bypass -- a reports.template.manage-
-- only actor (NO reports.publish) must be denied INSERTing a version that is
-- already is_published = true.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into report_template_versions (facility_id, template_id, version_number, schema_json, is_published) values
      ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e00000-0000-0000-0000-000000000e01', 2, '{"fields":[]}'::jsonb, true);
    raise exception 'H1 FAIL: a reports.template.manage-only actor INSERTed an already-published version';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- Sanity: the same actor CAN still insert a draft (is_published = false) --
-- H1's fix must not have narrowed template.manage's ordinary draft-insert
-- capability.
do $$
begin
  insert into report_template_versions (facility_id, template_id, version_number, schema_json, is_published) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e00000-0000-0000-0000-000000000e01', 3, '{"fields":[]}'::jsonb, false);
exception
  when insufficient_privilege then
    raise exception 'H1 FAIL: a reports.template.manage holder was denied inserting an ordinary draft version';
end;
$$;

reset role;

-- ===========================================================================
-- H2: incident_audit_events INSERT widened -- an escalate-only actor (no
-- incidents.manage/review) must be able to complete the FULL route: insert
-- the child row (incident_escalations) AND the audit row
-- (incident_audit_events), with neither step rejected by RLS.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_escalations (facility_id, incident_id, reason_code, target_role, status, due_at) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e10000-0000-0000-0000-000000000e11', 'user_escalation', 'manager', 'pending', now() + interval '1 day');
exception
  when insufficient_privilege then
    raise exception 'H2 FAIL: an incidents.escalate holder was denied inserting an escalation';
end;
$$;

do $$
begin
  insert into incident_audit_events (facility_id, incident_id, event_type, event_payload, event_hash) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e10000-0000-0000-0000-000000000e11', 'incident.escalated', '{}'::jsonb, 'w1b-escalate-fixture-hash');
exception
  when insufficient_privilege then
    raise exception 'H2 FAIL: an incidents.escalate-only actor was denied inserting the matching incident_audit_events row (the exact 500-after-commit gap H2 reports)';
end;
$$;

reset role;

-- Same proof for incidents.tasks.create (the follow-up-actions route).
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_followup_actions (facility_id, incident_id, action_type, status, description) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e10000-0000-0000-0000-000000000e11', 'corrective_action', 'open', 'W1B task-creator followup');
exception
  when insufficient_privilege then
    raise exception 'H2 FAIL: an incidents.tasks.create holder was denied inserting a follow-up action';
end;
$$;

do $$
begin
  insert into incident_audit_events (facility_id, incident_id, event_type, event_payload, event_hash) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48e10000-0000-0000-0000-000000000e11', 'incident.followup_created', '{}'::jsonb, 'w1b-followup-fixture-hash');
exception
  when insufficient_privilege then
    raise exception 'H2 FAIL: an incidents.tasks.create-only actor was denied inserting the matching incident_audit_events row';
end;
$$;

reset role;

-- ===========================================================================
-- H3: incidents.legal_hold.manage-only actor (NO incidents.manage, NO
-- incidents.review) must be able to UPDATE incident_reports to flip
-- legal_hold -- the missing RLS policy H3 reports -- but must be restricted
-- to changing ONLY legal_hold (and updated_at); an attempt to also change
-- summary must fail.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update incident_reports set legal_hold = true, updated_at = now() where id = '48e10000-0000-0000-0000-000000000e12';
exception
  when insufficient_privilege then
    raise exception 'H3 FAIL: a legal_hold.manage-only actor was denied UPDATEing incident_reports (RLS gap not closed)';
  when check_violation then
    raise exception 'H3 FAIL: a legal_hold.manage-only actor was denied changing legal_hold itself';
end;
$$;

do $$
declare
  hold_value boolean;
begin
  select legal_hold into hold_value from incident_reports where id = '48e10000-0000-0000-0000-000000000e12';
  if hold_value is not true then
    raise exception 'H3 FAIL: legal_hold was not actually set to true';
  end if;
end;
$$;

-- Guard 1b: the SAME actor may not also change summary (or anything else
-- outside legal_hold/updated_at) on that row.
do $$
begin
  begin
    update incident_reports set legal_hold = false, summary = 'H3 side-channel attempt' where id = '48e10000-0000-0000-0000-000000000e12';
    raise exception 'H3 FAIL: a legal_hold.manage-only actor changed summary via the new UPDATE policy (side channel not closed)';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- H4: fn_incident_report_audit's payload is an allow-list -- an admin.manage
-- -only actor (holds NO incidents.read at all) can read the audit_events row
-- a status change produces, but the payload never carries summary/
-- immediate_actions content, only status/severity before+after and the
-- changed-column NAMES.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a06","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update incident_reports set status = 'under_review' where id = '48e10000-0000-0000-0000-000000000e13';
exception
  when check_violation then
    raise exception 'H4 setup FAIL: submitted -> under_review was rejected as an illegal transition';
end;
$$;

reset role;

select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a05","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  visible_count int;
  incident_read_count int;
begin
  -- Sanity: this actor holds admin.manage only -- confirm they cannot read
  -- incident_reports at all (the two permissions are disjoint), so the read
  -- below is proof of the audit_events-widened readership H4 flags, not an
  -- accident of also holding incidents.read.
  select count(*) into incident_read_count from incident_reports where id = '48e10000-0000-0000-0000-000000000e13';
  if incident_read_count <> 0 then
    raise exception 'H4 setup FAIL: the admin.manage-only actor could read incident_reports directly (expected 0, saw %)', incident_read_count;
  end if;

  select count(*) into visible_count
    from audit_events
    where entity_table = 'incident_reports'
      and entity_id = '48e10000-0000-0000-0000-000000000e13'
      and event_type = 'incident.status_changed';
  if visible_count <> 1 then
    raise exception 'H4 FAIL: expected exactly 1 incident.status_changed audit_events row visible to admin.manage, saw %', visible_count;
  end if;
end;
$$;

do $$
declare
  payload jsonb;
begin
  select event_payload into payload
    from audit_events
    where entity_table = 'incident_reports'
      and entity_id = '48e10000-0000-0000-0000-000000000e13'
      and event_type = 'incident.status_changed';

  if payload ? 'summary' or payload ? 'immediate_actions' or payload ? 'location_text' then
    raise exception 'H4 FAIL: the audit_events payload still carries free-text incident content: %', payload;
  end if;
  if payload ? 'before' or payload ? 'after' then
    raise exception 'H4 FAIL: the audit_events payload still carries a full before/after row envelope: %', payload;
  end if;
  if (payload ->> 'status_before') <> 'submitted' or (payload ->> 'status_after') <> 'under_review' then
    raise exception 'H4 FAIL: status_before/status_after are missing or wrong: %', payload;
  end if;
  if not (payload -> 'changed_columns' ? 'status') then
    raise exception 'H4 FAIL: changed_columns does not list status: %', payload;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- M2: legal_hold may only be created true by an actor holding
-- incidents.legal_hold.manage -- an incidents.manage-only actor (the S-5
-- original gap) is denied at INSERT time; an actor holding BOTH
-- incidents.manage (required for the INSERT itself -- incident_reports has
-- no INSERT policy for legal_hold.manage alone, only the incidents.manage
-- `for all` policy admits INSERT at all) AND incidents.legal_hold.manage
-- succeeds.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a06","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into incident_reports (facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary, legal_hold) values
      ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-W1BM2A', 'incident', 'draft', 'medium', '2026-07-02T00:00:00Z', 'Dock M2', 'M2 insert attempt', true);
    raise exception 'M2 FAIL: an incidents.manage-only actor created an incident already on legal hold';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- Same actor: legal_hold defaulting to/explicitly false is unaffected.
do $$
begin
  insert into incident_reports (facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary, legal_hold) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-W1BM2B', 'incident', 'draft', 'medium', '2026-07-02T00:00:00Z', 'Dock M2', 'M2 insert attempt (no hold)', false);
exception
  when check_violation then
    raise exception 'M2 FAIL: an incidents.manage holder was denied creating an ordinary (legal_hold=false) draft';
end;
$$;

reset role;

select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a08","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_reports (facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary, legal_hold) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-W1BM2C', 'incident', 'draft', 'medium', '2026-07-02T00:00:00Z', 'Dock M2', 'M2 insert attempt (legal hold holder)', true);
exception
  when check_violation then
    raise exception 'M2 FAIL: an incidents.manage + incidents.legal_hold.manage holder was denied creating an incident already on legal hold';
  when insufficient_privilege then
    raise exception 'M2 FAIL: an incidents.manage + incidents.legal_hold.manage holder was denied the INSERT outright';
end;
$$;

reset role;

-- ===========================================================================
-- M1 (RPC guard rails, beyond the direct-vs-RPC proof already in
-- incident_report_guards.sql #4a/4b): internal.apply_incident_amendment
-- itself enforces incidents.manage/review -- an incidents.escalate-only
-- actor (no manage, no review) calling the RPC directly is rejected.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    perform internal.apply_incident_amendment(
      '48e10000-0000-0000-0000-000000000e11'::uuid,
      jsonb_build_object('summary', 'should never apply'),
      'M1 permission test'
    );
    raise exception 'M1 FAIL: an incidents.escalate-only actor was able to call apply_incident_amendment';
  exception
    when insufficient_privilege then null; -- expected
  end;
  -- NEW-1: the same denial holds through the PostgREST-facing public wrapper
  -- (SECURITY INVOKER: it adds no privilege of its own).
  begin
    perform public.apply_incident_amendment(
      '48e10000-0000-0000-0000-000000000e11'::uuid,
      jsonb_build_object('summary', 'should never apply'),
      'M1 permission test (public wrapper)'
    );
    raise exception 'M1 FAIL: an incidents.escalate-only actor was able to call public.apply_incident_amendment';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- NEW-1 grant shape: the public wrapper is executable by authenticated (and
-- service_role where it exists) and by nobody else -- a role with no explicit
-- grant (standing in for PUBLIC / anon) cannot call it or the internal
-- function behind it.
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'probe_1b_new1') then
    create role probe_1b_new1 nologin;
  end if;
end;
$$;

do $$
begin
  if not has_function_privilege('authenticated', 'public.apply_incident_amendment(uuid,jsonb,text)', 'execute') then
    raise exception 'NEW-1 FAIL: authenticated cannot execute public.apply_incident_amendment';
  end if;
  if has_function_privilege('probe_1b_new1', 'public.apply_incident_amendment(uuid,jsonb,text)', 'execute') then
    raise exception 'NEW-1 FAIL: a role with no grant (PUBLIC) can execute public.apply_incident_amendment';
  end if;
  if has_function_privilege('probe_1b_new1', 'internal.apply_incident_amendment(uuid,jsonb,text)', 'execute') then
    raise exception 'NEW-1 FAIL: a role with no grant (PUBLIC) can execute internal.apply_incident_amendment';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.apply_incident_amendment(uuid,jsonb,text)', 'execute') then
    raise exception 'NEW-1 FAIL: anon can execute public.apply_incident_amendment';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and not has_function_privilege('service_role', 'public.apply_incident_amendment(uuid,jsonb,text)', 'execute') then
    raise exception 'NEW-1 FAIL: service_role cannot execute public.apply_incident_amendment';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'probe_1b_new1') then
    drop role probe_1b_new1;
  end if;
end;
$$;

-- ===========================================================================
-- M3: message_audiences.audience_ref_id must be non-null for
-- audience_type = 'employee' -- a null ref there is rejected (policy AND
-- trigger); department/shift/role keep accepting a null ref (degrades to
-- zero recipients, per resolveMessageAudience -- a legitimate, if inert,
-- row).
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a07","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
      ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48000000-0000-0000-0000-0000000000f9', 'employee', null);
    raise exception 'M3 FAIL: audience_type=employee with a null audience_ref_id was accepted (policy)';
  exception
    when insufficient_privilege then null; -- expected (WITH CHECK dispatch)
    when check_violation then null; -- also acceptable (trigger fires first under some plans)
  end;
end;
$$;

do $$
begin
  insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48000000-0000-0000-0000-0000000000f9', 'department', null);
exception
  when insufficient_privilege then
    raise exception 'M3 FAIL: audience_type=department with a null audience_ref_id was rejected (should stay legal, degrades to zero recipients)';
end;
$$;

do $$
begin
  insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
    ('48aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '48000000-0000-0000-0000-0000000000f9', 'employee', '48000000-0000-0000-0000-0000000000e9');
exception
  when insufficient_privilege then
    raise exception 'M3 FAIL: audience_type=employee with a real, same-facility audience_ref_id was rejected';
end;
$$;

reset role;

-- ===========================================================================
-- L2: submitted_by/submitted_at are frozen once an incident has left draft
-- -- even for an incidents.manage holder, even though every other UPDATE
-- policy would otherwise admit them.
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"48000000-0000-0000-0000-000000000a06","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    update incident_reports set submitted_by = '48000000-0000-0000-0000-000000000a06' where id = '48e10000-0000-0000-0000-000000000e11';
    raise exception 'L2 FAIL: submitted_by was reassigned on a non-draft incident';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- L3: deleted_at is exempted from guard 3's freeze for a null-auth.uid()
-- caller (service-role/definer context) -- proven here as the unauthenticated
-- table-owner connection (request.jwt.claims explicitly cleared, so
-- auth.uid() is null, the same condition a real service-role caller
-- produces -- `set_config(..., true)` is transaction-local, so it would
-- otherwise still carry the LAST actor's claims from an earlier section of
-- this same transaction). An authenticated actor's deleted_at write on a
-- non-draft row is still rejected (unchanged from 0043 -- no RLS policy ever
-- admitted it in the first place).
-- ===========================================================================
select set_config('request.jwt.claims', '', true);

do $$
begin
  update incident_reports set deleted_at = now() where id = '48e10000-0000-0000-0000-000000000e12';
exception
  when check_violation then
    raise exception 'L3 FAIL: a null-auth.uid() (service-role-equivalent) caller was denied setting deleted_at on a non-draft incident';
end;
$$;

do $$
begin
  update incident_reports set deleted_at = null where id = '48e10000-0000-0000-0000-000000000e12';
end;
$$;

rollback;
