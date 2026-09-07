-- Verification intent: Wave 3, Slice 3B, IN-16
-- (plans/INCIDENTS_PLAN.md / plans/WAVES_1_4_IMPLEMENTATION_PLAN.md) --
-- 0057_incident_legal_hold_retention.sql. Covers the delete-protection
-- matrix at the DB layer, independent of whatever the BFF route layer does
-- (no route soft-deletes incident_reports or its children today -- every
-- probe below writes straight to PostgREST-equivalent SQL, exactly the shape
-- a raw REST client reaching these tables directly would produce):
--   1. A DRAFT incident under legal_hold=true: soft-delete (deleted_at) is
--      rejected for an incidents.manage holder (new Guard 0) -- the one gap
--      0048's status-based freeze left open (that freeze never engages for
--      a still-draft row).
--   2. That same held incident's children -- incident_people (hard DELETE
--      and the soft-delete UPDATE), incident_attachments (hard DELETE and
--      the soft-delete UPDATE), incident_witness_statements (the soft-delete
--      UPDATE; hard DELETE was already unconditionally rejected before this
--      migration) -- are all rejected too, by the new
--      fn_incident_child_legal_hold_guard trigger.
--   3. A CLOSED incident (legal_hold=false): soft-delete of the INCIDENT
--      ITSELF is rejected (0048's existing status-based freeze, re-verified
--      here as part of this task's explicit acceptance list) -- but its
--      children are NOT rejected by the new child guard, which is
--      deliberately legal_hold-only (see 0057's own header for why a
--      status-based freeze on the children would have regressed
--      incident_people_statements.sql's existing "reviewer removes a person
--      from a SUBMITTED incident" coverage). incident_people's soft-delete
--      succeeds directly on this closed-but-unheld parent, proving the
--      distinction is real, not just documented.
--   4. A released hold on a still-draft incident (legal_hold=false,
--      status=draft): soft-delete IS allowed, for both the incident itself
--      and its children -- proving the guards are genuinely conditional, not
--      a blanket freeze.
--   5. A service-role/definer-context caller (auth.uid() is null) is exempt
--      from every guard above, for both the parent and a child -- the
--      forward-looking carve-out a future retention/purge job (Wave 4
--      IN-25) needs, matching 0048's L3 precedent.
--   6. incident_amendments: a quick sanity probe that DELETE stays rejected
--      unconditionally (fn_block_audit_mutation, 0032 -- untouched by this
--      migration, already strictly stronger than "no delete while held").
-- Runs against a migrated database inside a rolled-back transaction, so no
-- fixture persists.
begin;

insert into auth.users (id, email) values
  ('57000000-0000-0000-0000-000000000a01', 'ilh-manager@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('57000000-0000-0000-0000-000000000a01', 'ILH Manager', 'ilh-manager@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('57111111-1111-1111-1111-111111111111', 'ILH Org A')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57111111-1111-1111-1111-111111111111', 'ILH Facility A')
on conflict (id) do nothing;

-- One role holding both incidents.manage AND incidents.legal_hold.manage --
-- the interaction between those two codes is already exhaustively covered
-- by supabase/tests/incident_report_guards.sql and wave1b_review_fixes.sql
-- (H3/M2); this file only needs a single actor who can both place a hold and
-- then attempt (and be rejected from) a delete.
insert into roles (id, facility_id, name) values
  ('57c00000-0000-0000-0000-0000000000c1', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ILH Manager Role')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('57c00000-0000-0000-0000-0000000000c1', 'incidents.manage'),
  ('57c00000-0000-0000-0000-0000000000c1', 'incidents.legal_hold.manage'),
  ('57c00000-0000-0000-0000-0000000000c1', 'incidents.read')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('57d10000-0000-0000-0000-0000000000d1', '57000000-0000-0000-0000-000000000a01', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57c00000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- Four incident_reports fixtures, seeded RLS-bypassed (owner role) with
-- legal_hold=false throughout (M2, 0048, requires incidents.legal_hold.manage
-- even at INSERT time for legal_hold=true -- simplest to seed false and flip
-- it via an authenticated actor below, matching every other test file in
-- this set's own convention):
--   e01 -- HELD: draft, flipped to legal_hold=true below.
--   e02 -- RELEASED: draft, legal_hold stays false throughout.
--   e03 -- CLOSED: status=closed, legal_hold=false.
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('57e00000-0000-0000-0000-000000000e01', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-ILH1', 'incident', 'draft', 'medium', '2026-07-01T00:00:00Z', 'Dock 1', 'Held draft'),
  ('57e00000-0000-0000-0000-000000000e02', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-ILH2', 'incident', 'draft', 'medium', '2026-07-01T00:00:00Z', 'Dock 2', 'Released draft'),
  ('57e00000-0000-0000-0000-000000000e03', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INC-2026-ILH3', 'incident', 'closed', 'medium', '2026-07-01T00:00:00Z', 'Dock 3', 'Closed, not held')
on conflict (id) do nothing;

-- One child row per table, per incident above -- each seeded RLS-bypassed.
insert into incident_people (id, facility_id, incident_id, person_role, full_name) values
  ('57f10000-0000-0000-0000-000000000f01', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e01', 'witness', 'Held Incident Witness'),
  ('57f10000-0000-0000-0000-000000000f02', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e02', 'witness', 'Released Incident Witness'),
  ('57f10000-0000-0000-0000-000000000f03', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e03', 'witness', 'Closed Incident Witness')
on conflict (id) do nothing;

insert into incident_attachments (id, facility_id, incident_id, attachment_type, storage_path) values
  ('57f20000-0000-0000-0000-000000000f01', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e01', 'photo', 'facilities/57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/incidents/57e00000-0000-0000-0000-000000000e01/held.jpg'),
  ('57f20000-0000-0000-0000-000000000f02', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e02', 'photo', 'facilities/57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/incidents/57e00000-0000-0000-0000-000000000e02/released.jpg'),
  ('57f20000-0000-0000-0000-000000000f03', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e03', 'photo', 'facilities/57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/incidents/57e00000-0000-0000-0000-000000000e03/closed.jpg')
on conflict (id) do nothing;

insert into incident_witness_statements (id, facility_id, incident_id, person_id, version_no, statement_text) values
  ('57f30000-0000-0000-0000-000000000f01', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e01', '57f10000-0000-0000-0000-000000000f01', 1, 'Held statement'),
  ('57f30000-0000-0000-0000-000000000f02', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e02', '57f10000-0000-0000-0000-000000000f02', 1, 'Released statement'),
  ('57f30000-0000-0000-0000-000000000f03', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e03', '57f10000-0000-0000-0000-000000000f03', 1, 'Closed statement')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Place the hold on e01, as the manager (who also holds
-- incidents.legal_hold.manage) -- confirms the toggle itself still works
-- (Wave 1) before this file's own new-guard probes run against it.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"57000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update incident_reports set legal_hold = true where id = '57e00000-0000-0000-0000-000000000e01';
exception
  when check_violation then
    raise exception 'ILH FAIL: the manager (who holds incidents.legal_hold.manage) was denied placing the hold on e01';
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. HELD draft (e01): soft-delete rejected for the manager (Guard 0).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set deleted_at = now() where id = '57e00000-0000-0000-0000-000000000e01';
    raise exception 'ILH FAIL: soft-delete of a legal-held DRAFT incident succeeded for a manager (Guard 0 not closed)';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. HELD draft's children (e01's people/attachments/statements): every
-- delete path rejected for the manager (fn_incident_child_legal_hold_guard).
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    delete from incident_people where id = '57f10000-0000-0000-0000-000000000f01';
    raise exception 'ILH FAIL: hard DELETE of incident_people succeeded while the parent incident is under legal hold';
  exception
    when check_violation then null; -- expected
  end;

  begin
    update incident_people set deleted_at = now() where id = '57f10000-0000-0000-0000-000000000f01';
    raise exception 'ILH FAIL: soft-delete (UPDATE deleted_at) of incident_people succeeded while the parent incident is under legal hold';
  exception
    when check_violation then null; -- expected
  end;

  begin
    delete from incident_attachments where id = '57f20000-0000-0000-0000-000000000f01';
    raise exception 'ILH FAIL: hard DELETE of incident_attachments succeeded while the parent incident is under legal hold';
  exception
    when check_violation then null; -- expected
  end;

  begin
    update incident_attachments set deleted_at = now() where id = '57f20000-0000-0000-0000-000000000f01';
    raise exception 'ILH FAIL: soft-delete (UPDATE deleted_at) of incident_attachments succeeded while the parent incident is under legal hold';
  exception
    when check_violation then null; -- expected
  end;

  begin
    update incident_witness_statements set deleted_at = now() where id = '57f30000-0000-0000-0000-000000000f01';
    raise exception 'ILH FAIL: soft-delete (UPDATE deleted_at) of incident_witness_statements succeeded while the parent incident is under legal hold';
  exception
    when check_violation then null; -- expected
  end;

  -- Hard DELETE stays unreachable regardless of legal hold, exactly as
  -- before this migration: incident_witness_statements carries no DELETE
  -- policy at all (0050), so the DELETE silently matches zero rows under
  -- RLS rather than raising -- same RLS-by-omission idiom
  -- incident_people_statements.sql's own probe #7 documents.
  begin
    delete from incident_witness_statements where id = '57f30000-0000-0000-0000-000000000f01';
  exception
    when insufficient_privilege then null; -- acceptable: the trigger's DELETE branch fired
  end;
  if not exists (select 1 from incident_witness_statements where id = '57f30000-0000-0000-0000-000000000f01') then
    raise exception 'ILH FAIL: a witness statement row was hard-deleted';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. CLOSED incident (e03, legal_hold=false): soft-delete of the INCIDENT
-- ITSELF is rejected -- 0048's existing status-based freeze, re-verified as
-- this task's own acceptance item.
-- ---------------------------------------------------------------------------
do $$
begin
  update incident_reports set deleted_at = now() where id = '57e00000-0000-0000-0000-000000000e03';
  raise exception 'ILH FAIL: soft-delete of a CLOSED incident succeeded for a manager';
exception
  when check_violation then null; -- expected
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Its children are NOT rejected -- the new child guard is legal_hold-
-- only (see 0057's own header comment for why: a status-based freeze here
-- would regress incident_people_statements.sql's existing, shipped coverage
-- of removing a person from a submitted-not-held incident). Exercised as a
-- hard DELETE for incident_attachments (sidesteps the unrelated 0026
-- visibility restriction entirely -- a DELETE only needs the USING clause,
-- not post-image SELECT visibility) and as the ordinary soft-delete UPDATE
-- for incident_people/incident_witness_statements (both already visible to
-- this actor post-update via their own, pre-existing SELECT policies -- see
-- section 4's header comment for the two tables that are NOT).
-- ---------------------------------------------------------------------------
do $$
begin
  update incident_people set deleted_at = now() where id = '57f10000-0000-0000-0000-000000000f03';
exception
  when check_violation then
    raise exception 'ILH FAIL: incident_people soft-delete was rejected on a CLOSED-but-unheld parent (children are legal_hold-only)';
end;
$$;

do $$
begin
  delete from incident_attachments where id = '57f20000-0000-0000-0000-000000000f03';
exception
  when check_violation then
    raise exception 'ILH FAIL: incident_attachments hard DELETE was rejected on a CLOSED-but-unheld parent (children are legal_hold-only)';
end;
$$;

do $$
begin
  update incident_witness_statements set deleted_at = now() where id = '57f30000-0000-0000-0000-000000000f03';
exception
  when check_violation then
    raise exception 'ILH FAIL: incident_witness_statements soft-delete was rejected on a CLOSED-but-unheld parent (children are legal_hold-only)';
end;
$$;

do $$
declare
  v_deleted_at timestamptz;
  v_still_exists boolean;
begin
  select deleted_at into v_deleted_at from incident_people where id = '57f10000-0000-0000-0000-000000000f03';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_people.deleted_at was not actually set on the CLOSED-but-unheld parent''s child';
  end if;

  select exists(select 1 from incident_attachments where id = '57f20000-0000-0000-0000-000000000f03') into v_still_exists;
  if v_still_exists then
    raise exception 'ILH FAIL: the CLOSED-but-unheld parent''s attachment row still exists after the hard DELETE';
  end if;

  select deleted_at into v_deleted_at from incident_witness_statements where id = '57f30000-0000-0000-0000-000000000f03';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_witness_statements.deleted_at was not actually set on the CLOSED-but-unheld parent''s child';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RELEASED draft (e02, legal_hold=false, status=draft): neither Guard 0
-- nor the child guard fires here -- proving they are genuinely conditional,
-- not a blanket freeze -- but "soft-delete allowed" plays out two different
-- ways depending on the table's OWN, pre-existing SELECT-policy shape
-- (0026_soft_delete_policy_hardening.sql, unrelated to this migration):
--
--   * incident_people (0050(e) widened its SELECT policy for manage/review
--     to carry no deleted_at filter) and incident_witness_statements (its
--     lone SELECT policy, unlike every OTHER incident_* table's, has never
--     carried a deleted_at filter at all) both stay visible to this actor
--     after their own soft-delete -- a plain authenticated UPDATE succeeds
--     directly, exactly like the shipped soft-delete PEOPLE route does today.
--
--   * incident_reports and incident_attachments have NO such widened policy
--     -- every SELECT-capable policy available to a manage holder on either
--     table requires deleted_at IS NULL. 0026's header documents (and this
--     probe re-confirms empirically) that PostgreSQL refuses ANY UPDATE
--     whose resulting row would become invisible under every one of the
--     acting role's own permissive SELECT policies -- "new row violates
--     row-level security policy", SQLSTATE 42501/insufficient_privilege --
--     regardless of what the UPDATE policy's own WITH CHECK says. This is
--     NOT Guard 0 or the child guard firing (neither raises check_violation
--     here, confirmed below) -- it is the SAME pre-existing restriction
--     0026 already documents for every other soft-deletable table, and the
--     same reason 0048's L3 and this migration's own guards both carve out
--     a service-role/definer-context exemption: completing a live soft-
--     delete on either of these two tables requires exactly that mechanism,
--     matching 0026's own conclusion for WO-24 verbatim. Proven immediately
--     below via the same service-role path section 5 uses.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update incident_reports set deleted_at = now() where id = '57e00000-0000-0000-0000-000000000e02';
    raise exception 'ILH FAIL: a released-hold draft incident''s soft-delete unexpectedly succeeded via a plain authenticated UPDATE (expected the pre-existing 0026 visibility rejection)';
  exception
    when check_violation then
      raise exception 'ILH FAIL: Guard 0 rejected a released-hold (legal_hold=false), still-draft incident -- it must be unconditional on the CURRENT hold/status, not the guard';
    when insufficient_privilege then null; -- expected: 0026's pre-existing visibility rule, not this migration's guards
  end;
end;
$$;

do $$
begin
  update incident_people set deleted_at = now() where id = '57f10000-0000-0000-0000-000000000f02';
exception
  when check_violation then
    raise exception 'ILH FAIL: soft-delete of incident_people was rejected on a released-hold draft parent (should be allowed)';
end;
$$;

do $$
begin
  begin
    update incident_attachments set deleted_at = now() where id = '57f20000-0000-0000-0000-000000000f02';
    raise exception 'ILH FAIL: a released-hold draft''s attachment soft-delete unexpectedly succeeded via a plain authenticated UPDATE (expected the pre-existing 0026 visibility rejection)';
  exception
    when check_violation then
      raise exception 'ILH FAIL: the child guard rejected a released-hold, still-draft parent''s attachment -- it must be unconditional on the CURRENT hold/status, not the guard';
    when insufficient_privilege then null; -- expected: 0026's pre-existing visibility rule, not this migration's guard
  end;
end;
$$;

do $$
begin
  update incident_witness_statements set deleted_at = now() where id = '57f30000-0000-0000-0000-000000000f02';
exception
  when check_violation then
    raise exception 'ILH FAIL: soft-delete of incident_witness_statements was rejected on a released-hold draft parent (should be allowed)';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Assertions for 4 above (the two directly-successful tables), run as the
-- superuser table owner (bypasses RLS, matching every other file in this
-- set's own convention).
-- ---------------------------------------------------------------------------
do $$
declare
  v_deleted_at timestamptz;
begin
  select deleted_at into v_deleted_at from incident_reports where id = '57e00000-0000-0000-0000-000000000e02';
  if v_deleted_at is not null then
    raise exception 'ILH FAIL: incident_reports.deleted_at was unexpectedly set by the rejected authenticated UPDATE attempt';
  end if;

  select deleted_at into v_deleted_at from incident_people where id = '57f10000-0000-0000-0000-000000000f02';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_people.deleted_at was not actually set on the released-hold draft''s child';
  end if;

  select deleted_at into v_deleted_at from incident_attachments where id = '57f20000-0000-0000-0000-000000000f02';
  if v_deleted_at is not null then
    raise exception 'ILH FAIL: incident_attachments.deleted_at was unexpectedly set by the rejected authenticated UPDATE attempt';
  end if;

  select deleted_at into v_deleted_at from incident_witness_statements where id = '57f30000-0000-0000-0000-000000000f02';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_witness_statements.deleted_at was not actually set on the released-hold draft''s child';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. The two tables 0026's visibility rule blocked above (incident_reports,
-- incident_attachments) via the SAME service-role/definer-context mechanism
-- section 5 exercises against the still-HELD e01 -- proving "soft-delete
-- allowed" for a released-hold, still-draft row IS genuinely reachable, just
-- not through a raw client-authenticated UPDATE. This is the exact path a
-- Wave 4 IN-25 purge job (which never runs as an RLS-subject authenticated
-- actor) would use.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);

do $$
begin
  update incident_reports set deleted_at = now() where id = '57e00000-0000-0000-0000-000000000e02';
exception
  when check_violation then
    raise exception 'ILH FAIL: a null-auth.uid() (service-role-equivalent) caller was denied soft-deleting a released-hold draft incident';
end;
$$;

do $$
begin
  update incident_attachments set deleted_at = now() where id = '57f20000-0000-0000-0000-000000000f02';
exception
  when check_violation then
    raise exception 'ILH FAIL: a null-auth.uid() (service-role-equivalent) caller was denied soft-deleting a released-hold draft''s attachment';
end;
$$;

do $$
declare
  v_deleted_at timestamptz;
begin
  select deleted_at into v_deleted_at from incident_reports where id = '57e00000-0000-0000-0000-000000000e02';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_reports.deleted_at was not actually set by the service-role caller on the released-hold draft';
  end if;

  select deleted_at into v_deleted_at from incident_attachments where id = '57f20000-0000-0000-0000-000000000f02';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_attachments.deleted_at was not actually set by the service-role caller on the released-hold draft''s child';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Service role (auth.uid() is null): exempt from every guard above, for
-- both the still-HELD e01 (parent) and its child -- unlike 4b (a released,
-- unheld row, blocked only by the pre-existing 0026 visibility rule), e01
-- is STILL under legal hold here, so this specifically proves Guard 0 and
-- the child guard both carry the service-role exemption they claim, not
-- just that some path to a null-auth.uid() delete exists. request.jwt.claims
-- was already cleared in 4b (transaction-local set_config; re-asserted here
-- for a reader jumping straight to this section) -- same rationale as
-- wave1b_review_fixes.sql's own L3 probe -- and the assertions run as the
-- connecting (table-owner) role, which bypasses RLS entirely -- exactly what
-- a real service-role client does.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);

do $$
begin
  update incident_reports set deleted_at = now() where id = '57e00000-0000-0000-0000-000000000e01';
exception
  when check_violation then
    raise exception 'ILH FAIL: a null-auth.uid() (service-role-equivalent) caller was denied soft-deleting a still-HELD incident';
end;
$$;

do $$
begin
  delete from incident_attachments where id = '57f20000-0000-0000-0000-000000000f01';
exception
  when check_violation then
    raise exception 'ILH FAIL: a null-auth.uid() (service-role-equivalent) caller was denied hard-deleting a child of a still-HELD incident';
end;
$$;

do $$
declare
  v_deleted_at timestamptz;
  v_still_exists boolean;
begin
  select deleted_at into v_deleted_at from incident_reports where id = '57e00000-0000-0000-0000-000000000e01';
  if v_deleted_at is null then
    raise exception 'ILH FAIL: incident_reports.deleted_at was not actually set by the service-role caller';
  end if;

  select exists(select 1 from incident_attachments where id = '57f20000-0000-0000-0000-000000000f01') into v_still_exists;
  if v_still_exists then
    raise exception 'ILH FAIL: the child attachment row still exists after the service-role caller''s hard DELETE';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. incident_amendments: DELETE stays unconditionally rejected (0032,
-- untouched by this migration -- a quick sanity probe, not new coverage).
-- ---------------------------------------------------------------------------
insert into incident_amendments (id, facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot) values
  ('57f40000-0000-0000-0000-000000000f01', '57aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '57e00000-0000-0000-0000-000000000e03', 'ILH sanity probe', '{}'::jsonb, '{}'::jsonb)
on conflict (id) do nothing;

do $$
begin
  begin
    delete from incident_amendments where id = '57f40000-0000-0000-0000-000000000f01';
    raise exception 'ILH FAIL: incident_amendments DELETE succeeded (append-only guarantee, 0032, regressed)';
  exception
    when insufficient_privilege then null; -- expected (fn_block_audit_mutation)
  end;
end;
$$;

rollback;
