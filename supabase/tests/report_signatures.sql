-- Verification intent: DR-17 (plans/DAILY_REPORTS_PLAN.md) --
-- 0052_report_signatures.sql. Covers:
--   1. reports.read holder can SELECT signatures for their own facility.
--   2. reports.read-only holder (no reports.submit) CANNOT INSERT a
--      signature.
--   3. reports.submit holder CAN INSERT a signature for a draft submission
--      in their own facility, signing as themselves.
--   4. Cross-facility FK injection is rejected: facility_id names Facility
--      A, but submission_id names a submission that actually belongs to
--      Facility B (fn_assert_same_facility).
--   5. Signer must be the caller: an INSERT whose signer_user_id names a
--      DIFFERENT user (even one who also holds reports.submit in the same
--      facility) is rejected.
--   6. UPDATE and DELETE are both rejected on an existing signature --
--      "immutable once recorded" (fn_report_submission_signature_guard),
--      independent of the RLS-by-omission gap (no UPDATE/DELETE policy
--      exists at all).
--   7. INSERT is rejected once the referenced submission is no longer
--      'draft' (fn_report_submission_signature_guard's INSERT branch).
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('52000000-0000-0000-0000-000000000a01', 'rs-submitter@test'),
  ('52000000-0000-0000-0000-000000000a02', 'rs-reader@test'),
  ('52000000-0000-0000-0000-000000000a03', 'rs-other-submitter@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('52000000-0000-0000-0000-000000000a01', 'RS Submitter', 'rs-submitter@test'),
  ('52000000-0000-0000-0000-000000000a02', 'RS Reader', 'rs-reader@test'),
  ('52000000-0000-0000-0000-000000000a03', 'RS Other Submitter', 'rs-other-submitter@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('52111111-1111-1111-1111-111111111111', 'RS Org A'),
  ('52222222-2222-2222-2222-222222222222', 'RS Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52111111-1111-1111-1111-111111111111', 'RS Facility A'),
  ('52bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '52222222-2222-2222-2222-222222222222', 'RS Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('52c00000-0000-0000-0000-0000000000c1', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RS Submitter Role'),
  ('52c00000-0000-0000-0000-0000000000c2', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'RS Reader Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('52c00000-0000-0000-0000-0000000000c1', 'reports.submit'),
  ('52c00000-0000-0000-0000-0000000000c1', 'reports.create'),
  ('52c00000-0000-0000-0000-0000000000c1', 'reports.read'),
  ('52c00000-0000-0000-0000-0000000000c2', 'reports.read')
on conflict do nothing;

-- All three test users are members of Facility A ONLY -- none has any
-- membership in Facility B, so the cross-facility case below is a real
-- foreign tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('52d10000-0000-0000-0000-0000000000d1', '52000000-0000-0000-0000-000000000a01', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52c00000-0000-0000-0000-0000000000c1', 'active'),
  ('52d10000-0000-0000-0000-0000000000d2', '52000000-0000-0000-0000-000000000a02', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52c00000-0000-0000-0000-0000000000c2', 'active'),
  ('52d10000-0000-0000-0000-0000000000d3', '52000000-0000-0000-0000-000000000a03', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52c00000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- Templates/versions, seeded with RLS bypassed (owner role).
insert into report_templates (id, facility_id, code, name, status, active_version) values
  ('52e00000-0000-0000-0000-0000000000e1', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rs_tpl_a', 'RS Template A', 'published', null),
  ('52e00000-0000-0000-0000-0000000000e2', '52bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'rs_tpl_b', 'RS Template B', 'published', null)
on conflict (id) do nothing;

insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, is_published) values
  ('52f00000-0000-0000-0000-0000000000f1', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52e00000-0000-0000-0000-0000000000e1', 1, '{"sections":[]}'::jsonb, true),
  ('52f00000-0000-0000-0000-0000000000f2', '52bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '52e00000-0000-0000-0000-0000000000e2', 1, '{"sections":[]}'::jsonb, true)
on conflict (id) do nothing;

update report_templates set active_version = 1
  where id in ('52e00000-0000-0000-0000-0000000000e1', '52e00000-0000-0000-0000-0000000000e2') and active_version is null;

-- Draft submissions, one per facility, seeded with RLS bypassed. Facility
-- B's submission is only ever used as the cross-tenant FK-injection target
-- in step 4.
insert into report_submissions (id, facility_id, template_id, template_version_id, report_date, status) values
  ('52100000-0000-0000-0000-000000001001', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52e00000-0000-0000-0000-0000000000e1', '52f00000-0000-0000-0000-0000000000f1', '2026-08-10', 'draft'),
  ('52100000-0000-0000-0000-000000001002', '52bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '52e00000-0000-0000-0000-0000000000e2', '52f00000-0000-0000-0000-0000000000f2', '2026-08-10', 'draft')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Seed one signature row (RLS bypassed) so step 1's SELECT has something to
-- find.
-- ---------------------------------------------------------------------------
insert into report_submission_signatures (id, facility_id, submission_id, signer_user_id, signer_role, signature_hash) values
  ('52200000-0000-0000-0000-000000002000', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52100000-0000-0000-0000-000000001001', '52000000-0000-0000-0000-000000000a01', 'manager', 'seed-hash')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Reader (reports.read only) can SELECT signatures for their own
-- facility.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"52000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  seen_count int;
begin
  select count(*) into seen_count from report_submission_signatures where id = '52200000-0000-0000-0000-000000002000';
  if seen_count <> 1 then
    raise exception 'RS FAIL: reports.read holder could not read a signature in their own facility';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. That same reader (no reports.submit) CANNOT INSERT a signature.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_submission_signatures (facility_id, submission_id, signer_user_id, signer_role, signature_hash) values
      ('52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52100000-0000-0000-0000-000000001001', '52000000-0000-0000-0000-000000000a02', 'reader-attempt', 'hash');
    raise exception 'RS FAIL: a reports.read-only member inserted a signature';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. reports.submit holder CAN INSERT a signature for their own facility's
-- draft submission, signing as themselves.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"52000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into report_submission_signatures (id, facility_id, submission_id, signer_user_id, signer_role, signature_hash) values
    ('52200000-0000-0000-0000-000000002001', '52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52100000-0000-0000-0000-000000001001', '52000000-0000-0000-0000-000000000a01', 'supervisor', 'real-hash-1');
exception
  when insufficient_privilege then
    raise exception 'RS FAIL: reports.submit holder was denied signing their own facility''s draft submission';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-facility FK injection: facility_id names Facility A, but
-- submission_id names Facility B's submission. fn_assert_same_facility must
-- reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_submission_signatures (facility_id, submission_id, signer_user_id, signer_role, signature_hash) values
      ('52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52100000-0000-0000-0000-000000001002', '52000000-0000-0000-0000-000000000a01', 'fk-injection', 'hash');
    raise exception 'RS FAIL: submitter injected a Facility B submission_id into a Facility A signature';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Signer must be the caller: an INSERT naming a DIFFERENT user as
-- signer_user_id is rejected, even though that user (rs-other-submitter)
-- also holds reports.submit in the same facility.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into report_submission_signatures (facility_id, submission_id, signer_user_id, signer_role, signature_hash) values
      ('52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52100000-0000-0000-0000-000000001001', '52000000-0000-0000-0000-000000000a03', 'impersonation', 'hash');
    raise exception 'RS FAIL: submitter inserted a signature attributed to a different user';
  exception
    when insufficient_privilege then null; -- expected: signer_user_id = (select auth.uid()) blocked it
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6a. UPDATE is rejected on an existing signature -- immutable once
-- recorded. No UPDATE policy exists at all (RLS-by-omission: the UPDATE's
-- own USING clause admits zero rows, so it affects 0 rows and returns
-- WITHOUT raising -- same idiom as incident_amendments/incident_audit_events
-- (incident_immutability.sql) and this table's own DELETE case below), so
-- the fn_report_submission_signature_guard UPDATE branch is presently
-- unreachable in practice -- kept as defense in depth against a future
-- policy addition, same posture 0050's header documents for its own DELETE
-- branch. Either way (silently-zero-rows, or the trigger raising) is
-- acceptable; the row simply must be unchanged afterward.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update report_submission_signatures set signature_hash = 'tampered' where id = '52200000-0000-0000-0000-000000002001';
  exception
    when check_violation then null; -- also acceptable: the trigger's UPDATE branch fired
  end;
end;
$$;

do $$
declare
  current_hash text;
begin
  select signature_hash into current_hash from report_submission_signatures where id = '52200000-0000-0000-0000-000000002001';
  if current_hash <> 'real-hash-1' then
    raise exception 'RS FAIL: signature_hash changed despite the rejected UPDATE (saw %)', current_hash;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b. DELETE is rejected on an existing signature. No DELETE policy exists
-- at all (RLS-by-omission would already block this), plus the trigger
-- rejects it explicitly (defense in depth) -- either failure mode is
-- acceptable, the row must simply survive.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    delete from report_submission_signatures where id = '52200000-0000-0000-0000-000000002001';
  exception
    when check_violation then null; -- also acceptable: the trigger's DELETE branch fired
  end;
  if not exists (select 1 from report_submission_signatures where id = '52200000-0000-0000-0000-000000002001') then
    raise exception 'RS FAIL: an existing signature was hard-deleted';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. INSERT is rejected once the submission is no longer 'draft'. Advance
-- the Facility A submission to 'submitted' (RLS bypassed -- only the status
-- transition itself matters here, not the reports module's own submit
-- state machine), then attempt one more signature.
-- ---------------------------------------------------------------------------
update report_submissions
  set status = 'submitted', submitted_by = '52000000-0000-0000-0000-000000000a01', submitted_at = now()
  where id = '52100000-0000-0000-0000-000000001001';

select set_config('request.jwt.claims', '{"sub":"52000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into report_submission_signatures (facility_id, submission_id, signer_user_id, signer_role, signature_hash) values
      ('52aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '52100000-0000-0000-0000-000000001001', '52000000-0000-0000-0000-000000000a01', 'too-late', 'hash');
    raise exception 'RS FAIL: a signature was inserted against a non-draft submission';
  exception
    when check_violation then null; -- expected: fn_report_submission_signature_guard's INSERT branch blocked it
  end;
end;
$$;

reset role;

rollback;
