-- ===========================================================================
-- 0060_work_order_sla.sql
-- Wave 3, Slice 3C: WO-15 (SLA tracking columns), WO-16 (overdue scan --
-- table/index support only, the scan itself is src/lib/work-order-sla-scan.mjs
-- running off notification_jobs it already has RLS access to as service
-- role), WO-21 (report-defect auto-creation -- per-defect idempotency on the
-- existing DR-20 mint RPC).
--
-- Every helper call is schema-qualified internal.<name>(...) per 0042's
-- convention (mandatory for every migration >= 0043,
-- scripts/verify-migrations.mjs enforces it). Idempotent throughout: `add
-- column if not exists`, `create index if not exists` / `drop index if
-- exists`, `create or replace function`.
--
-- ---------------------------------------------------------------------------
-- WO-15: four SLA columns on work_orders.
--   sla_due_at         -- the ENFORCED deadline, always server-computed from
--                          the facility's workOrders.slaHoursUrgent/Routine
--                          config (src/lib/work-orders.mjs slaHoursForPriority
--                          / workOrderDueAt) -- never client-supplied. Kept
--                          deliberately separate from the existing `due_at`
--                          column, which stays the caller's own human target
--                          (client-suppliable, unchanged).
--   first_response_at  -- stamped once, by the route layer, on the WO's
--                          first comment or its first status change off
--                          'open' -- whichever happens first.
--   sla_breached_at     -- stamped ONLY by src/lib/work-order-sla-scan.mjs's
--                          service-role scan; the trigger below is the DB-
--                          layer backstop for that rule (defense in depth,
--                          the same "never trust the route layer alone"
--                          posture as every other server-authoritative
--                          column in this codebase).
--   resolved_at         -- stamped by the route layer on transition into
--                          resolved/closed; cleared on reopen (mirrors
--                          completed_at's existing reopen-clears behavior,
--                          src/lib/work-orders.mjs applyStatusChange).
-- Backfill: a pre-existing row's sla_due_at seeds from its own due_at (the
-- best available estimate for a row created before this migration; a null
-- due_at backfills to a null sla_due_at too, which slaState treats as
-- "no window, always on_track" -- see that function's own doc comment).
-- ---------------------------------------------------------------------------
alter table work_orders add column if not exists sla_due_at timestamptz;
alter table work_orders add column if not exists first_response_at timestamptz;
alter table work_orders add column if not exists sla_breached_at timestamptz;
alter table work_orders add column if not exists resolved_at timestamptz;

update work_orders set sla_due_at = coalesce(sla_due_at, due_at) where sla_due_at is null;

-- Partial index: only open-status rows carrying a deadline are ever scan
-- candidates (src/lib/work-orders.mjs OPEN_STATUSES = open/in_progress/
-- on_hold) -- a resolved/closed/cancelled row, or one with no sla_due_at at
-- all, is never scanned again once it leaves that set, so it is excluded
-- from the index outright rather than carried as dead weight.
create index if not exists work_orders_sla_due_open_idx
  on work_orders(sla_due_at)
  where status in ('open', 'in_progress', 'on_hold') and sla_due_at is not null;

-- ---------------------------------------------------------------------------
-- WO-15: sla_breached_at is server-scan-only. `authenticated` (any session
-- with request.jwt.claims set, i.e. auth.uid() is not null) is rejected
-- outright on any attempt to set/change it, on both INSERT and UPDATE; only
-- a service-role-authenticated request (auth.uid() reads null, exactly like
-- every other service-role write in this codebase -- see 0053's
-- fn_incident_report_audit v_actor guard for the same test) may write it.
-- This is deliberately narrower than a full RLS policy rewrite: the existing
-- "work order managers can manage work orders" for-all policy (0026) still
-- governs every other column exactly as before -- this trigger only ever
-- fires on the one column it names.
-- ---------------------------------------------------------------------------
create or replace function fn_work_orders_guard_sla_breach()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' and new.sla_breached_at is not null then
      raise exception 'sla_breached_at may only be set by the SLA scan (service role)'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.sla_breached_at is distinct from old.sla_breached_at then
      raise exception 'sla_breached_at may only be set by the SLA scan (service role)'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists work_orders_guard_sla_breach on work_orders;
create trigger work_orders_guard_sla_breach
  before insert or update on work_orders
  for each row execute function fn_work_orders_guard_sla_breach();

revoke execute on function fn_work_orders_guard_sla_breach() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_work_orders_guard_sla_breach() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- WO-21: per-defect work orders. A report submission with multiple defect
-- fields (report-schema.mjs's isDefect convention) now emits one
-- create_work_order action PER defect (src/lib/report-workflow.mjs), each
-- carrying its own params.sourceDefectKey (the field's key). Before this
-- migration, internal.mint_workflow_work_order's idempotency guard was keyed
-- on source_submission_id ALONE (0053's unique partial index) -- correct for
-- "one workflow-minted work order per submission", but wrong once a single
-- submission can legitimately mint SEVERAL (one per defect): the second
-- defect's mint call would find the first defect's row already sitting on
-- source_submission_id and silently treat itself as a duplicate, discarding
-- every defect but the first.
--
-- source_defect_key carries the field key (null for a non-defect,
-- rule-authored create_work_order action -- unchanged behavior, still one
-- per submission). The unique index widens to
-- (source_submission_id, coalesce(source_defect_key, '')) so distinct
-- defects on the same submission each get their own row, while a retried
-- mint for the SAME defect key still resolves to its existing row.
-- ---------------------------------------------------------------------------
alter table work_orders add column if not exists source_defect_key text;

drop index if exists work_orders_source_submission_uidx;
create unique index if not exists work_orders_source_submission_defect_uidx
  on work_orders(source_submission_id, coalesce(source_defect_key, ''))
  where source_submission_id is not null;

-- create or replace: internal.mint_workflow_work_order (0053) --
--   1. WO-15: also stamps sla_due_at (the workflow's own params.dueAt was
--      already derived server-side through slaHoursForPriority at
--      evaluateWorkflow time -- src/lib/report-workflow.mjs -- using the
--      facility's resolved workOrders.* config, so it is exactly the
--      "resolved config, never client-supplied" value WO-15 requires; the
--      mint RPC simply carries it into both due_at and sla_due_at).
--   2. WO-21: reads v_defect_key from params.sourceDefectKey, checks/inserts
--      against the new composite key, and sets source_defect_key on the row.
--   3. WO-21: created_by is now always the submission's own submitted_by --
--      the acceptance criterion that the workflow-minted work order is
--      attributed to the report's submitter even though that submitter need
--      not hold work_orders.manage (the same documented, Opus-reviewed
--      server-side elevation 0053's header already describes for this RPC
--      pair; this migration only fixes an oversight where the INSERT never
--      populated the column at all).
-- Signature, grants, and every other branch are unchanged from 0053.
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
  v_defect_key text;
begin
  select * into v_submission from report_submissions where id = p_submission_id;
  if not found then
    raise exception 'mint_workflow_work_order: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  v_defect_key := nullif(btrim(coalesce(v_params ->> 'sourceDefectKey', '')), '');

  select * into v_existing
    from work_orders
    where source_submission_id = p_submission_id
      and coalesce(source_defect_key, '') = coalesce(v_defect_key, '');
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
    facility_id, department_id, source_type, source_id, source_submission_id, source_defect_key,
    title, description, priority, status, due_at, sla_due_at, created_by
  ) values (
    v_submission.facility_id, v_submission.department_id, 'report', p_submission_id, p_submission_id, v_defect_key,
    v_title, v_description, v_priority, 'open', v_due_at, v_due_at, v_submission.submitted_by
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

-- public.* wrapper is unchanged in shape (same signature, still delegates to
-- internal.*) -- recreated verbatim only so this migration is a complete,
-- self-contained CREATE OR REPLACE of the pair, matching 0053's own
-- convention of always keeping the internal/public pair's definitions
-- together.
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

-- ---------------------------------------------------------------------------
-- WO-21: internal.enqueue_report_workflow (0053) -- create or replace to
-- honor an action's own `eventType` when the caller supplies one (e.g.
-- report-workflow.mjs's per-defect create_work_order actions, which set
-- `eventType: 'create_work_order:<fieldKey>'` so each defect's ledger row is
-- labeled by the field that produced it), falling back to the original
-- `<type>:<index>` composition when the action carries none -- byte-
-- identical to 0053's own behavior for every rule-authored action that
-- predates this column. actionEventType in src/lib/report-workflow.mjs
-- mirrors this exact precedence in JS (duplicated, not imported, the same
-- "documented in both places" convention 0053's header already uses for
-- incident_no generation). Every other line is unchanged from 0053.
-- ---------------------------------------------------------------------------
create or replace function internal.enqueue_report_workflow(
  p_submission_id uuid,
  p_actions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_submission report_submissions%rowtype;
  v_action jsonb;
  v_idx int := 0;
  v_event_type text;
  v_custom_event_type text;
  v_event_id uuid;
  v_event_ids uuid[] := array[]::uuid[];
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

  if not internal.has_permission(v_actor, v_submission.facility_id, v_submission.department_id, 'reports.submit') then
    raise exception 'enqueue_report_workflow: missing permission: reports.submit'
      using errcode = '42501';
  end if;

  if v_submission.status <> 'submitted' then
    raise exception 'enqueue_report_workflow: submission % is not submitted', p_submission_id
      using errcode = 'check_violation';
  end if;

  if p_actions is not null and jsonb_typeof(p_actions) = 'array' then
    for v_action in select * from jsonb_array_elements(p_actions)
    loop
      v_custom_event_type := nullif(btrim(coalesce(v_action ->> 'eventType', '')), '');
      v_event_type := coalesce(v_custom_event_type, coalesce(v_action ->> 'type', 'unknown') || ':' || v_idx::text);
      v_event_id := null;
      insert into report_workflow_events (facility_id, submission_id, event_type, action, status)
      values (v_submission.facility_id, p_submission_id, v_event_type, v_action, 'pending')
      on conflict (submission_id, event_type) do nothing
      returning id into v_event_id;
      if v_event_id is not null then
        v_event_ids := array_append(v_event_ids, v_event_id);
      end if;
      v_idx := v_idx + 1;
    end loop;
  end if;

  insert into outbox_events (facility_id, event_type, payload)
  values (
    v_submission.facility_id,
    'report.submitted',
    jsonb_build_object(
      'submission_id', p_submission_id,
      'template_id', v_submission.template_id,
      'action_count', v_idx
    )
  );

  return jsonb_build_object('submission_id', p_submission_id, 'event_ids', to_jsonb(v_event_ids));
end;
$$;

revoke execute on function internal.enqueue_report_workflow(uuid, jsonb) from public;
grant execute on function internal.enqueue_report_workflow(uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.enqueue_report_workflow(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.enqueue_report_workflow(uuid, jsonb) to service_role;
  end if;
end
$$;

create or replace function public.enqueue_report_workflow(
  p_submission_id uuid,
  p_actions jsonb
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select internal.enqueue_report_workflow(p_submission_id, p_actions);
$$;

revoke execute on function public.enqueue_report_workflow(uuid, jsonb) from public;
grant execute on function public.enqueue_report_workflow(uuid, jsonb) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.enqueue_report_workflow(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_report_workflow(uuid, jsonb) to service_role;
  end if;
end
$$;

notify pgrst, 'reload schema';
