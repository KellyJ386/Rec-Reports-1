-- Proof for 0023: department-level permission scoping. A department-scoped
-- membership must NOT pass facility-scope (3-arg) has_permission, must pass
-- the 4-arg overload only for its own department, and must be able to write
-- department_settings rows only for that department. Facility-wide
-- memberships are unaffected, and a membership's department must belong to
-- the membership's facility. Runs inside begin/rollback.
begin;

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-0000000000aa', 'deptadmin@test'),
  ('d0000000-0000-0000-0000-0000000000ab', 'facadmin@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('d0000000-0000-0000-0000-0000000000aa', 'Dept Scoped Admin', 'deptadmin@test'),
  ('d0000000-0000-0000-0000-0000000000ab', 'Facility Admin', 'facadmin@test')
on conflict (id) do nothing;
insert into organizations (id, name) values
  ('d0000000-0000-0000-0000-0000000000b0', 'Dept Scope Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000b0', 'Dept Scope Facility'),
  ('d0000000-0000-0000-0000-0000000000c1', 'd0000000-0000-0000-0000-0000000000b0', 'Other Facility')
on conflict (id) do nothing;
insert into departments (id, facility_id, name) values
  ('d0000000-0000-0000-0000-0000000000da', 'd0000000-0000-0000-0000-0000000000c0', 'Aquatics'),
  ('d0000000-0000-0000-0000-0000000000db', 'd0000000-0000-0000-0000-0000000000c0', 'Fitness'),
  ('d0000000-0000-0000-0000-0000000000dc', 'd0000000-0000-0000-0000-0000000000c1', 'Foreign Dept')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('d0000000-0000-0000-0000-0000000000d0', 'd0000000-0000-0000-0000-0000000000c0', 'Dept Scope Admin Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('d0000000-0000-0000-0000-0000000000d0', 'admin.manage')
on conflict do nothing;
-- User A: admin.manage scoped to the Aquatics department only.
insert into memberships (id, user_id, facility_id, role_id, status, department_id) values
  ('d0000000-0000-0000-0000-0000000000e0', 'd0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d0', 'active', 'd0000000-0000-0000-0000-0000000000da')
on conflict (id) do nothing;
-- User B: facility-wide admin.manage (department_id null, the pre-0023 shape).
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('d0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-0000000000ab', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d0', 'active')
on conflict (id) do nothing;

-- Scope semantics of both overloads.
do $$
begin
  if has_permission('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'DEPT FAIL: department-scoped membership passed a facility-scope check';
  end if;
  if not has_permission('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000da', 'admin.manage') then
    raise exception 'DEPT FAIL: department-scoped membership denied its own department';
  end if;
  if has_permission('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'admin.manage') then
    raise exception 'DEPT FAIL: department-scoped membership granted a sibling department';
  end if;
  if not has_permission('d0000000-0000-0000-0000-0000000000ab', 'd0000000-0000-0000-0000-0000000000c0', 'admin.manage') then
    raise exception 'DEPT FAIL: facility-wide membership lost its facility-scope grant';
  end if;
  if not has_permission('d0000000-0000-0000-0000-0000000000ab', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'admin.manage') then
    raise exception 'DEPT FAIL: facility-wide membership denied a department-scoped check';
  end if;
end;
$$;

-- Concrete consequence: the department-scoped admin can write settings for
-- their own department, not for a sibling department; they remain a facility
-- member for member-level reads.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into department_settings (facility_id, department_id, settings_jsonb)
  values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000da', '{"note":"own dept"}'::jsonb);
  begin
    insert into department_settings (facility_id, department_id, settings_jsonb)
    values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', '{"note":"sibling dept"}'::jsonb);
    raise exception 'DEPT FAIL: department-scoped admin wrote a sibling department''s settings';
  exception
    when insufficient_privilege then null; -- expected: 4-arg policy denies it
  end;
  if not exists (select 1 from facilities where id = 'd0000000-0000-0000-0000-0000000000c0') then
    raise exception 'DEPT FAIL: department-scoped member lost member-level facility read';
  end if;
end;
$$;
reset role;

-- Integrity: a membership cannot be scoped to a department of another
-- facility (fn_membership_department_facility raises check_violation).
do $$
begin
  begin
    insert into memberships (user_id, facility_id, role_id, status, department_id)
    values ('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d0', 'active', 'd0000000-0000-0000-0000-0000000000dc');
    raise exception 'DEPT FAIL: membership accepted a department from another facility';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- DR-11: report_templates SELECT + report_submissions INSERT/UPDATE now use
-- the 4-arg has_permission overload keyed off each row's own department_id
-- (0033). Reuses facility c0 and departments da (Aquatics) / db (Fitness)
-- from above. A dept-A-scoped filer can file (create + submit) for dept A's
-- template and is denied dept B's; a facility-wide filer is unaffected
-- either way.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-0000000000ac', 'deptfiler-a@test'),
  ('d0000000-0000-0000-0000-0000000000ad', 'facfiler@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('d0000000-0000-0000-0000-0000000000ac', 'Dept A Filer', 'deptfiler-a@test'),
  ('d0000000-0000-0000-0000-0000000000ad', 'Facility-wide Filer', 'facfiler@test')
on conflict (id) do nothing;
insert into roles (id, facility_id, name) values
  ('d0000000-0000-0000-0000-0000000000d2', 'd0000000-0000-0000-0000-0000000000c0', 'Report Filer Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('d0000000-0000-0000-0000-0000000000d2', 'reports.create'),
  ('d0000000-0000-0000-0000-0000000000d2', 'reports.submit'),
  ('d0000000-0000-0000-0000-0000000000d2', 'reports.read')
on conflict do nothing;
-- User AC: reports.create/submit/read scoped to the Aquatics department only.
insert into memberships (id, user_id, facility_id, role_id, status, department_id) values
  ('d0000000-0000-0000-0000-0000000000e2', 'd0000000-0000-0000-0000-0000000000ac', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d2', 'active', 'd0000000-0000-0000-0000-0000000000da')
on conflict (id) do nothing;
-- User AD: facility-wide reports.create/submit/read (department_id null).
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('d0000000-0000-0000-0000-0000000000e3', 'd0000000-0000-0000-0000-0000000000ad', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000d2', 'active')
on conflict (id) do nothing;

-- active_version starts null and is set only AFTER the matching version row
-- exists -- fn_report_template_active_version_published (0028) requires a
-- published version_number match at insert/update time.
insert into report_templates (id, facility_id, department_id, code, name, status, active_version) values
  ('d0000000-0000-0000-0000-0000000000f0', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000da', 'dept_a_rpt', 'Aquatics Report', 'published', null),
  ('d0000000-0000-0000-0000-0000000000f1', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'dept_b_rpt', 'Fitness Report', 'published', null)
on conflict (id) do nothing;
insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('d0000000-0000-0000-0000-0000000000f2', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000f0', 1, '{"sections":[]}'::jsonb, true),
  ('d0000000-0000-0000-0000-0000000000f3', 'd0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000f1', 1, '{"sections":[]}'::jsonb, true)
on conflict (id) do nothing;
update report_templates set active_version = 1
  where id in ('d0000000-0000-0000-0000-0000000000f0', 'd0000000-0000-0000-0000-0000000000f1') and active_version is null;

-- Reader scoping: the dept-A filer can see the Aquatics template but not the
-- Fitness template; the facility-wide filer sees both.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000ac","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from report_templates where id = 'd0000000-0000-0000-0000-0000000000f0') then
    raise exception 'DEPT FAIL: dept-A filer could not read their own department''s template';
  end if;
  if exists (select 1 from report_templates where id = 'd0000000-0000-0000-0000-0000000000f1') then
    raise exception 'DEPT FAIL: dept-A filer could read a sibling department''s template';
  end if;
end;
$$;
reset role;

-- Write scoping: the dept-A filer can create + submit a draft against their
-- own department's template, and cannot create one against the sibling
-- department's template at all (INSERT WITH CHECK raises).
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000ac","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_dept_a_submission_id uuid;
begin
  insert into report_submissions (facility_id, department_id, template_id, template_version_id, report_date, status)
  values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000da', 'd0000000-0000-0000-0000-0000000000f0', 'd0000000-0000-0000-0000-0000000000f2', '2026-08-01', 'draft')
  returning id into v_dept_a_submission_id;

  update report_submissions set status = 'submitted' where id = v_dept_a_submission_id;
  if not exists (select 1 from report_submissions where id = v_dept_a_submission_id and status = 'submitted') then
    raise exception 'DEPT FAIL: dept-A filer could not submit their own department''s draft';
  end if;

  begin
    insert into report_submissions (facility_id, department_id, template_id, template_version_id, report_date, status)
    values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'd0000000-0000-0000-0000-0000000000f1', 'd0000000-0000-0000-0000-0000000000f3', '2026-08-01', 'draft');
    raise exception 'DEPT FAIL: dept-A filer created a submission for a sibling department';
  exception
    when insufficient_privilege then null; -- expected: 4-arg policy denies it
  end;
end;
$$;
reset role;

-- A dept-B draft (created by the facility-wide filer) is invisible to the
-- UPDATE policy from the dept-A filer's session: the USING clause filters it
-- out, so the UPDATE matches zero rows instead of raising.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000ad","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_dept_b_submission_id uuid;
begin
  insert into report_submissions (facility_id, department_id, template_id, template_version_id, report_date, status)
  values ('d0000000-0000-0000-0000-0000000000c0', 'd0000000-0000-0000-0000-0000000000db', 'd0000000-0000-0000-0000-0000000000f1', 'd0000000-0000-0000-0000-0000000000f3', '2026-08-02', 'draft')
  returning id into v_dept_b_submission_id;
  perform set_config('report_dept_test.dept_b_submission_id', v_dept_b_submission_id::text, true);

  -- The facility-wide filer, unaffected by 0033, can submit it themselves.
  update report_submissions set status = 'submitted' where id = v_dept_b_submission_id;
  if not exists (select 1 from report_submissions where id = v_dept_b_submission_id and status = 'submitted') then
    raise exception 'DEPT FAIL: facility-wide filer could not submit a draft outside any department scope';
  end if;
  -- Revert to draft so the next block's negative case is meaningful.
  update report_submissions set status = 'draft' where id = v_dept_b_submission_id;
end;
$$;
reset role;

select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000ac","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  v_dept_b_submission_id uuid := current_setting('report_dept_test.dept_b_submission_id')::uuid;
begin
  update report_submissions set status = 'submitted' where id = v_dept_b_submission_id;
  if exists (select 1 from report_submissions where id = v_dept_b_submission_id and status = 'submitted') then
    raise exception 'DEPT FAIL: dept-A filer moved a sibling department''s draft to submitted';
  end if;
end;
$$;
reset role;

rollback;
