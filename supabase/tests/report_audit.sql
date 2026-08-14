-- Verification intent: DR-10's submission lifecycle audit trigger
-- (fn_report_submission_audit, 0033). A report_submissions/
-- report_submission_attachments write produces exactly the documented
-- audit_events row per lifecycle transition, each one chained into the
-- facility's hash-chain partition (0013/0019), and the whole trail stays
-- append-only (0010). Runs inside a transaction that is rolled back, so no
-- fixture persists. Each assertion RAISEs on failure so
-- psql -v ON_ERROR_STOP=1 turns any regression into a non-zero exit.
begin;

insert into auth.users (id, email) values
  ('9a000000-0000-0000-0000-00000000009a', 'reportaudit@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('9a000000-0000-0000-0000-00000000009a', 'Report Audit User', 'reportaudit@test')
on conflict (id) do nothing;
insert into organizations (id, name) values
  ('9a000000-0000-0000-0000-00000000009b', 'Report Audit Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('9a000000-0000-0000-0000-00000000009c', '9a000000-0000-0000-0000-00000000009b', 'Report Audit Facility')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('9a000000-0000-0000-0000-00000000009d', '9a000000-0000-0000-0000-00000000009c', 'Report Filer Role')
on conflict (id) do nothing;
-- Deliberately NOT admin.manage: proves fn_report_submission_audit's
-- SECURITY DEFINER insert into audit_events works for an actor who could
-- never satisfy "admins can write audit events" (0019) directly.
insert into role_permissions (role_id, permission_code) values
  ('9a000000-0000-0000-0000-00000000009d', 'reports.create'),
  ('9a000000-0000-0000-0000-00000000009d', 'reports.submit'),
  ('9a000000-0000-0000-0000-00000000009d', 'reports.read')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('9a000000-0000-0000-0000-00000000009e', '9a000000-0000-0000-0000-00000000009a', '9a000000-0000-0000-0000-00000000009c', '9a000000-0000-0000-0000-00000000009d', 'active')
on conflict (id) do nothing;

-- active_version starts null and is set only AFTER the matching version row
-- exists -- fn_report_template_active_version_published (0028) requires a
-- published version_number match at insert/update time.
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('9a000000-0000-0000-0000-00000000009f', '9a000000-0000-0000-0000-00000000009c', 'audit_tpl', 'Audit Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('9a000000-0000-0000-0000-0000000000a0', '9a000000-0000-0000-0000-00000000009c', '9a000000-0000-0000-0000-00000000009f', 1, '{"sections":[]}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '9a000000-0000-0000-0000-00000000009f' and active_version is null;

-- Draft create -> draft edit -> submit, all under the actor's own
-- RLS-scoped session (the real API's connection shape).
select set_config('request.jwt.claims', '{"sub":"9a000000-0000-0000-0000-00000000009a","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_submission_id uuid;
begin
  insert into report_submissions (facility_id, template_id, template_version_id, report_date, status)
  values ('9a000000-0000-0000-0000-00000000009c', '9a000000-0000-0000-0000-00000000009f', '9a000000-0000-0000-0000-0000000000a0', '2026-08-10', 'draft')
  returning id into v_submission_id;

  update report_submissions set payload_json = '{"note":"in progress"}'::jsonb where id = v_submission_id;

  update report_submissions
    set status = 'submitted', submitted_by = '9a000000-0000-0000-0000-00000000009a', submitted_at = now()
    where id = v_submission_id;

  perform set_config('report_audit_test.submission_id', v_submission_id::text, true);
end;
$$;

reset role;

-- Attachment insert runs directly (report_submission_attachments has no
-- INSERT policy yet -- DR-09 is a sibling task, not this one); the point
-- here is only to prove the trigger fires and files the event against the
-- parent submission, not to prove attachment write authorization.
do $$
declare
  v_submission_id uuid := current_setting('report_audit_test.submission_id')::uuid;
begin
  insert into report_submission_attachments (facility_id, submission_id, field_key, storage_path, mime_type)
  values ('9a000000-0000-0000-0000-00000000009c', v_submission_id, 'photo', 'facilities/x/reports/y/z.jpg', 'image/jpeg');
end;
$$;

-- Exactly one audit row per lifecycle event -- append-only means "exactly
-- one row per submit" is provable by counting, since nothing can ever merge
-- or overwrite a prior row.
do $$
declare
  v_submission_id uuid := current_setting('report_audit_test.submission_id')::uuid;
  v_created_count int;
  v_updated_count int;
  v_submitted_count int;
  v_attached_count int;
begin
  select count(*) into v_created_count from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.draft_created';
  select count(*) into v_updated_count from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.draft_updated';
  select count(*) into v_submitted_count from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.submitted';
  select count(*) into v_attached_count from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.attachment_added';

  if v_created_count <> 1 then
    raise exception 'AUDIT FAIL: expected exactly one report.draft_created row, got %', v_created_count;
  end if;
  if v_updated_count <> 1 then
    raise exception 'AUDIT FAIL: expected exactly one report.draft_updated row, got %', v_updated_count;
  end if;
  if v_submitted_count <> 1 then
    raise exception 'AUDIT FAIL: expected exactly one report.submitted row, got %', v_submitted_count;
  end if;
  if v_attached_count <> 1 then
    raise exception 'AUDIT FAIL: expected exactly one report.attachment_added row, got %', v_attached_count;
  end if;
end;
$$;

-- Chain linkage (insertion order: created -> updated -> submitted ->
-- attached) and payload shape.
do $$
declare
  v_submission_id uuid := current_setting('report_audit_test.submission_id')::uuid;
  v_created audit_events%rowtype;
  v_updated audit_events%rowtype;
  v_submitted audit_events%rowtype;
  v_attached audit_events%rowtype;
begin
  select * into v_created from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.draft_created';
  select * into v_updated from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.draft_updated';
  select * into v_submitted from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.submitted';
  select * into v_attached from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.attachment_added';

  if v_created.row_hash is null then
    raise exception 'CHAIN FAIL: report.draft_created row has no row_hash';
  end if;
  if v_updated.prev_hash is distinct from v_created.row_hash then
    raise exception 'CHAIN FAIL: report.draft_updated prev_hash (%) does not chain onto report.draft_created row_hash (%)', v_updated.prev_hash, v_created.row_hash;
  end if;
  if v_submitted.prev_hash is distinct from v_updated.row_hash then
    raise exception 'CHAIN FAIL: report.submitted prev_hash (%) does not chain onto report.draft_updated row_hash (%)', v_submitted.prev_hash, v_updated.row_hash;
  end if;
  if v_attached.prev_hash is distinct from v_submitted.row_hash then
    raise exception 'CHAIN FAIL: report.attachment_added prev_hash (%) does not chain onto report.submitted row_hash (%)', v_attached.prev_hash, v_submitted.row_hash;
  end if;

  if v_submitted.event_payload #>> '{before,status}' <> 'draft' then
    raise exception 'AUDIT FAIL: report.submitted before-status = %, expected draft', v_submitted.event_payload #>> '{before,status}';
  end if;
  if v_submitted.event_payload #>> '{after,status}' <> 'submitted' then
    raise exception 'AUDIT FAIL: report.submitted after-status = %, expected submitted', v_submitted.event_payload #>> '{after,status}';
  end if;
  if v_attached.event_payload #>> '{before}' is not null then
    raise exception 'AUDIT FAIL: report.attachment_added before payload should be null (an attachment insert has no prior state)';
  end if;
  if v_attached.event_payload #>> '{after,field_key}' <> 'photo' then
    raise exception 'AUDIT FAIL: report.attachment_added after payload does not carry the attachment row';
  end if;
end;
$$;

-- Append-only: none of these rows can ever be rewritten or deleted.
do $$
declare
  v_submission_id uuid := current_setting('report_audit_test.submission_id')::uuid;
  v_id uuid;
begin
  select id into v_id from audit_events
    where entity_table = 'report_submissions' and entity_id = v_submission_id and event_type = 'report.submitted';

  begin
    update audit_events set event_type = 'tampered' where id = v_id;
    raise exception 'APPEND-ONLY FAIL: update on a report lifecycle audit row was permitted';
  exception
    when insufficient_privilege then null; -- expected: fn_block_audit_mutation raised
  end;

  begin
    delete from audit_events where id = v_id;
    raise exception 'APPEND-ONLY FAIL: delete on a report lifecycle audit row was permitted';
  exception
    when insufficient_privilege then null; -- expected: fn_block_audit_mutation raised
  end;
end;
$$;

rollback;
