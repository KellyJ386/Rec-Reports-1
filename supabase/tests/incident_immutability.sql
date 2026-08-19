-- Verification intent: IN-04 (plans/INCIDENTS_PLAN.md) write-side RLS for
-- incident_amendments (0032) plus append-only enforcement for
-- incident_amendments and incident_audit_events. Covers:
--   1. incidents.manage and incidents.review holders can each INSERT an
--      amendment for an incident in their own facility (POST
--      /incidents/:id/amendments' HTTP guard accepts either -- this proves
--      the RLS policy actually admits both, not just one).
--   2. An incidents.read-only member (no manage, no review) cannot INSERT an
--      amendment, even in their own facility.
--   3. Cross-facility insert denial: a direct facility_id mismatch, plus a
--      fn_assert_same_facility FK-injection attempt on incident_id.
--   4. Cross-tenant read: a Facility-A-only member cannot SELECT a
--      Facility-B incident_amendments row.
--   5. Append-only: authenticated cannot UPDATE or DELETE an
--      incident_amendments row, even the row's own inserter.
--   6. Append-only: authenticated cannot UPDATE or DELETE an
--      incident_audit_events row (0010's trigger; not previously exercised
--      by an RLS SQL test against this specific table -- audit_append_only.sql
--      only covers audit_events).
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('32000000-0000-0000-0000-000000000a01', 'im-manager@test'),
  ('32000000-0000-0000-0000-000000000a02', 'im-reviewer@test'),
  ('32000000-0000-0000-0000-000000000a03', 'im-reader@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('32000000-0000-0000-0000-000000000a01', 'IM Manager', 'im-manager@test'),
  ('32000000-0000-0000-0000-000000000a02', 'IM Reviewer', 'im-reviewer@test'),
  ('32000000-0000-0000-0000-000000000a03', 'IM Reader', 'im-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('32111111-1111-1111-1111-111111111111', 'IM Org A'),
  ('32222222-2222-2222-2222-222222222222', 'IM Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32111111-1111-1111-1111-111111111111', 'IM Facility A'),
  ('32bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '32222222-2222-2222-2222-222222222222', 'IM Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('32c00000-0000-0000-0000-0000000000c1', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IM Manager Role'),
  ('32c00000-0000-0000-0000-0000000000c2', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IM Reviewer Role'),
  ('32c00000-0000-0000-0000-0000000000c3', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IM Reader Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('32c00000-0000-0000-0000-0000000000c1', 'incidents.manage'),
  ('32c00000-0000-0000-0000-0000000000c1', 'incidents.read'),
  ('32c00000-0000-0000-0000-0000000000c2', 'incidents.review'),
  ('32c00000-0000-0000-0000-0000000000c2', 'incidents.read'),
  ('32c00000-0000-0000-0000-0000000000c3', 'incidents.read')
on conflict do nothing;

-- All three test users are members of Facility A ONLY -- none has any
-- membership in Facility B, so the cross-facility cases below are a real
-- foreign tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('32d10000-0000-0000-0000-0000000000d1', '32000000-0000-0000-0000-000000000a01', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32c00000-0000-0000-0000-0000000000c1', 'active'),
  ('32d10000-0000-0000-0000-0000000000d2', '32000000-0000-0000-0000-000000000a02', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32c00000-0000-0000-0000-0000000000c2', 'active'),
  ('32d10000-0000-0000-0000-0000000000d3', '32000000-0000-0000-0000-000000000a03', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

-- Incident reports in both facilities, seeded with RLS bypassed (owner
-- role). Facility B's row is only ever used as a cross-tenant target below.
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('32e00000-0000-0000-0000-0000000000e1', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IMA1', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Facility A dock', 'Facility A seed incident'),
  ('32e00000-0000-0000-0000-0000000000e2', '32bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'INC-2026-IMB1', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Facility B dock', 'Facility B seed incident')
on conflict (id) do nothing;

-- A pre-existing Facility B amendment, seeded with RLS bypassed, used only as
-- the cross-tenant SELECT-denial target in step 4.
insert into incident_amendments (id, facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot, amended_by) values
  ('32f00000-0000-0000-0000-0000000000f1', '32bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '32e00000-0000-0000-0000-0000000000e2', 'seed', '{"summary":"before"}'::jsonb, '{"summary":"after"}'::jsonb, null)
on conflict (id) do nothing;

-- A pre-existing incident_audit_events row, seeded with RLS bypassed, used
-- only for the append-only check in step 6 (id is bigserial -- referenced
-- below by event_type rather than a chosen id). event_hash (0004) is a NOT
-- NULL legacy column no trigger populates -- every real caller goes through
-- buildIncidentAuditEvent (src/lib/incidents.mjs), which fills it; this raw
-- fixture insert must supply one explicitly the same way.
insert into incident_audit_events (facility_id, incident_id, event_type, event_payload, event_hash) values
  ('32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32e00000-0000-0000-0000-0000000000e1', 'incident_immutability.seed', '{}'::jsonb, 'seed-fixture-hash');

-- ---------------------------------------------------------------------------
-- 1a. incidents.manage holder can INSERT an amendment for their own
-- facility's incident.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"32000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_amendments (id, facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot, amended_by) values
    ('32100000-0000-0000-0000-000000001001', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32e00000-0000-0000-0000-0000000000e1', 'manager amendment', '{"summary":"before"}'::jsonb, '{"summary":"after (manager)"}'::jsonb, '32000000-0000-0000-0000-000000000a01');
exception
  when insufficient_privilege then
    raise exception 'IM FAIL: incidents.manage holder was denied inserting an amendment in their own facility';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3a. Cross-facility insert denial: the manager has no membership in
-- Facility B, so inserting an amendment there must fail even naming
-- Facility B's own incident (facility_id/incident_id internally consistent,
-- but the caller lacks the permission on that facility at all).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_amendments (facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot) values
      ('32bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '32e00000-0000-0000-0000-0000000000e2', 'cross facility attempt', '{}'::jsonb, '{}'::jsonb);
    raise exception 'IM FAIL: manager inserted an incident_amendments row into a facility they are not a member of';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Cross-tenant FK injection: facility_id = A (where the manager does
-- hold incidents.manage), but incident_id names the Facility B incident --
-- fn_assert_same_facility must reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_amendments (facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot) values
      ('32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32e00000-0000-0000-0000-0000000000e2', 'fk injection attempt', '{}'::jsonb, '{}'::jsonb);
    raise exception 'IM FAIL: manager injected a Facility B incident_id into a Facility A amendment row';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Append-only: even the manager who inserted the row cannot UPDATE or
-- DELETE it afterwards.
--
-- incident_amendments carries NO update/delete policy at all (0032): with
-- RLS enabled and zero permissive policies for a command, Postgres denies it
-- by silently matching zero rows -- it does NOT raise insufficient_privilege
-- (that only happens when a USING/WITH CHECK clause is evaluated and fails;
-- here there is no policy to evaluate at all, so fn_block_audit_mutation's
-- BEFORE UPDATE/DELETE trigger never even fires for this row). This is the
-- exact "RLS-by-omission" semantics 0032's own header documents and the same
-- idiom work_orders_scope.sql uses for a reader's denied UPDATE -- so the
-- correct assertion is "the row is unchanged afterward", not "an exception
-- was raised". The insufficient_privilege catch is kept (not required, but
-- harmless) as defense-in-depth coverage for a hypothetical future stray
-- permissive policy, which is exactly what 0032 added the trigger to guard
-- against.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_amendments set amendment_reason = 'tampered' where id = '32100000-0000-0000-0000-000000001001';
  exception
    when insufficient_privilege then null; -- acceptable: fn_block_audit_mutation raised
  end;
  if exists (select 1 from incident_amendments where id = '32100000-0000-0000-0000-000000001001' and amendment_reason = 'tampered') then
    raise exception 'IM FAIL: an incident_amendments row was updated';
  end if;
end;
$$;

do $$
begin
  begin
    delete from incident_amendments where id = '32100000-0000-0000-0000-000000001001';
  exception
    when insufficient_privilege then null; -- acceptable: fn_block_audit_mutation raised
  end;
  if not exists (select 1 from incident_amendments where id = '32100000-0000-0000-0000-000000001001') then
    raise exception 'IM FAIL: an incident_amendments row was deleted';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Append-only: incident_audit_events cannot be UPDATEd or DELETEd either
-- (0010's trigger), exercised here (not just audit_events, which
-- audit_append_only.sql already covers). Same RLS-by-omission semantics as
-- step 5 above: incident_audit_events also carries no update/delete policy,
-- so the UPDATE/DELETE below silently matches zero rows rather than
-- raising -- verified by re-reading the row afterward, not by expecting an
-- exception.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_audit_events set event_type = 'tampered' where event_type = 'incident_immutability.seed';
  exception
    when insufficient_privilege then null; -- acceptable: fn_block_audit_mutation raised
  end;
  if exists (select 1 from incident_audit_events where event_type = 'tampered') then
    raise exception 'IM FAIL: an incident_audit_events row was updated';
  end if;
end;
$$;

do $$
begin
  begin
    delete from incident_audit_events where event_type = 'incident_immutability.seed';
  exception
    when insufficient_privilege then null; -- acceptable: fn_block_audit_mutation raised
  end;
  if not exists (select 1 from incident_audit_events where event_type = 'incident_immutability.seed') then
    raise exception 'IM FAIL: an incident_audit_events row was deleted';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 1b. incidents.review holder (no incidents.manage) can ALSO insert an
-- amendment for their own facility's incident -- the policy is OR-ed across
-- both codes, matching the HTTP route's guard.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"32000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_amendments (id, facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot, amended_by) values
    ('32100000-0000-0000-0000-000000001002', '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32e00000-0000-0000-0000-0000000000e1', 'reviewer amendment', '{"summary":"before"}'::jsonb, '{"summary":"after (reviewer)"}'::jsonb, '32000000-0000-0000-0000-000000000a02');
exception
  when insufficient_privilege then
    raise exception 'IM FAIL: incidents.review holder was denied inserting an amendment in their own facility';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2. An incidents.read-only member (no manage, no review) cannot insert an
-- amendment, even in their own facility.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"32000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into incident_amendments (facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot) values
      ('32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '32e00000-0000-0000-0000-0000000000e1', 'reader attempt', '{}'::jsonb, '{}'::jsonb);
    raise exception 'IM FAIL: an incidents.read-only member inserted an incident_amendments row';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant read denial: the reader (Facility A only) cannot see the
-- pre-seeded Facility B amendment row.
-- ---------------------------------------------------------------------------
do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from incident_amendments where id = '32f00000-0000-0000-0000-0000000000f1';
  if visible_count <> 0 then
    raise exception 'IM FAIL: a Facility-A-only member could read a Facility B incident_amendments row';
  end if;
end;
$$;

-- Sanity check: the same reader CAN see their own facility's amendments
-- (both rows inserted in steps 1a/1b), proving the zero-row result above is
-- tenant isolation and not merely "nobody can read anything".
do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from incident_amendments where facility_id = '32aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  if visible_count <> 2 then
    raise exception 'IM FAIL: expected the reader to see 2 Facility A amendments, saw %', visible_count;
  end if;
end;
$$;

reset role;

rollback;
