-- Verification intent: active memberships must only expose rows whose facility_id is in current_facility_ids().
select has_table_privilege('authenticated', 'facilities', 'select') as authenticated_can_select_facilities;
select relrowsecurity from pg_class where relname in ('facilities', 'memberships', 'roles');

-- ---------------------------------------------------------------------------
-- Negative cases (0009 hardening). Runs against a Supabase-style database that
-- exposes the `authenticated` role and auth.uid() via request.jwt.claims.
-- Everything is created inside a transaction that is rolled back at the end, so
-- the fixtures never persist. Each assertion RAISEs on an isolation failure so
-- psql -v ON_ERROR_STOP=1 turns any leak into a non-zero exit.
-- ---------------------------------------------------------------------------
begin;

-- Two organizations in two tenants, each with its own facility and admin user.
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'user-a@isolation.test'),
  ('44444444-4444-4444-4444-444444444444', 'user-b@isolation.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('33333333-3333-3333-3333-333333333333', 'User A', 'user-a@isolation.test'),
  ('44444444-4444-4444-4444-444444444444', 'User B', 'user-b@isolation.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Org A (isolation test)'),
  ('22222222-2222-2222-2222-222222222222', 'Org B (isolation test)')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Facility A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('a0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Isolation Admin A'),
  ('b0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Isolation Admin B')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code)
  select 'a0000000-0000-0000-0000-0000000000a1', code from permissions
on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select 'b0000000-0000-0000-0000-0000000000b1', code from permissions
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('a1000000-0000-0000-0000-0000000000a1', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-0000000000a1', 'active'),
  ('b1000000-0000-0000-0000-0000000000b1', '44444444-4444-4444-4444-444444444444', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-0000000000b1', 'active')
on conflict (id) do nothing;

-- User A is an org admin of Org A only.
insert into organization_admins (organization_id, user_id) values
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333')
on conflict do nothing;

-- Report templates/versions in both facilities (for the FK-injection test).
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('a2000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'iso_a', 'Iso Template A', 'published', 1),
  ('b2000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'iso_b', 'Iso Template B', 'published', 1)
on conflict (id) do nothing;

insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('a3000000-0000-0000-0000-0000000000a3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a2000000-0000-0000-0000-0000000000a2', 1, '{}'::jsonb, true),
  ('b3000000-0000-0000-0000-0000000000b3', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b2000000-0000-0000-0000-0000000000b2', 1, '{}'::jsonb, true)
on conflict (id) do nothing;

-- A soft-deleted template in Facility A must stay invisible to Facility A readers.
insert into report_templates (id, facility_id, code, name, status, active_version, deleted_at) values
  ('a4000000-0000-0000-0000-0000000000a4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'iso_a_deleted', 'Iso Deleted A', 'archived', 1, now())
on conflict (id) do nothing;

-- Act as User A (member of Facility A / Org A).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
set local role authenticated;

-- Cross-facility read denial: User A sees zero Facility B rows.
do $$
declare
  visible int;
begin
  select count(*) into visible from facilities where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: User A can read Facility B (% row(s))', visible;
  end if;
  select count(*) into visible from report_templates where facility_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: User A can read Facility B templates (% row(s))', visible;
  end if;
end;
$$;

-- Soft-deleted row invisibility.
do $$
declare
  visible int;
begin
  select count(*) into visible from report_templates where id = 'a4000000-0000-0000-0000-0000000000a4';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: User A can read a soft-deleted template';
  end if;
end;
$$;

-- Cross-facility insert denial: User A cannot create a submission in Facility B.
do $$
begin
  begin
    insert into report_submissions (facility_id, template_id, template_version_id, report_date)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b2000000-0000-0000-0000-0000000000b2', 'b3000000-0000-0000-0000-0000000000b3', current_date);
    raise exception 'ISOLATION FAIL: User A inserted a submission into Facility B';
  exception
    when insufficient_privilege then null; -- expected: RLS blocked the insert
  end;
end;
$$;

-- Cross-tenant FK injection denial: even in Facility A, a Facility B template is rejected.
do $$
begin
  begin
    insert into report_submissions (facility_id, template_id, template_version_id, report_date)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b2000000-0000-0000-0000-0000000000b2', 'b3000000-0000-0000-0000-0000000000b3', current_date);
    raise exception 'ISOLATION FAIL: User A injected a Facility B template_id into a Facility A submission';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- Cross-facility update denial + legal draft->submitted transition.
do $$
declare
  submission_id uuid := 'a5000000-0000-0000-0000-0000000000a5';
begin
  insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status)
  values (submission_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a2000000-0000-0000-0000-0000000000a2', 'a3000000-0000-0000-0000-0000000000a3', current_date, 'draft');

  update report_submissions set status = 'submitted' where id = submission_id;
  if not exists (select 1 from report_submissions where id = submission_id and status = 'submitted') then
    raise exception 'ISOLATION FAIL: a reports.submit holder could not move draft -> submitted';
  end if;
end;
$$;

-- Org-admin module-settings write allowed for own org.
do $$
begin
  insert into organization_module_settings (organization_id, module_id, enabled)
  select '11111111-1111-1111-1111-111111111111', id, true from modules limit 1
  on conflict (organization_id, module_id) do update set enabled = excluded.enabled;
exception
  when insufficient_privilege then
    raise exception 'ISOLATION FAIL: Org A admin was denied writing its own org_module_settings';
end;
$$;

-- Org-admin module-settings write denied for a foreign org.
do $$
begin
  begin
    insert into organization_module_settings (organization_id, module_id, enabled)
    select '22222222-2222-2222-2222-222222222222', id, true from modules limit 1;
    raise exception 'ISOLATION FAIL: User A wrote org_module_settings for foreign Org B';
  exception
    when insufficient_privilege then null; -- expected: not an admin of Org B
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Necessity of reports.submit: the draft->submitted transition above ran as an
-- all-permissions fixture, so it did not prove reports.submit is required. Here
-- a member holding reports.create + reports.read but NOT reports.submit must be
-- able to create a draft yet be DENIED moving it to submitted (the update
-- policy's WITH CHECK is gated on reports.submit).
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('33300000-0000-0000-0000-000000000001', 'no-submit@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('33300000-0000-0000-0000-000000000001', 'No Submit', 'no-submit@test')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('a0000000-0000-0000-0000-0000000000a9', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Creator No Submit')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('a0000000-0000-0000-0000-0000000000a9', 'reports.create'),
  ('a0000000-0000-0000-0000-0000000000a9', 'reports.read')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('a1000000-0000-0000-0000-0000000000a9', '33300000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-0000000000a9', 'active')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"33300000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  no_submit_id uuid := 'a5000000-0000-0000-0000-0000000000b9';
begin
  -- Allowed: reports.create holder inserts a draft.
  insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status)
  values (no_submit_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a2000000-0000-0000-0000-0000000000a2', 'a3000000-0000-0000-0000-0000000000a3', current_date, 'draft');
  -- Denied: without reports.submit the update policy's USING clause
  -- (has_permission reports.submit) filters the row out, so the UPDATE matches
  -- zero rows silently -- no exception, and the status must remain 'draft'.
  -- Assert the outcome (RLS denies by row-invisibility here, not by raising).
  update report_submissions set status = 'submitted' where id = no_submit_id;
  if exists (select 1 from report_submissions where id = no_submit_id and status = 'submitted') then
    raise exception 'ISOLATION FAIL: a member without reports.submit moved draft -> submitted';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 0021 regression: a member holding ONLY reports.export (not reports.read) can
-- read report_submissions, so the export route's reports.export guard and the
-- SELECT RLS agree and exports are not silently empty.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('33300000-0000-0000-0000-000000000002', 'export-only@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('33300000-0000-0000-0000-000000000002', 'Export Only', 'export-only@test')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('a0000000-0000-0000-0000-0000000000ae', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Export Only')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('a0000000-0000-0000-0000-0000000000ae', 'reports.export')
on conflict do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('a1000000-0000-0000-0000-0000000000ae', '33300000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-0000000000ae', 'active')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"33300000-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from report_submissions where facility_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'ISOLATION FAIL: a reports.export holder could not read any report_submissions (export would be silently empty)';
  end if;
end;
$$;
reset role;

rollback;
