-- ===========================================================================
-- 0053_report_workflow_events.sql
-- DR-19/DR-20 (plans/DAILY_REPORTS_PLAN.md, Wave 3 Slice 3A). Builds on
-- DR-18's pure rule engine (src/lib/report-workflow.mjs).
--
-- DR-19: report_workflow_events -- the durable ledger of actions a
-- submission's on_submit workflow produced. SELECT-only for `authenticated`
-- (reports.read); there is deliberately NO insert/update/delete policy for
-- `authenticated` -- every write goes through one of the RPC pairs below,
-- following 0048's internal.apply_incident_amendment pattern:
--   * internal.enqueue_report_workflow / public.enqueue_report_workflow --
--     called by reports-routes.mjs's submit route UNDER THE SUBMITTING
--     USER'S OWN SESSION (never service-role). Re-checks reports.submit (or
--     submitted_by) on the submission's own facility/department itself
--     (defense in depth -- the route already checked it, but this RPC must
--     stand on its own the way apply_incident_amendment does), and inserts
--     exactly ONE pending 'evaluate' event, idempotently
--     (report_workflow_events' own unique(submission_id, event_type) +
--     `on conflict do nothing`) plus one outbox_events row (event_type
--     'report.submitted') ONLY when that insert actually happened. Granted
--     to `authenticated`.
--
--   H-1 (security review): this RPC used to be
--   enqueue_report_workflow(p_submission_id, p_actions jsonb) -- the
--   caller-supplied `p_actions` array was written into
--   report_workflow_events verbatim, with NO validation against the
--   submission's own pinned template version at all. Any reports.submit
--   holder could call public.enqueue_report_workflow directly through
--   PostgREST with an arbitrary action list (create_incident with an
--   attacker-chosen severity/summary, create_work_order with an
--   attacker-chosen title/priority, notify with attacker-chosen text
--   broadcast to every reports.export holder in the facility) and the
--   drain would mint every one of them, with no incidents.manage/
--   work_orders.manage of their own and no workflow configured on the
--   template at all -- proved against a template whose workflow_json is
--   `{}`. Fixed by removing the injection surface entirely rather than
--   trying to validate it: the RPC now takes ONLY p_submission_id. It
--   enqueues a single 'evaluate' event (action = '{}') and nothing else;
--   src/lib/report-workflow-executor.mjs's executor -- running under the
--   service-role client the caller can never reach or impersonate -- is
--   what loads the pinned template version, re-derives the action list
--   from workflow_json via the SAME pure evaluateWorkflow the route used to
--   call, and inserts the concrete action events itself. There is nothing
--   left here for a caller to inject.
--
--   This closes M-4 too (the same finding's twin): the old RPC inserted an
--   outbox_events row UNCONDITIONALLY on every call, with no per-submission
--   uniqueness, so a caller in a loop could grow both queues (and the
--   drain's downstream fan-out, including outbound email) without bound.
--   The new RPC's single 'evaluate' event is the only thing it ever writes,
--   `on conflict (submission_id, event_type) do nothing` makes a second
--   call for the same submission a true no-op (GET DIAGNOSTICS ... row_count
--   right after the INSERT), and the outbox_events insert only runs when
--   that INSERT actually landed a new row -- so calling this RPC any number
--   of times for one submission produces exactly one report_workflow_events
--   row and exactly one outbox_events row, period.
--
-- DR-20: execution. src/lib/report-workflow-executor.mjs (the CRON_SECRET
-- drain, service-role client) claims pending events and dispatches on
-- action->>'type'. An 'evaluate' event (see H-1 above) has its action list
-- derived server-side and the concrete action events inserted from there;
-- `notify`/`queue_pdf` need no elevated privilege (the service-role client
-- already bypasses RLS for a plain UPDATE/INSERT), but `create_incident`/
-- `create_work_order` go through a SECOND RPC pair:
--   * internal.mint_workflow_incident / public.mint_workflow_incident
--   * internal.mint_workflow_work_order / public.mint_workflow_work_order
-- Both are granted ONLY to service_role -- NOT authenticated, NOT public --
-- this is the Opus-reviewed privilege boundary: a submitter (even one
-- lacking incidents.manage/work_orders.manage) can trigger these indirectly
-- through their own report submission's *configured* workflow (H-1 above is
-- what makes "configured" actually true end to end now), but can never call
-- either RPC directly, and no authenticated actor of any permission level
-- can either. The submission-derived facility_id/department_id/submitted_by
-- are read SERVER-SIDE from report_submissions by submission_id -- never
-- accepted as caller-supplied parameters -- so there is no cross-tenant
-- injection surface even though the function itself bypasses RLS.
--
-- Provenance (DR-20's other acceptance criterion): incident_reports carries
-- no metadata jsonb column, so internal.mint_workflow_incident sets two
-- transaction-local session settings (rec.report_workflow_source,
-- rec.report_workflow_submission_id -- same set_config/current_setting
-- mechanism as 0048's rec.amendment_in_progress) immediately before its
-- INSERT; fn_incident_report_audit (recreated below, CREATE OR REPLACE
-- preserves its trigger binding and OID) reads them and folds
-- {source: 'report_workflow', submission_id} into the 'incident.created'
-- audit_events row it already writes. Combined with actor_user_id landing
-- NULL (auth.uid() is null under a service-role-authenticated PostgREST
-- request, exactly like every other service-role write in this codebase --
-- see fn_incident_report_audit's own v_actor guard), the audit trail
-- unambiguously shows the row was minted by the workflow, not by any user
-- exercising incidents.manage.
--
-- Idempotency: report_workflow_events.unique(submission_id, event_type)
-- covers the ledger; incident_reports.source_submission_id and
-- work_orders.source_submission_id both carry a UNIQUE partial index (one
-- workflow-minted incident/work order per submission -- report_workflow_
-- events' own uniqueness on (submission_id, event_type) means a template
-- author configuring two create_incident rules for one submission is a
-- template-authoring mistake, not something this migration needs to
-- support; the second mint attempt hits the unique index and
-- internal.mint_workflow_incident/work_order return the pre-existing row
-- instead of erroring), so a concurrent or re-run drain can never duplicate
-- either row -- both mint RPCs check-then-insert, and the unique index
-- closes the race between the check and the insert.
--
-- Backoff: report_workflow_events carries the same available_at/attempts/
-- last_error shape as outbox_events (0002/0029); the executor applies the
-- identical exponential-backoff algorithm as notifications/worker.mjs
-- (2m, 4m, 8m, ... capped at 1h), terminal 'failed' at 5 attempts.
--
-- Idempotency conventions (0009-0051): drop policy/trigger if exists before
-- every create; create or replace for functions; every internal.* helper
-- call is schema-qualified per 0042's mandate for >= 0043.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Provenance columns. Both nullable (a normal, human-authored incident/work
-- order never sets these) with a UNIQUE partial index (see header) doubling
-- as the mint RPCs' idempotency guard and their lookup index.
-- ---------------------------------------------------------------------------
alter table incident_reports
  add column if not exists source_submission_id uuid references report_submissions(id);
create unique index if not exists incident_reports_source_submission_uidx
  on incident_reports(source_submission_id) where source_submission_id is not null;

alter table work_orders
  add column if not exists source_submission_id uuid references report_submissions(id);
create unique index if not exists work_orders_source_submission_uidx
  on work_orders(source_submission_id) where source_submission_id is not null;

-- ---------------------------------------------------------------------------
-- DR-19: report_workflow_events.
-- ---------------------------------------------------------------------------
create table if not exists report_workflow_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  submission_id uuid not null references report_submissions(id) on delete cascade,
  event_type text not null,
  action jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  result jsonb,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (submission_id, event_type)
);

create index if not exists report_workflow_events_facility_status_idx
  on report_workflow_events(facility_id, status, available_at);

alter table report_workflow_events enable row level security;

drop policy if exists "report readers can read workflow events" on report_workflow_events;
create policy "report readers can read workflow events" on report_workflow_events
  for select using (internal.has_permission(auth.uid(), facility_id, 'reports.read'));

-- ---------------------------------------------------------------------------
-- fn_incident_report_audit -- recreated whole (CREATE OR REPLACE preserves
-- the existing trigger binding/OID) to fold in workflow provenance on
-- 'incident.created' rows. Every other branch is carried over verbatim from
-- 0048.
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
  v_workflow_source text;
  v_workflow_submission_id text;
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

  -- DR-20 provenance: internal.mint_workflow_incident sets these two
  -- transaction-local settings immediately before its INSERT (and clears
  -- them immediately after, mirroring 0048's rec.amendment_in_progress
  -- disarm) -- only ever present for a workflow-minted 'incident.created'
  -- row, never for a human-authored one (POST /facilities/:id/incidents
  -- never sets them).
  if tg_op = 'INSERT' then
    v_workflow_source := nullif(current_setting('rec.report_workflow_source', true), '');
    if v_workflow_source is not null then
      v_workflow_submission_id := nullif(current_setting('rec.report_workflow_submission_id', true), '');
      v_payload := v_payload || jsonb_build_object(
        'source', v_workflow_source,
        'submission_id', v_workflow_submission_id
      );
    end if;
  end if;

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
-- H-1: drop the old two-argument overloads outright (rather than leaving
-- them to coexist with the new one-argument signature as PostgREST-visible
-- overloads, which would be ambiguous at best and reopen the caller-
-- supplied-actions surface at worst).
-- ---------------------------------------------------------------------------
drop function if exists internal.enqueue_report_workflow(uuid, jsonb);
drop function if exists public.enqueue_report_workflow(uuid, jsonb);

-- ---------------------------------------------------------------------------
-- DR-19/H-1: internal.enqueue_report_workflow(p_submission_id uuid) --
-- called under the SUBMITTING USER'S OWN session (reports-routes.mjs's POST
-- /reports/:id/submit), immediately after that route's own
-- report_submissions UPDATE. Re-derives facility_id/department_id from the
-- submission row itself (never trusts a caller-supplied facility/
-- department), re-checks reports.submit (or that the caller IS the
-- submission's own submitted_by -- the submitting user's own session should
-- never be locked out of enqueueing their own already-submitted report's
-- workflow purely because a later membership change cost them
-- reports.submit at that department), and requires the submission to
-- already be 'submitted'. Takes NO other parameter -- see the migration
-- header's H-1 note for why the caller-supplied action list this used to
-- accept was removed rather than validated. Inserts exactly ONE
-- 'evaluate' event, idempotently, and the outbox_events row only when that
-- insert actually happened -- so N calls for the same submission produce
-- exactly one row in each table (closes M-4 too).
-- ---------------------------------------------------------------------------
create or replace function internal.enqueue_report_workflow(
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_submission report_submissions%rowtype;
  v_event_id uuid;
  v_inserted int;
begin
  if v_actor is null then
    raise exception 'enqueue_report_workflow: authentication required'
      using errcode = '28000';
  end if;

  select * into v_submission from report_submissions where id = p_submission_id;
  if not found then
    raise exception 'enqueue_report_workflow: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  if not (
    internal.has_permission(v_actor, v_submission.facility_id, v_submission.department_id, 'reports.submit')
    or v_submission.submitted_by = v_actor
  ) then
    raise exception 'enqueue_report_workflow: missing permission: reports.submit'
      using errcode = '42501';
  end if;

  if v_submission.status <> 'submitted' then
    raise exception 'enqueue_report_workflow: submission % is not submitted', p_submission_id
      using errcode = 'check_violation';
  end if;

  v_event_id := null;
  insert into report_workflow_events (facility_id, submission_id, event_type, action, status)
  values (v_submission.facility_id, p_submission_id, 'evaluate', '{}'::jsonb, 'pending')
  on conflict (submission_id, event_type) do nothing
  returning id into v_event_id;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    insert into outbox_events (facility_id, event_type, payload)
    values (
      v_submission.facility_id,
      'report.submitted',
      jsonb_build_object(
        'submission_id', p_submission_id,
        'template_id', v_submission.template_id
      )
    );
  end if;

  return jsonb_build_object('submission_id', p_submission_id, 'event_id', to_jsonb(v_event_id), 'enqueued', v_inserted > 0);
end;
$$;

revoke execute on function internal.enqueue_report_workflow(uuid) from public;
grant execute on function internal.enqueue_report_workflow(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.enqueue_report_workflow(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.enqueue_report_workflow(uuid) to service_role;
  end if;
end
$$;

-- PostgREST-facing wrapper (see 0048's apply_incident_amendment pair for the
-- rationale -- `internal` is never exposed by PostgREST, 0042).
create or replace function public.enqueue_report_workflow(
  p_submission_id uuid
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.enqueue_report_workflow(p_submission_id);
$$;

revoke execute on function public.enqueue_report_workflow(uuid) from public;
grant execute on function public.enqueue_report_workflow(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.enqueue_report_workflow(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_report_workflow(uuid) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- DR-20: internal.mint_workflow_incident -- called ONLY by the CRON_SECRET
-- drain's service-role client (src/lib/report-workflow-executor.mjs). Grants
-- below are service_role ONLY -- deliberately NOT authenticated, closing off
-- the exact privilege-elevation path the Opus review targets: no submitter,
-- however permissioned, can reach this function directly through PostgREST.
-- incident_no is generated the same way IN-09's route does (nextIncidentNo,
-- src/lib/incidents.mjs), duplicated here in SQL the same way
-- fn_incident_report_transition_guard already duplicates the JS transition
-- graph -- a collision (unique(facility_id, incident_no), 0004) simply fails
-- this call; the executor's own attempts/backoff retries the event, and a
-- retry recomputes a fresh number against then-current table state.
-- ---------------------------------------------------------------------------
create or replace function internal.mint_workflow_incident(
  p_submission_id uuid,
  p_action jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission report_submissions%rowtype;
  v_template report_templates%rowtype;
  v_existing incident_reports%rowtype;
  v_incident incident_reports%rowtype;
  v_params jsonb := coalesce(p_action -> 'params', '{}'::jsonb);
  v_severity text := coalesce(v_params ->> 'severity', 'medium');
  v_report_type text := coalesce(v_params ->> 'reportType', 'incident');
  v_requires_osha boolean := coalesce((v_params ->> 'requiresOshaReview')::boolean, false);
  v_summary text;
  v_location text;
  v_year int;
  v_sequence int;
  v_incident_no text;
begin
  select * into v_submission from report_submissions where id = p_submission_id;
  if not found then
    raise exception 'mint_workflow_incident: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- Idempotency (see header): a prior or concurrent mint may already have
  -- landed this submission's workflow incident.
  select * into v_existing from incident_reports where source_submission_id = p_submission_id;
  if found then
    return jsonb_build_object('incident', to_jsonb(v_existing), 'created', false);
  end if;

  select * into v_template from report_templates where id = v_submission.template_id;

  if v_severity not in ('low', 'medium', 'high', 'critical') then
    v_severity := 'medium';
  end if;
  if v_report_type not in ('incident', 'accident', 'near_miss') then
    v_report_type := 'incident';
  end if;

  v_summary := nullif(btrim(coalesce(v_params ->> 'summary', '')), '');
  if v_summary is null then
    v_summary := 'Auto-created from report workflow'
      || case when v_template.name is not null then ' (' || v_template.name || ')' else '' end
      || ' -- submission ' || p_submission_id::text;
  end if;

  v_location := nullif(btrim(coalesce(v_params ->> 'locationText', '')), '');
  if v_location is null then
    v_location := 'Reported via report workflow; see submission ' || p_submission_id::text;
  end if;

  v_year := extract(year from coalesce(v_submission.submitted_at, now()))::int;
  select coalesce(max((regexp_match(incident_no, '^INC-[0-9]{4}-([0-9]+)$'))[1]::int), 0) + 1
    into v_sequence
    from incident_reports
    where facility_id = v_submission.facility_id
      and incident_no like 'INC-' || v_year::text || '-%';
  v_incident_no := 'INC-' || v_year::text || '-' || lpad(v_sequence::text, 4, '0');

  -- Provenance (see header and fn_incident_report_audit above): armed
  -- immediately before the INSERT, disarmed immediately after, exactly like
  -- 0048's rec.amendment_in_progress.
  perform set_config('rec.report_workflow_source', 'report_workflow', true);
  perform set_config('rec.report_workflow_submission_id', p_submission_id::text, true);

  insert into incident_reports (
    facility_id, department_id, incident_no, report_type, status, severity,
    occurred_at, reported_at, location_text, summary, requires_osha_review,
    submitted_by, submitted_at, source_submission_id
  ) values (
    v_submission.facility_id, v_submission.department_id, v_incident_no, v_report_type, 'draft', v_severity,
    coalesce(v_submission.submitted_at, now()), now(), v_location, v_summary, v_requires_osha,
    v_submission.submitted_by, v_submission.submitted_at, p_submission_id
  )
  returning * into v_incident;

  perform set_config('rec.report_workflow_source', '', true);
  perform set_config('rec.report_workflow_submission_id', '', true);

  return jsonb_build_object('incident', to_jsonb(v_incident), 'created', true);
end;
$$;

revoke execute on function internal.mint_workflow_incident(uuid, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.mint_workflow_incident(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.mint_workflow_incident(uuid, jsonb) to service_role;
  end if;
end
$$;

create or replace function public.mint_workflow_incident(
  p_submission_id uuid,
  p_action jsonb
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.mint_workflow_incident(p_submission_id, p_action);
$$;

revoke execute on function public.mint_workflow_incident(uuid, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.mint_workflow_incident(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.mint_workflow_incident(uuid, jsonb) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- DR-20: internal.mint_workflow_work_order -- same service_role-only
-- boundary and idempotency shape as mint_workflow_incident above.
-- work_orders carries no audit trigger in this codebase (0005), so there is
-- no provenance session-setting hook here -- source_type='report' +
-- source_submission_id is the row's own provenance, matching the existing
-- source_type check-constraint vocabulary work-orders.mjs's
-- createWorkOrderFromIncident already uses for the incident-sourced path.
-- ---------------------------------------------------------------------------
create or replace function internal.mint_workflow_work_order(
  p_submission_id uuid,
  p_action jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission report_submissions%rowtype;
  v_template report_templates%rowtype;
  v_existing work_orders%rowtype;
  v_work_order work_orders%rowtype;
  v_params jsonb := coalesce(p_action -> 'params', '{}'::jsonb);
  v_priority text := coalesce(v_params ->> 'priority', 'medium');
  v_title text;
  v_description text;
  v_due_at timestamptz;
begin
  select * into v_submission from report_submissions where id = p_submission_id;
  if not found then
    raise exception 'mint_workflow_work_order: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  select * into v_existing from work_orders where source_submission_id = p_submission_id;
  if found then
    return jsonb_build_object('work_order', to_jsonb(v_existing), 'created', false);
  end if;

  select * into v_template from report_templates where id = v_submission.template_id;

  if v_priority not in ('low', 'medium', 'high', 'urgent') then
    v_priority := 'medium';
  end if;

  v_title := nullif(btrim(coalesce(v_params ->> 'title', '')), '');
  if v_title is null then
    v_title := 'Follow up: ' || coalesce(v_template.name, 'report submission');
  end if;

  v_description := nullif(btrim(coalesce(v_params ->> 'description', '')), '');
  if v_description is null then
    v_description := 'Auto-created from report workflow -- submission ' || p_submission_id::text;
  end if;

  begin
    v_due_at := nullif(v_params ->> 'dueAt', '')::timestamptz;
  exception
    when others then
      v_due_at := null;
  end;

  insert into work_orders (
    facility_id, department_id, source_type, source_id, source_submission_id,
    title, description, priority, status, due_at
  ) values (
    v_submission.facility_id, v_submission.department_id, 'report', p_submission_id, p_submission_id,
    v_title, v_description, v_priority, 'open', v_due_at
  )
  returning * into v_work_order;

  return jsonb_build_object('work_order', to_jsonb(v_work_order), 'created', true);
end;
$$;

revoke execute on function internal.mint_workflow_work_order(uuid, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.mint_workflow_work_order(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.mint_workflow_work_order(uuid, jsonb) to service_role;
  end if;
end
$$;

create or replace function public.mint_workflow_work_order(
  p_submission_id uuid,
  p_action jsonb
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.mint_workflow_work_order(p_submission_id, p_action);
$$;

revoke execute on function public.mint_workflow_work_order(uuid, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.mint_workflow_work_order(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.mint_workflow_work_order(uuid, jsonb) to service_role;
  end if;
end
$$;

notify pgrst, 'reload schema';
