-- Verification intent: Slice 2B, P-6 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md)
-- / IN-11 (plans/INCIDENTS_PLAN.md) -- 0050_incident_people_statements.sql.
-- Covers:
--   1. incidents.read-only member can SELECT incident_witness_statements
--      rows for their own facility.
--   2. That same reader CANNOT INSERT a statement (no incidents.manage or
--      incidents.review).
--   3. incidents.manage AND incidents.review holders can each INSERT a new
--      statement version for a person in their own facility (the INSERT
--      policy is OR-ed across both codes, matching the routes' guard).
--   4. Cross-facility FK injection is rejected in BOTH directions:
--      person_id naming a person who belongs to a different facility, and
--      incident_id naming an incident that belongs to a different facility
--      (fn_assert_same_facility on each parent reference independently).
--   5. UPDATE of statement_text is rejected even for an incidents.manage
--      holder who otherwise has RLS write access to the row --
--      fn_incident_witness_statement_guard (0050) enforces this at the
--      trigger layer, independent of the permission check.
--   6. signed_at can be set exactly once: the sign UPDATE succeeds, and a
--      second attempt (to re-sign OR to change any other column afterward)
--      is rejected -- the row is fully immutable once signed.
--   7. Hard DELETE is unreachable under RLS (no DELETE policy exists at
--      all -- RLS-by-omission, same idiom as incident_amendments/
--      incident_audit_events in incident_immutability.sql): the row is
--      unchanged afterward, no exception required.
--   8. incident_people's additive incidents.review INSERT/UPDATE policies
--      (0050(d)) plus the additive manager/reviewer SELECT policy (0050(e),
--      needed because Postgres RLS requires an UPDATE's resulting row to
--      remain SELECT-visible even when the UPDATE policy's own WITH CHECK
--      already allows it): a reviewer (no incidents.manage) can add a
--      person and soft-delete one, and a cross-facility FK-injection INSERT
--      attempt is rejected the same way as (4).
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('50000000-0000-0000-0000-000000000a01', 'ips-manager@test'),
  ('50000000-0000-0000-0000-000000000a02', 'ips-reviewer@test'),
  ('50000000-0000-0000-0000-000000000a03', 'ips-reader@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('50000000-0000-0000-0000-000000000a01', 'IPS Manager', 'ips-manager@test'),
  ('50000000-0000-0000-0000-000000000a02', 'IPS Reviewer', 'ips-reviewer@test'),
  ('50000000-0000-0000-0000-000000000a03', 'IPS Reader', 'ips-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('50111111-1111-1111-1111-111111111111', 'IPS Org A'),
  ('50222222-2222-2222-2222-222222222222', 'IPS Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50111111-1111-1111-1111-111111111111', 'IPS Facility A'),
  ('50bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '50222222-2222-2222-2222-222222222222', 'IPS Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('50c00000-0000-0000-0000-0000000000c1', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IPS Manager Role'),
  ('50c00000-0000-0000-0000-0000000000c2', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IPS Reviewer Role'),
  ('50c00000-0000-0000-0000-0000000000c3', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'IPS Reader Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('50c00000-0000-0000-0000-0000000000c1', 'incidents.manage'),
  ('50c00000-0000-0000-0000-0000000000c1', 'incidents.read'),
  ('50c00000-0000-0000-0000-0000000000c2', 'incidents.review'),
  ('50c00000-0000-0000-0000-0000000000c2', 'incidents.read'),
  ('50c00000-0000-0000-0000-0000000000c3', 'incidents.read')
on conflict do nothing;

-- All three test users are members of Facility A ONLY -- none has any
-- membership in Facility B, so the cross-facility cases below are a real
-- foreign tenant.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('50d10000-0000-0000-0000-0000000000d1', '50000000-0000-0000-0000-000000000a01', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50c00000-0000-0000-0000-0000000000c1', 'active'),
  ('50d10000-0000-0000-0000-0000000000d2', '50000000-0000-0000-0000-000000000a02', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50c00000-0000-0000-0000-0000000000c2', 'active'),
  ('50d10000-0000-0000-0000-0000000000d3', '50000000-0000-0000-0000-000000000a03', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50c00000-0000-0000-0000-0000000000c3', 'active')
on conflict (id) do nothing;

-- Incident reports in both facilities, seeded with RLS bypassed (owner
-- role). Facility B's row is only ever used as a cross-tenant FK-injection
-- target below.
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('50e00000-0000-0000-0000-0000000000e1', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-IPS1', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Facility A dock', 'IPS Facility A seed incident'),
  ('50e00000-0000-0000-0000-0000000000e2', '50bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'INC-2026-IPS2', 'incident', 'submitted', 'medium', '2026-07-01T00:00:00Z', 'Facility B dock', 'IPS Facility B seed incident')
on conflict (id) do nothing;

-- One person per facility, seeded with RLS bypassed. Facility B's person is
-- only ever used as the cross-tenant FK-injection target in step 4a.
insert into incident_people (id, facility_id, incident_id, person_role, full_name) values
  ('50f00000-0000-0000-0000-0000000000f1', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', 'witness', 'IPS Person A'),
  ('50f00000-0000-0000-0000-0000000000f2', '50bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '50e00000-0000-0000-0000-0000000000e2', 'witness', 'IPS Person B')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Reader (incidents.read only) can SELECT witness statements for their
-- own facility. Seeded here (RLS bypassed) so there is something to read.
-- ---------------------------------------------------------------------------
insert into incident_witness_statements (id, facility_id, incident_id, person_id, version_no, statement_text, submitted_by) values
  ('50200000-0000-0000-0000-000000002000', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', '50f00000-0000-0000-0000-0000000000f1', 1, 'IPS seed statement v1', '50000000-0000-0000-0000-000000000a01')
on conflict (id) do nothing;

select set_config('request.jwt.claims', '{"sub":"50000000-0000-0000-0000-000000000a03","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  seen_count int;
begin
  select count(*) into seen_count from incident_witness_statements where id = '50200000-0000-0000-0000-000000002000';
  if seen_count <> 1 then
    raise exception 'IPS FAIL: incidents.read holder could not read a witness statement in their own facility';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. That same reader CANNOT INSERT a new statement version.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_witness_statements (facility_id, incident_id, person_id, version_no, statement_text, submitted_by) values
      ('50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', '50f00000-0000-0000-0000-0000000000f1', 2, 'reader attempt', '50000000-0000-0000-0000-000000000a03');
    raise exception 'IPS FAIL: an incidents.read-only member inserted a witness statement';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3a. incidents.manage holder can INSERT a new statement version.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"50000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_witness_statements (id, facility_id, incident_id, person_id, version_no, statement_text, submitted_by) values
    ('50200000-0000-0000-0000-000000002001', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', '50f00000-0000-0000-0000-0000000000f1', 2, 'manager version', '50000000-0000-0000-0000-000000000a01');
exception
  when insufficient_privilege then
    raise exception 'IPS FAIL: incidents.manage holder was denied inserting a witness statement in their own facility';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. Cross-facility FK injection via person_id: facility_id/incident_id
-- both name Facility A (where the manager holds incidents.manage), but
-- person_id names Facility B's person. fn_assert_same_facility on
-- incident_people must reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_witness_statements (facility_id, incident_id, person_id, version_no, statement_text, submitted_by) values
      ('50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', '50f00000-0000-0000-0000-0000000000f2', 1, 'fk injection via person_id', '50000000-0000-0000-0000-000000000a01');
    raise exception 'IPS FAIL: manager injected a Facility B person_id into a Facility A witness statement';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility(..., 'incident_people', ...) blocked it
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. Cross-facility FK injection via incident_id: facility_id/person_id
-- both name Facility A, but incident_id names Facility B's incident.
-- fn_assert_same_facility on incident_reports must reject this.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_witness_statements (facility_id, incident_id, person_id, version_no, statement_text, submitted_by) values
      ('50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e2', '50f00000-0000-0000-0000-0000000000f1', 3, 'fk injection via incident_id', '50000000-0000-0000-0000-000000000a01');
    raise exception 'IPS FAIL: manager injected a Facility B incident_id into a Facility A witness statement';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility(..., 'incident_reports', ...) blocked it
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. UPDATE of statement_text is rejected even for the manager who inserted
-- the row and otherwise holds RLS UPDATE access -- the append-only trigger
-- (fn_incident_witness_statement_guard) enforces the locked-column set
-- independent of the permission check.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_witness_statements set statement_text = 'tampered' where id = '50200000-0000-0000-0000-000000002001';
    raise exception 'IPS FAIL: statement_text was edited on an unsigned witness statement';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

do $$
declare
  current_text text;
begin
  select statement_text into current_text from incident_witness_statements where id = '50200000-0000-0000-0000-000000002001';
  if current_text <> 'manager version' then
    raise exception 'IPS FAIL: statement_text changed despite the rejected UPDATE (saw %)', current_text;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6a. signed_at can be set exactly once: the sign UPDATE succeeds.
-- ---------------------------------------------------------------------------
do $$
begin
  update incident_witness_statements set signed_at = now() where id = '50200000-0000-0000-0000-000000002001';
exception
  when check_violation then
    raise exception 'IPS FAIL: the one-time sign UPDATE (signed_at null -> now()) was rejected';
end;
$$;

do $$
declare
  signed_count int;
begin
  select count(*) into signed_count from incident_witness_statements where id = '50200000-0000-0000-0000-000000002001' and signed_at is not null;
  if signed_count <> 1 then
    raise exception 'IPS FAIL: signed_at was not actually set';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b. A signed statement is fully immutable: a second sign attempt (or any
-- other column change) afterward is rejected.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_witness_statements set signed_at = now() where id = '50200000-0000-0000-0000-000000002001';
    raise exception 'IPS FAIL: a signed witness statement accepted a second signed_at UPDATE';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

do $$
begin
  begin
    update incident_witness_statements set statement_text = 'post-sign tamper' where id = '50200000-0000-0000-0000-000000002001';
    raise exception 'IPS FAIL: a signed witness statement accepted a statement_text UPDATE';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Hard DELETE is unreachable under RLS: no DELETE policy exists for
-- incident_witness_statements at all (only SELECT/INSERT/UPDATE), so a
-- DELETE from an authenticated manager silently matches zero rows -- same
-- RLS-by-omission idiom incident_immutability.sql documents for
-- incident_amendments/incident_audit_events. Exercised against the still-
-- unsigned version 2 row.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    delete from incident_witness_statements where id = '50200000-0000-0000-0000-000000002001';
  exception
    when insufficient_privilege then null; -- acceptable: the trigger's DELETE branch fired
  end;
  if not exists (select 1 from incident_witness_statements where id = '50200000-0000-0000-0000-000000002001') then
    raise exception 'IPS FAIL: a witness statement row was hard-deleted';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3b. incidents.review holder (no incidents.manage) can ALSO insert a new
-- statement version -- the INSERT policy is OR-ed across both codes.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"50000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into incident_witness_statements (id, facility_id, incident_id, person_id, version_no, statement_text, submitted_by) values
    ('50200000-0000-0000-0000-000000002002', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', '50f00000-0000-0000-0000-0000000000f1', 4, 'reviewer version', '50000000-0000-0000-0000-000000000a02');
exception
  when insufficient_privilege then
    raise exception 'IPS FAIL: incidents.review holder was denied inserting a witness statement in their own facility';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8a. incident_people's additive incidents.review policies (0050(d)): a
-- reviewer (no incidents.manage) can INSERT a new person into their own
-- facility's incident.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into incident_people (id, facility_id, incident_id, person_role, full_name) values
    ('50f00000-0000-0000-0000-0000000000f3', '50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e1', 'witness', 'IPS Reviewer-added Person');
exception
  when insufficient_privilege then
    raise exception 'IPS FAIL: incidents.review holder was denied inserting a person (0050(d) additive policy not working)';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8b. Same additive INSERT policy: a cross-facility FK-injection attempt
-- (incident_id naming Facility B's incident) is rejected.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into incident_people (facility_id, incident_id, person_role, full_name) values
      ('50aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '50e00000-0000-0000-0000-0000000000e2', 'witness', 'FK injection attempt');
    raise exception 'IPS FAIL: reviewer injected a Facility B incident_id into a Facility A incident_people row';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8c. Same reviewer can UPDATE (soft-delete) the person they just added --
-- the additive UPDATE policy from 0050(d), made reachable by the additive
-- SELECT policy from 0050(e) (see that migration's header (e): without it,
-- Postgres RLS rejects an UPDATE whose resulting row would no longer be
-- visible under any SELECT policy, even when the UPDATE policy's own WITH
-- CHECK already allows it).
-- ---------------------------------------------------------------------------
do $$
begin
  update incident_people set deleted_at = now() where id = '50f00000-0000-0000-0000-0000000000f3';
exception
  when insufficient_privilege then
    raise exception 'IPS FAIL: incidents.review holder was denied soft-deleting a person (0050(d)/(e) additive policies not working)';
end;
$$;

do $$
declare
  deleted_count int;
begin
  select count(*) into deleted_count from incident_people where id = '50f00000-0000-0000-0000-0000000000f3' and deleted_at is not null;
  if deleted_count <> 1 then
    raise exception 'IPS FAIL: incident_people.deleted_at was not actually set by the reviewer';
  end if;
end;
$$;

reset role;

rollback;
