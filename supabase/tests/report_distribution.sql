-- Verification intent: DR-21 (plans/DAILY_REPORTS_PLAN.md) RLS for
-- report_distribution_lists/report_deliveries (0054). Covers:
--   1. A reports.read holder (no manage) can SELECT distribution bindings
--      and deliveries.
--   2. A reports.distribution.manage holder can INSERT a binding whose
--      template_id/distribution_list_id/department_id/role_id all belong to
--      their own facility.
--   3. Cross-facility binding rejected (42501/insufficient_privilege): a
--      manage holder in Facility A cannot point template_id, nor
--      distribution_list_id, at a row that actually belongs to Facility B
--      (fn_assert_same_facility on each).
--   4. A member without reports.distribution.manage cannot insert a binding.
--   5. UPDATE re-checks the same facility guards: flipping an existing
--      binding's distribution_list_id to a Facility B list is rejected.
--   6. report_deliveries carries NO authenticated write policy at all:
--      INSERT is denied outright (insufficient_privilege -- with zero
--      permissive WITH CHECK policies, Postgres has nothing to satisfy and
--      raises immediately). UPDATE/DELETE are different in kind but the
--      same in effect: with zero permissive USING policies, the row is
--      invisible to the command's own row-selection, so it silently
--      matches and affects ZERO rows rather than raising -- verified below
--      via GET DIAGNOSTICS row_count, not an exception handler. Either way
--      deliveries are written exclusively by the service-role drain
--      consumer (src/lib/report-distribution.mjs), never an authenticated
--      caller, reports.distribution.manage holder included.
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('54000000-0000-0000-0000-000000000a01', 'rd-manager@test'),
  ('54000000-0000-0000-0000-000000000a02', 'rd-reader@test'),
  ('54000000-0000-0000-0000-000000000a03', 'rd-noperm@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('54000000-0000-0000-0000-000000000a01', 'RD Manager', 'rd-manager@test'),
  ('54000000-0000-0000-0000-000000000a02', 'RD Reader', 'rd-reader@test'),
  ('54000000-0000-0000-0000-000000000a03', 'RD NoPerm', 'rd-noperm@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('54111111-1111-1111-1111-111111111111', 'RD Org A'),
  ('54222222-2222-2222-2222-222222222222', 'RD Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54111111-1111-1111-1111-111111111111', 'RD Facility A'),
  ('54bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '54222222-2222-2222-2222-222222222222', 'RD Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('54c00000-0000-0000-0000-0000000000c1', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD Manager Role'),
  ('54c00000-0000-0000-0000-0000000000c2', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD Reader Role'),
  ('54c00000-0000-0000-0000-0000000000c3', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD NoPerm Role'),
  -- Used as the role_id a binding is scoped to (any facility-A role works).
  ('54c00000-0000-0000-0000-0000000000c4', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD Bound Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('54c00000-0000-0000-0000-0000000000c1', 'reports.distribution.manage'),
  ('54c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('54c00000-0000-0000-0000-0000000000c2', 'reports.read'),
  ('54c00000-0000-0000-0000-0000000000c3', 'reports.create')
on conflict do nothing;

-- All three test users are members of Facility A ONLY -- neither has any
-- membership in Facility B, so the cross-facility cases below are a real
-- foreign tenant, not just a second row in the same tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('54d00000-0000-0000-0000-0000000000d1', '54000000-0000-0000-0000-000000000a01', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54c00000-0000-0000-0000-0000000000c1', 'active'),
  ('54d00000-0000-0000-0000-0000000000d2', '54000000-0000-0000-0000-000000000a02', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54c00000-0000-0000-0000-0000000000c2', 'active'),
  ('54d00000-0000-0000-0000-0000000000d3', '54000000-0000-0000-0000-000000000a03', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

insert into departments (id, facility_id, name) values
  ('54e00000-0000-0000-0000-0000000000e1', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD Dept A')
on conflict (id) do nothing;

-- report_templates + distribution_lists, one pair per facility, seeded with
-- RLS bypassed (migration-owner role) -- these are the FK-injection targets
-- below.
insert into report_templates (id, facility_id, code, name, status) values
  ('54f00000-0000-0000-0000-0000000000f1', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rd_a', 'RD Facility A Template', 'published'),
  ('54f00000-0000-0000-0000-0000000000f2', '54bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'rd_b', 'RD Facility B Template', 'published')
on conflict (id) do nothing;

insert into distribution_lists (id, facility_id, name) values
  ('54100000-0000-0000-0000-000000001a01', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD List A'),
  ('54100000-0000-0000-0000-000000001a02', '54bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'RD List B')
on conflict (id) do nothing;

-- A pre-existing binding in Facility A (used by the SELECT/UPDATE steps
-- below), seeded with RLS bypassed.
insert into report_distribution_lists (id, facility_id, template_id, distribution_list_id, channel) values
  ('54200000-0000-0000-0000-000000002001', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f1', '54100000-0000-0000-0000-000000001a01', 'email')
on conflict (id) do nothing;

-- A submission + delivery row in Facility A, seeded with RLS bypassed --
-- used by the SELECT/write-denial steps for report_deliveries below.
insert into employees (id, facility_id, first_name, last_name) values
  ('54300000-0000-0000-0000-000000003001', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RD', 'Employee')
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('54400000-0000-0000-0000-000000004001', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f1', 1, '{}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1 where id = '54f00000-0000-0000-0000-0000000000f1' and active_version is null;
insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status) values
  ('54500000-0000-0000-0000-000000005001', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f1', '54400000-0000-0000-0000-000000004001', '2026-09-07', 'submitted')
on conflict (id) do nothing;
insert into report_deliveries (id, facility_id, submission_id, report_distribution_list_id, recipient_employee_id, channel, status) values
  ('54600000-0000-0000-0000-000000006001', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54500000-0000-0000-0000-000000005001', '54200000-0000-0000-0000-000000002001', '54300000-0000-0000-0000-000000003001', 'email', 'sent')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. A reports.read holder (no manage) can SELECT bindings and deliveries.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"54000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from report_distribution_lists where id = '54200000-0000-0000-0000-000000002001';
  if v_count <> 1 then
    raise exception 'RD FAIL: reports.read holder could not read the Facility A distribution binding';
  end if;

  select count(*) into v_count from report_deliveries where id = '54600000-0000-0000-0000-000000006001';
  if v_count <> 1 then
    raise exception 'RD FAIL: reports.read holder could not read the Facility A delivery row';
  end if;
end;
$$;

-- A reader cannot insert a binding (no reports.distribution.manage).
do $$
begin
  begin
    insert into report_distribution_lists (facility_id, template_id, distribution_list_id, channel) values
      ('54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f1', '54100000-0000-0000-0000-000000001a01', 'email');
    raise exception 'RD FAIL: a reports.read-only holder inserted a distribution binding';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Act as the manager: insert a binding referencing same-facility
-- template/list/department/role. Allowed.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"54000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into report_distribution_lists (id, facility_id, template_id, distribution_list_id, department_id, role_id, channel, attach_pdf, digest) values
    ('54700000-0000-0000-0000-000000007001', '54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f1', '54100000-0000-0000-0000-000000001a01', '54e00000-0000-0000-0000-0000000000e1', '54c00000-0000-0000-0000-0000000000c4', 'push', true, false);
exception
  when insufficient_privilege then
    raise exception 'RD FAIL: reports.distribution.manage holder was denied inserting a same-facility binding';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3a. Cross-facility binding rejected: template_id points at Facility B.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_distribution_lists (facility_id, template_id, distribution_list_id, channel) values
      ('54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f2', '54100000-0000-0000-0000-000000001a01', 'email');
    raise exception 'RD FAIL: manager bound a Facility B template into a Facility A binding';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Cross-facility binding rejected: distribution_list_id points at
-- Facility B.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_distribution_lists (facility_id, template_id, distribution_list_id, channel) values
      ('54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54f00000-0000-0000-0000-0000000000f1', '54100000-0000-0000-0000-000000001a02', 'email');
    raise exception 'RD FAIL: manager bound a Facility B distribution list into a Facility A binding';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. UPDATE re-checks the same facility guards: flipping the binding
-- inserted in step 2 to point at Facility B's distribution list is rejected.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update report_distribution_lists set distribution_list_id = '54100000-0000-0000-0000-000000001a02'
      where id = '54700000-0000-0000-0000-000000007001';
    raise exception 'RD FAIL: manager updated a binding to point at a Facility B distribution list';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- A legitimate update (toggling active/digest) still works.
do $$
begin
  update report_distribution_lists set digest = true, active = false
    where id = '54700000-0000-0000-0000-000000007001';
exception
  when insufficient_privilege then
    raise exception 'RD FAIL: manager was denied a same-facility field update';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. report_deliveries: no authenticated write policy at all -- INSERT is
-- denied even for the reports.distribution.manage holder.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_deliveries (facility_id, submission_id, report_distribution_list_id, recipient_employee_id, channel) values
      ('54aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '54500000-0000-0000-0000-000000005001', '54200000-0000-0000-0000-000000002001', '54300000-0000-0000-0000-000000003001', 'email');
    raise exception 'RD FAIL: an authenticated caller (reports.distribution.manage holder) inserted a report_deliveries row';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- UPDATE: with no permissive USING policy, the row is invisible to the
-- command's own row selection -- it silently matches (and changes) ZERO
-- rows rather than raising. GET DIAGNOSTICS row_count is what actually
-- proves the denial here (a bare "no error" would also be true of a bug
-- that let the row through unnoticed with an unrelated WHERE typo).
do $$
declare
  v_rows integer;
begin
  update report_deliveries set status = 'sent' where id = '54600000-0000-0000-0000-000000006001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RD FAIL: an authenticated caller (reports.distribution.manage holder) updated a report_deliveries row';
  end if;
end;
$$;

do $$
declare
  v_rows integer;
begin
  delete from report_deliveries where id = '54600000-0000-0000-0000-000000006001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RD FAIL: an authenticated caller (reports.distribution.manage holder) deleted a report_deliveries row';
  end if;
end;
$$;

-- Confirms the row genuinely still exists and is unchanged (bypassing RLS
-- as the migration-owner role), so the zero-row UPDATE/DELETE above was a
-- real denial, not a coincidental no-op against an already-deleted row.
reset role;
do $$
declare
  v_status text;
begin
  select status into v_status from report_deliveries where id = '54600000-0000-0000-0000-000000006001';
  if v_status is distinct from 'sent' then
    raise exception 'RD FAIL: report_deliveries row 54600000-... is missing or was mutated (status = %)', v_status;
  end if;
end;
$$;

rollback;
