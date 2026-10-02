-- Verification intent: DR-24 (plans/DAILY_REPORTS_PLAN.md), 0055's RLS +
-- fn_report_submission_transition_guard extension to report_submissions.
-- Covers:
--   1. Legal transitions: submitted -> locked; submitted -> revised (direct,
--      skipping locked); locked -> revised. Each mints/records what the
--      route layer would (a lock just flips status; a revise also inserts a
--      draft successor with revision_of pointing back at the original).
--   2. Illegal transitions rejected with check_violation: locked -> submitted
--      (backwards), draft -> locked (skipping submit entirely), a
--      submitted/locked row's content edited alongside (or instead of) a
--      legal status move.
--   3. A revised row is permanently immutable (tested as a service-role/
--      superuser write, bypassing RLS entirely, to prove the TRIGGER closes
--      this regardless of role -- not just the RLS policy that also happens
--      to exclude 'revised' rows from every UPDATE policy's USING clause).
--   4. A locked row rejects a payload change even when the actor legitimately
--      holds reports.publish and the status field itself is left alone.
--   5. revision_of must reference a submission in the same facility
--      (insufficient_privilege via the INSERT policy's
--      fn_assert_same_facility guard).
--   6. Permission boundaries: a reports.submit-only actor (no
--      reports.publish) can neither lock nor revise a submitted report (0
--      rows affected, not an exception -- RLS's USING simply never admits
--      the row).
--   7. report.locked / report.revised audit events land (0055's extension of
--      fn_report_submission_audit, 0033).
--   8. L-5 (security review): an authenticated reports.publish holder cannot
--      write pdf_status/pdf_storage_path/pdf_content_hash/pdf_attempts/
--      pdf_error on their own facility's submitted row -- only a session
--      with no acting user at all (service-role shape) may. Tested both
--      ways: authenticated rejected, service-role-shaped (RLS bypassed,
--      auth.uid() null) accepted.
--   9. L-8 (security review): revision_of is now department-checked, not
--      just facility-checked -- a successor whose OWN department_id
--      disagrees with the department of the submission it revises is
--      rejected, even though both rows are in the same facility and the
--      actor holds reports.publish in both departments (facility-wide
--      membership).
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('55000000-0000-0000-0000-000000000a01', 'rl-manager@test'),
  ('55000000-0000-0000-0000-000000000a02', 'rl-submitter@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('55000000-0000-0000-0000-000000000a01', 'RL Manager', 'rl-manager@test'),
  ('55000000-0000-0000-0000-000000000a02', 'RL Submitter', 'rl-submitter@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('55111111-1111-1111-1111-111111111111', 'RL Org A'),
  ('55222222-2222-2222-2222-222222222222', 'RL Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55111111-1111-1111-1111-111111111111', 'RL Facility A'),
  ('55bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55222222-2222-2222-2222-222222222222', 'RL Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('55c00000-0000-0000-0000-0000000000c1', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RL Manager Role'),
  ('55c00000-0000-0000-0000-0000000000c2', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RL Submitter-only Role')
on conflict (id) do nothing;

-- The manager holds reports.publish (lock/revise) AND reports.create/submit
-- (so the revise route's successor INSERT never has to disentangle which
-- code actually let it through). The submitter-only role deliberately holds
-- reports.submit but NOT reports.publish -- the permission-boundary cases
-- below.
insert into role_permissions (role_id, permission_code) values
  ('55c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('55c00000-0000-0000-0000-0000000000c1', 'reports.create'),
  ('55c00000-0000-0000-0000-0000000000c1', 'reports.submit'),
  ('55c00000-0000-0000-0000-0000000000c1', 'reports.publish'),
  ('55c00000-0000-0000-0000-0000000000c2', 'reports.read'),
  ('55c00000-0000-0000-0000-0000000000c2', 'reports.create'),
  ('55c00000-0000-0000-0000-0000000000c2', 'reports.submit')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('55d00000-0000-0000-0000-0000000000d1', '55000000-0000-0000-0000-000000000a01', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55c00000-0000-0000-0000-0000000000c1', 'active'),
  ('55d00000-0000-0000-0000-0000000000d2', '55000000-0000-0000-0000-000000000a02', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55c00000-0000-0000-0000-0000000000c2', 'active')
on conflict (id) do nothing;

insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('55e00000-0000-0000-0000-0000000000e1', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rl_tpl', 'RL Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('55f00000-0000-0000-0000-0000000000f1', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', 1, '{"sections":[]}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '55e00000-0000-0000-0000-0000000000e1' and active_version is null;

-- A pre-existing SUBMITTED report in a different facility (B), used only as
-- the cross-facility revision_of FK-injection target in step 5. Seeded with
-- RLS bypassed (table owner).
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('55e00000-0000-0000-0000-0000000000e2', '55bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'rl_tpl_b', 'RL Template B', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('55f00000-0000-0000-0000-0000000000f2', '55bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55e00000-0000-0000-0000-0000000000e2', 1, '{"sections":[]}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '55e00000-0000-0000-0000-0000000000e2' and active_version is null;
insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status, submitted_by, submitted_at, payload_json) values
  ('55000000-0000-0000-0000-0000000000b0', '55bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55e00000-0000-0000-0000-0000000000e2', '55f00000-0000-0000-0000-0000000000f2', '2026-07-01', 'submitted', '55000000-0000-0000-0000-000000000a01', now(), '{}'::jsonb)
on conflict (id) do nothing;

-- Four Facility-A submissions, all born 'submitted' (bypassing the normal
-- draft->submit dance -- not what this file is testing), one per scenario
-- below so each case starts from a clean, independent row.
insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status, submitted_by, submitted_at, payload_json) values
  ('55000000-0000-0000-0000-000000001001', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-10', 'submitted', '55000000-0000-0000-0000-000000000a02', now(), '{"note":"lock-me"}'::jsonb),
  ('55000000-0000-0000-0000-000000001002', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-11', 'submitted', '55000000-0000-0000-0000-000000000a02', now(), '{"note":"revise-me-direct"}'::jsonb),
  ('55000000-0000-0000-0000-000000001003', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-12', 'submitted', '55000000-0000-0000-0000-000000000a02', now(), '{"note":"lock-then-revise"}'::jsonb),
  ('55000000-0000-0000-0000-000000001004', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-13', 'submitted', '55000000-0000-0000-0000-000000000a02', now(), '{"note":"permission-boundary"}'::jsonb),
  ('55000000-0000-0000-0000-000000001005', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-16', 'submitted', '55000000-0000-0000-0000-000000000a02', now(), '{"note":"pdf-guard"}'::jsonb)
on conflict (id) do nothing;

-- L-8 fixtures: two departments in Facility A, and a submitted report filed
-- against department X.
insert into departments (id, facility_id, name) values
  ('55dd0000-0000-0000-0000-00000000dd01', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RL Dept X'),
  ('55dd0000-0000-0000-0000-00000000dd02', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RL Dept Y')
on conflict (id) do nothing;
insert into report_submissions (id, facility_id, department_id, template_id, template_version_id, report_date, status, submitted_by, submitted_at, payload_json) values
  ('55000000-0000-0000-0000-000000001006', '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55dd0000-0000-0000-0000-00000000dd01', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-17', 'submitted', '55000000-0000-0000-0000-000000000a02', now(), '{"note":"dept-x-original"}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Act as the SUBMITTER (reports.submit, no reports.publish) from here.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"55000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

-- 6a. A reports.submit-only actor cannot lock a submitted report: RLS's
-- USING never admits the row (0 rows affected, no exception).
do $$
declare
  v_count int;
begin
  update report_submissions set status = 'locked' where id = '55000000-0000-0000-0000-000000001004';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'RL FAIL: a reports.submit-only actor was able to lock a submitted report (% rows)', v_count;
  end if;
end;
$$;

-- 6b. Same actor cannot revise it either.
do $$
declare
  v_count int;
begin
  update report_submissions set status = 'revised' where id = '55000000-0000-0000-0000-000000001004';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'RL FAIL: a reports.submit-only actor was able to revise a submitted report (% rows)', v_count;
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Act as the MANAGER (reports.publish) from here.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"55000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

-- 1a. Legal: submitted -> locked.
do $$
begin
  update report_submissions set status = 'locked' where id = '55000000-0000-0000-0000-000000001001';
exception
  when check_violation then
    raise exception 'RL FAIL: submitted -> locked was rejected as an illegal transition';
end;
$$;

do $$
declare
  v_status text;
begin
  select status into v_status from report_submissions where id = '55000000-0000-0000-0000-000000001001';
  if v_status <> 'locked' then
    raise exception 'RL FAIL: expected status locked, got %', v_status;
  end if;
end;
$$;

-- 2a. Illegal: locked -> submitted (backwards).
do $$
begin
  begin
    update report_submissions set status = 'submitted' where id = '55000000-0000-0000-0000-000000001001';
    raise exception 'RL FAIL: locked -> submitted (backwards) succeeded';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- 4. A locked row rejects a payload change even with status left alone.
do $$
begin
  begin
    update report_submissions set payload_json = '{"note":"tampered"}'::jsonb where id = '55000000-0000-0000-0000-000000001001';
    raise exception 'RL FAIL: a locked report''s payload_json was changed';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- 1b. Legal: locked -> revised, WITH a content change bundled into the same
-- statement -- rejected (content must stay unchanged even on a legal status
-- move); then the legal no-content-change form succeeds.
do $$
begin
  begin
    update report_submissions
      set status = 'revised', payload_json = '{"note":"tampered-on-revise"}'::jsonb
      where id = '55000000-0000-0000-0000-000000001001';
    raise exception 'RL FAIL: locked -> revised with a bundled content change succeeded';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

do $$
begin
  update report_submissions set status = 'revised' where id = '55000000-0000-0000-0000-000000001001';
exception
  when check_violation then
    raise exception 'RL FAIL: locked -> revised (no content change) was rejected';
end;
$$;

-- The "lock-then-revise" successor: DR-24's revise route inserts a draft
-- successor before flipping the original -- reproduced here directly (plain
-- INSERT, re-selected below rather than via psql's \gset, matching every
-- other file in this suite).
insert into report_submissions (facility_id, template_id, template_version_id, report_date, status, payload_json, revision_of)
  values ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-10', 'draft', '{"note":"lock-me"}'::jsonb, '55000000-0000-0000-0000-000000001001');

do $$
declare
  v_successor_id uuid;
  v_successor_status text;
begin
  select id, status into v_successor_id, v_successor_status
    from report_submissions where revision_of = '55000000-0000-0000-0000-000000001001';
  if v_successor_id is null then
    raise exception 'RL FAIL: no revision successor row found for original 55000000-0000-0000-0000-000000001001';
  end if;
  if v_successor_status <> 'draft' then
    raise exception 'RL FAIL: revision successor status = %, expected draft', v_successor_status;
  end if;
end;
$$;

-- 1c. Legal: submitted -> revised DIRECTLY (skipping locked entirely).
do $$
begin
  update report_submissions set status = 'revised' where id = '55000000-0000-0000-0000-000000001002';
exception
  when check_violation then
    raise exception 'RL FAIL: submitted -> revised (direct) was rejected as an illegal transition';
end;
$$;

-- 2b. Illegal: draft -> locked (skipping submit entirely). Uses a fresh
-- draft row inserted under this same session (reports.create).
do $$
declare
  v_draft_id uuid;
begin
  insert into report_submissions (facility_id, template_id, template_version_id, report_date, status, payload_json)
    values ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-14', 'draft', '{}'::jsonb)
    returning id into v_draft_id;

  begin
    update report_submissions set status = 'locked' where id = v_draft_id;
    raise exception 'RL FAIL: draft -> locked (skipping submit) succeeded';
  exception
    -- This actor holds BOTH reports.submit (admits the draft row's
    -- pre-image via the draft-only policy's USING) AND reports.publish
    -- (whose WITH CHECK, status in ('locked','revised'), would otherwise
    -- admit the post-image on its own -- Postgres ORs WITH CHECK across
    -- every permissive UPDATE policy on the table, not just the one whose
    -- USING happened to admit this row). fn_report_submission_transition_
    -- guard's explicit old.status = 'draft' -> new.status in
    -- ('draft','submitted') check (0055) is what actually closes this, not
    -- RLS alone -- see that migration's comment on this exact scenario.
    when check_violation then null; -- expected
  end;
end;
$$;

do $$
declare
  v_status text;
begin
  select status into v_status from report_submissions
    where facility_id = '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and report_date = '2026-07-14';
  if v_status <> 'draft' then
    raise exception 'RL FAIL: a draft report moved to % without ever being submitted', v_status;
  end if;
end;
$$;

-- 3b (still as the manager, RLS-scoped): a report.publish holder cannot
-- reach the now-revised row at all -- RLS's USING for the lock/revise policy
-- only ever admits status in ('submitted', 'locked'), so this is 0 rows, not
-- an exception, and is the RLS half of "revised is immutable" (the trigger
-- half, exercised independent of RLS, is step 3 below).
do $$
declare
  v_count int;
begin
  update report_submissions set payload_json = '{"note":"tampered-after-revise"}'::jsonb
    where id = '55000000-0000-0000-0000-000000001001';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'RL FAIL: a reports.publish holder edited an already-revised report (% rows)', v_count;
  end if;
end;
$$;

-- 5. revision_of cross-facility FK injection: this actor has reports.publish
-- (and reports.create) in Facility A only; pointing revision_of at the
-- Facility B submission seeded above must be rejected.
do $$
begin
  begin
    insert into report_submissions (facility_id, template_id, template_version_id, report_date, status, payload_json, revision_of)
      values ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-15', 'draft', '{}'::jsonb, '55000000-0000-0000-0000-0000000000b0');
    raise exception 'RL FAIL: revision_of was allowed to point at a submission in a different facility';
  exception
    -- fn_report_submission_transition_guard's BEFORE INSERT check (0055)
    -- fires before RLS's own WITH CHECK is evaluated and raises
    -- check_violation first; the INSERT policy's own
    -- fn_assert_same_facility(..., 'report_submissions', revision_of) guard
    -- is a second, redundant line of defense that would raise
    -- insufficient_privilege if the trigger were ever removed.
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. L-8 (security review): revision_of is now department-checked, not just
-- facility-checked. This actor holds reports.publish facility-wide (passes
-- the department check on EITHER department), so the department mismatch
-- below is caught by the trigger, not by a permission gap.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_submissions (facility_id, department_id, template_id, template_version_id, report_date, status, payload_json, revision_of)
      values ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55dd0000-0000-0000-0000-00000000dd02', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-18', 'draft', '{}'::jsonb, '55000000-0000-0000-0000-000000001006');
    raise exception 'RL FAIL: revision_of was allowed to point at a submission in a DIFFERENT department (dept X original, dept Y successor)';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- Same-department revision_of is still legal (including the both-null
-- shape every other fixture in this file already exercises).
do $$
declare
  v_successor_id uuid;
begin
  insert into report_submissions (facility_id, department_id, template_id, template_version_id, report_date, status, payload_json, revision_of)
    values ('55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55dd0000-0000-0000-0000-00000000dd01', '55e00000-0000-0000-0000-0000000000e1', '55f00000-0000-0000-0000-0000000000f1', '2026-07-19', 'draft', '{}'::jsonb, '55000000-0000-0000-0000-000000001006')
    returning id into v_successor_id;
  if v_successor_id is null then
    raise exception 'RL FAIL: a same-department revision_of successor was unexpectedly rejected';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. L-5 (security review): an authenticated reports.publish holder cannot
-- write pdf_status/pdf_storage_path/pdf_content_hash/pdf_attempts/pdf_error
-- on their own facility's submitted row -- only a nil-auth.uid() (service-
-- role-shaped) session may. The RLS lock/revise policy's WITH CHECK would
-- otherwise admit this (status stays 'submitted' -> not in its own status
-- list, so RLS never even reaches it -- proving the previous fast path in
-- fn_report_submission_transition_guard, not RLS, was the actual hole:
-- status UNCHANGED content-only updates are governed by that trigger's
-- v_content_unchanged fast path, which pdf_* columns deliberately sit
-- outside of).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update report_submissions
      set pdf_status = 'generated',
          pdf_content_hash = repeat('a', 64),
          pdf_storage_path = 'facilities/55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/reports/55000000-0000-0000-0000-000000001005/snapshot-aaaaaaaa.pdf'
      where id = '55000000-0000-0000-0000-000000001005';
    raise exception 'RL FAIL: an authenticated reports.publish holder was able to write pdf_* columns';
  exception
    when insufficient_privilege then null; -- expected: fn_report_submission_transition_guard's v_pdf_changed guard
  end;
end;
$$;

reset role;
-- `reset role` alone does not clear request.jwt.claims (set with
-- is_local=true, so it otherwise stays active for the rest of THIS
-- transaction) -- clear it explicitly so auth.uid() genuinely reads null
-- below, simulating a real service-role-authenticated PostgREST call
-- rather than an accidental continuation of the manager's own session
-- (same pattern report_workflow_events.sql's suite already uses).
select set_config('request.jwt.claims', '', true);

-- L-5, other half: a service-role-shaped session (RLS bypassed, no acting
-- user -- auth.uid() reads null) CAN write the same pdf_* columns.
do $$
declare
  v_pdf_status text;
begin
  update report_submissions
    set pdf_status = 'generated',
        pdf_content_hash = repeat('a', 64),
        pdf_storage_path = 'facilities/55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/reports/55000000-0000-0000-0000-000000001005/snapshot-aaaaaaaa.pdf'
    where id = '55000000-0000-0000-0000-000000001005';
  select pdf_status into v_pdf_status from report_submissions where id = '55000000-0000-0000-0000-000000001005';
  if v_pdf_status <> 'generated' then
    raise exception 'RL FAIL: a service-role-shaped session could not write pdf_* columns (pdf_status=%)', v_pdf_status;
  end if;
exception
  when insufficient_privilege then
    raise exception 'RL FAIL: a service-role-shaped session (auth.uid() is null) was denied writing pdf_* columns';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A revised row is permanently immutable, tested as the table owner
-- (RLS bypassed entirely, simulating a service-role/direct write) -- proves
-- fn_report_submission_transition_guard itself closes this, independent of
-- whatever RLS policy would otherwise have excluded the row.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update report_submissions set payload_json = '{"note":"service-role-tamper"}'::jsonb
      where id = '55000000-0000-0000-0000-000000001001';
    raise exception 'RL FAIL: a revised report was edited by a role that bypasses RLS entirely';
  exception
    when check_violation then null; -- expected: the trigger, not RLS, caught this
  end;
end;
$$;

do $$
begin
  begin
    update report_submissions set status = 'submitted' where id = '55000000-0000-0000-0000-000000001001';
    raise exception 'RL FAIL: a revised report''s status was changed back by a role that bypasses RLS entirely';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. report.locked / report.revised audit events landed for submission 1001
-- (submitted -> locked -> revised, from steps 1a/1b above).
-- ---------------------------------------------------------------------------
do $$
declare
  v_locked_count int;
  v_revised_count int;
begin
  select count(*) into v_locked_count from audit_events
    where entity_table = 'report_submissions' and entity_id = '55000000-0000-0000-0000-000000001001' and event_type = 'report.locked';
  select count(*) into v_revised_count from audit_events
    where entity_table = 'report_submissions' and entity_id = '55000000-0000-0000-0000-000000001001' and event_type = 'report.revised';
  if v_locked_count <> 1 then
    raise exception 'RL FAIL: expected exactly one report.locked audit row, got %', v_locked_count;
  end if;
  if v_revised_count <> 1 then
    raise exception 'RL FAIL: expected exactly one report.revised audit row, got %', v_revised_count;
  end if;
end;
$$;

-- report.revised also landed for submission 1002 (submitted -> revised,
-- direct, step 1c).
do $$
declare
  v_revised_count int;
begin
  select count(*) into v_revised_count from audit_events
    where entity_table = 'report_submissions' and entity_id = '55000000-0000-0000-0000-000000001002' and event_type = 'report.revised';
  if v_revised_count <> 1 then
    raise exception 'RL FAIL: expected exactly one report.revised audit row for submission 1002, got %', v_revised_count;
  end if;
end;
$$;

rollback;
