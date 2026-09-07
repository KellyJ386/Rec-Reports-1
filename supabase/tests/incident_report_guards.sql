-- Verification intent: Slice 1C, S-4 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md)
-- -- 0043_incident_report_guards.sql. Covers:
--   1. A legal transition (draft -> submitted) by an incidents.manage holder
--      succeeds, and lands an incident.submitted row in audit_events
--      (fn_incident_report_audit).
--   2. An illegal transition (submitted -> closed, skipping under_review)
--      raises check_violation (23514) -- fn_incident_report_transition_guard.
--   3. Once an incident has left draft, editing a locked column
--      (occurred_at, not on the amendment allow-list) raises check_violation,
--      even for an incidents.manage holder.
--   4. M1 (0048, wave 1B review fix): a DIRECT UPDATE to an amendable field
--      (summary) on a non-draft incident is now REJECTED -- amendable
--      fields may only change via internal.apply_incident_amendment, which
--      is exercised here too, succeeding for the same actor/incident.
--   5. A reviewer (incidents.review, no incidents.manage) can transition a
--      submitted incident to under_review (0043's widened incident_reports
--      UPDATE policy) AND the resulting write lands an incident.status_changed
--      row in audit_events (definer, so the reviewer's own lack of
--      admin.manage never blocks it).
--   6. That same reviewer can insert an incident_audit_events row directly
--      (0043's widened incident_audit_events INSERT policy) -- proving the
--      DB/BFF mismatch the routes already relied on is actually closed.
--   7. legal_hold can only change under incidents.legal_hold.manage: a plain
--      incidents.manage holder is denied (check_violation); an actor holding
--      incidents.legal_hold.manage succeeds.
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('43000000-0000-0000-0000-000000000a01', 'irg-manager@test'),
  ('43000000-0000-0000-0000-000000000a02', 'irg-reviewer@test'),
  ('43000000-0000-0000-0000-000000000a03', 'irg-legalhold@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('43000000-0000-0000-0000-000000000a01', 'IRG Manager', 'irg-manager@test'),
  ('43000000-0000-0000-0000-000000000a02', 'IRG Reviewer', 'irg-reviewer@test'),
  ('43000000-0000-0000-0000-000000000a03', 'IRG Legal Hold Manager', 'irg-legalhold@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('43111111-1111-1111-1111-111111111111', 'IRG Org A')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '43111111-1111-1111-1111-111111111111', 'IRG Facility A')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('43c00000-0000-0000-0000-0000000000c1', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IRG Manager Role'),
  ('43c00000-0000-0000-0000-0000000000c2', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IRG Reviewer Role'),
  ('43c00000-0000-0000-0000-0000000000c3', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IRG Legal Hold Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('43c00000-0000-0000-0000-0000000000c1', 'incidents.manage'),
  ('43c00000-0000-0000-0000-0000000000c1', 'incidents.read'),
  ('43c00000-0000-0000-0000-0000000000c2', 'incidents.review'),
  ('43c00000-0000-0000-0000-0000000000c2', 'incidents.read'),
  ('43c00000-0000-0000-0000-0000000000c3', 'incidents.review'),
  ('43c00000-0000-0000-0000-0000000000c3', 'incidents.legal_hold.manage'),
  ('43c00000-0000-0000-0000-0000000000c3', 'incidents.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('43d10000-0000-0000-0000-0000000000d1', '43000000-0000-0000-0000-000000000a01', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '43c00000-0000-0000-0000-0000000000c1', 'active'),
  ('43d10000-0000-0000-0000-0000000000d2', '43000000-0000-0000-0000-000000000a02', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '43c00000-0000-0000-0000-0000000000c2', 'active'),
  ('43d10000-0000-0000-0000-0000000000d3', '43000000-0000-0000-0000-000000000a03', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '43c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

-- One incident row per scenario below, seeded with RLS bypassed (owner
-- role) so each test starts from a known, isolated state.
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('43e00000-0000-0000-0000-000000000e01', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IRG1', 'incident', 'draft', 'medium', '2026-07-01T00:00:00Z', 'Dock 1', 'Draft for valid-transition test'),
  ('43e00000-0000-0000-0000-000000000e02', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IRG2', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock 2', 'Submitted for illegal-transition test'),
  ('43e00000-0000-0000-0000-000000000e03', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IRG3', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock 3', 'Submitted for locked-column test'),
  ('43e00000-0000-0000-0000-000000000e04', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IRG4', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock 4', 'Submitted for reviewer-transition test'),
  ('43e00000-0000-0000-0000-000000000e05', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IRG5', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock 5', 'Submitted for legal_hold-denial test'),
  ('43e00000-0000-0000-0000-000000000e06', '43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IRG6', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Dock 6', 'Submitted for legal_hold-success test')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Manager: draft -> submitted succeeds and lands an incident.submitted
-- audit_events row.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"43000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update incident_reports
    set status = 'submitted', submitted_by = '43000000-0000-0000-0000-000000000a01', submitted_at = now()
    where id = '43e00000-0000-0000-0000-000000000e01';
exception
  when check_violation then
    raise exception 'IRG FAIL: draft -> submitted was rejected as an illegal transition';
end;
$$;

-- (audit_events' own SELECT policy is admin.manage-only, 0019, untouched by
-- this slice -- none of this file's actors hold it, so every audit_events
-- read below happens AFTER `reset role`, as the superuser table owner who
-- bypasses RLS entirely, never under the acting role's own session.)

-- ---------------------------------------------------------------------------
-- 2. Manager: submitted -> closed (skipping under_review) is illegal.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set status = 'closed' where id = '43e00000-0000-0000-0000-000000000e02';
    raise exception 'IRG FAIL: submitted -> closed (an illegal transition) succeeded';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Manager: once submitted, editing a locked column (occurred_at, not on
-- the amendment allow-list) is rejected even though the manager otherwise
-- has full RLS write access to this row.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set occurred_at = '2026-08-01T00:00:00Z' where id = '43e00000-0000-0000-0000-000000000e03';
    raise exception 'IRG FAIL: a locked column (occurred_at) was edited on a non-draft incident';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. M1 (0048): a DIRECT UPDATE to an amendable field (summary) on the same
-- non-draft incident is now rejected -- the prior wide-open behavior this
-- migration closes.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set summary = 'Corrected summary (direct)' where id = '43e00000-0000-0000-0000-000000000e03';
    raise exception 'IRG FAIL: a direct UPDATE to an amendable field (summary) succeeded on a non-draft incident (M1 not closed)';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. M1 (0048): the SAME field change succeeds through
-- internal.apply_incident_amendment, which sets the session flag the guard
-- above honors, and writes an incident_amendments row atomically with the
-- incident_reports UPDATE.
-- ---------------------------------------------------------------------------
do $$
declare
  result jsonb;
begin
  select internal.apply_incident_amendment(
    '43e00000-0000-0000-0000-000000000e03'::uuid,
    jsonb_build_object('summary', 'Corrected summary (via RPC)'),
    'IRG amendment test'
  ) into result;
  if (result -> 'incident' ->> 'summary') <> 'Corrected summary (via RPC)' then
    raise exception 'IRG FAIL: apply_incident_amendment did not actually change summary (saw %)', result -> 'incident' ->> 'summary';
  end if;
  if (result -> 'amendment' ->> 'amendment_reason') <> 'IRG amendment test' then
    raise exception 'IRG FAIL: apply_incident_amendment did not insert the expected incident_amendments row';
  end if;
exception
  when insufficient_privilege then
    raise exception 'IRG FAIL: an incidents.manage holder was denied by apply_incident_amendment';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4c. NEW-2 (0048 re-verification): the RPC disarms rec.amendment_in_progress
-- before returning, so a direct amendable-field UPDATE later in the SAME
-- transaction is still rejected -- the flag cannot be left armed by one
-- legitimate amendment and reused for an unaudited rewrite.
-- ---------------------------------------------------------------------------
do $$
begin
  if coalesce(current_setting('rec.amendment_in_progress', true), '') = 'true' then
    raise exception 'IRG FAIL: rec.amendment_in_progress is still armed after apply_incident_amendment returned';
  end if;
  begin
    update incident_reports set summary = 'Unaudited rewrite after RPC' where id = '43e00000-0000-0000-0000-000000000e03';
    raise exception 'IRG FAIL: a direct amendable-field UPDATE succeeded after a prior RPC call in the same transaction (flag left armed)';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4d. NEW-1 (0048 re-verification): the BFF reaches the RPC through
-- PostgREST as POST /rest/v1/rpc/apply_incident_amendment, i.e. the
-- UNQUALIFIED public.apply_incident_amendment wrapper -- `internal` is never
-- exposed by PostgREST. Calling the wrapper exactly as PostgREST would (as
-- `authenticated`, by bare name) must work and must land the amendment row.
-- ---------------------------------------------------------------------------
do $$
declare
  result jsonb;
  amendment_count integer;
begin
  select public.apply_incident_amendment(
    '43e00000-0000-0000-0000-000000000e03'::uuid,
    jsonb_build_object('location_text', 'Pool deck, north end (via public wrapper)'),
    'IRG public wrapper test'
  ) into result;
  if (result -> 'incident' ->> 'location_text') <> 'Pool deck, north end (via public wrapper)' then
    raise exception 'IRG FAIL: public.apply_incident_amendment did not apply the change (saw %)', result -> 'incident' ->> 'location_text';
  end if;
  select count(*) into amendment_count
    from incident_amendments
    where incident_id = '43e00000-0000-0000-0000-000000000e03' and amendment_reason = 'IRG public wrapper test';
  if amendment_count <> 1 then
    raise exception 'IRG FAIL: public.apply_incident_amendment did not insert its incident_amendments row (count %)', amendment_count;
  end if;
  if coalesce(current_setting('rec.amendment_in_progress', true), '') = 'true' then
    raise exception 'IRG FAIL: rec.amendment_in_progress left armed by the public wrapper';
  end if;
exception
  when insufficient_privilege then
    raise exception 'IRG FAIL: authenticated cannot execute public.apply_incident_amendment (the PostgREST-facing wrapper)';
  when undefined_function then
    raise exception 'IRG FAIL: public.apply_incident_amendment does not exist -- the RPC is unreachable through PostgREST';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7a. Manager (no incidents.legal_hold.manage) cannot flip legal_hold.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set legal_hold = true where id = '43e00000-0000-0000-0000-000000000e05';
    raise exception 'IRG FAIL: a plain incidents.manage holder changed legal_hold without incidents.legal_hold.manage';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Assertions for 1 and 4 above, run as the superuser table owner (bypasses
-- RLS) since audit_events' own SELECT policy is admin.manage-only and none
-- of this file's actors hold it.
-- ---------------------------------------------------------------------------
do $$
declare
  submitted_count int;
  updated_count int;
begin
  select count(*) into submitted_count
    from audit_events
    where entity_table = 'incident_reports'
      and entity_id = '43e00000-0000-0000-0000-000000000e01'
      and event_type = 'incident.submitted';
  if submitted_count <> 1 then
    raise exception 'IRG FAIL: expected exactly 1 incident.submitted audit_events row, saw %', submitted_count;
  end if;

  select count(*) into updated_count
    from audit_events
    where entity_table = 'incident_reports'
      and entity_id = '43e00000-0000-0000-0000-000000000e03'
      and event_type = 'incident.updated';
  -- Two audited amendments landed on e03 above: the summary edit through
  -- internal.apply_incident_amendment (#4b) and the location_text edit
  -- through the PostgREST-facing public wrapper (#4d). The rejected direct
  -- UPDATEs (#4a, #4c) must not have produced a row.
  if updated_count <> 2 then
    raise exception 'IRG FAIL: expected exactly 2 incident.updated audit_events rows (one per amendment), saw %', updated_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reviewer (incidents.review, NO incidents.manage): submitted ->
-- under_review succeeds (0043's widened incident_reports UPDATE policy), and
-- lands an incident.status_changed audit_events row even though the reviewer
-- holds no admin.manage (fn_incident_report_audit is SECURITY DEFINER).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"43000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update incident_reports set status = 'under_review' where id = '43e00000-0000-0000-0000-000000000e04';
exception
  when insufficient_privilege then
    raise exception 'IRG FAIL: an incidents.review holder was denied updating incident_reports (0043 RLS gap not closed)';
  when check_violation then
    raise exception 'IRG FAIL: submitted -> under_review was rejected as an illegal transition';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. That same reviewer can INSERT an incident_audit_events row directly --
-- the DB/BFF mismatch incidents-routes.mjs's status route relies on
-- (:578-591 inserts as the caller's own client) is closed.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into incident_audit_events (facility_id, incident_id, event_type, event_payload, event_hash) values
    ('43aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '43e00000-0000-0000-0000-000000000e04', 'incident.status_changed', '{}'::jsonb, 'irg-fixture-hash');
exception
  when insufficient_privilege then
    raise exception 'IRG FAIL: an incidents.review holder was denied inserting an incident_audit_events row';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Assertion for 5 above (same reset-role rationale as the earlier batch).
-- ---------------------------------------------------------------------------
do $$
declare
  audit_count int;
begin
  select count(*) into audit_count
    from audit_events
    where entity_table = 'incident_reports'
      and entity_id = '43e00000-0000-0000-0000-000000000e04'
      and event_type = 'incident.status_changed';
  if audit_count <> 1 then
    raise exception 'IRG FAIL: expected exactly 1 incident.status_changed audit_events row from the reviewer''s transition, saw %', audit_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7b. An actor holding incidents.legal_hold.manage CAN flip legal_hold.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"43000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update incident_reports set legal_hold = true where id = '43e00000-0000-0000-0000-000000000e06';
exception
  when check_violation then
    raise exception 'IRG FAIL: an incidents.legal_hold.manage holder was denied changing legal_hold';
end;
$$;

do $$
declare
  hold_value boolean;
begin
  select legal_hold into hold_value from incident_reports where id = '43e00000-0000-0000-0000-000000000e06';
  if hold_value is not true then
    raise exception 'IRG FAIL: legal_hold was not actually set to true';
  end if;
end;
$$;

reset role;

rollback;
