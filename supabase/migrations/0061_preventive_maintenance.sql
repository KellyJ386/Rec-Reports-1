-- ===========================================================================
-- 0061_preventive_maintenance.sql
-- Wave 3, Slice 3C: WO-17 (recurring PM schema) -- plans/WORK_ORDERS_PLAN.md.
--
-- Two new tables:
--   pm_plans             -- the recurring maintenance definition (cadence,
--                            asset, default assignee/priority).
--   pm_plan_occurrences  -- the generation ledger: one row per
--                            (pm_plan_id, scheduled_for) the PM generation
--                            job (WO-19, src/lib/pm-generation.mjs) has
--                            claimed or fulfilled, linking forward to the
--                            work_orders row it minted once created. The
--                            UNIQUE(pm_plan_id, scheduled_for) constraint is
--                            the idempotency primitive WO-19 relies on: the
--                            generation job INSERTs a placeholder occurrence
--                            row (work_order_id null) BEFORE creating a work
--                            order, so a concurrent/retried pass that hits
--                            the unique violation learns "this date is
--                            already claimed" before ever minting a second
--                            work order for it -- see pm-generation.mjs's own
--                            header for why this is insert-occurrence-first,
--                            not insert-work-order-first as the plan's prose
--                            summary suggested (that ordering cannot be made
--                            idempotent: a second pass would already have
--                            minted its own work order by the time it
--                            discovered the occurrence conflict).
--
-- Also (still WO-17): widens work_orders.source_type to accept 'pm', and
-- adds work_orders.source_pm_plan_id / source_pm_occurrence_id so a
-- PM-generated work order carries its own provenance back to the plan/
-- occurrence that minted it -- the same "source_type + a source_*_id column"
-- shape source_type='report' + source_submission_id already uses (0053).
--
-- RLS, per the WO-07 lesson (0026's header): pm_plans and
-- pm_plan_occurrences each get FOUR separate policies (select/insert/update/
-- delete), never a single `for all`, so a write policy's USING clause can
-- never end up silently covering SELECT the way a `for all` policy does. All
-- four are gated on the existing work_orders.read/work_orders.manage codes
-- (no new permission code -- these tables are part of the work-orders
-- module, matching assets/work_order_updates/work_order_attachments in
-- 0005). SELECT policies filter `deleted_at is null` from the start (the
-- exact gap 0026 had to retrofit into the work-orders family); pm_plans has
-- deleted_at (soft-deletable like every other work-orders-family table),
-- pm_plan_occurrences does not (it is a generation ledger, not a
-- user-facing/soft-deletable record -- nothing ever "deletes" a past
-- occurrence, and WO-20's deactivate route only flips pm_plans.active).
--
-- fn_assert_same_facility (0009, moved to `internal` by 0042) guards every
-- cross-table FK on both new tables in the same WITH CHECK shape 0009/0013/
-- 0026/0035 already established for work_orders.asset_id:
--   pm_plans.asset_id                    -> assets
--   pm_plan_occurrences.pm_plan_id       -> pm_plans
--   pm_plan_occurrences.work_order_id    -> work_orders
-- and, since this migration also adds two new FK columns onto the EXISTING
-- work_orders table, the existing "work order managers can manage work
-- orders" policy is extended (drop+recreate, same USING, WITH CHECK gains
-- two more fn_assert_same_facility guards) to close the identical gap for
-- those two new columns. Its LATEST prior definition is 0038's (grepped
-- every migration for this policy name to confirm -- 0038 is more recent
-- than 0026 and already added guards for department_id and
-- assigned_to_employee_id too, closing WO-09's JS-level-only gap at the DB
-- layer; supabase/tests/rls_audit_hardening.sql asserts this), so this
-- migration's version of the policy carries ALL FIVE guards forward
-- (asset_id, department_id, assigned_to_employee_id, plus the two new
-- source_pm_* columns) rather than reverting to 0026's asset_id-only shape.
-- work_orders itself is NOT re-split into insert/update/delete -- 0026
-- already fixed its soft-delete leak for the `for all` shape, and re-doing
-- that split is out of scope for this migration.
--
-- Idempotency conventions (mirroring 0009-0055): `create table if not
-- exists`, `add column if not exists`, drop-then-recreate for constraints/
-- policies/functions, `create index if not exists`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) pm_plans
-- ---------------------------------------------------------------------------
create table if not exists pm_plans (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  asset_id uuid references assets(id),
  title text not null,
  description text,
  cadence_type text not null check (cadence_type in ('interval', 'seasonal')),
  interval_days integer check (interval_days is null or interval_days >= 1),
  anchor_date date not null,
  -- Seasonal cadence's list of 1-12 month numbers; NULL for an interval plan.
  season_months integer[],
  lead_time_days integer not null default 0 check (lead_time_days >= 0),
  -- Mirrors work_orders.priority's own check-constraint vocabulary (0005).
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  default_assignee_employee_id uuid references employees(id),
  active boolean not null default true,
  last_generated_at timestamptz,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pm_plans_interval_shape check (cadence_type <> 'interval' or interval_days is not null),
  constraint pm_plans_seasonal_shape check (
    cadence_type <> 'seasonal' or (season_months is not null and array_length(season_months, 1) > 0)
  ),
  -- Array-contained-by check: every element of season_months must be one of
  -- 1-12. `<@` is a plain array operator (no subquery, no aggregate), so
  -- this is safe inside a CHECK constraint.
  constraint pm_plans_season_months_range check (
    season_months is null or season_months <@ array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  )
);

create index if not exists pm_plans_facility_active_idx
  on pm_plans(facility_id, active) where deleted_at is null;
create index if not exists pm_plans_asset_idx
  on pm_plans(facility_id, asset_id) where deleted_at is null and asset_id is not null;

alter table pm_plans enable row level security;

drop policy if exists "pm plan readers can read pm plans" on pm_plans;
create policy "pm plan readers can read pm plans" on pm_plans
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.read') and deleted_at is null);

-- M-2 (security review, wave3-slice-3c): default_assignee_employee_id is a
-- second FK on this table into a facility-scoped table (employees), same as
-- asset_id, but it shipped with no fn_assert_same_facility guard on either
-- WITH CHECK clause below -- a work_orders.manage holder at facility A could
-- point a plan at a facility-B employee, and pm-generation.mjs's
-- mintWorkOrder copies default_assignee_employee_id straight into
-- work_orders.assigned_to_employee_id UNDER THE SERVICE-ROLE CLIENT (RLS
-- bypassed there), landing exactly the cross-facility assignment 0038's
-- fn_assert_same_facility(facility_id,'employees',assigned_to_employee_id)
-- guard exists to prevent. Closed here at the DB layer, matching asset_id's
-- existing guard shape on both clauses (pm-plans-routes.mjs already resolves
-- this ref in JS -- see resolveFacilityRefs-equivalent validation there --
-- so this is defense-in-depth for the class 0038 closed, not a live route
-- hole, but the RLS layer should never rely on the route layer alone for a
-- cross-facility FK, same posture as every other guard in this file).
drop policy if exists "pm plan managers can create pm plans" on pm_plans;
create policy "pm plan managers can create pm plans" on pm_plans
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage')
    and internal.fn_assert_same_facility(facility_id, 'assets', asset_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', default_assignee_employee_id)
  );

drop policy if exists "pm plan managers can update pm plans" on pm_plans;
create policy "pm plan managers can update pm plans" on pm_plans
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage')
    and internal.fn_assert_same_facility(facility_id, 'assets', asset_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', default_assignee_employee_id)
  );

drop policy if exists "pm plan managers can delete pm plans" on pm_plans;
create policy "pm plan managers can delete pm plans" on pm_plans
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage') and deleted_at is null);

-- ---------------------------------------------------------------------------
-- (b) pm_plan_occurrences -- see the file header for why UNIQUE(pm_plan_id,
-- scheduled_for) is load-bearing for WO-19's idempotency, and why this table
-- carries no deleted_at (it is a generation ledger, not a soft-deletable
-- user record).
-- ---------------------------------------------------------------------------
create table if not exists pm_plan_occurrences (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  pm_plan_id uuid not null references pm_plans(id) on delete cascade,
  scheduled_for date not null,
  work_order_id uuid references work_orders(id),
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pm_plan_id, scheduled_for)
);

create index if not exists pm_plan_occurrences_facility_plan_idx
  on pm_plan_occurrences(facility_id, pm_plan_id, scheduled_for);
create index if not exists pm_plan_occurrences_work_order_idx
  on pm_plan_occurrences(work_order_id) where work_order_id is not null;

alter table pm_plan_occurrences enable row level security;

drop policy if exists "pm plan occurrence readers can read occurrences" on pm_plan_occurrences;
create policy "pm plan occurrence readers can read occurrences" on pm_plan_occurrences
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.read'));

drop policy if exists "pm plan managers can create occurrences" on pm_plan_occurrences;
create policy "pm plan managers can create occurrences" on pm_plan_occurrences
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage')
    and internal.fn_assert_same_facility(facility_id, 'pm_plans', pm_plan_id)
    and internal.fn_assert_same_facility(facility_id, 'work_orders', work_order_id)
  );

drop policy if exists "pm plan managers can update occurrences" on pm_plan_occurrences;
create policy "pm plan managers can update occurrences" on pm_plan_occurrences
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage')
    and internal.fn_assert_same_facility(facility_id, 'pm_plans', pm_plan_id)
    and internal.fn_assert_same_facility(facility_id, 'work_orders', work_order_id)
  );

drop policy if exists "pm plan managers can delete occurrences" on pm_plan_occurrences;
create policy "pm plan managers can delete occurrences" on pm_plan_occurrences
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage'));

-- ---------------------------------------------------------------------------
-- (c) work_orders: widen source_type to accept 'pm', add provenance columns.
-- The unnamed 0005 check constraint on source_type is Postgres's own
-- default-named `work_orders_source_type_check` -- confirmed precedent for
-- this exact drop/re-add shape at 0029_delivery_bookkeeping.sql (widening
-- notification_jobs_status_check the same way).
-- ---------------------------------------------------------------------------
alter table work_orders
  add column if not exists source_pm_plan_id uuid references pm_plans(id),
  add column if not exists source_pm_occurrence_id uuid references pm_plan_occurrences(id);

create index if not exists work_orders_source_pm_plan_idx
  on work_orders(source_pm_plan_id) where source_pm_plan_id is not null;

alter table work_orders drop constraint if exists work_orders_source_type_check;
alter table work_orders
  add constraint work_orders_source_type_check
  check (source_type in ('manual', 'report', 'incident', 'pm'));

-- Carries forward EVERY guard 0038_rls_audit_hardening.sql's version of this
-- policy already had (asset_id, department_id, assigned_to_employee_id --
-- confirmed as the latest prior definition by grepping every migration for
-- this exact policy name) and adds the two new pm-provenance columns;
-- dropping any of the three existing guards here would silently reopen the
-- Class B cross-tenant gaps 0038 closed (supabase/tests/rls_audit_hardening.sql
-- asserts all five).
--
-- H-1 (security review, wave3-slice-3c): a SIXTH guard is added here --
-- source_submission_id, an existing column (0053) that had never carried a
-- fn_assert_same_facility guard at all until this fix. A work_orders.manage
-- holder at facility A who learned a facility-B report_submissions id (only
-- reports.read on B is needed to read one -- e.g. a multi-facility member)
-- could otherwise pre-insert a work order at facility A claiming that
-- foreign submission id as its own source_submission_id ("squatting" on the
-- key facility B's own workflow mint will look up). See 0060's
-- work_orders_facility_source_submission_defect_uidx / mint_workflow_work_order
-- comments for the other half of this fix (the mint RPC's own lookup and
-- the unique index are now ALSO facility-scoped, so a squatting row from a
-- different facility can no longer be found/collide with the real mint even
-- if one somehow existed) -- this WITH CHECK guard closes the INSERT path
-- that could create the squatting row in the first place.
--
-- N-1 (security re-verification): the latest prior definition of this
-- policy is 0058, NOT 0038 -- 0058 added the source_followup_id guard for
-- IN-17's cross-module work orders, and the first version of this file
-- re-created the policy from 0038's list and silently dropped it, which
-- reopened the same squatting bypass on incident follow-ups. Every guard
-- of the latest prior definition is carried forward here (seven in total)
-- and supabase/tests/work_order_sla.sql section 5c asserts the full list
-- against pg_policies so a future redefinition cannot drop one unnoticed.
drop policy if exists "work order managers can manage work orders" on work_orders;
create policy "work order managers can manage work orders" on work_orders
  for all using (internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'work_orders.manage')
    and internal.fn_assert_same_facility(facility_id, 'assets', asset_id)
    and internal.fn_assert_same_facility(facility_id, 'departments', department_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', assigned_to_employee_id)
    and internal.fn_assert_same_facility(facility_id, 'pm_plans', source_pm_plan_id)
    and internal.fn_assert_same_facility(facility_id, 'pm_plan_occurrences', source_pm_occurrence_id)
    and internal.fn_assert_same_facility(facility_id, 'report_submissions', source_submission_id)
    and internal.fn_assert_same_facility(facility_id, 'incident_followup_actions', source_followup_id)
  );

notify pgrst, 'reload schema';
