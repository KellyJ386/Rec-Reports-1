-- ===========================================================================
-- 0058_incident_cross_module.sql
-- Wave 3, Slice 3B: IN-17 (cross-module creation), IN-20 (notification
-- emission), IN-21 (SLA breach sweep). See plans/INCIDENTS_PLAN.md and
-- plans/WAVES_1_4_IMPLEMENTATION_PLAN.md's Wave 3 3B row (Opus review on
-- IN-17's cross-module writes).
--
-- IN-17 -- work-order elevation model (the Opus-reviewed surface):
--   POST /facilities/:id/incidents/:incidentId/followups/:followupId/work-order
--   is guarded at the HTTP layer (incidents-routes.mjs) by incidents.manage
--   OR incidents.review -- deliberately NOT work_orders.manage, since the
--   whole point of this route is that a supervisor who can review/manage an
--   incident, but does not separately hold work-order authority, can still
--   turn a follow-up into a tracked work order. Two paths from there:
--     * the caller ALSO holds work_orders.manage -> the route inserts
--       straight into work_orders through the CALLER'S OWN RLS-scoped
--       client (createWorkOrderFromIncidentFollowup, work-orders.mjs) --
--       ordinary RLS does the gating, no elevation involved.
--     * the caller does NOT hold work_orders.manage -> the route calls
--       public.create_work_order_from_incident(followup_id), the RPC
--       defined below. This is the ONLY server-side privilege elevation in
--       this migration: a SECURITY DEFINER function that re-checks
--       incidents.manage/review itself (never trusts the HTTP layer's
--       guard), derives facility_id/title/description/priority from the
--       follow-up + incident rows it loads itself (a caller can pass
--       NOTHING but the follow-up id -- there is no body field this
--       function reads that could redirect the write), and is idempotent
--       per follow-up via a UNIQUE partial index on
--       work_orders.source_followup_id (added below), mirroring 0053's
--       mint_workflow_incident/mint_workflow_work_order check-then-insert
--       pattern. Unlike 0053's mint RPCs (service_role only -- a workflow
--       drain has no caller identity to re-check), this one is granted to
--       `authenticated` and re-checks the ACTOR's own permission, because
--       the whole feature is "let an authenticated incidents.manage/review
--       holder do this without ALSO needing work_orders.manage" -- the
--       apply_incident_amendment RPC (0048) is the pattern this follows,
--       not mint_workflow_work_order.
--
--   Provenance: the RPC inserts BOTH the work_orders row (source_type
--   'incident', source_id = incident_id, source_followup_id = followup_id)
--   AND an incident_audit_events row (event_type
--   'incident.work_order_created', payload {source:'incident_followup',
--   followup_id, work_order_id, actor}) in the SAME transaction -- unlike
--   0053's session-setting hook into fn_incident_report_audit (which exists
--   because incident_reports' OWN audit trigger needed a way to learn who
--   asked and why), work_orders carries no audit trigger of its own (0053's
--   header note, still true), so there is nothing to hook; writing directly
--   to incident_audit_events is simpler and puts the provenance where a
--   reader of THIS incident's ledger will actually look for it. The direct-
--   insert (work_orders.manage) path writes the identical audit-event shape
--   from incidents-routes.mjs via the existing writeAuditEvent helper, so
--   the ledger looks the same regardless of which path created the row.
--
--   POST .../training-triggers gets NO elevation path: it always inserts
--   incident_training_triggers (added below) through the caller's own
--   client under incidents.manage/review, and ADDITIONALLY inserts a
--   training_assignments row through that SAME client only when the caller
--   ALSO holds training.manage -- otherwise only the trigger row is
--   created. This is a narrower feature than the work-order half on
--   purpose: an incidents.manage/review holder who lacks training.manage
--   gets a durable record that training should happen (for a training
--   admin to act on), never a training_assignments write they aren't
--   authorized to make -- no RPC needed because there is no elevation to
--   grant here, only a smaller success surface for a caller who lacks the
--   second permission.
--
-- IN-20 -- notification_jobs gains a nullable dedupe_key with a UNIQUE
-- partial index; incidents-routes.mjs/incident-sla-sweep.mjs insert through
-- pgInsert's new ignoreDuplicates option (Prefer: resolution=ignore-
-- duplicates) so a retried/re-run emission can never double-enqueue the
-- same (incident, event, recipient).
--
-- IN-21 -- no schema beyond the settings-registry key already added in
-- src/lib/settings-registry.mjs (incidents.maxEscalationLevel); the sweep
-- itself only reads/writes the existing incident_escalations table.
--
-- Idempotency conventions (0009-0053): drop policy/trigger if exists before
-- every create; create or replace for functions; every internal.* helper
-- call is schema-qualified per 0042's mandate for >= 0043; add column if
-- not exists for every ALTER TABLE.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. work_orders.source_followup_id -- nullable provenance column (a
-- manually-created work order, or one minted from a bare incident via WO-03's
-- POST /incidents/:id/work-orders, never sets this), with a UNIQUE partial
-- index doubling as the create_work_order_from_incident RPC's idempotency
-- guard and lookup index -- identical shape to 0053's
-- work_orders_source_submission_uidx.
-- ---------------------------------------------------------------------------
alter table work_orders
  add column if not exists source_followup_id uuid references incident_followup_actions(id);
create unique index if not exists work_orders_source_followup_uidx
  on work_orders(source_followup_id) where source_followup_id is not null;

-- The direct-insert IN-17 path (a caller who holds work_orders.manage,
-- inserting through their OWN client) is otherwise governed entirely by the
-- existing "work order managers can manage work orders" policy (0038) --
-- but that policy's WITH CHECK has no facility guard on source_followup_id,
-- the column just added above, so a work_orders.manage holder at facility A
-- could otherwise set it to a follow-up belonging to a DIFFERENT facility,
-- attaching false provenance (this is the exact WO-08/0035 cross-tenant-FK
-- shape). Re-created here (drop+create, same name, same using clause) with
-- fn_assert_same_facility added for the new column alongside the three it
-- already guards.
drop policy if exists "work order managers can manage work orders" on work_orders;
create policy "work order managers can manage work orders" on work_orders
  for all
  using (internal.has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (
    internal.has_permission(auth.uid(), facility_id, 'work_orders.manage')
    and internal.fn_assert_same_facility(facility_id, 'assets', asset_id)
    and internal.fn_assert_same_facility(facility_id, 'departments', department_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', assigned_to_employee_id)
    and internal.fn_assert_same_facility(facility_id, 'incident_followup_actions', source_followup_id)
  );

-- ---------------------------------------------------------------------------
-- 2. notification_jobs.dedupe_key (IN-20) -- nullable text, UNIQUE partial
-- index. A normal (non-incident) job producer that has no natural dedupe key
-- yet (communications-routes.mjs's message.published, the notification-
-- routes.mjs test sandbox, ...) leaves this null and is completely
-- unaffected -- the partial index only constrains rows that set it.
-- ---------------------------------------------------------------------------
-- Deliberately a PLAIN (non-partial) unique index, unlike 0053's
-- work_orders_source_submission_uidx/incident_reports_source_submission_uidx
-- (both `where ... is not null`). Those are only ever queried directly in
-- plpgsql (select-then-insert, catching unique_violation) -- never through
-- PostgREST's on_conflict mechanism. IN-20's ignoreDuplicates insert
-- (pgInsert's new option) sends `?on_conflict=dedupe_key` +
-- `Prefer: resolution=ignore-duplicates`, which PostgREST translates
-- verbatim into `ON CONFLICT (dedupe_key) DO NOTHING` -- Postgres requires
-- an UNAMBIGUOUSLY MATCHING unique constraint/index for that inference, and
-- a partial index's predicate is part of that match; a plain
-- `ON CONFLICT (dedupe_key)` does NOT match a partial `WHERE dedupe_key IS
-- NOT NULL` index (verified empirically against a live Postgres 16 instance
-- while building supabase/tests/incident_cross_module.sql -- the partial
-- form raises "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification"). A plain unique index needs no such predicate to
-- get the same practical effect anyway: Postgres unique constraints already
-- treat every NULL as distinct from every other NULL, so any number of
-- ordinary (non-deduped) jobs with dedupe_key IS NULL remain unconstrained.
alter table notification_jobs
  add column if not exists dedupe_key text;
create unique index if not exists notification_jobs_dedupe_key_uidx
  on notification_jobs(dedupe_key);

-- notification_jobs' only existing write policy ("communication publishers
-- can manage notifications", 0006) gates EVERY write on communications.publish
-- -- a code incidents-routes.mjs's emitIncidentNotifications helper's callers
-- (submit, escalate) have no reason to hold. Without this, an
-- incidents.manage/review/escalate-only actor's own-client insert into
-- notification_jobs (IN-20) would be silently rejected by RLS every time,
-- even though the HTTP layer never surfaces that failure (emitIncidentNotifications
-- is deliberately best-effort/fire-and-forget) -- exactly the kind of gap
-- 0044's (b)/(c) ADD-a-permissive-INSERT-only-policy pattern exists to close.
-- Scoped to the three incident event codes only (event_type in (...)), so
-- holding one of these incident permissions can never be used to insert an
-- arbitrary notification_jobs row for an unrelated event. The SLA sweep
-- (incident.sla_breached) runs under a service-role client, which bypasses
-- RLS entirely, so it never needs this policy -- it is included in the
-- `event_type` list anyway for symmetry/defense in depth, not because
-- anything authenticated currently inserts it.
--
-- M2 (security review): the ORIGINAL version of this policy constrained
-- only facility_id (via the permission checks) and event_type -- every
-- other column, including payload_jsonb, was attacker-controlled. Probed:
-- an actor holding only incidents.escalate inserted, through their own
-- RLS-scoped client, an ARBITRARY payload_jsonb (`{"channels":["push",
-- "email","sms"],"quietHoursBypass":true,"body":"attacker text",...}`) --
-- the high/critical-only quiet-hours-bypass rule (incidents.mjs's
-- QUIET_HOURS_BYPASS_SEVERITIES) is enforced ONLY in JavaScript, so ANY
-- incident actor could page any same-facility employee on any channel at
-- 3 AM for a LOW-severity incident. The added clause below ties
-- quietHoursBypass to the SAME rule the JS layer already claims to
-- enforce: it must be absent/false, UNLESS the row's own payload names an
-- incident (payload_jsonb->>'incidentId') that is actually high/critical
-- severity in THIS SAME facility -- read as text and matched against
-- incident_reports.id::text (never cast the untrusted jsonb value to uuid,
-- which would raise "invalid input syntax for type uuid" on a malformed
-- value and turn a bad payload into a 500 instead of a clean RLS denial).
-- A manage/review/escalate holder gets no special exemption -- the rule is
-- the INCIDENT's severity, exactly matching buildIncidentNotificationJobs'
-- own business logic, not the caller's permission level.
drop policy if exists "incident actors can insert incident notification jobs" on notification_jobs;
create policy "incident actors can insert incident notification jobs" on notification_jobs
  for insert
  with check (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.escalate')
    )
    and event_type in ('incident.submitted', 'incident.escalated', 'incident.sla_breached')
    and (
      coalesce(payload_jsonb ->> 'quietHoursBypass', 'false') <> 'true'
      or exists (
        select 1 from incident_reports r
        where r.id::text = payload_jsonb ->> 'incidentId'
          and r.facility_id = notification_jobs.facility_id
          and r.severity in ('high', 'critical')
      )
    )
  );

-- Companion SELECT policy, same scope as the INSERT policy above. Not just
-- symmetry: PostgreSQL's row security requires SELECT visibility on the
-- CONFLICTING row for `INSERT ... ON CONFLICT (col) DO NOTHING` to resolve
-- as a silent no-op -- with INSERT-only RLS, a caller who cannot SELECT the
-- table at all gets "new row violates row-level security policy" on the
-- SECOND (conflicting) insert instead of a clean no-op, even though the
-- row's own WITH CHECK passes (verified empirically against a live
-- Postgres 16 instance while building supabase/tests/incident_cross_module.sql
-- -- this is exactly pgInsert's ignoreDuplicates path, IN-20's whole
-- dedupe mechanism). Scoped identically to the INSERT policy's permission/
-- event-type predicate (SELECT does not need the quietHoursBypass clause --
-- an already-inserted row's payload is read-only history at that point, not
-- something this policy could still prevent) so this grants no broader read
-- access into notification_jobs than the write access already granted.
drop policy if exists "incident actors can read incident notification jobs" on notification_jobs;
create policy "incident actors can read incident notification jobs" on notification_jobs
  for select
  using (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.escalate')
    )
    and event_type in ('incident.submitted', 'incident.escalated', 'incident.sla_breached')
  );

-- fn_notification_job_dedupe_key(): M2 continued. dedupe_key was otherwise
-- free text the client fully controls -- an authenticated actor could
-- pre-insert a row carrying the SAME key a future genuine emission would
-- use (${incidentId}:${eventCode}:${recipientId}, incidents.mjs's ORIGINAL
-- formula), which notification_jobs_dedupe_key_uidx + pgInsert's
-- ignoreDuplicates would then silently treat that future, real emission as
-- an already-handled duplicate -- permanently suppressing e.g. an
-- incident.sla_breached alert to a named recipient (see M3's dedupe_key fix
-- in src/lib/incidents.mjs, which independently closes most of this by
-- folding an unpredictable escalation id into the key). This trigger closes
-- the vector directly and unconditionally, for EVERY caller including
-- service-role (a BEFORE trigger fires for every role -- RLS bypass never
-- skips a trigger): whenever a caller supplies a non-null dedupe_key (opting
-- in to dedup at all -- a caller that wants no dedup leaves it null and is
-- untouched), it is OVERWRITTEN with a value computed purely from the row's
-- own validated columns (facility_id, event_type, and the incidentId/
-- escalationId/first-recipient already present in payload_jsonb), never
-- from whatever string the client sent. A caller can therefore no longer
-- set an ARBITRARY key decoupled from their own row's real content; the
-- worst they can do is a row that collides with ITS OWN future resend of
-- the identical event, which is exactly what dedup is supposed to do.
create or replace function fn_notification_job_dedupe_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.dedupe_key is not null then
    new.dedupe_key := new.facility_id::text || ':' || new.event_type || ':' ||
      coalesce(new.payload_jsonb ->> 'incidentId', '') || ':' ||
      coalesce(new.payload_jsonb ->> 'escalationId', 'n/a') || ':' ||
      coalesce(new.payload_jsonb -> 'recipients' ->> 0, '');
  end if;
  return new;
end;
$$;

drop trigger if exists notification_jobs_dedupe_key on notification_jobs;
create trigger notification_jobs_dedupe_key
  before insert on notification_jobs
  for each row execute function fn_notification_job_dedupe_key();

revoke execute on function fn_notification_job_dedupe_key() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_notification_job_dedupe_key() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. incident_training_triggers (IN-17). facility_id + incident_id +
-- employee_id are the three cross-tenant FK surfaces fn_assert_same_facility
-- guards below; `target` jsonb carries either {certificationTypeId} or
-- {trainingModuleId} (the route validates exactly one of the two is
-- present -- there is no course_id linkage in this schema for either
-- certification_types or course_modules directly to certification_types, so
-- the raw target is preserved here for a human/training-admin to act on even
-- when the route could not itself resolve a course to assign).
-- ---------------------------------------------------------------------------
create table if not exists incident_training_triggers (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  employee_id uuid not null references employees(id),
  target jsonb not null default '{}'::jsonb,
  reason text not null,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

create index if not exists incident_training_triggers_facility_incident_idx
  on incident_training_triggers(facility_id, incident_id);

alter table incident_training_triggers enable row level security;

-- L7 (security review): every predicate below uses 0049's `(select
-- auth.uid())` InitPlan-caching form (per-statement evaluation, not
-- per-row) rather than the bare `auth.uid()` this file originally shipped
-- with for its two NEW tables (notification_jobs above, incident_training_
-- triggers here) -- matching 0056's own convention for its new policies.
-- The recreated work_orders policy above is deliberately left in its
-- pre-existing bare form (0038's own convention, unchanged by this
-- migration) -- that one is not a regression, only these two brand-new
-- policy sets are.
drop policy if exists "incident readers can read training triggers" on incident_training_triggers;
create policy "incident readers can read training triggers" on incident_training_triggers
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'incidents.read'));

drop policy if exists "incident managers can create training triggers" on incident_training_triggers;
create policy "incident managers can create training triggers" on incident_training_triggers
  for insert
  with check (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- ---------------------------------------------------------------------------
-- 4. internal.create_work_order_from_incident / public wrapper (IN-17).
-- SECURITY DEFINER, granted to `authenticated` (see header note on why this
-- follows 0048's apply_incident_amendment pattern rather than 0053's
-- service_role-only mint RPCs). Re-checks the caller's own permission,
-- derives every written field from the follow-up + incident rows it loads
-- itself, and is idempotent per follow-up.
-- ---------------------------------------------------------------------------
create or replace function internal.create_work_order_from_incident(
  followup_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_followup incident_followup_actions%rowtype;
  v_incident incident_reports%rowtype;
  v_existing work_orders%rowtype;
  v_work_order work_orders%rowtype;
  v_audit incident_audit_events%rowtype;
  v_title text;
  v_priority text;
  v_payload jsonb;
begin
  if v_actor is null then
    raise exception 'create_work_order_from_incident: authentication required'
      using errcode = '28000';
  end if;

  select * into v_followup from incident_followup_actions where id = followup_id;
  if not found then
    raise exception 'create_work_order_from_incident: follow-up % not found', followup_id
      using errcode = 'P0002';
  end if;

  select * into v_incident from incident_reports where id = v_followup.incident_id;
  if not found then
    raise exception 'create_work_order_from_incident: incident % not found', v_followup.incident_id
      using errcode = 'P0002';
  end if;

  if not (
    internal.has_permission(v_actor, v_incident.facility_id, 'incidents.manage')
    or internal.has_permission(v_actor, v_incident.facility_id, 'incidents.review')
  ) then
    raise exception 'create_work_order_from_incident: missing permission: incidents.manage or incidents.review'
      using errcode = '42501';
  end if;

  -- Idempotent per follow-up: a second call (retry, or a caller who no
  -- longer holds work_orders.manage re-hitting the route after someone else
  -- already ran the elevation path) returns the existing row instead of
  -- erroring or duplicating it.
  select * into v_existing from work_orders where source_followup_id = followup_id;
  if found then
    return jsonb_build_object('work_order', to_jsonb(v_existing), 'created', false);
  end if;

  v_title := 'Follow up: ' || v_incident.incident_no || ' (' || v_followup.action_type || ')';
  v_priority := case
    when v_incident.severity = 'critical' then 'urgent'
    when v_incident.severity = 'high' then 'high'
    else 'medium'
  end;

  begin
    insert into work_orders (
      facility_id, source_type, source_id, source_followup_id,
      title, description, priority, status, created_by
    ) values (
      v_incident.facility_id, 'incident', v_incident.id, followup_id,
      v_title, coalesce(v_followup.description, v_incident.summary), v_priority, 'open', v_actor
    )
    returning * into v_work_order;
  exception
    when unique_violation then
      -- Closes the check-then-insert race the same way 0053's mint RPCs
      -- document: a concurrent call won between our SELECT and this INSERT.
      select * into v_existing from work_orders where source_followup_id = followup_id;
      return jsonb_build_object('work_order', to_jsonb(v_existing), 'created', false);
  end;

  v_payload := jsonb_build_object(
    'source', 'incident_followup',
    'followup_id', followup_id,
    'work_order_id', v_work_order.id,
    'actor', v_actor
  );

  insert into incident_audit_events (
    facility_id, incident_id, actor_user_id, event_type, event_payload, event_hash
  ) values (
    v_incident.facility_id, v_incident.id, v_actor, 'incident.work_order_created', v_payload,
    encode(digest('incident.work_order_created|' || v_incident.id::text || '|' || v_payload::text, 'sha256'), 'hex')
  )
  returning * into v_audit;

  return jsonb_build_object('work_order', to_jsonb(v_work_order), 'created', true, 'audit_event_id', v_audit.id);
end;
$$;

revoke execute on function internal.create_work_order_from_incident(uuid) from public;
grant execute on function internal.create_work_order_from_incident(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.create_work_order_from_incident(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.create_work_order_from_incident(uuid) to service_role;
  end if;
end
$$;

-- PostgREST only serves functions in its exposed schemas (`public`); this
-- thin SECURITY INVOKER wrapper is what incidents-routes.mjs's pgRpc call
-- actually posts to (POST /rest/v1/rpc/create_work_order_from_incident).
-- Carries no logic of its own -- every check still runs inside the internal
-- definer function above.
create or replace function public.create_work_order_from_incident(
  followup_id uuid
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.create_work_order_from_incident(followup_id);
$$;

revoke execute on function public.create_work_order_from_incident(uuid) from public;
grant execute on function public.create_work_order_from_incident(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.create_work_order_from_incident(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.create_work_order_from_incident(uuid) to service_role;
  end if;
end
$$;
