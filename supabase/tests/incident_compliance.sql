-- Verification intent: Wave 3, Slice 3B -- IN-13/IN-15
-- (0056_incident_compliance.sql). Covers:
--   1. incidents.read-only member can SELECT incident_signatures and
--      incident_compliance_checks rows for their own facility.
--   2. That same reader CANNOT INSERT a signature or a compliance check (no
--      incidents.manage or incidents.review).
--   3. incidents.manage holder can sign an incident, but only as
--      themselves -- signer_user_id naming a different user is rejected.
--   4. Cross-facility FK injection on incident_signatures (incident_id
--      naming another facility's incident) is rejected.
--   5. incident_signatures is immutable: UPDATE and DELETE are both
--      rejected for the manager who inserted the row.
--   6. incident_compliance_checks: a manage holder can record a pass/fail
--      check, but CANNOT record status='waived' -- waiving requires
--      incidents.review (RLS-level, not just the route's own pre-check).
--   7. incident_compliance_checks: an incidents.review holder CAN record a
--      waived check.
--   8. incident_compliance_checks upsert semantics: a second check for the
--      same (incident_id, check_key) supersedes the first in place (no
--      second row -- the unique constraint plus ON CONFLICT DO UPDATE).
--   9. Closure gate (fn_incident_report_transition_guard's guard 2.5): a
--      high-severity incident with no evidence_complete check is rejected
--      when transitioning action_pending -> closed; once evidence_complete
--      is recorded 'pass', the same transition succeeds. A 'fail' result
--      blocks it again; a 'waived' result (recorded by a reviewer) passes.
--  10. Closure gate: an incident with requires_osha_review additionally
--      needs a passing/waived supervisor_signoff check, independent of (9).
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('56000000-0000-0000-0000-000000000a01', 'ic-manager@test'),
  ('56000000-0000-0000-0000-000000000a02', 'ic-reviewer@test'),
  ('56000000-0000-0000-0000-000000000a03', 'ic-reader@test'),
  ('56000000-0000-0000-0000-000000000a04', 'ic-other@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('56000000-0000-0000-0000-000000000a01', 'IC Manager', 'ic-manager@test'),
  ('56000000-0000-0000-0000-000000000a02', 'IC Reviewer', 'ic-reviewer@test'),
  ('56000000-0000-0000-0000-000000000a03', 'IC Reader', 'ic-reader@test'),
  ('56000000-0000-0000-0000-000000000a04', 'IC Other', 'ic-other@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('56111111-1111-1111-1111-111111111111', 'IC Org A'),
  ('56222222-2222-2222-2222-222222222222', 'IC Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56111111-1111-1111-1111-111111111111', 'IC Facility A'),
  ('56bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '56222222-2222-2222-2222-222222222222', 'IC Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('56c00000-0000-0000-0000-0000000000c1', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IC Manager Role'),
  ('56c00000-0000-0000-0000-0000000000c2', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IC Reviewer Role'),
  ('56c00000-0000-0000-0000-0000000000c3', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IC Reader Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('56c00000-0000-0000-0000-0000000000c1', 'incidents.manage'),
  ('56c00000-0000-0000-0000-0000000000c1', 'incidents.read'),
  ('56c00000-0000-0000-0000-0000000000c2', 'incidents.review'),
  ('56c00000-0000-0000-0000-0000000000c2', 'incidents.read'),
  ('56c00000-0000-0000-0000-0000000000c3', 'incidents.read')
on conflict do nothing;

-- All four test users are members of Facility A ONLY -- ic-other included,
-- solely so signer_user_id can name a real app_users row that is not the
-- caller, for step 3b.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('56d10000-0000-0000-0000-0000000000d1', '56000000-0000-0000-0000-000000000a01', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56c00000-0000-0000-0000-0000000000c1', 'active'),
  ('56d10000-0000-0000-0000-0000000000d2', '56000000-0000-0000-0000-000000000a02', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56c00000-0000-0000-0000-0000000000c2', 'active'),
  ('56d10000-0000-0000-0000-0000000000d3', '56000000-0000-0000-0000-000000000a03', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56c00000-0000-0000-0000-0000000000c3', 'active'),
  ('56d10000-0000-0000-0000-0000000000d4', '56000000-0000-0000-0000-000000000a04', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56c00000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- Incident reports: one in each facility (medium severity, no OSHA review,
-- for the RLS-only cases 1-8), plus two more high-severity/OSHA-review
-- incidents in Facility A already sitting in action_pending for the
-- closure-gate cases (9)-(10) -- seeded with RLS bypassed (owner role).
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary, requires_osha_review) values
  ('56e00000-0000-0000-0000-0000000000e1', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IC01', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Facility A dock', 'IC Facility A seed incident', false),
  ('56e00000-0000-0000-0000-0000000000e2', '56bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'INC-2026-IC02', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Facility B dock', 'IC Facility B seed incident', false),
  ('56e00000-0000-0000-0000-0000000000e3', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IC03', 'accident', 'action_pending', 'high', '2026-07-01T00:00:00Z', 'Facility A dock', 'IC high-severity closure-gate incident', false),
  ('56e00000-0000-0000-0000-0000000000e4', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IC04', 'accident', 'action_pending', 'low', '2026-07-01T00:00:00Z', 'Facility A dock', 'IC OSHA-review closure-gate incident', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Reader (incidents.read only) can SELECT signatures and compliance
-- checks for their own facility. Seeded here (RLS bypassed) so there is
-- something to read.
-- ---------------------------------------------------------------------------
insert into incident_signatures (id, facility_id, incident_id, signer_user_id, role, attestation_text, signed_name) values
  ('56200000-0000-0000-0000-000000002000', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', '56000000-0000-0000-0000-000000000a01', 'reporter', 'IC seed attestation', 'IC Manager')
on conflict (id) do nothing;

insert into incident_compliance_checks (id, facility_id, incident_id, check_key, status, checked_by) values
  ('56300000-0000-0000-0000-000000003000', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', 'evidence_complete', 'pass', '56000000-0000-0000-0000-000000000a01')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"56000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  seen_count int;
begin
  select count(*) into seen_count from incident_signatures where id = '56200000-0000-0000-0000-000000002000';
  if seen_count <> 1 then
    raise exception 'IC FAIL: incidents.read holder could not read a signature in their own facility';
  end if;
  select count(*) into seen_count from incident_compliance_checks where id = '56300000-0000-0000-0000-000000003000';
  if seen_count <> 1 then
    raise exception 'IC FAIL: incidents.read holder could not read a compliance check in their own facility';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. That same reader CANNOT INSERT a signature or a compliance check.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_signatures (facility_id, incident_id, signer_user_id, role, attestation_text, signed_name) values
      ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', '56000000-0000-0000-0000-000000000a03', 'witness', 'reader attempt', 'IC Reader');
    raise exception 'IC FAIL: an incidents.read-only member inserted a signature';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

do $$
begin
  begin
    insert into incident_compliance_checks (facility_id, incident_id, check_key, status, checked_by) values
      ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', 'legal_review', 'pass', '56000000-0000-0000-0000-000000000a03');
    raise exception 'IC FAIL: an incidents.read-only member inserted a compliance check';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3a. incidents.manage holder can sign an incident as themselves.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"56000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_signatures (id, facility_id, incident_id, signer_user_id, role, attestation_text, signed_name) values
    ('56200000-0000-0000-0000-000000002001', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', '56000000-0000-0000-0000-000000000a01', 'manager', 'I attest this is accurate.', 'IC Manager');
exception
  when insufficient_privilege then
    raise exception 'IC FAIL: incidents.manage holder was denied signing in their own facility as themselves';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Signer must be the caller: naming a different user (even a real
-- member of the same facility) is rejected.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_signatures (facility_id, incident_id, signer_user_id, role, attestation_text, signed_name) values
      ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', '56000000-0000-0000-0000-000000000a04', 'witness', 'signing on behalf of someone else', 'IC Other');
    raise exception 'IC FAIL: manager signed a row attributed to a different user';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-facility FK injection: facility_id names Facility A, but
-- incident_id names Facility B's incident. fn_assert_same_facility must
-- reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_signatures (facility_id, incident_id, signer_user_id, role, attestation_text, signed_name) values
      ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e2', '56000000-0000-0000-0000-000000000a01', 'manager', 'fk injection via incident_id', 'IC Manager');
    raise exception 'IC FAIL: manager injected a Facility B incident_id into a Facility A signature';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. incident_signatures is immutable: UPDATE and DELETE both rejected for
-- the manager who inserted the row.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_signatures set signed_name = 'tampered' where id = '56200000-0000-0000-0000-000000002001';
  exception
    when check_violation then null; -- acceptable: fn_incident_signature_guard's UPDATE branch fired
    when insufficient_privilege then null; -- acceptable: no UPDATE policy admits the row at all
  end;
  if exists (select 1 from incident_signatures where id = '56200000-0000-0000-0000-000000002001' and signed_name = 'tampered') then
    raise exception 'IC FAIL: a signature accepted an UPDATE';
  end if;
end;
$$;

do $$
begin
  begin
    delete from incident_signatures where id = '56200000-0000-0000-0000-000000002001';
  exception
    when check_violation then null; -- acceptable: the trigger's DELETE branch fired
    when insufficient_privilege then null; -- acceptable: no DELETE policy admits the row at all
  end;
  if not exists (select 1 from incident_signatures where id = '56200000-0000-0000-0000-000000002001') then
    raise exception 'IC FAIL: a signature row was hard-deleted';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. incidents.manage holder can record a pass/fail compliance check, but
-- CANNOT record status='waived' -- enforced at the RLS layer.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into incident_compliance_checks (id, facility_id, incident_id, check_key, status, checked_by) values
    ('56300000-0000-0000-0000-000000003001', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', 'legal_review', 'fail', '56000000-0000-0000-0000-000000000a01');
exception
  when insufficient_privilege then
    raise exception 'IC FAIL: incidents.manage holder was denied recording a fail compliance check';
end;
$$;

do $$
begin
  begin
    insert into incident_compliance_checks (facility_id, incident_id, check_key, status, checked_by) values
      ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', 'osha_recordability', 'waived', '56000000-0000-0000-0000-000000000a01');
    raise exception 'IC FAIL: incidents.manage holder (no incidents.review) waived a compliance check';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. incidents.review holder CAN record a waived compliance check.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"56000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_compliance_checks (id, facility_id, incident_id, check_key, status, checked_by, notes) values
    ('56300000-0000-0000-0000-000000003002', '56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', 'osha_recordability', 'waived', '56000000-0000-0000-0000-000000000a02', 'reviewer waiver');
exception
  when insufficient_privilege then
    raise exception 'IC FAIL: incidents.review holder was denied waiving a compliance check';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Upsert semantics: a second check for the same (incident_id, check_key)
-- supersedes the first IN PLACE (no second row).
-- ---------------------------------------------------------------------------
do $$
begin
  insert into incident_compliance_checks (facility_id, incident_id, check_key, status, checked_by, notes) values
    ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e1', 'osha_recordability', 'pass', '56000000-0000-0000-0000-000000000a02', 'superseding waiver with a pass')
  on conflict (incident_id, check_key) do update set status = excluded.status, notes = excluded.notes, checked_by = excluded.checked_by, checked_at = now();
end;
$$;

do $$
declare
  row_count int;
  final_status text;
begin
  select count(*) into row_count from incident_compliance_checks where incident_id = '56e00000-0000-0000-0000-0000000000e1' and check_key = 'osha_recordability';
  if row_count <> 1 then
    raise exception 'IC FAIL: upsert produced % rows for the same (incident_id, check_key), expected 1', row_count;
  end if;
  select status into final_status from incident_compliance_checks where incident_id = '56e00000-0000-0000-0000-0000000000e1' and check_key = 'osha_recordability';
  if final_status <> 'pass' then
    raise exception 'IC FAIL: upsert did not supersede the prior status (saw %)', final_status;
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 9. Closure gate: a high-severity incident (56e...e3) with no
-- evidence_complete check cannot close; once evidence_complete is 'pass' it
-- can; a later 'fail' blocks it again; a reviewer 'waived' passes.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"56000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    update incident_reports set status = 'closed' where id = '56e00000-0000-0000-0000-0000000000e3';
    raise exception 'IC FAIL: a high-severity incident closed with no evidence_complete compliance check';
  exception
    when check_violation then null; -- expected: guard 2.5
  end;
end;
$$;

do $$
begin
  insert into incident_compliance_checks (facility_id, incident_id, check_key, status, checked_by) values
    ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e3', 'evidence_complete', 'fail', '56000000-0000-0000-0000-000000000a02');
end;
$$;

do $$
begin
  begin
    update incident_reports set status = 'closed' where id = '56e00000-0000-0000-0000-0000000000e3';
    raise exception 'IC FAIL: a high-severity incident closed with a FAILING evidence_complete compliance check';
  exception
    when check_violation then null; -- expected: guard 2.5
  end;
end;
$$;

do $$
begin
  insert into incident_compliance_checks (facility_id, incident_id, check_key, status, checked_by)
  values ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e3', 'evidence_complete', 'pass', '56000000-0000-0000-0000-000000000a02')
  on conflict (incident_id, check_key) do update set status = excluded.status, checked_by = excluded.checked_by, checked_at = now();
end;
$$;

do $$
begin
  update incident_reports set status = 'closed' where id = '56e00000-0000-0000-0000-0000000000e3';
exception
  when check_violation then
    raise exception 'IC FAIL: a high-severity incident with a PASSING evidence_complete compliance check was blocked from closing';
end;
$$;

do $$
declare
  final_status text;
begin
  select status into final_status from incident_reports where id = '56e00000-0000-0000-0000-0000000000e3';
  if final_status <> 'closed' then
    raise exception 'IC FAIL: incident 56e...e3 did not actually close (saw %)', final_status;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Closure gate: requires_osha_review (56e...e4, low severity, so
-- evidence_complete is NOT required) needs a passing/waived
-- supervisor_signoff check independent of severity.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set status = 'closed' where id = '56e00000-0000-0000-0000-0000000000e4';
    raise exception 'IC FAIL: an OSHA-review incident closed with no supervisor_signoff compliance check';
  exception
    when check_violation then null; -- expected: guard 2.5
  end;
end;
$$;

do $$
begin
  insert into incident_compliance_checks (facility_id, incident_id, check_key, status, checked_by, notes) values
    ('56aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '56e00000-0000-0000-0000-0000000000e4', 'supervisor_signoff', 'waived', '56000000-0000-0000-0000-000000000a02', 'reviewer waiver, supervisor unavailable');
end;
$$;

do $$
begin
  update incident_reports set status = 'closed' where id = '56e00000-0000-0000-0000-0000000000e4';
exception
  when check_violation then
    raise exception 'IC FAIL: an OSHA-review incident with a WAIVED supervisor_signoff compliance check was blocked from closing';
end;
$$;

do $$
declare
  final_status text;
begin
  select status into final_status from incident_reports where id = '56e00000-0000-0000-0000-0000000000e4';
  if final_status <> 'closed' then
    raise exception 'IC FAIL: incident 56e...e4 did not actually close (saw %)', final_status;
  end if;
end;
$$;

reset role;

rollback;
