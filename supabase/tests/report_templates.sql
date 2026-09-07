-- Verification intent: DR-02 (plans/DAILY_REPORTS_PLAN.md) write-side RLS for
-- report_templates/report_template_versions (0028). Covers:
--   1. A reports.template.manage holder can create a draft template AND a
--      draft version under it, both in their own facility.
--   2. Cross-facility insert denial (42501/insufficient_privilege): both a
--      direct facility_id mismatch on report_templates, and a
--      fn_assert_same_facility FK-injection attempt on
--      report_template_versions.template_id.
--   3. Publish transition works once (is_published false -> true), then the
--      version becomes immutable: any further UPDATE raises
--      (fn_report_template_version_immutable).
--   4. A member without reports.template.manage cannot insert a template.
--   5. active_version can only be set to a version_number that is actually
--      published for that template (fn_report_template_active_version_published).
--   6. M-1(a) (security review): with
--      daily_reports.templatePublishRequiresApproval enabled for the
--      facility, the SAME actor (holding both reports.template.manage AND
--      reports.publish) who could publish directly in step 3 above can no
--      longer flip is_published false -> true without an approved
--      admin_change_requests row for that exact version --
--      fn_report_template_version_publish_guard enforces this at the DB
--      layer, independent of whatever the route layer separately checks.
--      Once such a row exists (status='approved', reviewed_by different
--      from requested_by), the identical UPDATE succeeds.
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('28000000-0000-0000-0000-000000000a01', 'rt-manager@test'),
  ('28000000-0000-0000-0000-000000000a02', 'rt-nomanage@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('28000000-0000-0000-0000-000000000a01', 'RT Manager', 'rt-manager@test'),
  ('28000000-0000-0000-0000-000000000a02', 'RT No Manage', 'rt-nomanage@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('28111111-1111-1111-1111-111111111111', 'RT Org A'),
  ('28222222-2222-2222-2222-222222222222', 'RT Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28111111-1111-1111-1111-111111111111', 'RT Facility A'),
  ('28bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '28222222-2222-2222-2222-222222222222', 'RT Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('28c00000-0000-0000-0000-0000000000c1', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RT Manager Role'),
  ('28c00000-0000-0000-0000-0000000000c2', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RT No Manage Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('28c00000-0000-0000-0000-0000000000c1', 'reports.template.manage'),
  -- reports.publish (Slice 1C, S-5, 0044): since that migration, flipping
  -- is_published to true additionally requires this code -- template.manage
  -- alone still covers every other field edit (asserted in step 2 above via
  -- the version insert, and implicitly by every non-publish write in this
  -- file).
  ('28c00000-0000-0000-0000-0000000000c1', 'reports.publish'),
  ('28c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('28c00000-0000-0000-0000-0000000000c2', 'reports.read')
on conflict do nothing;

-- Both users are members of Facility A ONLY -- neither has any membership in
-- Facility B, so the cross-facility case below is a real foreign tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('28d00000-0000-0000-0000-0000000000d1', '28000000-0000-0000-0000-000000000a01', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28c00000-0000-0000-0000-0000000000c1', 'active'),
  ('28d00000-0000-0000-0000-0000000000d2', '28000000-0000-0000-0000-000000000a02', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28c00000-0000-0000-0000-0000000000c2', 'active')
on conflict (id) do nothing;

-- A pre-existing published template + version in Facility B, seeded with RLS
-- bypassed (owner role), used only as the FK-injection target below.
-- active_version starts null and is set only AFTER the matching version row
-- exists -- fn_report_template_active_version_published (0028) requires a
-- published version_number match at insert/update time, so the template and
-- its version can't be created in the opposite order within one insert.
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('28e00000-0000-0000-0000-0000000000e1', '28bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'rt_b', 'RT Facility B Template', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('28f00000-0000-0000-0000-0000000000f1', '28bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '28e00000-0000-0000-0000-0000000000e1', 1, '{}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id = '28e00000-0000-0000-0000-0000000000e1' and active_version is null;

-- ---------------------------------------------------------------------------
-- 1. Act as the manager: create a draft template, then a draft version under
-- it, both in Facility A. Allowed.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"28000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into report_templates (id, facility_id, code, name, status) values
    ('28100000-0000-0000-0000-000000001001', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rt_a', 'RT Facility A Template', 'draft');
exception
  when insufficient_privilege then
    raise exception 'RT FAIL: reports.template.manage holder was denied creating a draft template in their own facility';
end;
$$;

do $$
begin
  insert into report_template_versions (id, facility_id, template_id, version_number, schema_json) values
    ('28100000-0000-0000-0000-000000001002', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28100000-0000-0000-0000-000000001001', 1, '{"sections":[]}'::jsonb);
exception
  when insufficient_privilege then
    raise exception 'RT FAIL: reports.template.manage holder was denied creating a draft version in their own facility';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2a. Cross-facility insert denial: the manager has no membership in Facility
-- B, so inserting a template there must fail (42501/insufficient_privilege).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_templates (facility_id, code, name, status) values
      ('28bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'rt_cross', 'Cross-facility attempt', 'draft');
    raise exception 'RT FAIL: manager inserted a report_template into a facility they are not a member of';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. Cross-tenant FK injection: even with facility_id = A (where the manager
-- does hold reports.template.manage), pointing template_id at the Facility B
-- template must be rejected by fn_assert_same_facility.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_template_versions (facility_id, template_id, version_number, schema_json) values
      ('28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28e00000-0000-0000-0000-0000000000e1', 2, '{"sections":[]}'::jsonb);
    raise exception 'RT FAIL: manager injected a Facility B template_id into a Facility A version row';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Publish transition works once, then the version is immutable.
-- ---------------------------------------------------------------------------
do $$
begin
  update report_template_versions set is_published = true
    where id = '28100000-0000-0000-0000-000000001002';
exception
  when insufficient_privilege then
    raise exception 'RT FAIL: the legal draft -> published transition was denied';
end;
$$;

do $$
begin
  if not exists (
    select 1 from report_template_versions
    where id = '28100000-0000-0000-0000-000000001002' and is_published = true
  ) then
    raise exception 'RT FAIL: publishing the version did not persist';
  end if;
end;
$$;

do $$
begin
  begin
    update report_template_versions set schema_json = '{"sections":[{"title":"x","fields":[]}]}'::jsonb
      where id = '28100000-0000-0000-0000-000000001002';
    raise exception 'RT FAIL: a published report_template_version was edited';
  exception
    when insufficient_privilege then null; -- expected: fn_report_template_version_immutable raised
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5a. active_version can be set once it names a published version of the
-- same template.
-- ---------------------------------------------------------------------------
do $$
begin
  update report_templates set active_version = 1, status = 'published'
    where id = '28100000-0000-0000-0000-000000001001';
exception
  when insufficient_privilege then
    raise exception 'RT FAIL: setting active_version to an actually-published version was denied';
end;
$$;

-- 5b. active_version cannot be set to a version_number that is not published
-- for this template (fn_report_template_active_version_published).
do $$
begin
  begin
    insert into report_templates (id, facility_id, code, name, status, active_version) values
      ('28100000-0000-0000-0000-000000001003', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rt_a_bad', 'RT Bad Active Version', 'published', 99);
    raise exception 'RT FAIL: active_version was set to a version_number with no matching published version';
  exception
    when insufficient_privilege then null; -- expected: fn_report_template_active_version_published raised
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 6. M-1(a): a SECOND draft version, published under governance. Fixture
-- ordering: table-owner writes (no RLS involved) turn on
-- daily_reports.templatePublishRequiresApproval for Facility A, and seed a
-- second reviewer (RT Reviewer, holding the SAME template.manage+publish
-- actor set) so approval can come from someone other than the requester.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('28000000-0000-0000-0000-000000000a03', 'rt-reviewer@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('28000000-0000-0000-0000-000000000a03', 'RT Reviewer', 'rt-reviewer@test')
on conflict (id) do nothing;
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('28d00000-0000-0000-0000-0000000000d3', '28000000-0000-0000-0000-000000000a03', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28c00000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- daily_reports module id is fixed by supabase/seed.sql
-- (00000000-0000-0000-0000-000000002801); this facility fixture never ran
-- seed.sql's own facility rows, but modules is a global catalog table, so
-- the row is already there regardless of which facility references it.
insert into facility_module_overrides (facility_id, module_id, enabled, config_patch_jsonb) values
  ('28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000002801', true, '{"daily_reports.templatePublishRequiresApproval": true}'::jsonb)
on conflict (facility_id, module_id) do update set config_patch_jsonb = excluded.config_patch_jsonb;

insert into report_template_versions (id, facility_id, template_id, version_number, schema_json) values
  ('28100000-0000-0000-0000-000000001004', '28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '28100000-0000-0000-0000-000000001001', 2, '{"sections":[]}'::jsonb)
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"28000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

-- 6a. Direct publish is now rejected -- no admin_change_requests row exists
-- for this version yet, even though the actor holds every permission the
-- ROUTE layer requires.
do $$
begin
  begin
    update report_template_versions set is_published = true
      where id = '28100000-0000-0000-0000-000000001004';
    raise exception 'RT FAIL: direct publish succeeded under templatePublishRequiresApproval with no change request at all';
  exception
    when insufficient_privilege then null; -- expected: fn_report_template_version_publish_guard raised
  end;
end;
$$;

-- 6b. Stage + approve a change request for this exact version (requester
-- 28...a01, a DIFFERENT reviewer 28...a03) -- then the identical publish
-- UPDATE succeeds.
do $$
declare
  v_cr_id uuid;
begin
  insert into admin_change_requests (facility_id, entity_table, entity_id, change_summary, status, requested_by)
    values ('28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'report_template_versions', '28100000-0000-0000-0000-000000001004', 'Governance fixture', 'draft', '28000000-0000-0000-0000-000000000a01')
    returning id into v_cr_id;
  update admin_change_requests set status = 'pending_review' where id = v_cr_id;
  perform set_config('rt_test.cr_id', v_cr_id::text, true);
end;
$$;

select set_config('request.jwt.claims', '{"sub":"28000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);

do $$
declare
  v_cr_id uuid := current_setting('rt_test.cr_id')::uuid;
begin
  update admin_change_requests
    set status = 'approved', reviewed_by = '28000000-0000-0000-0000-000000000a03', reviewed_at = now()
    where id = v_cr_id;
exception
  when insufficient_privilege then
    raise exception 'RT FAIL: a different-reviewer approval was denied';
end;
$$;

select set_config('request.jwt.claims', '{"sub":"28000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);

do $$
begin
  update report_template_versions set is_published = true
    where id = '28100000-0000-0000-0000-000000001004';
exception
  when insufficient_privilege then
    raise exception 'RT FAIL: publish was denied even though an approved change request exists for this version';
end;
$$;

do $$
begin
  if not exists (
    select 1 from report_template_versions
    where id = '28100000-0000-0000-0000-000000001004' and is_published = true
  ) then
    raise exception 'RT FAIL: publishing under an approved change request did not persist';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. A member without reports.template.manage cannot insert a template, even
-- in their own facility (reports.read alone is not enough).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"28000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into report_templates (facility_id, code, name, status) values
      ('28aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rt_denied', 'No Manage Attempt', 'draft');
    raise exception 'RT FAIL: a member without reports.template.manage inserted a report_template';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

rollback;
