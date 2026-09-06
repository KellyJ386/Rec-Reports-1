-- Proof for Wave 1 Slice 1A, S-1/S-2.
--
-- Covers:
--   1. S-1: fn_storage_attachment_module()/the module-aware storage.objects
--      SELECT policy (0040) -- a reports.read-only member sees ONLY the
--      reports-module object, never incidents/certifications objects in the
--      same facility; an incidents.read-only member sees only incidents.
--   2. S-1: certifications self-scoping -- an employee holding a bare
--      membership with NO permissions at all (no training.read) can read
--      their OWN certification's evidence object (evidence_path =
--      storage.objects.name, employees.user_id = auth.uid()) but not
--      another employee's.
--   3. S-2: fn_attachment_path_facility() (0041) -- a BEFORE INSERT trigger
--      on each of the four attachment-path tables rejects (23514
--      check_violation) a row whose storage_path/evidence_path names a
--      facility other than the row's own facility_id, for
--      report_submission_attachments, incident_attachments,
--      work_order_attachments, and employee_certifications.
--
-- Runs inside begin/rollback so fixtures never persist.
begin;

insert into auth.users (id, email) values
  ('40100000-0000-0000-0000-000000000001', 'smr-reports-reader@test'),
  ('40100000-0000-0000-0000-000000000002', 'smr-incidents-reader@test'),
  ('40100000-0000-0000-0000-000000000003', 'smr-cert-owner-1@test'),
  ('40100000-0000-0000-0000-000000000004', 'smr-cert-owner-2@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('40100000-0000-0000-0000-000000000001', 'SMR Reports Reader', 'smr-reports-reader@test'),
  ('40100000-0000-0000-0000-000000000002', 'SMR Incidents Reader', 'smr-incidents-reader@test'),
  ('40100000-0000-0000-0000-000000000003', 'SMR Cert Owner 1', 'smr-cert-owner-1@test'),
  ('40100000-0000-0000-0000-000000000004', 'SMR Cert Owner 2', 'smr-cert-owner-2@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('40200000-0000-0000-0000-000000000001', 'SMR Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('40300000-0000-0000-0000-000000000001', '40200000-0000-0000-0000-000000000001', 'SMR Facility')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('40400000-0000-0000-0000-000000000001', '40300000-0000-0000-0000-000000000001', 'SMR Reports Reader Role'),
  ('40400000-0000-0000-0000-000000000002', '40300000-0000-0000-0000-000000000001', 'SMR Incidents Reader Role'),
  ('40400000-0000-0000-0000-000000000003', '40300000-0000-0000-0000-000000000001', 'SMR Basic Member Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('40400000-0000-0000-0000-000000000001', 'reports.read'),
  ('40400000-0000-0000-0000-000000000002', 'incidents.read')
on conflict do nothing;
-- "SMR Basic Member Role" deliberately carries NO permissions at all -- the
-- two cert owners below hold it purely so current_facility_ids() includes
-- this facility, which the employees/employee_certifications SELECT
-- policies (0009: "members can read employees"/"...employee
-- certifications", gated on facility membership alone, no permission) then
-- require before the certifications self-scoping EXISTS subquery inside
-- 0040's storage.objects policy can see either table's rows at all. This is
-- the real-world shape too: every employee with a login has some
-- membership, and the self-scoping branch needs no *.read permission
-- beyond that.

-- The two facility-permission readers plus both cert owners (basic member,
-- no permissions) hold memberships.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('40500000-0000-0000-0000-000000000001', '40100000-0000-0000-0000-000000000001', '40300000-0000-0000-0000-000000000001', '40400000-0000-0000-0000-000000000001', 'active'),
  ('40500000-0000-0000-0000-000000000002', '40100000-0000-0000-0000-000000000002', '40300000-0000-0000-0000-000000000001', '40400000-0000-0000-0000-000000000002', 'active'),
  ('40500000-0000-0000-0000-000000000003', '40100000-0000-0000-0000-000000000003', '40300000-0000-0000-0000-000000000001', '40400000-0000-0000-0000-000000000003', 'active'),
  ('40500000-0000-0000-0000-000000000004', '40100000-0000-0000-0000-000000000004', '40300000-0000-0000-0000-000000000001', '40400000-0000-0000-0000-000000000003', 'active')
on conflict (id) do nothing;

insert into employees (id, facility_id, user_id, first_name, last_name, status) values
  ('40600000-0000-0000-0000-000000000001', '40300000-0000-0000-0000-000000000001', '40100000-0000-0000-0000-000000000003', 'Owner', 'One', 'active'),
  ('40600000-0000-0000-0000-000000000002', '40300000-0000-0000-0000-000000000001', '40100000-0000-0000-0000-000000000004', 'Owner', 'Two', 'active')
on conflict (id) do nothing;
insert into certification_types (id, facility_id, code, name) values
  ('40700000-0000-0000-0000-000000000001', '40300000-0000-0000-0000-000000000001', 'CPR', 'CPR Certification'),
  ('40700000-0000-0000-0000-000000000002', '40300000-0000-0000-0000-000000000001', 'FIRST-AID', 'First Aid Certification')
on conflict (id) do nothing;
insert into employee_certifications (id, facility_id, employee_id, certification_type_id, evidence_path, status) values
  ('40800000-0000-0000-0000-000000000001', '40300000-0000-0000-0000-000000000001', '40600000-0000-0000-0000-000000000001', '40700000-0000-0000-0000-000000000001', 'facilities/40300000-0000-0000-0000-000000000001/certifications/40800000-0000-0000-0000-000000000001/evidence-1.pdf', 'active'),
  ('40800000-0000-0000-0000-000000000002', '40300000-0000-0000-0000-000000000001', '40600000-0000-0000-0000-000000000002', '40700000-0000-0000-0000-000000000001', 'facilities/40300000-0000-0000-0000-000000000001/certifications/40800000-0000-0000-0000-000000000002/evidence-2.pdf', 'active')
on conflict (id) do nothing;

-- storage.objects fixtures: one per module, plus the two certification
-- evidence objects (names must exactly match employee_certifications.evidence_path
-- above for the self-scoping branch to match).
insert into storage.objects (id, bucket_id, name) values
  ('40900000-0000-0000-0000-000000000001', 'attachments', 'facilities/40300000-0000-0000-0000-000000000001/reports/rec-1/uuid-report.pdf'),
  ('40900000-0000-0000-0000-000000000002', 'attachments', 'facilities/40300000-0000-0000-0000-000000000001/incidents/rec-1/uuid-incident.pdf'),
  ('40900000-0000-0000-0000-000000000003', 'attachments', 'facilities/40300000-0000-0000-0000-000000000001/certifications/40800000-0000-0000-0000-000000000001/evidence-1.pdf'),
  ('40900000-0000-0000-0000-000000000004', 'attachments', 'facilities/40300000-0000-0000-0000-000000000001/certifications/40800000-0000-0000-0000-000000000002/evidence-2.pdf')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1a. reports.read-only member sees ONLY the reports-module object.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"40100000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  visible int;
begin
  select count(*) into visible from storage.objects where bucket_id = 'attachments';
  if visible <> 1 then
    raise exception 'SMR FAIL: reports.read-only member sees % attachments objects, expected exactly 1', visible;
  end if;
  if not exists (select 1 from storage.objects where id = '40900000-0000-0000-0000-000000000001') then
    raise exception 'SMR FAIL: reports.read-only member cannot read the reports-module object';
  end if;
  if exists (select 1 from storage.objects where id = '40900000-0000-0000-0000-000000000002') then
    raise exception 'SMR FAIL: reports.read-only member can read the incidents-module object';
  end if;
  if exists (select 1 from storage.objects where id in ('40900000-0000-0000-0000-000000000003', '40900000-0000-0000-0000-000000000004')) then
    raise exception 'SMR FAIL: reports.read-only member can read a certifications-module object';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 1b. incidents.read-only member sees ONLY the incidents-module object.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"40100000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  visible int;
begin
  select count(*) into visible from storage.objects where bucket_id = 'attachments';
  if visible <> 1 then
    raise exception 'SMR FAIL: incidents.read-only member sees % attachments objects, expected exactly 1', visible;
  end if;
  if not exists (select 1 from storage.objects where id = '40900000-0000-0000-0000-000000000002') then
    raise exception 'SMR FAIL: incidents.read-only member cannot read the incidents-module object';
  end if;
  if exists (select 1 from storage.objects where id = '40900000-0000-0000-0000-000000000001') then
    raise exception 'SMR FAIL: incidents.read-only member can read the reports-module object';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. Certifications self-scoping: an employee with no training.read and no
-- membership anywhere can read only their OWN certification's evidence
-- object, never another employee's.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"40100000-0000-0000-0000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  visible int;
begin
  select count(*) into visible from storage.objects where bucket_id = 'attachments';
  if visible <> 1 then
    raise exception 'SMR FAIL: cert owner sees % attachments objects, expected exactly 1 (their own)', visible;
  end if;
  if not exists (select 1 from storage.objects where id = '40900000-0000-0000-0000-000000000003') then
    raise exception 'SMR FAIL: cert owner cannot read their own certification evidence object';
  end if;
  if exists (select 1 from storage.objects where id = '40900000-0000-0000-0000-000000000004') then
    raise exception 'SMR FAIL: cert owner can read ANOTHER employee''s certification evidence object';
  end if;
  if exists (select 1 from storage.objects where id in ('40900000-0000-0000-0000-000000000001', '40900000-0000-0000-0000-000000000002')) then
    raise exception 'SMR FAIL: cert owner (no reports.read/incidents.read permission) can read a reports/incidents object';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. M-1 regression: a training.manage holder (no training.read) cannot
-- read ANOTHER employee's certification evidence just by inserting their
-- OWN certification row with its evidence_path set to the victim's exact
-- storage key. Before the M-1 fix, the self-scoping EXISTS subquery only
-- checked `ec.evidence_path = name` and `e.user_id = auth.uid()` -- it
-- never tied the object back to *that certification's own* canonical path,
-- so employee_id and evidence_path (two independent columns with no
-- cross-validation at write time -- 0041's trigger only checks the
-- facility/module shape, never that the recordId segment matches the row's
-- own id) could point at completely different certifications. Fixed by
-- additionally requiring `name like
-- 'facilities/{facility}/certifications/{ec.id}/%'`, binding the object to
-- THIS certification's own id, not just the attacker's employee identity.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('40100000-0000-0000-0000-000000000005', 'smr-attacker@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('40100000-0000-0000-0000-000000000005', 'SMR Attacker', 'smr-attacker@test')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('40400000-0000-0000-0000-000000000004', '40300000-0000-0000-0000-000000000001', 'SMR Training Manager Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('40400000-0000-0000-0000-000000000004', 'training.manage')
on conflict do nothing;
-- Deliberately NO training.read on this role -- the whole point of the
-- attack is reading evidence WITHOUT that permission.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('40500000-0000-0000-0000-000000000005', '40100000-0000-0000-0000-000000000005', '40300000-0000-0000-0000-000000000001', '40400000-0000-0000-0000-000000000004', 'active')
on conflict (id) do nothing;
insert into employees (id, facility_id, user_id, first_name, last_name, status) values
  ('40600000-0000-0000-0000-000000000003', '40300000-0000-0000-0000-000000000001', '40100000-0000-0000-0000-000000000005', 'SMR', 'Attacker', 'active')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"40100000-0000-0000-0000-000000000005","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  visible int;
  new_cert_id uuid;
begin
  select count(*) into visible from storage.objects where id = '40900000-0000-0000-0000-000000000004';
  if visible <> 0 then
    raise exception 'SMR FAIL: attacker (training.manage only, no cert row yet) can already see the victim''s evidence object';
  end if;

  -- The attack: insert the attacker's OWN certification row (their own
  -- employee_id, so the self-scoping join's `e.user_id = auth.uid()` will
  -- match), but with evidence_path set to the VICTIM's (Owner Two's) exact
  -- evidence object key rather than a path under this new row's own id.
  -- This INSERT is expected to SUCCEED (0031's write-side policy only
  -- requires training.manage + same-facility employee/cert-type, and
  -- 0041's trigger only validates the path's facility/module shape, never
  -- that its recordId segment matches this row's own id) -- the write side
  -- is not what M-1 fixes; the read side is.
  insert into employee_certifications (facility_id, employee_id, certification_type_id, evidence_path, status)
  values (
    '40300000-0000-0000-0000-000000000001',
    '40600000-0000-0000-0000-000000000003',
    '40700000-0000-0000-0000-000000000001',
    'facilities/40300000-0000-0000-0000-000000000001/certifications/40800000-0000-0000-0000-000000000002/evidence-2.pdf',
    'active'
  )
  returning id into new_cert_id;
  if new_cert_id is null then
    raise exception 'SMR FAIL: attacker could not insert their own certification row with the victim''s evidence_path (attack setup is broken, not the fix under test)';
  end if;

  select count(*) into visible from storage.objects where id = '40900000-0000-0000-0000-000000000004';
  if visible <> 0 then
    raise exception 'SMR FAIL (M-1): attacker can read the victim''s certification evidence object after inserting a colliding evidence_path on their own cert row';
  end if;
end;
$$;
reset role;

-- ===========================================================================
-- S-2: fn_attachment_path_facility() (0041) rejects a mismatched
-- storage_path/evidence_path on INSERT for each of the four tables, with
-- sqlstate 23514 (check_violation). Fixture parent rows below (superuser,
-- RLS-bypassing) are the minimum each attachment table's own NOT NULL FK
-- requires.
-- ===========================================================================

insert into report_templates (id, facility_id, code, name, status) values
  ('40a00000-0000-0000-0000-000000000001', '40300000-0000-0000-0000-000000000001', 'SMR-TPL', 'SMR Template', 'published')
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('40a00000-0000-0000-0000-000000000002', '40300000-0000-0000-0000-000000000001', '40a00000-0000-0000-0000-000000000001', 1, '{}'::jsonb, true)
on conflict (id) do nothing;
insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status) values
  ('40a00000-0000-0000-0000-000000000003', '40300000-0000-0000-0000-000000000001', '40a00000-0000-0000-0000-000000000001', '40a00000-0000-0000-0000-000000000002', '2026-09-01', 'draft')
on conflict (id) do nothing;

insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('40a00000-0000-0000-0000-000000000004', '40300000-0000-0000-0000-000000000001', 'SMR-INC-1', 'incident', 'draft', 'low', now(), 'Deck', 'SMR fixture incident')
on conflict (id) do nothing;

insert into work_orders (id, facility_id, title, description) values
  ('40a00000-0000-0000-0000-000000000005', '40300000-0000-0000-0000-000000000001', 'SMR fixture work order', 'SMR fixture work order description')
on conflict (id) do nothing;

do $$
begin
  begin
    insert into report_submission_attachments (facility_id, submission_id, field_key, storage_path, mime_type)
    values ('40300000-0000-0000-0000-000000000001', '40a00000-0000-0000-0000-000000000003', 'photo', 'facilities/99999999-9999-9999-9999-999999999999/reports/x/y.jpg', 'image/jpeg');
    raise exception 'SMR FAIL: report_submission_attachments accepted a storage_path naming a different facility';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'SMR FAIL: report_submission_attachments mismatched-path insert failed with unexpected sqlstate % (%), expected 23514', sqlstate, sqlerrm;
      end if;
      -- expected: fn_attachment_path_facility raised check_violation
  end;
end;
$$;

do $$
begin
  begin
    insert into incident_attachments (facility_id, incident_id, attachment_type, storage_path)
    values ('40300000-0000-0000-0000-000000000001', '40a00000-0000-0000-0000-000000000004', 'photo', 'facilities/99999999-9999-9999-9999-999999999999/incidents/x/y.jpg');
    raise exception 'SMR FAIL: incident_attachments accepted a storage_path naming a different facility';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'SMR FAIL: incident_attachments mismatched-path insert failed with unexpected sqlstate % (%), expected 23514', sqlstate, sqlerrm;
      end if;
  end;
end;
$$;

do $$
begin
  begin
    insert into work_order_attachments (facility_id, work_order_id, storage_path, mime_type)
    values ('40300000-0000-0000-0000-000000000001', '40a00000-0000-0000-0000-000000000005', 'facilities/99999999-9999-9999-9999-999999999999/work_orders/x/y.jpg', 'image/jpeg');
    raise exception 'SMR FAIL: work_order_attachments accepted a storage_path naming a different facility';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'SMR FAIL: work_order_attachments mismatched-path insert failed with unexpected sqlstate % (%), expected 23514', sqlstate, sqlerrm;
      end if;
  end;
end;
$$;

do $$
begin
  begin
    insert into employee_certifications (facility_id, employee_id, certification_type_id, evidence_path, status)
    values ('40300000-0000-0000-0000-000000000001', '40600000-0000-0000-0000-000000000001', '40700000-0000-0000-0000-000000000002', 'facilities/99999999-9999-9999-9999-999999999999/certifications/x/y.pdf', 'active');
    raise exception 'SMR FAIL: employee_certifications accepted an evidence_path naming a different facility';
  exception
    when others then
      if sqlstate <> '23514' then
        raise exception 'SMR FAIL: employee_certifications mismatched-path insert failed with unexpected sqlstate % (%), expected 23514', sqlstate, sqlerrm;
      end if;
  end;
end;
$$;

-- Sanity: employee_certifications with evidence_path left NULL still inserts
-- fine (the guard skips a null path rather than rejecting every insert).
do $$
declare
  new_id uuid;
begin
  insert into employee_certifications (facility_id, employee_id, certification_type_id, status)
  values ('40300000-0000-0000-0000-000000000001', '40600000-0000-0000-0000-000000000001', '40700000-0000-0000-0000-000000000002', 'active')
  returning id into new_id;
  if new_id is null then
    raise exception 'SMR FAIL: employee_certifications insert with a NULL evidence_path was unexpectedly rejected';
  end if;
end;
$$;

rollback;
