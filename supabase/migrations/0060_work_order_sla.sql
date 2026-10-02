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
-- M-1 (security review, wave3-slice-3c): WO-15's header above documents
-- sla_due_at as "the ENFORCED deadline ... never client-supplied" and
-- first_response_at/resolved_at as stamped only by the route layer off other
-- request fields -- but until this fix the DB enforced none of that: the
-- guard trigger below only ever rejected sla_breached_at, so any
-- `authenticated` work_orders.manage holder could PATCH sla_due_at out to
-- any future date (permanently evading selectBreachCandidates -- WO-16's
-- overdue scan), or forge first_response_at/resolved_at directly through
-- PostgREST with their own JWT, exactly the "route-layer rejection is not
-- the boundary" gap 0038 closed for department_id/assigned_to_employee_id.
-- Widened to reject an `authenticated` session's INSERT/UPDATE of ALL FOUR
-- SLA columns (sla_due_at, first_response_at, resolved_at, sla_breached_at)
-- -- `authenticated` here means any session with request.jwt.claims set,
-- i.e. auth.uid() is not null; only a service-role-authenticated request
-- (auth.uid() reads null, exactly like every other service-role write in
-- this codebase -- see 0053's fn_incident_report_audit v_actor guard for the
-- same test) may write any of them. Function/trigger name kept as
-- fn_work_orders_guard_sla_breach/work_orders_guard_sla_breach (pre-existing,
-- unapplied migration -- no external reference depends on the name, and
-- renaming would leave nothing behind to clean up either way; the "_breach"
-- suffix is now just historical). Deliberately narrower than a full RLS
-- policy rewrite: the existing "work order managers can manage work orders"
-- for-all policy still governs every other column exactly as before -- this
-- trigger only ever fires on the four columns it names.
--
-- The route layer's three legitimate stamps (create-time sla_due_at,
-- first_response_at, resolved_at -- src/lib/http/work-orders-routes.mjs)
-- move to internal.set_work_order_sla_fields below, a service-role-only
-- SECURITY DEFINER RPC following 0053's mint_workflow_work_order grant
-- pattern exactly (revoke from public/authenticated/anon, grant to
-- service_role only) -- the route calls it through a service-role client
-- (env.SUPABASE_SERVICE_ROLE_KEY), the same client buildServiceClient
-- (src/lib/http/internal-routes.mjs) and claimBreach
-- (src/lib/work-order-sla-scan.mjs) already use for a service-role write,
-- AFTER doing its own permission/facility-ref checks under the caller's own
-- client exactly as before -- this RPC adds no new authorization surface,
-- it only relocates WHERE the already-decided write physically lands so the
-- trigger above can reject the same column from every other path. SLA
-- columns stay normally SELECT-able -- nothing here touches read access.
-- ---------------------------------------------------------------------------
create or replace function fn_work_orders_guard_sla_breach()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      if new.sla_due_at is not null then
        raise exception 'sla_due_at may only be set by a service-role write'
          using errcode = '42501';
      end if;
      if new.first_response_at is not null then
        raise exception 'first_response_at may only be set by a service-role write'
          using errcode = '42501';
      end if;
      if new.resolved_at is not null then
        raise exception 'resolved_at may only be set by a service-role write'
          using errcode = '42501';
      end if;
      if new.sla_breached_at is not null then
        raise exception 'sla_breached_at may only be set by the SLA scan (service role)'
          using errcode = '42501';
      end if;
    end if;
    if tg_op = 'UPDATE' then
      if new.sla_due_at is distinct from old.sla_due_at then
        raise exception 'sla_due_at may only be set by a service-role write'
          using errcode = '42501';
      end if;
      if new.first_response_at is distinct from old.first_response_at then
        raise exception 'first_response_at may only be set by a service-role write'
          using errcode = '42501';
      end if;
      if new.resolved_at is distinct from old.resolved_at then
        raise exception 'resolved_at may only be set by a service-role write'
          using errcode = '42501';
      end if;
      if new.sla_breached_at is distinct from old.sla_breached_at then
        raise exception 'sla_breached_at may only be set by the SLA scan (service role)'
          using errcode = '42501';
      end if;
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
-- M-1: internal.set_work_order_sla_fields / public wrapper -- the single
-- service-role-only RPC every route-layer SLA stamp now goes through (the
-- trigger above rejects all four columns for an `authenticated` write, so
-- there is no other path). `p_fields` is a small jsonb object carrying only
-- the keys the caller actually wants to change, from
-- {sla_due_at, first_response_at, resolved_at} -- a key that is ABSENT from
-- p_fields leaves that column untouched (the `?` jsonb-has-key operator,
-- not a null check, so a caller CAN legitimately clear resolved_at back to
-- null on a reopen by sending {"resolved_at": null} -- key present, value
-- null -- distinguishable from "don't touch resolved_at" which omits the key
-- entirely). sla_breached_at is deliberately NOT settable here -- that
-- column has its own dedicated, already-service-role-only writer
-- (work-order-sla-scan.mjs's claimBreach, a plain CAS pgUpdate under the
-- scan's own service-role client, unaffected by this migration) and mixing
-- the two writers would blur which one owns the breach stamp. Grants mirror
-- mint_workflow_work_order exactly: revoke from public/authenticated/anon,
-- grant to service_role only.
-- ---------------------------------------------------------------------------
create or replace function internal.set_work_order_sla_fields(
  p_work_order_id uuid,
  p_fields jsonb
)
returns work_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row work_orders%rowtype;
begin
  if p_fields is null or p_fields = '{}'::jsonb then
    raise exception 'set_work_order_sla_fields: p_fields must name at least one field'
      using errcode = '22023';
  end if;

  update work_orders set
    sla_due_at = case when p_fields ? 'sla_due_at'
      then nullif(p_fields ->> 'sla_due_at', '')::timestamptz else sla_due_at end,
    first_response_at = case when p_fields ? 'first_response_at'
      then nullif(p_fields ->> 'first_response_at', '')::timestamptz else first_response_at end,
    resolved_at = case when p_fields ? 'resolved_at'
      then nullif(p_fields ->> 'resolved_at', '')::timestamptz else resolved_at end
  where id = p_work_order_id
  returning * into v_row;

  if not found then
    raise exception 'set_work_order_sla_fields: work order % not found', p_work_order_id
      using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke execute on function internal.set_work_order_sla_fields(uuid, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.set_work_order_sla_fields(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.set_work_order_sla_fields(uuid, jsonb) to service_role;
  end if;
end
$$;

create or replace function public.set_work_order_sla_fields(
  p_work_order_id uuid,
  p_fields jsonb
)
returns work_orders
language sql
security invoker
set search_path = public
as $$
  select internal.set_work_order_sla_fields(p_work_order_id, p_fields);
$$;

revoke execute on function public.set_work_order_sla_fields(uuid, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.set_work_order_sla_fields(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.set_work_order_sla_fields(uuid, jsonb) to service_role;
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
-- (facility_id, source_submission_id, coalesce(source_defect_key, '')) so
-- distinct defects on the same submission each get their own row, while a
-- retried mint for the SAME defect key still resolves to its existing row.
--
-- H-1 (security review, wave3-slice-3c): facility_id is now the LEADING
-- column of this index, and the mint RPC's existing-row lookup below is
-- scoped by it too. Before this fix, both the index and the lookup keyed on
-- source_submission_id ALONE: a work_orders.manage holder at facility A who
-- learned a facility-B submission id (obtainable with only reports.read on
-- B -- e.g. a multi-facility member) could pre-insert a work order carrying
-- source_submission_id = that B submission (the WITH CHECK guard added to
-- work_orders below, in 0061, closes the INSERT half of this). B's own
-- workflow mint would then find A's squatting row via the
-- source_submission_id-only lookup, return created:false, and B's real
-- defect work order would never be created -- and the RPC's
-- to_jsonb(v_existing) response (A's whole row) would land inside B's own
-- readable report_workflow_events.result. Scoping both the lookup and the
-- index by facility_id means a foreign-facility squat can no longer occupy
-- the key at all: B's mint finds no same-facility row and proceeds to
-- create its own, regardless of what A pre-inserted.
-- ---------------------------------------------------------------------------
alter table work_orders add column if not exists source_defect_key text;

drop index if exists work_orders_source_submission_uidx;
drop index if exists work_orders_source_submission_defect_uidx;
create unique index if not exists work_orders_facility_source_submission_defect_uidx
  on work_orders(facility_id, source_submission_id, coalesce(source_defect_key, ''))
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

  -- H-1: scoped by facility_id (v_submission's own, not caller-supplied) so
  -- a foreign-facility squat on this same source_submission_id/
  -- source_defect_key pair -- see the unique index's comment above -- is
  -- never treated as this submission's existing row.
  select * into v_existing
    from work_orders
    where facility_id = v_submission.facility_id
      and source_submission_id = p_submission_id
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
-- WO-21 and the workflow ledger: NO change to internal.enqueue_report_workflow.
-- Since 0053 (H-1) the RPC inserts exactly one 'evaluate' event per
-- submission and report-workflow-executor.mjs derives the concrete action
-- list server-side from the pinned version's workflow_json, so the
-- per-defect create_work_order actions this migration enables are produced
-- by evaluateWorkflow inside the executor and labelled by actionEventType
-- (`create_work_order:<fieldKey>`) at insert time. Re-introducing a
-- caller-supplied action list here would reopen the H-1 injection surface.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
