-- ===========================================================================
-- 0056_incident_compliance.sql
-- Wave 3, Slice 3B: IN-13 (signatures), IN-14 (OSHA recordability decision
-- tree), IN-15 (compliance checks + closure gate) -- plans/INCIDENTS_PLAN.md,
-- plans/WAVES_1_4_IMPLEMENTATION_PLAN.md's Wave 3 row. IN-19 (review
-- workspace UI) is app.js/incident-review.mjs only -- no schema.
--
-- Every helper call below is schema-qualified internal.<name>(...) per
-- 0042's convention (mandatory for every migration >= 0043,
-- scripts/verify-migrations.mjs enforces it), and every `auth.uid()` in a
-- NEW policy predicate is wrapped `(select auth.uid())` per 0049's InitPlan-
-- caching convention. fn_incident_report_transition_guard and
-- fn_attachment_path_facility are existing SECURITY DEFINER trigger
-- functions (not policy predicates), so their bodies keep their own
-- established bare `auth.uid()` style, matching every prior migration that
-- has touched them (0043/0048) rather than mixing conventions inside one
-- function body.
--
-- (a) incident_signatures (IN-13): one row per attestation/signature
--     collected against an incident (e.g. "I attest this report is
--     accurate" from the reporter, a witness, or -- the one that matters for
--     the closure gate below -- a supervisor signoff). signer_role is a
--     fixed vocabulary, verbatim from
--     INCIDENT_ACCIDENT_REPORTING_SYSTEM.md 2.1's
--     `signature_role enum('reporter','witness','supervisor','manager')`
--     (src/lib/incidents.mjs's SIGNATURE_ROLES). attestation_text is capped
--     at 2000 chars at the DB layer too (validateAttestationText,
--     incidents.mjs, is the route's own pre-check). signature_image_path is
--     nullable (many signatures are typed/attested only, no image capture)
--     but when present must satisfy 0041's attachment-path convention --
--     enforced by extending fn_attachment_path_facility (part (c) below)
--     rather than duplicating that regex here.
--
--     RLS: SELECT under incidents.read (matching every other incident_*
--     table). INSERT under incidents.manage OR incidents.review (matching
--     this module's established "review is a distinct, narrower-than-
--     manage governance surface that can still act on case content" design,
--     0032/0043(d)/0050) AND fn_assert_same_facility(facility_id,
--     'incident_reports', incident_id) (closing the cross-tenant
--     FK-injection path every incident_* write policy since 0009 closes)
--     AND signer_user_id = (select auth.uid()) -- mirrors
--     report_submission_signatures' own "a caller can only ever sign as
--     themselves" rule (0052(b)) exactly. No UPDATE/DELETE policy exists at
--     all (RLS-by-omission, matching incident_amendments/
--     incident_audit_events' own append-only posture) PLUS the trigger in
--     (b) rejects both explicitly, as defense in depth independent of
--     whatever a future policy addition might otherwise admit -- the same
--     belt-and-suspenders shape 0052(c)'s fn_report_submission_signature_guard
--     uses for report_submission_signatures.
--
-- (b) fn_incident_signature_guard(): BEFORE UPDATE OR DELETE trigger,
--     unconditionally rejecting both -- a signature is either absent or
--     present, with no draft/append-only version history to protect (unlike
--     incident_witness_statements' pre-sign editable window, 0050(c)), so
--     this is simpler than that guard: nothing about it depends on the
--     row's own content. SECURITY DEFINER + fixed search_path, matching
--     every other guard trigger in this migration set.
--
-- (c) fn_attachment_path_facility (0041) extended with an incident_signatures
--     branch reading signature_image_path instead of storage_path/
--     evidence_path -- the same table-name-dispatch shape 0041 already uses
--     for employee_certifications' evidence_path. CREATE OR REPLACE
--     preserves the function's existing grants, but every EXECUTE revoke
--     this migration set has applied to it (0041, 0042) is reasserted below
--     anyway, matching 0048's own precedent when it replaced
--     fn_incident_report_transition_guard (defensive, not because REPLACE
--     actually drops them). Registered as a BEFORE INSERT (not INSERT OR
--     UPDATE) trigger on incident_signatures specifically: (b) already
--     rejects every UPDATE on this table unconditionally, so the path only
--     needs checking once, at the row's only possible write.
--
-- (d) incident_compliance_checks (IN-15): one row per (incident_id,
--     check_key), `unique (incident_id, check_key)` enforcing the module's
--     chosen upsert semantics -- documented here since the task explicitly
--     allows either update-in-place or an appended history with
--     superseded_at, and this migration picks update-in-place: a later
--     check for the same key REPLACES the prior result via PostgREST's
--     `Prefer: resolution=merge-duplicates` upsert (pgInsert's `merge`
--     option, src/lib/supabase-rest.mjs) against this unique constraint,
--     rather than appending a new row and superseding the old one. Simpler
--     (no extra column, no "is this still the live one" filtering on every
--     read) and sufficient: the compliance-checks route never needs a
--     check's full revision history, only its current status, and every
--     status CHANGE is independently visible in incident_audit_events
--     (every POST .../compliance-checks writes an audit event with the old
--     and new status) for anyone who does need the "who changed a
--     determination and when" history.
--
--     check_key is a fixed vocabulary, verbatim from
--     INCIDENT_ACCIDENT_REPORTING_SYSTEM.md 2.2's
--     `check_type enum('osha_recordability','supervisor_signoff','evidence_complete','legal_review')`
--     (src/lib/incidents.mjs's COMPLIANCE_CHECK_KEYS). status is
--     pass/fail/waived (COMPLIANCE_CHECK_STATUSES).
--
--     RLS: SELECT under incidents.read. Because a PostgREST upsert
--     (INSERT ... ON CONFLICT DO UPDATE) is checked against BOTH the INSERT
--     policy (for a genuinely new row) AND the UPDATE policy (when the
--     conflict target already exists -- Postgres requires the existing row
--     be visible under an applicable UPDATE policy's USING expression, and
--     the resulting row satisfy its WITH CHECK, even though the statement
--     is written as INSERT), this migration adds matching INSERT/UPDATE
--     pairs rather than an INSERT-only policy:
--       * "incident managers can record compliance checks" (INSERT + UPDATE):
--         incidents.manage OR incidents.review, status IN ('pass','fail')
--         only -- a manage/review holder may record or update a pass/fail
--         result but never mint a waiver themselves.
--       * "incident reviewers can waive compliance checks" (INSERT +
--         UPDATE): incidents.review only, status = 'waived' only -- IN-15's
--         "waive requires incidents.review" acceptance criterion, enforced
--         at the RLS layer (not just the route's own pre-check) so a
--         manage-only actor's waive attempt is rejected by the database
--         even if some future write path skips the route's own guard.
--     Both pairs also require checked_by = (select auth.uid()) (mirrors
--     incident_signatures' signer_user_id rule -- a caller attributes a
--     determination to themselves, never to someone else) and
--     fn_assert_same_facility(facility_id, 'incident_reports', incident_id).
--     No DELETE policy exists (a compliance check, like a signature, is
--     never removed -- only superseded via the upsert path above).
--
-- (e) Closure gate (IN-13's "closure gate extended to require supervisor
--     signoff when requires_osha_review" + IN-15's "high/critical closure
--     requires evidence_complete pass", design §9.4 item 4): extends
--     fn_incident_report_transition_guard (0043/0048) ADDITIVELY -- every
--     existing guard in that function (BEFORE INSERT legal_hold branch,
--     guard 1/1b legal_hold permission, guard 2 transition graph, guard 3
--     frozen/amendable columns) is reproduced verbatim below; only the new
--     guard 2.5 is added, between guard 2 (transition legality) and guard 3
--     (column freeze), and only evaluated on old.status IS DISTINCT FROM
--     new.status AND new.status = 'closed' (i.e. the same "is this a close"
--     condition the route's own openFollowUps/legal_hold gate already keys
--     off, src/lib/http/incidents-routes.mjs's `to === "closed"` branch --
--     applied here regardless of which of the graph's two legal "-> closed"
--     edges (escalated->closed, action_pending->closed) is being taken,
--     matching evaluateClosureGate's own "any close" scope rather than
--     literally reproducing "under_review -> closed", which is not a legal
--     single-hop edge in this module's own transition graph, INCIDENT_
--     TRANSITIONS, src/lib/incidents.mjs):
--       * new.severity in ('high', 'critical') requires an
--         incident_compliance_checks row for this incident with
--         check_key = 'evidence_complete' and status in ('pass', 'waived').
--       * new.requires_osha_review requires the same for
--         check_key = 'supervisor_signoff'.
--     A missing row, or one recorded 'fail', blocks the close with a
--     check_violation (surfaced as 409 through translatePostgrestError,
--     P-9's class-23 mapping) exactly like guard 2's illegal-transition
--     rejection. This mirrors evaluateClosureGate (src/lib/incidents.mjs)
--     exactly -- that pure function is what incidents-routes.mjs's
--     POST /incidents/:id/status calls FIRST, for a specific, friendly
--     rejection naming which check blocked the close (and so the route
--     never even attempts the UPDATE for the common case); this trigger is
--     what actually enforces the rule at the database layer regardless of
--     write path (a race between two concurrent close attempts, a future
--     non-route caller, a bug in the route's own pre-check). SECURITY
--     DEFINER lets this read incident_compliance_checks independent of the
--     calling role's own incidents.read grant, matching every other
--     lookup this function (and fn_incident_report_audit, 0043) already
--     performs.
--
-- Idempotency conventions (mirroring 0009-0055): drop policy/trigger if
-- exists immediately before every create; create or replace for functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) incident_signatures: table + indexes + RLS.
-- ---------------------------------------------------------------------------
create table if not exists incident_signatures (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  signer_user_id uuid not null references app_users(id),
  role text not null check (role in ('reporter', 'witness', 'supervisor', 'manager')),
  attestation_text text not null check (char_length(attestation_text) <= 2000),
  signed_name text not null,
  signature_image_path text,
  signed_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists incident_signatures_facility_incident_idx
  on incident_signatures(facility_id, incident_id);
create index if not exists incident_signatures_incident_role_idx
  on incident_signatures(incident_id, role);

alter table incident_signatures enable row level security;

drop policy if exists "incident readers can read signatures" on incident_signatures;
create policy "incident readers can read signatures" on incident_signatures
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'incidents.read'));

drop policy if exists "incident managers can sign incidents" on incident_signatures;
create policy "incident managers can sign incidents" on incident_signatures
  for insert
  with check (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and signer_user_id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- (b) fn_incident_signature_guard(): a signature is immutable once recorded.
-- ---------------------------------------------------------------------------
create or replace function fn_incident_signature_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'incident_signatures %: a signature is immutable once recorded.', old.id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    raise exception 'incident_signatures %: a signature can never be deleted.', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists incident_signatures_guard on incident_signatures;
create trigger incident_signatures_guard
  before update or delete on incident_signatures
  for each row execute function fn_incident_signature_guard();

revoke execute on function fn_incident_signature_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_incident_signature_guard() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (c) fn_attachment_path_facility (0041): add the incident_signatures
-- branch (signature_image_path), then re-attach as a BEFORE INSERT trigger
-- on incident_signatures. See header (c).
-- ---------------------------------------------------------------------------
create or replace function fn_attachment_path_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  attachment_path text;
begin
  if TG_TABLE_NAME = 'employee_certifications' then
    attachment_path := new.evidence_path;
  elsif TG_TABLE_NAME = 'incident_signatures' then
    attachment_path := new.signature_image_path;
  else
    attachment_path := new.storage_path;
  end if;

  if attachment_path is not null then
    -- L1 (security review, Wave 3 Slice 3B): incident_signatures gets its
    -- OWN regex anchored on new.incident_id rather than reusing the shared
    -- four-module alternation below. The shared regex only pins
    -- facility_id + module ("incidents") + ANY single record-id segment --
    -- it happily accepted a signature on incident A naming a path under
    -- incident B (same facility, same module), and even a path under a
    -- completely different module (reports/work_orders/certifications), so
    -- long as the facility segment matched. This branch instead requires
    -- the path to literally be
    -- facilities/<facility_id>/incidents/<this row's own incident_id>/<filename>.
    if TG_TABLE_NAME = 'incident_signatures' then
      if attachment_path !~ (
        '^facilities/' || new.facility_id::text ||
        '/incidents/' || new.incident_id::text ||
        '/(?!\.\.?$)[^/]+$'
      ) then
        raise exception 'attachment path % does not match facilities/%/incidents/%/<filename>', attachment_path, new.facility_id, new.incident_id
          using errcode = 'check_violation';
      end if;
    elsif attachment_path !~ (
      '^facilities/' || new.facility_id::text ||
      '/(reports|incidents|work_orders|certifications)/(?!\.\.?/)[^/]+/(?!\.\.?$)[^/]+$'
    ) then
      raise exception 'attachment path % does not match facilities/%/<module>/<recordId>/<filename>', attachment_path, new.facility_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists report_submission_attachments_path_facility on report_submission_attachments;
create trigger report_submission_attachments_path_facility
  before insert or update on report_submission_attachments
  for each row execute function fn_attachment_path_facility();

drop trigger if exists incident_attachments_path_facility on incident_attachments;
create trigger incident_attachments_path_facility
  before insert or update on incident_attachments
  for each row execute function fn_attachment_path_facility();

drop trigger if exists work_order_attachments_path_facility on work_order_attachments;
create trigger work_order_attachments_path_facility
  before insert or update on work_order_attachments
  for each row execute function fn_attachment_path_facility();

drop trigger if exists employee_certifications_path_facility on employee_certifications;
create trigger employee_certifications_path_facility
  before insert or update on employee_certifications
  for each row execute function fn_attachment_path_facility();

drop trigger if exists incident_signatures_path_facility on incident_signatures;
create trigger incident_signatures_path_facility
  before insert on incident_signatures
  for each row execute function fn_attachment_path_facility();

revoke execute on function fn_attachment_path_facility() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_attachment_path_facility() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (d) incident_compliance_checks: table + indexes + RLS. See header (d).
-- ---------------------------------------------------------------------------
create table if not exists incident_compliance_checks (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  check_key text not null check (check_key in ('evidence_complete', 'supervisor_signoff', 'osha_recordability', 'legal_review')),
  status text not null check (status in ('pass', 'fail', 'waived')),
  notes text,
  checked_by uuid references app_users(id),
  checked_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (incident_id, check_key)
);

create index if not exists incident_compliance_checks_facility_incident_idx
  on incident_compliance_checks(facility_id, incident_id);

alter table incident_compliance_checks enable row level security;

drop policy if exists "incident readers can read compliance checks" on incident_compliance_checks;
create policy "incident readers can read compliance checks" on incident_compliance_checks
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'incidents.read'));

drop policy if exists "incident managers can record compliance checks" on incident_compliance_checks;
create policy "incident managers can record compliance checks" on incident_compliance_checks
  for insert
  with check (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and status in ('pass', 'fail')
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and checked_by = (select auth.uid())
  );

-- L2 (security review, Wave 3 Slice 3B): a manage-only actor's USING clause
-- used to admit ANY existing row (no restriction on the row's OWN prior
-- status), so a manage-without-review holder could overwrite a reviewer's
-- 'waived' determination with their own 'pass' -- the same record-integrity
-- guarantee "waive requires incidents.review" is supposed to protect, just
-- approached from the update-away-from-waived direction instead of the
-- mint-a-waiver direction. `and (status <> 'waived' or ... incidents.review)`
-- (USING is evaluated against the EXISTING/pre-update row, matching every
-- other UPDATE policy's own bare-column convention in this file set -- no
-- `old.`/`new.` qualifier is legal inside a policy expression) closes that:
-- a manage-only actor may still record/update a pass/fail check, but may no
-- longer touch a row a reviewer has already waived; a reviewer (with or
-- without manage) still can, via this same policy, matching G8's existing
-- "reviewer waive" capability and letting a reviewer supersede their own or
-- another reviewer's waiver without a second dedicated policy. The matching
-- `and (deleted_at is null or ... incidents.review)` on the WITH CHECK
-- (soft-delete was previously unconstrained here for EITHER code) closes
-- the sibling gap the same way: a manage-only actor could otherwise set
-- deleted_at on any check, making it invisible to the closure gate and to
-- GET .../compliance-checks, without holding incidents.review; a reviewer
-- still can.
drop policy if exists "incident managers can update compliance checks" on incident_compliance_checks;
create policy "incident managers can update compliance checks" on incident_compliance_checks
  for update
  using (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and (
      status <> 'waived'
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
  )
  with check (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and status in ('pass', 'fail')
    and (
      deleted_at is null
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and checked_by = (select auth.uid())
  );

drop policy if exists "incident reviewers can waive compliance checks" on incident_compliance_checks;
create policy "incident reviewers can waive compliance checks" on incident_compliance_checks
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    and status = 'waived'
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and checked_by = (select auth.uid())
  );

drop policy if exists "incident reviewers can update waived compliance checks" on incident_compliance_checks;
create policy "incident reviewers can update waived compliance checks" on incident_compliance_checks
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'incidents.review'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    and status = 'waived'
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and checked_by = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- (e) fn_incident_report_transition_guard: reproduced verbatim from 0048,
-- plus the new closure-gate guard 2.5. See header (e).
-- ---------------------------------------------------------------------------
create or replace function fn_incident_report_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manage_or_review boolean;
begin
  -- M2 (0048): BEFORE INSERT branch -- legal_hold may only be created true
  -- by an actor holding incidents.legal_hold.manage. No OLD row exists yet,
  -- so none of the UPDATE-only guards below apply.
  if tg_op = 'INSERT' then
    if new.legal_hold is true then
      if not internal.has_permission(auth.uid(), new.facility_id, 'incidents.legal_hold.manage') then
        raise exception 'incident_reports: legal_hold may only be created true by an actor holding incidents.legal_hold.manage.'
          using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;

  -- From here on, tg_op = 'UPDATE'.

  -- Guard 1: legal_hold is a permission-gated field, independent of status.
  if new.legal_hold is distinct from old.legal_hold then
    if not internal.has_permission(auth.uid(), new.facility_id, 'incidents.legal_hold.manage') then
      raise exception 'incident_reports %: legal_hold may only be changed by an actor holding incidents.legal_hold.manage.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 1b (H3, 0048): an actor holding ONLY incidents.legal_hold.manage
  -- (neither incidents.manage nor incidents.review) may change legal_hold
  -- and updated_at only. Gated on auth.uid() is not null (L3): a
  -- service-role/definer-context caller never reaches incident_reports
  -- through RLS at all, so this guard does not apply to it.
  v_manage_or_review := internal.has_permission(auth.uid(), new.facility_id, 'incidents.manage')
    or internal.has_permission(auth.uid(), new.facility_id, 'incidents.review');
  if auth.uid() is not null and not v_manage_or_review then
    if new.status is distinct from old.status
      or new.submitted_by is distinct from old.submitted_by
      or new.submitted_at is distinct from old.submitted_at
      or new.facility_id is distinct from old.facility_id
      or new.department_id is distinct from old.department_id
      or new.incident_no is distinct from old.incident_no
      or new.report_type is distinct from old.report_type
      or new.occurred_at is distinct from old.occurred_at
      or new.reported_at is distinct from old.reported_at
      or new.created_at is distinct from old.created_at
      or new.deleted_at is distinct from old.deleted_at
      or new.summary is distinct from old.summary
      or new.immediate_actions is distinct from old.immediate_actions
      or new.location_text is distinct from old.location_text
      or new.severity is distinct from old.severity
      or new.requires_osha_review is distinct from old.requires_osha_review
    then
      raise exception 'incident_reports %: an actor without incidents.manage or incidents.review may only change legal_hold (and updated_at).', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 2: the status transition graph (src/lib/incidents.mjs:90-97),
  -- verbatim from 0043.
  if old.status is distinct from new.status then
    if not (
      (old.status = 'draft' and new.status = 'submitted')
      or (old.status = 'submitted' and new.status = 'under_review')
      or (old.status = 'under_review' and new.status in ('escalated', 'action_pending'))
      or (old.status = 'escalated' and new.status in ('action_pending', 'closed'))
      or (old.status = 'action_pending' and new.status in ('escalated', 'closed'))
    ) then
      raise exception 'incident_reports %: illegal status transition from % to %.', old.id, old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 2.5 (0056, IN-13/IN-15): closing a high/critical incident requires
  -- a passing (or reviewer-waived) evidence_complete compliance check; an
  -- incident additionally flagged requires_osha_review also needs a
  -- passing (or waived) supervisor_signoff check. See migration header (e).
  if old.status is distinct from new.status and new.status = 'closed' then
    if new.severity in ('high', 'critical') then
      if not exists (
        select 1 from incident_compliance_checks
        where incident_id = new.id
          and check_key = 'evidence_complete'
          and status in ('pass', 'waived')
          and deleted_at is null
      ) then
        raise exception 'incident_reports %: cannot close a % incident without a passing (or waived) evidence_complete compliance check.', new.id, new.severity
          using errcode = 'check_violation';
      end if;
    end if;

    if new.requires_osha_review then
      if not exists (
        select 1 from incident_compliance_checks
        where incident_id = new.id
          and check_key = 'supervisor_signoff'
          and status in ('pass', 'waived')
          and deleted_at is null
      ) then
        raise exception 'incident_reports %: cannot close an incident requiring OSHA review without a passing (or waived) supervisor_signoff compliance check.', new.id
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- Guard 3: once an incident has left draft, only status, updated_at,
  -- legal_hold, and the amendable content fields may still change.
  -- L2: submitted_by/submitted_at are now frozen here too -- the
  -- draft->submitted edge that legitimately sets them has old.status =
  -- 'draft', so it never reaches this branch at all.
  -- L3: deleted_at is exempted from the freeze when auth.uid() is null (a
  -- service-role/definer-context caller) -- no authenticated actor's
  -- deleted_at write is affected, since no policy ever admitted one.
  if old.status <> 'draft' then
    if new.facility_id is distinct from old.facility_id
      or new.department_id is distinct from old.department_id
      or new.incident_no is distinct from old.incident_no
      or new.report_type is distinct from old.report_type
      or new.occurred_at is distinct from old.occurred_at
      or new.reported_at is distinct from old.reported_at
      or new.created_at is distinct from old.created_at
      or new.submitted_by is distinct from old.submitted_by
      or new.submitted_at is distinct from old.submitted_at
      or (new.deleted_at is distinct from old.deleted_at and auth.uid() is not null)
    then
      raise exception 'incident_reports %: no longer a draft; only status, updated_at, legal_hold, summary, immediate_actions, location_text, severity, and requires_osha_review may change (submitted_by/submitted_at are frozen once left draft).', old.id
        using errcode = 'check_violation';
    end if;

    -- M1 (0048): the amendable content fields may change on a non-draft
    -- incident ONLY via internal.apply_incident_amendment, which sets this
    -- session-local flag inside the same transaction as its own UPDATE. A
    -- plain client UPDATE to these columns is rejected here.
    if (
      new.summary is distinct from old.summary
      or new.immediate_actions is distinct from old.immediate_actions
      or new.location_text is distinct from old.location_text
      or new.severity is distinct from old.severity
      or new.requires_osha_review is distinct from old.requires_osha_review
    ) and coalesce(current_setting('rec.amendment_in_progress', true), 'false') <> 'true' then
      raise exception 'incident_reports %: amendable fields (summary, immediate_actions, location_text, severity, requires_osha_review) may only change via the amendment RPC (internal.apply_incident_amendment) once an incident has left draft.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists incident_reports_transition_guard on incident_reports;
create trigger incident_reports_transition_guard
  before insert or update on incident_reports
  for each row execute function fn_incident_report_transition_guard();

revoke execute on function fn_incident_report_transition_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_incident_report_transition_guard() from anon;
  end if;
end
$$;

notify pgrst, 'reload schema';
