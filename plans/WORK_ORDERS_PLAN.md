# Work Orders / Maintenance Module — Development Plan

## 1. Current state

- **Schema exists and is RLS-enabled.** `supabase/migrations/0005_work_orders.sql` creates `assets`, `work_orders`, `work_order_updates`, `work_order_attachments`, all `facility_id`-scoped with soft-delete (`deleted_at`), partial indexes on `(facility_id, status, due_at)`, `(facility_id, priority, created_at desc)`, `(facility_id, assigned_to_employee_id, status)`, and four read/manage policy pairs keyed on `has_permission(auth.uid(), facility_id, 'work_orders.read'|'work_orders.manage')`.
- **RLS was partially hardened in `supabase/migrations/0009_rls_hardening.sql:183-197`** — only the four **reader** SELECT policies were re-created with `and deleted_at is null`. The `for all` manage policies from 0005 were left untouched, so any holder of `work_orders.manage` still reads (and writes) soft-deleted rows via the OR-ed manage policy. This is a live gap, not a design choice (same pattern exists in incidents).
- **Domain lib is pure and tested.** `src/lib/work-orders.mjs` exports `isWorkOrderOpen`, `isWorkOrderOverdue`, `sortWorkOrdersForDashboard`, `slaHoursForPriority`, `workOrderDueAt`, `createWorkOrderFromIncident`. `test/work-orders.test.mjs` covers 4 of the 6 — `workOrderDueAt` and `isWorkOrderOpen` have no direct test.
- **Only four routes exist.** `src/lib/http/work-orders-routes.mjs` registers `GET /facilities/:facilityId/work-orders` (optional `?status=`), `GET /work-orders/:id`, `POST /facilities/:facilityId/work-orders`, `PATCH /work-orders/:id` (status and/or assignee only). Mounted on the end-user router at `scripts/server.mjs:246` under `/api/v1`.
- **Nothing in the route layer uses the domain lib.** `createWorkOrderFromIncident`, `workOrderDueAt` and `slaHoursForPriority` are imported by no route module; `due_at` is caller-supplied and unvalidated. `src/lib/http/work-orders-routes.mjs:2` also imports `authCanAccessFacility` and never uses it (dead import).
- **No endpoints for the comment thread, attachments, assets, or create-from-incident.** `work_order_updates` and `work_order_attachments` are written only by `supabase/seed.sql:167`; `PATCH` mutates status/assignee without writing a `status_change`/`assignment_change` history row and never sets `completed_at`.
- **Route tests are solid for what exists.** `test/work-orders-routes.test.mjs` has 13 tests over a stubbed `globalThis.fetch`, asserting 403 for non-members, 403 for readers on writes, validate-before-guard (400 with zero fetches), insert row shape, and 404s.
- **No RLS SQL proof for this module.** `supabase/tests/` contains 9 files — none covers `work_orders`, `assets`, or their child tables. `scripts/verify-migrations.mjs` does require all four tables to have RLS enabled.
- **Config plumbed but unused at runtime.** `src/lib/settings-registry.mjs:92-118` defines `workOrders.defaultPriority` (medium), `workOrders.slaHoursUrgent` (24), `workOrders.slaHoursRoutine` (72). No end-user route resolves effective settings; `resolveEffectiveSettings` is called only in `src/lib/http/admin-routes.mjs:566,609`.
- **UI is read-only and truncated.** `src/public/index.html:74-84` is a static panel; `src/public/js/app.js:305-334` (`loadWorkOrders`) fetches the list, renders `slice(0, 5)` as priority/title/description/due cards, and offers no create form, filters, detail view, or actions.
- **Supporting rails exist but are unwired.** `supabase/seed.sql:243` seeds the `work_order.overdue` notification event (`in_app`,`email`) and `seed.sql:214` seeds the `work_orders` module row; nothing enqueues `notification_jobs` for work orders and no code touches Supabase Storage for `storage_path`.

## 2. Gap analysis

| Capability | Target (roadmap / architecture) | Implemented today | Gap |
|---|---|---|---|
| **Assets registry** | `assets(asset_tag, name, category, location, criticality, active)`, browsable registry, WO↔asset linkage (`PLATFORM_ARCHITECTURE.md:73`; Phase 2 "asset registry") | Table exists (`name`, `asset_tag`, `location_text`, `status`) + RLS + seed rows; `work_orders.asset_id` FK accepted on create, unvalidated | **No API, no UI, no `category`/`criticality`/`metadata` columns.** No check that `asset_id` belongs to the same facility |
| **Priority / SLA** | Priority-driven due dates, SLA tracking, backlog aging KPI (`PHASED_MVP_ROADMAP.md:83, 223`) | Priority column + check constraint; `slaHoursForPriority`/`workOrderDueAt` in the lib; SLA hours in the settings registry | **Not wired end to end.** `due_at` is client-supplied; no `sla_due_at`/`first_response_at`/`breach` state; no config resolution in `/api/v1`; no overdue query/filter/notification |
| **Assignment** | Assign to staff, assignee views | `PATCH` sets `assigned_to_employee_id`; index on `(facility_id, assignee, status)` exists | **No validation that the employee belongs to the facility**, no `?assignee=` / "my work" filter, no assignment history row, no notify-on-assign |
| **Comment threads** | Comment thread on every work order (`PHASED_MVP_ROADMAP.md:47`) | `work_order_updates` table with `comment`/`status_change`/`assignment_change`/`priority_change` types + RLS | **No read or write endpoint, no auto-history on PATCH, no UI.** Table is seed-only |
| **Attachments** | Photos/PDF evidence on work orders | `work_order_attachments` table (`storage_path`, `mime_type`, `checksum`, `metadata`) + RLS | **No endpoints and no Supabase Storage wiring anywhere in the repo** (shared gap with report/incident attachments) |
| **Create-from-incident** | WO created from report/incident or manual; cross-module linking primitive | `createWorkOrderFromIncident()` implemented and tested; `source_type`/`source_id` columns accepted on manual create | **No route calls it.** No `POST /incidents/:id/work-orders`, no back-link from the incident |
| **Recurring preventive maintenance** | Recurring PM schedules (Phase 2) | Nothing | **Entirely absent**: no tables, no cadence lib, no generation job, no API, no UI |
| *(supporting)* Report-defect auto-creation | Report defects auto-create work orders | `report_submissions.payload_json` exists; `source_type='report'` allowed | No defect field convention, no extraction, no creation hook |
| *(supporting)* Notifications | `work_order.overdue` → in_app/email | Event seeded; routing lib (`resolveRoute`) exists | Nothing enqueues `notification_jobs`; no worker drains them |

## 3. Phased task list

Conventions for every task: routes follow the `register*Routes(router, {authenticate, sendJson, readBody})` shape with `withAuth` → validate-shape-first (400 before any fetch) → `requireAuthPermission` → `pgSelect/pgInsert/pgUpdate`; unit tests mirror `test/work-orders-routes.test.mjs` (stubbed `globalThis.fetch`, `MANAGER`/`READER`/`OUTSIDER` membership fixtures); every task must pass the full gate.

### Phase M1 — MVP-complete (close the Maintenance MVP-light scope)

**WO-01 — Comment thread endpoints (`work_order_updates`)** — *S/M*
`GET /work-orders/:id/updates` (chronological) and `POST /work-orders/:id/updates` (comment body, `update_type='comment'`). Load the parent work order first, guard on **its** `facility_id`, stamp `facility_id` from the parent row rather than trusting the body.
- Files: `src/lib/http/work-orders-routes.mjs`, `test/work-orders-routes.test.mjs`.
- Acceptance: reader can GET, reader gets 403 on POST, non-member 403 on both, 404 when parent missing, inserted row carries parent `facility_id` + `created_by = auth.claims.sub`, empty body → 400 with no fetch.
- Tests: 6+ unit tests. RLS SQL: covered by WO-08.

**WO-02 — Status lifecycle in the domain lib + auto-history on PATCH** — *M*
Add `canTransition(from, to)` and `applyStatusChange(workOrder, next, now)` (legal transitions only; `resolved`/`closed`/`cancelled` set `completed_at`; reopening clears it). Make `PATCH` validate the transition (409 on illegal), accept `priority`, and write a `work_order_updates` row per changed field with `previous_value`/`new_value`.
- Files: `src/lib/work-orders.mjs`, `src/lib/http/work-orders-routes.mjs`, both test suites.
- Acceptance: `open→in_progress→resolved→closed` allowed; `closed→in_progress` rejected 409; each accepted PATCH emits exactly one history row per changed field; `completed_at` set on resolve; unknown status/priority values rejected 400 before any fetch.

**WO-03 — Create work order from an incident** — *M*
`POST /incidents/:id/work-orders`: loads the incident, requires `incidents.read` **and** `work_orders.manage` on the incident's facility, builds the row via `createWorkOrderFromIncident(incident, defaults, config)`, returns 201. Optionally link back via `incident_followup_actions` with `action_type='equipment_fix'`.
- Files: `src/lib/http/work-orders-routes.mjs`, `src/lib/work-orders.mjs`, `test/work-orders-routes.test.mjs`.
- Acceptance: created row has `source_type='incident'`, `source_id=<incident id>`, facility inherited from the incident (never from the body), severity→priority mapping matches the lib; a user with `incidents.read` but not `work_orders.manage` gets 403; 404 on unknown incident.

**WO-04 — SLA-driven `due_at` + an effective-config loader for `/api/v1`** — *M*
Shared helper (e.g. `src/lib/http/module-config.mjs`) that loads org + facility settings layers and returns `effectiveConfig(...)`, memoized per request. On create, when `due_at` is absent, derive from `workOrderDueAt(row, config)`; when `priority` is absent, use `workOrders.defaultPriority`.
- Files: new `src/lib/http/module-config.mjs`, `src/lib/http/work-orders-routes.mjs`, `test/module-config.test.mjs`, `test/work-orders-routes.test.mjs`.
- Acceptance: with `workOrders.slaHoursUrgent=6`, an `urgent` WO created at T gets `due_at = T+6h`; an explicit `due_at` always wins; config fetch failure degrades to registry defaults rather than 500.

**WO-05 — List filtering, sorting and pagination** — *S/M*
`?priority=`, `?assignee=`, `?asset=`, `?department=`, `?overdue=true`, `?limit=`/`?offset=` (bounded, default 50, max 200) and an `?order=` allowlist. Reject unknown enum values with 400 before fetching.
- Files: `src/lib/http/work-orders-routes.mjs`, `test/work-orders-routes.test.mjs`; note `pgSelect` currently only supports `eq.` filters — the `in.`/`lt.` shapes need a small extension in `src/lib/supabase-rest.mjs` (cover in `test/supabase-rest.test.mjs`).

**WO-06 — Attachment metadata endpoints** — *M*
`GET/POST /work-orders/:id/attachments` recording `storage_path`, `mime_type`, `checksum`, `metadata`. Server derives the path as `facilities/{facility_id}/work-orders/{work_order_id}/{uuid}` — never accept a client-supplied path — and validates mime against an allowlist.
- Acceptance: client-supplied `storage_path` ignored; disallowed mime → 400; reader can list, only `work_orders.manage` can create. **Blocked on** the storage decision for actual upload/signed URLs (WO-14).

**WO-07 — Fix the manage-policy soft-delete leak** — *S*
New migration re-creating the four `work_orders`-family `for all` manage policies with `deleted_at is null` in both `USING` and `WITH CHECK` (or splitting into explicit `insert`/`update`/`delete` policies). Idempotent, matching 0009 style.
- Files: new migration, new `supabase/tests/work_orders_scope.sql` (shared with WO-08).
- Acceptance: a `work_orders.manage` holder cannot SELECT or UPDATE a soft-deleted row; `npm run db:verify` passes. Flag the identical pattern on incidents/reports to the orchestrator.

**WO-08 — RLS SQL proof for the work-orders family** — *M*
`supabase/tests/work_orders_scope.sql`: cross-facility isolation on all four tables; `work_orders.read` cannot insert/update; child rows unreachable when the parent facility is not the caller's; a `work_order_updates` row whose `facility_id` disagrees with its parent is rejected or invisible; the WO-07 soft-delete assertion. Consider a facility-consistency trigger (mirroring `fn_membership_department_facility` in 0023) if the test shows child rows can carry a foreign `facility_id`.

**WO-09 — Input hardening + dead-code cleanup** — *S*
Remove the unused `authCanAccessFacility` import; validate `priority`/`status` against the DB check-constraint enums in JS; verify `asset_id`, `department_id`, `assigned_to_employee_id` resolve to the **same facility** before insert; reject `facility_id` in bodies.
- Acceptance: a cross-facility `asset_id` → 400/404, never a 500 from a Postgres FK/RLS error.

**WO-10 — Real end-user Work Orders UI** — *M/L*
Filter chips (open / mine / overdue / priority), create form (title, description, priority, asset, assignee, due date), detail view with the comment thread, status/assign actions — all through `apiFetch`, preserving `escapeHtml` and the strict CSP (no inline handlers).
- Files: `src/public/index.html`, `src/public/js/app.js`, `src/public/styles.css`.
- Acceptance: list paginated (no longer truncated at 5); create → list refresh without reload; comment posts and appears; a reader sees no write controls; 403s surface as inline errors.

### Phase M2 — Phase-2 features (asset registry, SLA tracking, recurring PM)

**WO-11 — Assets registry: schema extension** — *S/M*
Migration adding `category`, `criticality` (check-constrained), `metadata jsonb`, `install_date`, `warranty_expires_at` to `assets`, plus an index on `(facility_id, category)`; extend seed rows. Idempotent (`add column if not exists`).

**WO-12 — Assets CRUD API** — *M*
`GET/POST /facilities/:facilityId/assets`, `GET/PATCH /assets/:id`, with `?status=`/`?category=`/`?q=` filters. **Permission decision:** stay on `work_orders.read`/`work_orders.manage` versus adding `assets.manage` — recommend staying on the existing pair unless the pilot demands otherwise; document the decision.
- Acceptance: unique `(facility_id, asset_tag)` violation → 409 not 500; retire does not cascade-delete work orders.

**WO-13 — Asset UI + picker** — *S/M*
Asset list/detail panel and an asset picker on the WO create form; WO detail shows the asset and its open-WO count.

**WO-14 — Storage integration for attachments (signed URLs)** — *L*
Server-issued upload URL (`POST /work-orders/:id/attachments/upload-url`) and short-TTL signed download URLs on read. Facility-scoped bucket paths, size/mime limits, checksum recorded on confirm. **This is the shared platform storage work — build generically in `src/lib/storage.mjs` so report/incident attachments reuse it.**
- Acceptance: signed URLs expire; a user without `work_orders.read` on the row's facility cannot obtain a download URL; paths always facility-prefixed; no service-role key ever reaches the browser. **Opus security review required.**

**WO-15 — SLA tracking columns + domain state** — *M*
Migration adding `sla_due_at`, `first_response_at`, `sla_breached_at`, `resolved_at` with a partial index on open+breaching rows; backfill `sla_due_at` from `due_at`. Add `slaState(workOrder, config, now)` → `{ state: 'on_track'|'at_risk'|'breached', dueAt, remainingHours }` and expose in list/detail responses.
- Acceptance: `sla_due_at` set on create from resolved config; `first_response_at` stamped by first comment or first status change off `open`; breach computed, never client-supplied.

**WO-16 — Overdue detection → notification enqueue** — *M*
Enqueue `notification_jobs` for the seeded `work_order.overdue` event using `resolveRoute` + `expandDistributionList` + `isWithinQuietHours`; follow the insert shape at `src/lib/http/notification-routes.mjs:319`. Runs as `scripts/work-order-sla-scan.mjs` so it works with or without the platform worker.
- Acceptance: idempotent per (work order, breach window); only open statuses considered; respects quiet hours except for `urgent`. **Delivery depends on the platform notification worker.**

**WO-17 — Recurring PM: schema** — *M*
New tables `pm_plans(...cadence_type check ('interval','seasonal'), interval_days, anchor_date, lead_time_days, ..., last_generated_at)` and `pm_plan_occurrences(..., unique(pm_plan_id, scheduled_for))`. RLS on `work_orders.read`/`work_orders.manage`, `deleted_at is null` on read policies from the start, `for all` policies written per WO-07's corrected pattern. **Must add both tables to `scripts/verify-migrations.mjs` `requiredRlsTables`.** Also widen the `work_orders.source_type` check constraint to allow `'pm'`.

**WO-18 — PM cadence domain lib** — *M*
`src/lib/preventive-maintenance.mjs`: `nextOccurrence(plan, after)`, `occurrencesInWindow(plan, from, to)`, `workOrderFromPlan(plan, occurrence, config)` (mirroring `createWorkOrderFromIncident`, `source_type='pm'`). Pure, no I/O.
- Acceptance: DST-safe day arithmetic; `lead_time_days` shifts generation, not the due date; inactive plans generate nothing. Table-driven cadence tests incl. leap day and month-end anchors.

**WO-19 — PM generation job** — *M*
`scripts/pm-generate.mjs`: for each active plan, generate occurrences inside the horizon (`workOrders.pmHorizonDays`, a new settings-registry key inserted contiguously in the `work_orders` block) and insert the paired work order + occurrence row, relying on `unique(pm_plan_id, scheduled_for)` for idempotency.
- Acceptance: running twice creates one work order; a conflict on the unique index is swallowed, not fatal.

**WO-20 — PM API + UI** — *M/L*
`GET/POST /facilities/:facilityId/pm-plans`, `GET/PATCH /pm-plans/:id`, `GET /pm-plans/:id/occurrences`, plus a "Preventive maintenance" sub-panel with an upcoming-occurrences calendar strip.
- Acceptance: creating a plan with a past anchor does not backfill history; deactivating stops future generation but leaves generated WOs.

**WO-21 — Report-defect auto-creation** — *M*
Define the defect convention in `src/lib/report-schema.mjs` (fields flagged `isDefect` in the template version), add `extractDefects(submission, templateVersion)`, and hook the report submit route to create work orders with `source_type='report'`. Gate on a new setting `workOrders.autoCreateFromReportDefects` (default off for pilots).
- Acceptance: a WO-creation failure must not roll back or 500 the submission (log + surface a partial-success field); no duplicate WOs on resubmit; the created WO's `created_by` is the submitter even without `work_orders.manage` (an explicit, documented server-side elevation — **security review required**).

### Phase M3 — Polish / automation

**WO-22 — Backlog & SLA dashboard aggregates** — *M* — `GET /facilities/:facilityId/work-orders/summary` returning open counts by status/priority, overdue count, median age, SLA breach rate. Aggregation in the domain lib over a bounded fetch.

**WO-23 — Work order PDF / export** — *M* — Reuse `src/lib/admin/pdf.mjs` for a single-WO PDF (header, timeline of updates, attachment manifest), mirroring the incident summary PDF pattern.

**WO-24 — Audit + soft-delete/cancel semantics** — *M* — `DELETE /work-orders/:id` → soft delete (`deleted_at`, `status='cancelled'`); emit `audit_events`/`outbox_events` for create/status/assign/delete, consistent with the hash chain (0010/0013).

**WO-25 — Entitlement / module gating** — *S/M* — Gate M2 automation (PM + SLA notifications) behind "Ops Plus" packaging using `src/lib/admin/entitlements.mjs`; base WO CRUD stays in Core Ops. Entitlement checks never widen access, only narrow it.

**WO-26 — Maintenance-window awareness for PM scheduling** — *M* — Consult scheduling (`schedule_periods`, `schedule_shifts`) so PM occurrences land in staffed windows; `nextWorkingOccurrence` in the PM lib. Occurrences shift forward, never backward; unstaffed-window plans still generate with a flag.

**WO-27 — Module security review + full gate** — *M* — End-to-end review of guard ordering, facility inheritance, storage paths, and the report-defect elevation; run the complete gate and the live RLS suite. No route trusts a body-supplied `facility_id`.

## 4. Dependencies

- **Incidents module** — WO-03 needs `incident_reports` reads and the `incidents.read`+`work_orders.manage` dual guard; optional linkage writes to `incident_followup_actions`. If incidents adds its own "create work order" button, both must produce identically shaped rows — keep the mapping in `src/lib/work-orders.mjs`, not duplicated.
- **Reports module** — WO-21 requires a defect field convention in template versions; there is **no `defect` concept anywhere in the schema or lib today**, so this needs a schema-lite decision. Defect extraction must run at submit time (submissions are immutable after submit).
- **Storage** — WO-06 (metadata) can ship without it; WO-14 (upload/signed URLs) is blocked on the platform storage decision. Build once in `src/lib/storage.mjs`, consume from three modules. Highest security risk in the plan.
- **Notifications** — WO-16 depends on the seeded `work_order.overdue` event and routing helpers. **Nothing drains `notification_jobs` today**; WO-16 enqueues correctly regardless, but the user-visible outcome is blocked on the platform worker. Do not build a work-order-specific delivery path.
- **Scheduling (maintenance windows)** — WO-26 reads scheduling tables; soft dependency, M3 only.
- **Cross-cutting gates** — new tables must be added to `scripts/verify-migrations.mjs` `requiredRlsTables`; new settings keys must sit contiguously in the `work_orders` block (`scripts/gen-settings-check.mjs`); new permission codes must appear in `src/lib/permissions.mjs`, `supabase/seed.sql`, and any referencing migration together. Migration numbering starts at **0024** — sequence to avoid collisions between parallel agents.

## 5. Suggested agent / model assignment

| Task | Model | Rationale |
|---|---|---|
| WO-01 Comment thread endpoints | **Haiku** (Sonnet review) | Direct copy of the existing route pattern; reviewer verifies facility stamping |
| WO-02 Status lifecycle + auto-history | **Sonnet** | Transition matrix and history semantics are design decisions |
| WO-03 Create-from-incident | **Sonnet** | Cross-module dual guard + facility inheritance; a classic privilege-escalation surface |
| WO-04 SLA due_at + config loader | **Sonnet** | New shared infrastructure consumed by other modules |
| WO-05 List filters/pagination | **Haiku** (Sonnet if `supabase-rest` is extended) | Mechanical, with an existing assert-the-query-string test pattern |
| WO-06 Attachment metadata endpoints | **Sonnet** | Server-derived paths and mime allowlist are security-bearing |
| WO-07 Manage-policy soft-delete fix | **Sonnet** authors, **Opus** reviews | RLS policy semantics; a wrong fix silently widens access |
| WO-08 RLS SQL proof | **Sonnet** | RLS/SQL test authoring |
| WO-09 Input hardening / cleanup | **Haiku** (Sonnet review) | Mechanical edits against a clear checklist |
| WO-10 Work Orders UI | **Haiku** markup/CSS, **Sonnet** fetch/permission logic | CSP-safe wiring needs care |
| WO-11 Assets schema extension | **Haiku** | Idempotent `add column if not exists` |
| WO-12 Assets CRUD API | **Haiku** build, **Sonnet** review | Pattern copy; permission-code decision escalated to Opus |
| WO-13 Asset UI + picker | **Haiku** | Static wiring against a shipped endpoint |
| WO-14 Storage / signed URLs | **Sonnet** build, **Opus** security review | Key custody and URL TTL are the highest-risk surface |
| WO-15 SLA columns + state | **Sonnet** | Backfill migration + server-authoritative breach computation |
| WO-16 Overdue → notifications | **Sonnet** | Idempotency, quiet hours, dedupe |
| WO-17 PM schema | **Sonnet** | New tables + RLS from scratch; must not repeat the WO-07 mistake |
| WO-18 PM cadence lib | **Sonnet** (Haiku writes table-driven tests) | Pure but subtle (DST, month-end, lead time) |
| WO-19 PM generation job | **Sonnet** | Idempotency under retry; settings gate |
| WO-20 PM API + UI | **Haiku**, **Sonnet** review | Mechanical once WO-17/18/19 fix the semantics |
| WO-21 Report-defect auto-creation | **Sonnet** build, **Opus** security review | Cross-module write with documented server-side elevation |
| WO-22 Dashboard aggregates | **Haiku** | Pure aggregation over a shipped read path |
| WO-23 Work order PDF | **Haiku** | Copies `pdf.mjs` and the export disposition pattern |
| WO-24 Audit + soft-delete semantics | **Sonnet** | Touches the hash-chained audit backbone |
| WO-25 Entitlement gating | **Sonnet** | Must narrow, never widen, access |
| WO-26 Maintenance-window awareness | **Sonnet** | Cross-module scheduling semantics |
| WO-27 Security review + full gate | **Opus (orchestrator)** | Final integration and security gate |

**Parallelization:** WO-01, WO-05, WO-09 and WO-11 are independent and can fan out immediately to Haiku agents in isolated worktrees. WO-02 → WO-03 → WO-04 are sequential. WO-07 must land before WO-08 finalizes its assertions. WO-17 → WO-18 → WO-19 → WO-20 is a strict chain. WO-14 and WO-16 are the two items with external blockers (storage decision, notification worker) and should be scheduled where their blockers resolve, not by phase order.
