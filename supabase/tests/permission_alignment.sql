-- Verification intent: Slice 1C, S-5 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md)
-- -- 0044_permission_alignment.sql. Each of the four predicates newly wired
-- into RLS gets a positive actor (holds the new code, not incidents.manage /
-- reports.template.manage) and a negative actor (lacks it) proving the
-- predicate -- not some other permissive policy -- is what let the positive
-- actor through:
--   1. reports.publish: report_template_versions UPDATE. A
--      reports.template.manage-only actor can edit a draft version's content
--      but cannot flip is_published to true; a reports.publish holder can.
--   2. incidents.tasks.create: incident_followup_actions INSERT. A
--      tasks.create-only actor (no incidents.manage) can insert; a plain
--      incidents.read-only actor cannot.
--   3. incidents.escalate: incident_escalations INSERT. An escalate-only
--      actor (no incidents.manage) can insert; a plain incidents.read-only
--      actor cannot.
--   4. incidents.audit.view: incident_audit_events SELECT. An
--      audit.view-only actor (no incidents.manage/incidents.review) can read
--      a facility's incident audit rows; a plain incidents.read-only actor
--      sees zero rows.
-- (incidents.legal_hold.manage's positive/negative pair is already covered
-- by supabase/tests/incident_report_guards.sql, same slice.)
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('44000000-0000-0000-0000-000000000a01', 'pa-template-manager@test'),
  ('44000000-0000-0000-0000-000000000a02', 'pa-publisher@test'),
  ('44000000-0000-0000-0000-000000000a03', 'pa-task-creator@test'),
  ('44000000-0000-0000-0000-000000000a04', 'pa-escalator@test'),
  ('44000000-0000-0000-0000-000000000a05', 'pa-audit-viewer@test'),
  ('44000000-0000-0000-0000-000000000a06', 'pa-reader@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('44000000-0000-0000-0000-000000000a01', 'PA Template Manager', 'pa-template-manager@test'),
  ('44000000-0000-0000-0000-000000000a02', 'PA Publisher', 'pa-publisher@test'),
  ('44000000-0000-0000-0000-000000000a03', 'PA Task Creator', 'pa-task-creator@test'),
  ('44000000-0000-0000-0000-000000000a04', 'PA Escalator', 'pa-escalator@test'),
  ('44000000-0000-0000-0000-000000000a05', 'PA Audit Viewer', 'pa-audit-viewer@test'),
  ('44000000-0000-0000-0000-000000000a06', 'PA Reader', 'pa-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('44111111-1111-1111-1111-111111111111', 'PA Org A')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44111111-1111-1111-1111-111111111111', 'PA Facility A')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('44c00000-0000-0000-0000-0000000000c1', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA Template Manager Role'),
  ('44c00000-0000-0000-0000-0000000000c2', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA Publisher Role'),
  ('44c00000-0000-0000-0000-0000000000c3', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA Task Creator Role'),
  ('44c00000-0000-0000-0000-0000000000c4', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA Escalator Role'),
  ('44c00000-0000-0000-0000-0000000000c5', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA Audit Viewer Role'),
  ('44c00000-0000-0000-0000-0000000000c6', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA Reader Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('44c00000-0000-0000-0000-0000000000c1', 'reports.template.manage'),
  ('44c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('44c00000-0000-0000-0000-0000000000c2', 'reports.template.manage'),
  ('44c00000-0000-0000-0000-0000000000c2', 'reports.publish'),
  ('44c00000-0000-0000-0000-0000000000c2', 'reports.read'),
  ('44c00000-0000-0000-0000-0000000000c3', 'incidents.tasks.create'),
  ('44c00000-0000-0000-0000-0000000000c3', 'incidents.read'),
  ('44c00000-0000-0000-0000-0000000000c4', 'incidents.escalate'),
  ('44c00000-0000-0000-0000-0000000000c4', 'incidents.read'),
  ('44c00000-0000-0000-0000-0000000000c5', 'incidents.audit.view'),
  ('44c00000-0000-0000-0000-0000000000c5', 'incidents.read'),
  ('44c00000-0000-0000-0000-0000000000c6', 'incidents.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('44d10000-0000-0000-0000-0000000000d1', '44000000-0000-0000-0000-000000000a01', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44c00000-0000-0000-0000-0000000000c1', 'active'),
  ('44d10000-0000-0000-0000-0000000000d2', '44000000-0000-0000-0000-000000000a02', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44c00000-0000-0000-0000-0000000000c2', 'active'),
  ('44d10000-0000-0000-0000-0000000000d3', '44000000-0000-0000-0000-000000000a03', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44c00000-0000-0000-0000-0000000000c3', 'active'),
  ('44d10000-0000-0000-0000-0000000000d4', '44000000-0000-0000-0000-000000000a04', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44c00000-0000-0000-0000-0000000000c4', 'active'),
  ('44d10000-0000-0000-0000-0000000000d5', '44000000-0000-0000-0000-000000000a05', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44c00000-0000-0000-0000-0000000000c5', 'active'),
  ('44d10000-0000-0000-0000-0000000000d6', '44000000-0000-0000-0000-000000000a06', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44c00000-0000-0000-0000-0000000000c6', 'active')
on conflict (id) do nothing;

-- Fixtures seeded with RLS bypassed (owner role).
insert into report_templates (id, facility_id, code, name, status) values
  ('44e00000-0000-0000-0000-000000000e01', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PA-TPL-1', 'PA Template 1', 'draft')
on conflict (id) do nothing;

insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('44f00000-0000-0000-0000-000000000f01', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e00000-0000-0000-0000-000000000e01', 1, '{"fields":[]}'::jsonb, false),
  ('44f00000-0000-0000-0000-000000000f02', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e00000-0000-0000-0000-000000000e01', 2, '{"fields":[]}'::jsonb, false)
on conflict (id) do nothing;

insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('44e10000-0000-0000-0000-000000000e11', '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-PA1', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock A', 'PA seed incident')
on conflict (id) do nothing;

insert into incident_audit_events (facility_id, incident_id, event_type, event_payload, event_hash) values
  ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e10000-0000-0000-0000-000000000e11', 'permission_alignment.seed', '{}'::jsonb, 'pa-fixture-hash');

-- ---------------------------------------------------------------------------
-- 1a. Negative: reports.template.manage alone can edit a draft version's
-- content, but cannot flip is_published to true.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update report_template_versions set schema_json = '{"fields":["a"]}'::jsonb where id = '44f00000-0000-0000-0000-000000000f01';
exception
  when insufficient_privilege then
    raise exception 'PA FAIL: reports.template.manage holder was denied a non-publish content edit';
end;
$$;

do $$
begin
  begin
    update report_template_versions set is_published = true where id = '44f00000-0000-0000-0000-000000000f01';
    raise exception 'PA FAIL: reports.template.manage alone was able to publish a version (missing reports.publish)';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 1b. Positive: reports.publish holder can flip is_published to true.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update report_template_versions set is_published = true where id = '44f00000-0000-0000-0000-000000000f02';
exception
  when insufficient_privilege then
    raise exception 'PA FAIL: a reports.publish holder was denied publishing a version';
end;
$$;

do $$
declare
  published boolean;
begin
  select is_published into published from report_template_versions where id = '44f00000-0000-0000-0000-000000000f02';
  if published is not true then
    raise exception 'PA FAIL: is_published was not actually set to true';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2a. Positive: incidents.tasks.create (no incidents.manage) can INSERT a
-- follow-up action.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_followup_actions (facility_id, incident_id, action_type, status, description) values
    ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e10000-0000-0000-0000-000000000e11', 'corrective_action', 'open', 'PA task-creator followup');
exception
  when insufficient_privilege then
    raise exception 'PA FAIL: an incidents.tasks.create holder was denied inserting a follow-up action';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2b. Negative: a plain incidents.read-only actor cannot.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a06","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into incident_followup_actions (facility_id, incident_id, action_type, status, description) values
      ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e10000-0000-0000-0000-000000000e11', 'corrective_action', 'open', 'PA reader followup attempt');
    raise exception 'PA FAIL: an incidents.read-only actor inserted a follow-up action';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3a. Positive: incidents.escalate (no incidents.manage) can INSERT an
-- escalation.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a04","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_escalations (facility_id, incident_id, reason_code, target_role, status, due_at) values
    ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e10000-0000-0000-0000-000000000e11', 'user_escalation', 'manager', 'pending', now() + interval '1 day');
exception
  when insufficient_privilege then
    raise exception 'PA FAIL: an incidents.escalate holder was denied inserting an escalation';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3b. Negative: a plain incidents.read-only actor cannot.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a06","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into incident_escalations (facility_id, incident_id, reason_code, target_role, status, due_at) values
      ('44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44e10000-0000-0000-0000-000000000e11', 'user_escalation', 'manager', 'pending', now() + interval '1 day');
    raise exception 'PA FAIL: an incidents.read-only actor inserted an escalation';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4a. Positive: incidents.audit.view (no incidents.manage/incidents.review)
-- can SELECT the facility's incident_audit_events rows.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a05","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from incident_audit_events where event_type = 'permission_alignment.seed';
  if visible_count <> 1 then
    raise exception 'PA FAIL: an incidents.audit.view holder could not read the seeded incident_audit_events row (saw %)', visible_count;
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4b. Negative: a plain incidents.read-only actor sees zero rows.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44000000-0000-0000-0000-000000000a06","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from incident_audit_events where event_type = 'permission_alignment.seed';
  if visible_count <> 0 then
    raise exception 'PA FAIL: an incidents.read-only actor (no audit.view/manage/review) could read incident_audit_events';
  end if;
end;
$$;

reset role;

rollback;
