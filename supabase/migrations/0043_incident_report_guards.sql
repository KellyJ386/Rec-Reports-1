-- ===========================================================================
-- 0043_incident_report_guards.sql
-- Slice 1C, S-4 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md). incident_reports
-- has carried its status check constraint (0004) and its transition graph in
-- JS only (src/lib/incidents.mjs's canTransitionIncident / INCIDENT_STATUSES)
-- since IN-02 -- no DB trigger has ever enforced the graph, and no DB trigger
-- has ever audited a submission's lifecycle the way report_submissions has
-- since 0033. This migration closes both gaps and fixes a pre-existing
-- DB/BFF permission mismatch found on the way.
--
-- Per 0042's header: every helper call below is schema-qualified
-- internal.<name>(...) -- the six scope/permission primitives now live in
-- `internal`, never bare/public.-qualified, from this migration forward.
--
-- (a) fn_incident_report_audit(): AFTER INSERT OR UPDATE on incident_reports,
--     mirroring fn_report_submission_audit (0033:115-176) exactly in shape:
--     SECURITY DEFINER + fixed search_path so an incidents.review holder
--     (who does NOT hold admin.manage, the code audit_events' own INSERT
--     policy requires -- 0019) still lands an audit row when they transition
--     a status; this function is deliberately the ONLY thing in this
--     migration that needs definer rights. Writes into the general
--     audit_events table (not incident_audit_events -- matching
--     fn_report_submission_audit's own choice of table for
--     report_submissions), {before, after} envelope shape (0010's
--     fn_audit_admin_change convention), event_type:
--       INSERT                                -> 'incident.created'
--       UPDATE, old.status <> new.status,
--         new.status = 'submitted'            -> 'incident.submitted'
--       UPDATE, old.status <> new.status,
--         new.status <> 'submitted'            -> 'incident.status_changed'
--       UPDATE, old.status = new.status        -> 'incident.updated'
--
-- (b) fn_incident_report_transition_guard(): BEFORE UPDATE on incident_reports,
--     SECURITY DEFINER + fixed search_path (it calls internal.has_permission,
--     which is EXECUTE-restricted to authenticated/service_role, 0042 -- a
--     plain invoker trigger running as an ordinary authenticated caller
--     already has EXECUTE on it via that grant, but definer keeps this
--     function's own privilege posture uniform with (a) and every other
--     security-relevant trigger in this file set). Two independent guards:
--       1. legal_hold may change on ANY update, at any status, but ONLY when
--          the caller holds incidents.legal_hold.manage (IN-02/S-5) -- this
--          is a permission check, not a status-machine edge, so it runs
--          unconditionally rather than being folded into the locked-column
--          list below.
--       2. old.status <> new.status must be a legal edge in the transition
--          graph (verbatim from src/lib/incidents.mjs:90-97's
--          INCIDENT_TRANSITIONS): draft->submitted; submitted->under_review;
--          under_review->escalated|action_pending;
--          escalated->action_pending|closed; action_pending->escalated|closed;
--          closed is terminal. Anything else raises check_violation (23514).
--     Once old.status <> 'draft' (i.e. the incident has left the freely-
--     editable draft period), every column OTHER than the ones below is
--     frozen -- an UPDATE may only ever change:
--       status, submitted_by, submitted_at  -- the guarded transition/submit
--                                               columns (POST .../submit,
--                                               POST .../status,
--                                               incidents-routes.mjs:496,570)
--       updated_at                          -- reserved for a future
--                                               explicit touch; no current
--                                               route sets it on
--                                               incident_reports, but nothing
--                                               here should have to change
--                                               if one starts to
--       legal_hold                          -- gated by guard 1 above
--                                               (PATCH .../legal-hold, S-5)
--       summary, immediate_actions,
--       location_text, severity,
--       requires_osha_review                -- AMENDABLE_INCIDENT_FIELDS
--                                               verbatim (src/lib/incidents.mjs)
--                                               -- the only content fields a
--                                               submitted-or-later incident
--                                               may still have corrected,
--                                               always via
--                                               POST /incidents/:id/amendments
--                                               (incidents-routes.mjs:669).
--     This migration cannot distinguish "the amendment route wrote this" from
--     "some other manage-permitted write touched these same columns" at the
--     database layer, so per the plan's fallback instruction the allow-list
--     simply permits the amendable fields outright once left of draft,
--     documented here rather than attempting a session-local marker.
--     facility_id, department_id, incident_no, report_type, occurred_at,
--     reported_at, created_at, and deleted_at may never change once an
--     incident has left draft.
--
-- (c) DB/BFF mismatch #1: incident_audit_events' INSERT policy (0010:100-102,
--     re-asserted 0038:486-491) has required incidents.manage since it was
--     first written, but incidents-routes.mjs's review/close transitions
--     (POST /incidents/:id/status, guarded by incidents.review inside
--     canTransitionIncident) insert an incident_audit_events row themselves
--     (:578-591) as the CALLER's own RLS-scoped client -- an incidents.review
--     holder with no incidents.manage would have that insert rejected by RLS
--     today. Widened to incidents.manage OR incidents.review.
--
-- (d) DB/BFF mismatch #2, found while verifying (c): incident_reports itself
--     has carried exactly one write policy since 0004 ("incident managers can
--     manage reports", latest at 0038:264-271), a single `for all` gated on
--     incidents.manage alone. But canTransitionIncident (src/lib/incidents.mjs)
--     requires only incidents.review -- not incidents.manage -- for every
--     transition past the initial draft->submitted step (POST
--     /incidents/:id/status), and the amendments route
--     (incidents-routes.mjs:690, POST /incidents/:id/amendments) already
--     documents accepting incidents.manage OR incidents.review while flagging
--     that "a review-only actor's UPDATE would in fact be rejected at the
--     database layer today" -- this is that flagged gap, closed here.
--     ADDITIVE, not a replacement: the existing "for all"/incidents.manage
--     policy is left completely untouched (still covers SELECT/INSERT/
--     UPDATE/DELETE under incidents.manage exactly as before -- including the
--     RETURNING-clause SELECT check Postgres runs on every INSERT/UPDATE,
--     which a narrower UPDATE-only replacement would have silently dropped
--     for any incidents.manage holder who does not separately hold
--     incidents.read, an actor shape supabase/tests/rls_audit_hardening.sql
--     turned out to already exercise). A second, permissive UPDATE-only
--     policy is added for incidents.review alone; Postgres OR's multiple
--     permissive policies for the same command together, so this only ever
--     widens who may UPDATE, never narrows the existing grant.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) fn_incident_report_audit()
-- ---------------------------------------------------------------------------
create or replace function fn_incident_report_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_type text;
  v_before jsonb;
  v_after jsonb;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'incident.created';
    v_before := null;
    v_after := to_jsonb(new);
  else
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
    if old.status is distinct from new.status then
      v_event_type := case when new.status = 'submitted' then 'incident.submitted' else 'incident.status_changed' end;
    else
      v_event_type := 'incident.updated';
    end if;
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not exists (select 1 from app_users where id = v_actor) then
    v_actor := null;
  end if;

  insert into audit_events (
    facility_id, actor_user_id, event_type, entity_table, entity_id, event_payload
  ) values (
    new.facility_id,
    v_actor,
    v_event_type,
    'incident_reports',
    new.id,
    jsonb_build_object('before', v_before, 'after', v_after)
  );

  return new;
end;
$$;

drop trigger if exists incident_reports_audit on incident_reports;
create trigger incident_reports_audit
  after insert or update on incident_reports
  for each row execute function fn_incident_report_audit();

revoke execute on function fn_incident_report_audit() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_incident_report_audit() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (b) fn_incident_report_transition_guard()
-- ---------------------------------------------------------------------------
create or replace function fn_incident_report_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard 1: legal_hold is a permission-gated field, independent of status.
  if new.legal_hold is distinct from old.legal_hold then
    if not internal.has_permission(auth.uid(), new.facility_id, 'incidents.legal_hold.manage') then
      raise exception 'incident_reports %: legal_hold may only be changed by an actor holding incidents.legal_hold.manage.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 2: the status transition graph (src/lib/incidents.mjs:90-97).
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

  -- Guard 3: once an incident has left draft, only the columns documented
  -- in this migration's header comment may still change.
  if old.status <> 'draft' then
    if new.facility_id is distinct from old.facility_id
      or new.department_id is distinct from old.department_id
      or new.incident_no is distinct from old.incident_no
      or new.report_type is distinct from old.report_type
      or new.occurred_at is distinct from old.occurred_at
      or new.reported_at is distinct from old.reported_at
      or new.created_at is distinct from old.created_at
      or new.deleted_at is distinct from old.deleted_at
    then
      raise exception 'incident_reports %: no longer a draft; only status, submitted_by, submitted_at, updated_at, legal_hold, summary, immediate_actions, location_text, severity, and requires_osha_review may change.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists incident_reports_transition_guard on incident_reports;
create trigger incident_reports_transition_guard
  before update on incident_reports
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
-- (c) incident_audit_events INSERT: widen incidents.manage -> incidents.manage
-- OR incidents.review, matching every transition route's actual actor set.
-- fn_assert_same_facility carried over verbatim from 0038:486-491.
-- ---------------------------------------------------------------------------
drop policy if exists "incident managers can write incident audit" on incident_audit_events;
create policy "incident managers can write incident audit" on incident_audit_events
  for insert
  with check (
    (
      internal.has_permission(auth.uid(), facility_id, 'incidents.manage')
      or internal.has_permission(auth.uid(), facility_id, 'incidents.review')
    )
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

-- ---------------------------------------------------------------------------
-- (d) incident_reports: ADD a permissive UPDATE-only policy for
-- incidents.review, alongside (not replacing) the existing "incident
-- managers can manage reports" `for all` policy (0038:264-271, untouched).
-- fn_assert_same_facility on department_id mirrors that policy's own
-- WITH CHECK verbatim.
-- ---------------------------------------------------------------------------
drop policy if exists "incident reviewers can update reports" on incident_reports;
create policy "incident reviewers can update reports" on incident_reports
  for update
  using (internal.has_permission(auth.uid(), facility_id, 'incidents.review') and deleted_at is null)
  with check (
    internal.has_permission(auth.uid(), facility_id, 'incidents.review')
    and internal.fn_assert_same_facility(facility_id, 'departments', department_id)
  );
