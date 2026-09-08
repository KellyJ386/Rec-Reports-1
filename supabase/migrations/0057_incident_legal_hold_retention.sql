-- ===========================================================================
-- 0057_incident_legal_hold_retention.sql
-- Wave 3, Slice 3B, IN-16 (plans/INCIDENTS_PLAN.md / WAVES_1_4_IMPLEMENTATION_
-- PLAN.md). PATCH /incidents/:id/legal-hold and the transition-guard
-- permission check that backs it already shipped in Wave 1 (0043's guard 1,
-- 0048's H3/M2 fixes) -- "legal-hold toggle, audited" is done. What is
-- missing, closed here, is the DELETE side of the design's promise ("Legal
-- hold flag blocks purge/archive jobs", INCIDENT_ACCIDENT_REPORTING_SYSTEM.md
-- §4.7): a soft-delete of a held-or-protected incident_reports row, and a
-- hard/soft delete of its children, was never actually rejected end to end.
--
-- (a) incident_reports gap: 0048's guard 3 (fn_incident_report_transition_
--     guard) already freezes deleted_at for every authenticated actor once
--     old.status <> 'draft' -- so submitted/under_review/escalated/
--     action_pending/closed are ALL already covered (a strict superset of
--     this task's "submitted, under_review, closed" list). The one gap left
--     open: legal_hold can be set true on a still-DRAFT incident (guard 1
--     runs independently of status), and guard 3 never engages for
--     old.status = 'draft', so a draft incident already on legal hold could
--     still be soft-deleted by any incidents.manage/review holder. New
--     Guard 0 below closes exactly that gap; the function is otherwise
--     carried over verbatim from 0048 (every migration touching it recreates
--     the whole body per this file set's own convention).
--
-- (b) Children: incident_people, incident_attachments, incident_witness_
--     statements, incident_amendments -- audited from their own migrations
--     forward (0004, 0038, 0050, 0032):
--       * incident_amendments: DELETE is already unconditionally rejected,
--         held or not (fn_block_audit_mutation, 0032(b), a BEFORE trigger
--         that fires for every role including the table owner -- RLS
--         bypass never skips a trigger). Already satisfies "no delete while
--         held" (a strictly stronger guarantee: no delete ever). Untouched.
--       * incident_witness_statements: hard DELETE is already unconditionally
--         rejected (fn_incident_witness_statement_guard, 0050(c)). Its own
--         soft-delete path (an UPDATE setting deleted_at, null -> non-null,
--         "in reserve" per 0050's header -- no route uses it yet) carried no
--         legal-hold/status check at all. Closed below with an ADDITIONAL
--         BEFORE UPDATE trigger (fn_incident_child_legal_hold_guard), left
--         to coexist with the existing guard trigger rather than folding
--         into it, so that trigger's own hard-won column-freeze logic is
--         never touched by this migration.
--       * incident_people: no DELETE policy actually admits a hard DELETE
--         attempt today under normal use (incidents-people-routes.mjs's
--         DELETE route is a soft-delete pgUpdate, per that file's own
--         comment) -- but incident_people's write policy is still a `for
--         all` grant (0038), which DOES admit a real SQL DELETE at the RLS
--         layer for any incidents.manage holder reaching PostgREST directly.
--         Both paths -- the real hard DELETE this leaves reachable, and the
--         soft-delete UPDATE the route actually uses -- get the same new
--         guard trigger (BEFORE DELETE, and BEFORE UPDATE OF deleted_at).
--       * incident_attachments: identical shape to incident_people -- a
--         `for all`/incidents.manage policy (0038) admits both a hard DELETE
--         (unreachable from any route today, but not from raw PostgREST) and
--         a soft-delete UPDATE (also unreachable from any route today -- no
--         attachment removal route exists yet -- but the deleted_at column
--         and the `... where deleted_at is null` read-side convention are
--         already there, so this is forward-looking in exactly the same
--         sense 0048's L3 was for incident_reports.deleted_at). Both guarded
--         the same way as incident_people.
--
--     fn_incident_child_legal_hold_guard(): one generic SECURITY DEFINER
--     function (TG_TABLE_NAME-driven, matching 0041's
--     fn_attachment_path_facility precedent for a function shared across
--     several child tables) rejects the triggering DELETE/UPDATE whenever
--     the parent incident_reports row (looked up by incident_id, bypassing
--     RLS the way every definer function here does) has legal_hold = true.
--     Deliberately legal_hold ALONE, not also gated on the parent's status
--     the way incident_reports' own guard 3 is for itself: the task's
--     literal condition for children is "no delete while the parent is
--     held" (legal_hold only), and supabase/tests/incident_people_
--     statements.sql already exercises -- as INTENDED, currently-shipped
--     behavior -- an incidents.review holder soft-deleting a person from a
--     SUBMITTED (non-draft, unheld) incident (test 8c). A status-based
--     freeze on the children, mirroring incident_reports' own guard 3,
--     would have silently broken that shipped capability; legal_hold is the
--     one condition this task actually asks for on the children, and the
--     one that does not regress it. Exempted when auth.uid() is null (the
--     same service-role/definer-context carve-out 0048's L3 established for
--     incident_reports.deleted_at) -- a future retention/purge job (Wave 4
--     IN-25) must still be able to remove a row once its hold is actually
--     lifted; that job runs service-role, never as an RLS-subject
--     authenticated actor, so it never reaches this guard at all.
--
-- (c) Retention config: three settings-registry keys added to the incidents
--     module block (contiguous, per scripts/gen-settings-check.mjs), plus a
--     pure retentionEligibleAt(incident, config) in src/lib/incidents.mjs
--     (see that file's own diff -- no schema is needed for a value that is
--     computed on read and never stored; retention/purge itself is Wave 4
--     IN-25, out of this migration's scope entirely, matching this plan
--     row's own "never purges anything" acceptance line).
--
-- Every helper call below is schema-qualified internal.<name>(...) per
-- 0042's mandate for every migration >= 0043 (this migration calls none of
-- the five internal.* scope/permission helpers directly -- both new guards
-- are pure data checks against incident_reports.legal_hold/status, not
-- permission checks -- so there is nothing to schema-qualify here, but the
-- note is kept for the same reason every migration in this range keeps it:
-- scripts/verify-migrations.mjs's bare-call scan covers this file too).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) fn_incident_report_transition_guard -- recreated whole (0048's body,
-- verbatim, plus 0056's Guard 2.5 closure gate) with new Guard 0 inserted right after the INSERT branch returns,
-- ahead of every other UPDATE-only guard.
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
  -- Guard 4 (H1, security review, Wave 3 Slice 3B): a hard DELETE of
  -- incident_reports was previously admitted straight through by the
  -- FOR ALL "incident managers can manage reports" policy (0004/0026/0038)
  -- with NO before-delete guard at all -- so a legally-held incident (and,
  -- via ON DELETE CASCADE, every one of its 10 child-table FKs) could be
  -- permanently destroyed by any incidents.manage holder, defeating every
  -- guarantee this migration's OWN Guard 0/fn_incident_child_legal_hold_guard
  -- claim to provide. Rejects the DELETE outright when the row being
  -- removed is under legal hold, or (matching guard 3's own posture below)
  -- has left draft -- a submitted-or-later incident's evidentiary record
  -- must go through a status transition, never a hard delete. Exempted when
  -- auth.uid() is null (the same service-role/definer-context carve-out
  -- every other guard in this function uses): a future retention/purge job
  -- (Wave 4 IN-25) must still be able to hard-delete a row once its hold is
  -- lifted and its retention window has passed. Checked BEFORE the INSERT
  -- branch (mutually exclusive tg_op values, so ordering has no functional
  -- effect -- placed first only because a DELETE has no `new` row to reason
  -- about, mirroring how the INSERT branch below has no `old` row).
  if tg_op = 'DELETE' then
    if auth.uid() is not null then
      if old.legal_hold is true then
        raise exception 'incident_reports %: an incident under legal hold may not be deleted.', old.id
          using errcode = 'check_violation';
      end if;
      if old.status <> 'draft' then
        raise exception 'incident_reports %: no longer a draft; may not be deleted (use a status transition instead).', old.id
          using errcode = 'check_violation';
      end if;
    end if;
    return old;
  end if;

  -- M2 (0048): BEFORE INSERT branch -- legal_hold may only be created true by
  -- an actor holding incidents.legal_hold.manage. No OLD row exists yet, so
  -- none of the UPDATE-only guards below (including the new Guard 0) apply.
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

  -- Guard 0 (0057, IN-16): a soft-delete (setting deleted_at) is rejected for
  -- any authenticated actor when the incident is under legal hold, REGARDLESS
  -- of status. This is the one gap 0048's L3/guard-3 freeze left open: guard
  -- 3 below only ever engages once old.status <> 'draft', but legal_hold can
  -- be set true on a still-draft incident (guard 1 below runs independently
  -- of status) -- without this guard a draft incident already on legal hold
  -- could still be soft-deleted by any incidents.manage/review holder.
  -- Checked against OLD.legal_hold specifically (the hold state as it stood
  -- BEFORE this UPDATE), so a single statement cannot smuggle a delete
  -- through by simultaneously clearing legal_hold and setting deleted_at in
  -- the same UPDATE -- the same "decide off the prior state" posture L2
  -- already uses for submitted_by/submitted_at below. Exempted when
  -- auth.uid() is null (L3's own service-role/definer-context exemption,
  -- carried forward identically): a future retention/purge job (Wave 4
  -- IN-25) must still be able to soft-delete a row once its hold is actually
  -- lifted and its retention window has passed; that job runs service-role,
  -- not as an RLS-subject authenticated actor, so this guard never sees it.
  if new.deleted_at is distinct from old.deleted_at and auth.uid() is not null then
    if old.legal_hold is true then
      raise exception 'incident_reports %: an incident under legal hold may not be soft-deleted.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 1: legal_hold is a permission-gated field, independent of status.
  if new.legal_hold is distinct from old.legal_hold then
    if not internal.has_permission(auth.uid(), new.facility_id, 'incidents.legal_hold.manage') then
      raise exception 'incident_reports %: legal_hold may only be changed by an actor holding incidents.legal_hold.manage.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 1b (H3, 0048): the incidents.legal_hold.manage UPDATE policy admits
  -- an actor who holds ONLY that code -- neither incidents.manage nor
  -- incidents.review. Without this, that RLS grant would double as a side
  -- channel into editing or transitioning the rest of the row. Such an actor
  -- may change legal_hold and updated_at only. Gated on auth.uid() is not
  -- null (L3): a service-role/definer-context caller (auth.uid() is null)
  -- never reaches incident_reports through any RLS policy at all -- it
  -- bypasses RLS entirely -- so this guard's own concern (an RLS-admitted-but
  -- -narrow actor exceeding their column scope) does not apply to it;
  -- leaving it ungated here would otherwise also override L3's own
  -- deleted_at exemption in guard 3 below for no reason.
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

  -- Guard 2.5 (0056, IN-13/IN-15; carried forward here because this
  -- migration recreates the whole function -- the last definition wins): closing a high/critical incident requires
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
  -- legal_hold, and the amendable content fields may still change. L2:
  -- submitted_by/submitted_at are frozen here too. L3: deleted_at is
  -- exempted from the freeze when auth.uid() is null (a service-role/
  -- definer-context caller) -- already covers submitted/under_review/
  -- escalated/action_pending/closed for every authenticated actor, a
  -- superset of this task's "submitted, under_review, closed" list.
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
    -- session-local flag inside the same transaction as its own UPDATE.
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

-- H1: "or delete" added to the trigger event list so Guard 4 above actually
-- fires -- a trigger registered only "before insert or update" never sees a
-- DELETE statement at all, regardless of what the function body checks.
drop trigger if exists incident_reports_transition_guard on incident_reports;
create trigger incident_reports_transition_guard
  before insert or update or delete on incident_reports
  for each row execute function fn_incident_report_transition_guard();

revoke execute on function fn_incident_report_transition_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_incident_report_transition_guard() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (b) fn_incident_child_legal_hold_guard(): generic BEFORE DELETE / BEFORE
-- UPDATE OF deleted_at / BEFORE UPDATE OF incident_id guard shared by
-- incident_people, incident_attachments, incident_witness_statements,
-- incident_followup_actions and incident_escalations (see this file's header
-- for why incident_amendments needs nothing further). The incident_id arm
-- (security re-verification, NEW-2): re-pointing a child row at another
-- incident removes it from the held case exactly as a delete would -- every
-- consumer filters by incident_id -- so a move is rejected when EITHER the
-- old or the new parent is held (or cannot be found). SECURITY DEFINER + fixed
-- search_path so the incident_reports lookup below resolves regardless of
-- which role fires the trigger and always bypasses that table's own RLS
-- (matching 0041's fn_attachment_path_facility and every other definer
-- trigger in this file set). legal_hold ONLY -- see this file's header for
-- why a parent-status check (mirroring incident_reports' own guard 3) is
-- deliberately NOT applied to the children.
-- ---------------------------------------------------------------------------
create or replace function fn_incident_child_legal_hold_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident_id uuid;
  v_row_id uuid;
  v_legal_hold boolean;
begin
  -- Service-role/definer-context exemption (matches 0048's L3 precedent for
  -- incident_reports.deleted_at): a future retention/purge job (Wave 4
  -- IN-25) runs service-role, bypassing RLS -- and this trigger -- entirely
  -- for most operations, but a trigger still fires for every role including
  -- the table owner, so the exemption is made explicit here rather than
  -- relying on RLS bypass alone.
  if auth.uid() is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  v_row_id := coalesce(new.id, old.id);

  -- NEW-2 (security re-verification): a re-point is checked against BOTH
  -- parents. The old parent is checked here; the new parent falls through
  -- to the ordinary lookup below (coalesce picks new.incident_id).
  if tg_op = 'UPDATE' and new.incident_id is distinct from old.incident_id then
    select legal_hold into v_legal_hold
      from incident_reports
      where id = old.incident_id;
    if not found or v_legal_hold is true then
      raise exception '% %: parent incident % is under legal hold or could not be found; moving the row to another incident is rejected.', tg_table_name, v_row_id, old.incident_id
        using errcode = 'check_violation';
    end if;
  end if;

  v_incident_id := coalesce(new.incident_id, old.incident_id);

  select legal_hold into v_legal_hold
    from incident_reports
    where id = v_incident_id;

  -- H1 (security review): fail CLOSED when the parent row cannot be found,
  -- rather than letting a NULL lookup read as "not held" and pass the
  -- delete through. This is exactly the gap the review's reproduction
  -- exploited: ON DELETE CASCADE's system-generated trigger removes the
  -- parent row (and fires this AFTER as part of the SAME statement) before
  -- cascading to the child rows referencing it, so by the time THIS
  -- trigger's own SELECT above runs, `select ... where id = v_incident_id`
  -- already returns no rows regardless of whether the parent was ever
  -- held -- `v_legal_hold is true` was therefore always false on that path,
  -- silently admitting the cascade-driven child delete no matter what.
  -- `not found` (set by the SELECT INTO immediately above) catches that
  -- case directly, independent of -- and even if some future change ever
  -- weakens or removes -- Guard 4's own top-level DELETE block on
  -- incident_reports itself.
  if not found or v_legal_hold is true then
    raise exception '% %: parent incident % is under legal hold or could not be found; delete is rejected.', tg_table_name, v_row_id, v_incident_id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function fn_incident_child_legal_hold_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_incident_child_legal_hold_guard() from anon;
  end if;
end
$$;

-- incident_people: guard both the real hard DELETE the `for all`/
-- incidents.manage policy (0038) still structurally admits, and the
-- soft-delete UPDATE the actual route (incidents-people-routes.mjs) uses.
drop trigger if exists incident_people_legal_hold_delete_guard on incident_people;
create trigger incident_people_legal_hold_delete_guard
  before delete on incident_people
  for each row execute function fn_incident_child_legal_hold_guard();

drop trigger if exists incident_people_legal_hold_soft_delete_guard on incident_people;
create trigger incident_people_legal_hold_soft_delete_guard
  before update on incident_people
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function fn_incident_child_legal_hold_guard();
drop trigger if exists incident_people_legal_hold_repoint_guard on incident_people;
create trigger incident_people_legal_hold_repoint_guard
  before update of incident_id on incident_people
  for each row
  when (new.incident_id is distinct from old.incident_id)
  execute function fn_incident_child_legal_hold_guard();

-- incident_attachments: same shape as incident_people (forward-looking for
-- the soft-delete side -- no attachment-removal route exists yet, matching
-- 0048's L3 precedent for incident_reports.deleted_at).
drop trigger if exists incident_attachments_legal_hold_delete_guard on incident_attachments;
create trigger incident_attachments_legal_hold_delete_guard
  before delete on incident_attachments
  for each row execute function fn_incident_child_legal_hold_guard();

drop trigger if exists incident_attachments_legal_hold_soft_delete_guard on incident_attachments;
create trigger incident_attachments_legal_hold_soft_delete_guard
  before update on incident_attachments
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function fn_incident_child_legal_hold_guard();
drop trigger if exists incident_attachments_legal_hold_repoint_guard on incident_attachments;
create trigger incident_attachments_legal_hold_repoint_guard
  before update of incident_id on incident_attachments
  for each row
  when (new.incident_id is distinct from old.incident_id)
  execute function fn_incident_child_legal_hold_guard();

-- incident_witness_statements: hard DELETE is already unconditionally
-- rejected by fn_incident_witness_statement_guard (0050); this ADDS a
-- second BEFORE UPDATE trigger (coexisting with, not replacing, that guard)
-- that only fires when deleted_at is actually changing, guarding the
-- one-time soft-delete path that guard never checked against legal_hold.
drop trigger if exists incident_witness_statements_legal_hold_guard on incident_witness_statements;
create trigger incident_witness_statements_legal_hold_guard
  before update on incident_witness_statements
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function fn_incident_child_legal_hold_guard();
drop trigger if exists incident_witness_statements_legal_hold_repoint_guard on incident_witness_statements;
create trigger incident_witness_statements_legal_hold_repoint_guard
  before update of incident_id on incident_witness_statements
  for each row
  when (new.incident_id is distinct from old.incident_id)
  execute function fn_incident_child_legal_hold_guard();

-- incident_followup_actions / incident_escalations (H2, security review):
-- 0057's original matrix covered incident_people/incident_attachments/
-- incident_witness_statements/incident_amendments but left these two out --
-- both carry the identical `for all`/incidents.manage FOR ALL policy shape
-- as incident_people/incident_attachments (0004/0038), which structurally
-- admits a real hard DELETE, and both already carry a deleted_at column
-- (0004) admitting a soft-delete UPDATE. They are also two of the packet's
-- own rendered sections ("Follow-Up Actions", "Escalation History") --
-- first-class case evidence, not incidental rows -- so a held case's
-- corrective-action record and escalation chain were erasable by any
-- incidents.manage holder even though every other child table in this
-- matrix was already protected. Guarded identically to incident_people/
-- incident_attachments above: the same generic fn_incident_child_legal_hold_
-- guard, both a BEFORE DELETE and a BEFORE UPDATE OF deleted_at trigger.
drop trigger if exists incident_followup_actions_legal_hold_delete_guard on incident_followup_actions;
create trigger incident_followup_actions_legal_hold_delete_guard
  before delete on incident_followup_actions
  for each row execute function fn_incident_child_legal_hold_guard();

drop trigger if exists incident_followup_actions_legal_hold_soft_delete_guard on incident_followup_actions;
create trigger incident_followup_actions_legal_hold_soft_delete_guard
  before update on incident_followup_actions
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function fn_incident_child_legal_hold_guard();
drop trigger if exists incident_followup_actions_legal_hold_repoint_guard on incident_followup_actions;
create trigger incident_followup_actions_legal_hold_repoint_guard
  before update of incident_id on incident_followup_actions
  for each row
  when (new.incident_id is distinct from old.incident_id)
  execute function fn_incident_child_legal_hold_guard();

drop trigger if exists incident_escalations_legal_hold_delete_guard on incident_escalations;
create trigger incident_escalations_legal_hold_delete_guard
  before delete on incident_escalations
  for each row execute function fn_incident_child_legal_hold_guard();

drop trigger if exists incident_escalations_legal_hold_soft_delete_guard on incident_escalations;
create trigger incident_escalations_legal_hold_soft_delete_guard
  before update on incident_escalations
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function fn_incident_child_legal_hold_guard();
drop trigger if exists incident_escalations_legal_hold_repoint_guard on incident_escalations;
create trigger incident_escalations_legal_hold_repoint_guard
  before update of incident_id on incident_escalations
  for each row
  when (new.incident_id is distinct from old.incident_id)
  execute function fn_incident_child_legal_hold_guard();

-- incident_amendments: deliberately untouched -- fn_block_audit_mutation
-- (0032(b)) already rejects every DELETE unconditionally, held or not, and
-- the table carries no deleted_at column for a soft-delete path to exist.
