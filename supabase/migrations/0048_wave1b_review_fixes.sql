-- ===========================================================================
-- 0048_wave1b_review_fixes.sql
-- Fixes for the Opus security review of the wave1-security..wave1-security-b
-- diff (H1-H4, M1-M5, L1-L5; see the review doc for full findings and
-- reproductions). 0043-0047 are left completely untouched -- every policy
-- and function this migration changes is dropped/recreated here, exactly
-- like every migration since 0009 requires. Every helper call below is
-- schema-qualified internal.<name>(...) per 0042's mandate for >= 0043.
--
-- H1: report_template_versions' INSERT policy had no is_published predicate
--     -- a reports.template.manage-only actor could INSERT an
--     already-published version, bypassing the UPDATE-side split 0044 added.
-- H2: incident_audit_events' INSERT policy (0043) only admitted
--     incidents.manage/review, but 0044 widened incident_escalations/
--     incident_followup_actions' own INSERT policies (and the matching HTTP
--     routes) to incidents.escalate/incidents.tasks.create -- an actor
--     holding only one of those got a committed child row and then a 500 on
--     the audit write. Widened to the full set of codes whose routes write
--     incident_audit_events (also folds in incidents.legal_hold.manage,
--     H3's new UPDATE policy, and incidents.export.pdf, already documented
--     as covered by 0044's header but never actually added to this policy).
-- H3: incidents.legal_hold.manage had a working transition-guard permission
--     check (0043) but no matching incident_reports UPDATE policy -- RLS
--     filtered a legal_hold.manage-only actor's UPDATE to zero rows before
--     the guard trigger ever got a say. Adds the missing additive UPDATE
--     policy, and restricts such an actor (guard 1b below) to changing only
--     legal_hold/updated_at -- the new policy must not become a side
--     channel into every other column.
-- H4: fn_incident_report_audit copied the ENTIRE incident_reports row
--     (summary, immediate_actions -- the injury narrative) into
--     audit_events, whose SELECT policy is admin.manage-only -- a strictly
--     different, and disjoint, permission from incidents.read. Replaced
--     with an allow-list payload: ids, status/severity before+after,
--     requires_osha_review, legal_hold, and the changed COLUMN NAMES only.
-- M1: "amendable" fields (summary, immediate_actions, location_text,
--     severity, requires_osha_review) stayed writable by a plain UPDATE on
--     a non-draft incident_reports row -- the amendment route's own
--     pgUpdate was doing exactly this, so nothing distinguished "wrote it
--     through the amendment flow" from "some other manage/review-permitted
--     write touched the same columns". Closed by blocking those columns'
--     change on a non-draft row unless a session-local flag
--     (rec.amendment_in_progress) is set, and adding
--     internal.apply_incident_amendment -- a SECURITY DEFINER RPC that sets
--     that flag, re-checks incidents.manage/review itself (it bypasses RLS
--     the way every definer function in this codebase does), and performs
--     the incident_reports UPDATE + incident_amendments INSERT atomically.
--     incidents-routes.mjs's amendment route now calls this RPC instead of
--     two separate REST writes.
-- M2: legal_hold could be set true at INSERT time by a plain
--     incidents.manage holder (the transition guard only ran BEFORE
--     UPDATE) -- a one-way lock, since closing a legal-held incident
--     requires incidents.legal_hold.manage and nothing could ever clear a
--     hold nobody meant to set. The guard now also runs BEFORE INSERT.
-- M3: message_audiences allowed audience_ref_id IS NULL unconditionally,
--     including for audience_type = 'employee' -- 0047's header claimed
--     this was inert, but communications.mjs's audienceRefId() actually
--     fell back to the audience row's OWN id in that case, making the
--     audience row itself a bogus "recipient". Both fixed: the DB now
--     rejects a null ref for 'employee' specifically (policy + trigger),
--     and communications.mjs's fallback bug is fixed independently (see
--     that file's own diff).
-- L2: submitted_by/submitted_at stayed on guard 3's non-draft allow-list,
--     so any incidents.manage/review holder could reassign submission
--     attribution after the fact. Frozen once left draft (the
--     draft->submitted edge that legitimately sets them never reaches
--     guard 3 at all, since it requires old.status = 'draft').
-- L3: guard 3's deleted_at freeze had no exemption for a service-role/
--     definer-context caller (auth.uid() is null there) -- forward-looking
--     (no route soft-deletes incident_reports today), but a future
--     retention/erasure job would otherwise be unable to. Exempted when
--     auth.uid() is null; no authenticated actor's deleted_at write is
--     affected (RLS already forbade that column's client mutation).
-- M4/M5/L1/L5 are JS-only fixes (scripts/server.mjs, auth-routes.mjs,
-- durable-rate-limit.mjs, supabase-rest.mjs) -- no schema change here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- H1: report_template_versions INSERT -- add the same is_published predicate
-- 0044 added to the UPDATE policy. template.manage alone still covers every
-- draft insert (is_published = false); flipping it true at INSERT time now
-- requires reports.publish too, closing the split's INSERT-side bypass.
-- ---------------------------------------------------------------------------
drop policy if exists "template managers can insert report template versions" on report_template_versions;
create policy "template managers can insert report template versions" on report_template_versions
  for insert
  with check (
    internal.has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and internal.fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and (
      is_published = false
      or internal.has_permission(auth.uid(), facility_id, 'reports.publish')
    )
  );

-- ---------------------------------------------------------------------------
-- H2: incident_audit_events INSERT -- widen to every permission code whose
-- route writes this table (incidents-routes.mjs): manage, review (0043),
-- escalate, tasks.create (0044's widened child-table writers), plus
-- legal_hold.manage (H3, this migration) and export.pdf (documented by
-- 0044's header as covered here, but never actually added).
-- ---------------------------------------------------------------------------
drop policy if exists "incident managers can write incident audit" on incident_audit_events;
create policy "incident managers can write incident audit" on incident_audit_events
  for insert
  with check (
    (
      internal.has_permission(auth.uid(), facility_id, 'incidents.manage')
      or internal.has_permission(auth.uid(), facility_id, 'incidents.review')
      or internal.has_permission(auth.uid(), facility_id, 'incidents.escalate')
      or internal.has_permission(auth.uid(), facility_id, 'incidents.tasks.create')
      or internal.has_permission(auth.uid(), facility_id, 'incidents.legal_hold.manage')
      or internal.has_permission(auth.uid(), facility_id, 'incidents.export.pdf')
    )
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

-- ---------------------------------------------------------------------------
-- H3: incident_reports -- ADD a permissive UPDATE-only policy for
-- incidents.legal_hold.manage, alongside (not replacing) the existing
-- incidents.manage `for all` (0038) and incidents.review UPDATE (0043)
-- policies. fn_assert_same_facility on department_id mirrors both of those
-- policies' own WITH CHECK verbatim. The transition guard (recreated below)
-- is what actually restricts a legal_hold.manage-only actor to changing
-- only legal_hold/updated_at -- RLS policies alone cannot express a
-- column-level restriction.
-- ---------------------------------------------------------------------------
drop policy if exists "incident legal hold managers can update reports" on incident_reports;
create policy "incident legal hold managers can update reports" on incident_reports
  for update
  using (internal.has_permission(auth.uid(), facility_id, 'incidents.legal_hold.manage') and deleted_at is null)
  with check (
    internal.has_permission(auth.uid(), facility_id, 'incidents.legal_hold.manage')
    and internal.fn_assert_same_facility(facility_id, 'departments', department_id)
  );

-- ---------------------------------------------------------------------------
-- H4: fn_incident_report_audit -- replace the full before/after row dump
-- with an allow-list payload. Never summary/immediate_actions/location_text
-- (the injury narrative) or incident_people content -- audit_events' SELECT
-- policy is admin.manage-only, a permission disjoint from incidents.read.
-- ---------------------------------------------------------------------------
create or replace function fn_incident_report_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_type text;
  v_actor uuid;
  v_changed_columns text[] := array[]::text[];
  v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'incident.created';
  else
    if old.status is distinct from new.status then
      v_event_type := case when new.status = 'submitted' then 'incident.submitted' else 'incident.status_changed' end;
    else
      v_event_type := 'incident.updated';
    end if;

    -- H4: the list of changed column NAMES only -- never their content.
    if new.status is distinct from old.status then v_changed_columns := array_append(v_changed_columns, 'status'); end if;
    if new.severity is distinct from old.severity then v_changed_columns := array_append(v_changed_columns, 'severity'); end if;
    if new.summary is distinct from old.summary then v_changed_columns := array_append(v_changed_columns, 'summary'); end if;
    if new.immediate_actions is distinct from old.immediate_actions then v_changed_columns := array_append(v_changed_columns, 'immediate_actions'); end if;
    if new.location_text is distinct from old.location_text then v_changed_columns := array_append(v_changed_columns, 'location_text'); end if;
    if new.requires_osha_review is distinct from old.requires_osha_review then v_changed_columns := array_append(v_changed_columns, 'requires_osha_review'); end if;
    if new.legal_hold is distinct from old.legal_hold then v_changed_columns := array_append(v_changed_columns, 'legal_hold'); end if;
    if new.submitted_by is distinct from old.submitted_by then v_changed_columns := array_append(v_changed_columns, 'submitted_by'); end if;
    if new.submitted_at is distinct from old.submitted_at then v_changed_columns := array_append(v_changed_columns, 'submitted_at'); end if;
    if new.department_id is distinct from old.department_id then v_changed_columns := array_append(v_changed_columns, 'department_id'); end if;
    if new.deleted_at is distinct from old.deleted_at then v_changed_columns := array_append(v_changed_columns, 'deleted_at'); end if;
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not exists (select 1 from app_users where id = v_actor) then
    v_actor := null;
  end if;

  -- H4: allow-list only. status/severity before+after, the current
  -- requires_osha_review/legal_hold, and the changed-column-name list are
  -- everything the audit trail (and admin.manage readers, who hold no
  -- incidents.read) legitimately need; the free-text narrative and any
  -- incident_people content never enter audit_events at all.
  v_payload := jsonb_build_object(
    'incident_id', new.id,
    'facility_id', new.facility_id,
    'status_before', case when tg_op = 'UPDATE' then old.status else null end,
    'status_after', new.status,
    'severity_before', case when tg_op = 'UPDATE' then old.severity else null end,
    'severity_after', new.severity,
    'requires_osha_review', new.requires_osha_review,
    'legal_hold', new.legal_hold,
    'changed_columns', to_jsonb(v_changed_columns)
  );

  insert into audit_events (
    facility_id, actor_user_id, event_type, entity_table, entity_id, event_payload
  ) values (
    new.facility_id,
    v_actor,
    v_event_type,
    'incident_reports',
    new.id,
    v_payload
  );

  return new;
end;
$$;

-- Trigger/grants unchanged from 0043 (CREATE OR REPLACE above preserves the
-- function's OID, so the existing trigger binding is untouched); re-asserted
-- here only for idempotent re-runnability.
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
-- fn_incident_report_transition_guard -- recreated whole to fold in H3
-- (guard 1b), M1 (amendable-field session-flag guard), M2 (BEFORE INSERT),
-- L2 (submitted_by/submitted_at frozen once left draft), and L3 (deleted_at
-- exempted for a null-auth.uid() caller). Guard 2 (the transition graph) is
-- carried over verbatim from 0043.
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
  -- M2: BEFORE INSERT branch -- legal_hold may only be created true by an
  -- actor holding incidents.legal_hold.manage. No OLD row exists yet, so
  -- none of the UPDATE-only guards below apply.
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

  -- Guard 1b (H3): the new incidents.legal_hold.manage UPDATE policy (this
  -- migration) admits an actor who holds ONLY that code -- neither
  -- incidents.manage nor incidents.review. Without this, that RLS grant
  -- would double as a side channel into editing or transitioning the rest
  -- of the row. Such an actor may change legal_hold and updated_at only.
  -- Gated on auth.uid() is not null (L3): a service-role/definer-context
  -- caller (auth.uid() is null) never reaches incident_reports through any
  -- RLS policy at all -- it bypasses RLS entirely -- so this guard's own
  -- concern (an RLS-admitted-but-narrow actor exceeding their column scope)
  -- does not apply to it; leaving it ungated here would otherwise also
  -- override L3's own deleted_at exemption in guard 3 below for no reason.
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

    -- M1: the amendable content fields may change on a non-draft incident
    -- ONLY via internal.apply_incident_amendment (below), which sets this
    -- session-local flag inside the same transaction as its own UPDATE. A
    -- plain client UPDATE to these columns -- the prior, wide-open
    -- behavior -- is rejected here.
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

-- ---------------------------------------------------------------------------
-- M1: internal.apply_incident_amendment -- SECURITY DEFINER RPC called by
-- incidents-routes.mjs's POST /incidents/:id/amendments (via
-- POST /rest/v1/rpc/apply_incident_amendment, src/lib/supabase-rest.mjs's
-- new pgRpc helper). Re-checks incidents.manage/review itself (this
-- function bypasses RLS the way every definer function in this codebase
-- does -- see 0043's fn_incident_report_audit for the same pattern), sets
-- rec.amendment_in_progress for the transition guard above, and performs
-- the incident_reports UPDATE + incident_amendments INSERT atomically in
-- one transaction. Registered under `internal` per 0042's convention for
-- privileged helpers; EXECUTE is explicitly granted to authenticated below
-- since 0042's blanket grant only covered functions that existed at that
-- migration's run time.
-- ---------------------------------------------------------------------------
create or replace function internal.apply_incident_amendment(
  incident_id uuid,
  changes jsonb,
  reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(reason, ''));
  v_key text;
  v_before jsonb;
  v_incident incident_reports%rowtype;
  v_amendment incident_amendments%rowtype;
begin
  if v_actor is null then
    raise exception 'apply_incident_amendment: authentication required'
      using errcode = '28000';
  end if;

  if v_reason = '' then
    raise exception 'apply_incident_amendment: reason is required'
      using errcode = 'check_violation';
  end if;

  if changes is null or changes = '{}'::jsonb then
    raise exception 'apply_incident_amendment: changes must include at least one amendable field'
      using errcode = 'check_violation';
  end if;

  for v_key in select jsonb_object_keys(changes) loop
    if v_key not in ('summary', 'immediate_actions', 'location_text', 'severity', 'requires_osha_review') then
      raise exception 'apply_incident_amendment: cannot amend field %', v_key
        using errcode = 'check_violation';
    end if;
  end loop;

  select * into v_incident from incident_reports where id = incident_id for update;
  if not found then
    raise exception 'apply_incident_amendment: incident % not found', incident_id
      using errcode = 'P0002';
  end if;

  if not (
    internal.has_permission(v_actor, v_incident.facility_id, 'incidents.manage')
    or internal.has_permission(v_actor, v_incident.facility_id, 'incidents.review')
  ) then
    raise exception 'apply_incident_amendment: missing permission: incidents.manage or incidents.review'
      using errcode = '42501';
  end if;

  if v_incident.status = 'draft' then
    raise exception 'apply_incident_amendment: draft incidents cannot be amended; edit the draft directly instead'
      using errcode = 'check_violation';
  end if;

  v_before := to_jsonb(v_incident);

  perform set_config('rec.amendment_in_progress', 'true', true);

  update incident_reports set
    summary = case when changes ? 'summary' then changes ->> 'summary' else summary end,
    immediate_actions = case when changes ? 'immediate_actions' then changes ->> 'immediate_actions' else immediate_actions end,
    location_text = case when changes ? 'location_text' then changes ->> 'location_text' else location_text end,
    severity = case when changes ? 'severity' then changes ->> 'severity' else severity end,
    requires_osha_review = case when changes ? 'requires_osha_review' then (changes ->> 'requires_osha_review')::boolean else requires_osha_review end
  where id = incident_id
  returning * into v_incident;

  insert into incident_amendments (
    facility_id, incident_id, amendment_reason, before_snapshot, after_snapshot, amended_by
  ) values (
    v_incident.facility_id, incident_id, v_reason, v_before, to_jsonb(v_incident), v_actor
  )
  returning * into v_amendment;

  -- Disarm the transition-guard bypass as soon as the audited write is done.
  -- set_config(..., true) is transaction-local, so this would die with the
  -- transaction anyway -- but PostgREST-issued statements are not the only
  -- callers (SQL tests, psql sessions, future batch jobs), and leaving the
  -- flag armed would let any later UPDATE in the same transaction rewrite
  -- amendable fields on ANY incident without an amendment row.
  perform set_config('rec.amendment_in_progress', 'false', true);

  return jsonb_build_object('incident', to_jsonb(v_incident), 'amendment', to_jsonb(v_amendment));
end;
$$;

revoke execute on function internal.apply_incident_amendment(uuid, jsonb, text) from public;
grant execute on function internal.apply_incident_amendment(uuid, jsonb, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.apply_incident_amendment(uuid, jsonb, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.apply_incident_amendment(uuid, jsonb, text) to service_role;
  end if;
end
$$;

-- PostgREST only serves functions in its exposed schemas (`public` here);
-- `internal` exists precisely so that PostgREST never serves it (0042). The
-- BFF route posts to /rest/v1/rpc/apply_incident_amendment, so it needs this
-- thin, SECURITY INVOKER wrapper in `public`. It carries no logic of its own:
-- every check (auth.uid(), permission, draft status, amendable-field
-- allow-list) still runs inside the internal definer function, and the
-- wrapper is only executable by the same roles that may call that function.
-- `internal` itself stays unexposed.
create or replace function public.apply_incident_amendment(
  incident_id uuid,
  changes jsonb,
  reason text
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.apply_incident_amendment(incident_id, changes, reason);
$$;

revoke execute on function public.apply_incident_amendment(uuid, jsonb, text) from public;
grant execute on function public.apply_incident_amendment(uuid, jsonb, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.apply_incident_amendment(uuid, jsonb, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.apply_incident_amendment(uuid, jsonb, text) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- M3: message_audiences -- audience_ref_id may stay NULL for department/
-- shift/role (0047's original, still-correct rationale: those degrade to
-- zero recipients, a legitimate if inert row), but NOT for 'employee' --
-- resolveMessageAudience's employee branch has no other way to resolve a
-- target, so a null ref there was never inert, only silently wrong (see
-- communications.mjs's own fixed audienceRefId()).
-- ---------------------------------------------------------------------------
drop policy if exists "communication publishers can manage audiences" on message_audiences;
create policy "communication publishers can manage audiences" on message_audiences
  for all
  using (internal.has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (
    internal.has_permission(auth.uid(), facility_id, 'communications.publish')
    and internal.fn_assert_same_facility(facility_id, 'messages', message_id)
    and (
      (audience_type = 'employee' and audience_ref_id is not null and internal.fn_assert_same_facility(facility_id, 'employees', audience_ref_id))
      or (audience_type = 'department' and (audience_ref_id is null or internal.fn_assert_same_facility(facility_id, 'departments', audience_ref_id)))
      or (audience_type = 'shift' and (audience_ref_id is null or internal.fn_assert_same_facility(facility_id, 'schedule_shifts', audience_ref_id)))
      or (audience_type = 'role' and (audience_ref_id is null or internal.fn_assert_same_facility(facility_id, 'roles', audience_ref_id)))
    )
  );

create or replace function fn_message_audience_ref_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_table text;
  parent_facility_id uuid;
begin
  if new.audience_ref_id is null then
    -- M3: a null ref is only legitimate for department/shift/role
    -- (resolveMessageAudience degrades those to zero recipients); for
    -- 'employee' there is no other way to resolve a target, so this is the
    -- service-role/worker-path equivalent of the policy predicate above.
    if new.audience_type = 'employee' then
      raise exception 'message_audiences.audience_ref_id is required when audience_type = employee'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  parent_table := case new.audience_type
    when 'employee' then 'employees'
    when 'department' then 'departments'
    when 'shift' then 'schedule_shifts'
    when 'role' then 'roles'
    else null
  end;

  if parent_table is null then
    raise exception 'message_audiences.audience_type % has no known parent table for audience_ref_id', new.audience_type
      using errcode = 'check_violation';
  end if;

  execute format('select facility_id from %I where id = $1', parent_table)
    into parent_facility_id
    using new.audience_ref_id;

  if parent_facility_id is null or parent_facility_id <> new.facility_id then
    raise exception 'message_audiences.audience_ref_id must belong to the same facility as audience_type %', new.audience_type
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists message_audiences_ref_facility_consistency on message_audiences;
create trigger message_audiences_ref_facility_consistency
  before insert or update on message_audiences
  for each row execute function fn_message_audience_ref_facility();

revoke execute on function fn_message_audience_ref_facility() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_message_audience_ref_facility() from anon;
  end if;
end
$$;

notify pgrst, 'reload schema';
