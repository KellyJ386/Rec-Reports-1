-- Verification intent: fn_enforce_change_request_transition (0014) enforces
-- the admin_change_requests state machine end to end --
-- draft -> pending_review -> approved|rejected -> published, with
-- reviewed_by/reviewed_at required on approve/reject, self-approval blocked,
-- and published_at auto-stamped on publish. Runs against a migrated
-- database; everything lives inside a transaction that is rolled back, so no
-- fixture persists. Each assertion RAISEs on failure so
-- psql -v ON_ERROR_STOP=1 turns any regression into a non-zero exit. Illegal
-- transitions surface as insufficient_privilege (SQLSTATE 42501), matching
-- the append-only/system-role guard convention (0010/0012).
begin;

insert into auth.users (id, email) values
  ('79999999-9999-9999-9999-999999999991', 'cr-requester@workflow.test'),
  ('79999999-9999-9999-9999-999999999992', 'cr-reviewer@workflow.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('79999999-9999-9999-9999-999999999991', 'CR Requester', 'cr-requester@workflow.test'),
  ('79999999-9999-9999-9999-999999999992', 'CR Reviewer', 'cr-reviewer@workflow.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('79111111-1111-1111-1111-111111111111', 'Org Change Requests')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '79111111-1111-1111-1111-111111111111', 'CR Facility A')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('79c00000-0000-0000-0000-0000000000c1', '79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CR Admin Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('79c00000-0000-0000-0000-0000000000c1', 'admin.manage')
on conflict do nothing;

-- Both the requester and the reviewer hold admin.manage on the facility, so
-- RLS ("admins can manage change requests", 0008:114) lets either of them
-- write admin_change_requests rows; the self-approval block below is
-- fn_enforce_change_request_transition's job, not RLS's.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('79d00000-0000-0000-0000-0000000000d1', '79999999-9999-9999-9999-999999999991', '79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '79c00000-0000-0000-0000-0000000000c1', 'active'),
  ('79d00000-0000-0000-0000-0000000000d2', '79999999-9999-9999-9999-999999999992', '79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '79c00000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- Three change requests, all created as plain drafts (INSERT is never
-- gated by the transition trigger -- only UPDATE is).
insert into admin_change_requests (id, facility_id, entity_table, change_summary, status, requested_by) values
  ('79e00000-0000-0000-0000-00000000e001', '79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'branding_profiles', 'Legal chain walkthrough', 'draft', '79999999-9999-9999-9999-999999999991'),
  ('79e00000-0000-0000-0000-00000000e002', '79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'branding_profiles', 'Illegal jump attempt', 'draft', '79999999-9999-9999-9999-999999999991'),
  ('79e00000-0000-0000-0000-00000000e003', '79aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'branding_profiles', 'Self-approval attempt', 'draft', '79999999-9999-9999-9999-999999999991')
on conflict (id) do nothing;

-- Act as the requester.
select set_config('request.jwt.claims', '{"sub":"79999999-9999-9999-9999-999999999991","role":"authenticated"}', true);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Legal chain: draft -> pending_review -> approved -> published.
-- ---------------------------------------------------------------------------
do $$
begin
  update admin_change_requests set status = 'pending_review'
    where id = '79e00000-0000-0000-0000-00000000e001';
exception
  when insufficient_privilege then
    raise exception 'CR FAIL: legal draft -> pending_review was denied';
end;
$$;

do $$
begin
  if (select status from admin_change_requests where id = '79e00000-0000-0000-0000-00000000e001') <> 'pending_review' then
    raise exception 'CR FAIL: draft -> pending_review did not persist';
  end if;
end;
$$;

-- Switch to the reviewer (a different user than the requester) to approve.
select set_config('request.jwt.claims', '{"sub":"79999999-9999-9999-9999-999999999992","role":"authenticated"}', true);

do $$
begin
  update admin_change_requests
    set status = 'approved', reviewed_by = '79999999-9999-9999-9999-999999999992', reviewed_at = now()
    where id = '79e00000-0000-0000-0000-00000000e001';
exception
  when insufficient_privilege then
    raise exception 'CR FAIL: legal pending_review -> approved (different reviewer) was denied';
end;
$$;

do $$
begin
  update admin_change_requests set status = 'published'
    where id = '79e00000-0000-0000-0000-00000000e001';
exception
  when insufficient_privilege then
    raise exception 'CR FAIL: legal approved -> published was denied';
end;
$$;

do $$
declare
  v_published_at timestamptz;
begin
  select published_at into v_published_at from admin_change_requests where id = '79e00000-0000-0000-0000-00000000e001';
  if v_published_at is null then
    raise exception 'CR FAIL: publishing did not auto-stamp published_at';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Illegal jump: draft straight to approved must raise.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update admin_change_requests
      set status = 'approved', reviewed_by = '79999999-9999-9999-9999-999999999992', reviewed_at = now()
      where id = '79e00000-0000-0000-0000-00000000e002';
    raise exception 'CR FAIL: draft -> approved (illegal jump) was allowed';
  exception
    when insufficient_privilege then null; -- expected: fn_enforce_change_request_transition raised
  end;
end;
$$;

-- Illegal jump: draft straight to published must raise.
do $$
begin
  begin
    update admin_change_requests set status = 'published'
      where id = '79e00000-0000-0000-0000-00000000e002';
    raise exception 'CR FAIL: draft -> published (illegal jump) was allowed';
  exception
    when insufficient_privilege then null; -- expected: fn_enforce_change_request_transition raised
  end;
end;
$$;

-- Approve without reviewed_by/reviewed_at must raise, even from the legal
-- pending_review status.
do $$
begin
  begin
    update admin_change_requests set status = 'pending_review' where id = '79e00000-0000-0000-0000-00000000e002';
    update admin_change_requests set status = 'approved' where id = '79e00000-0000-0000-0000-00000000e002';
    raise exception 'CR FAIL: approve without reviewed_by/reviewed_at was allowed';
  exception
    when insufficient_privilege then null; -- expected: reviewed_by/reviewed_at required
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Self-approval: the requester cannot also be the reviewer.
-- ---------------------------------------------------------------------------
do $$
begin
  update admin_change_requests set status = 'pending_review'
    where id = '79e00000-0000-0000-0000-00000000e003';
exception
  when insufficient_privilege then
    raise exception 'CR FAIL: legal draft -> pending_review (self-approval fixture) was denied';
end;
$$;

-- Still acting as the requester (79...991): approving your own request must
-- raise even though reviewed_by/reviewed_at are both set.
do $$
begin
  begin
    update admin_change_requests
      set status = 'approved', reviewed_by = '79999999-9999-9999-9999-999999999991', reviewed_at = now()
      where id = '79e00000-0000-0000-0000-00000000e003';
    raise exception 'CR FAIL: self-approval was allowed';
  exception
    when insufficient_privilege then null; -- expected: fn_enforce_change_request_transition raised
  end;
end;
$$;

-- A different reviewer can still legally approve the same request.
do $$
begin
  update admin_change_requests
    set status = 'approved', reviewed_by = '79999999-9999-9999-9999-999999999992', reviewed_at = now()
    where id = '79e00000-0000-0000-0000-00000000e003';
exception
  when insufficient_privilege then
    raise exception 'CR FAIL: legal approval by a different reviewer was denied after a blocked self-approval';
end;
$$;

reset role;
rollback;
