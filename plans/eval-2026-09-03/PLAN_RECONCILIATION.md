<!-- Evidence report generated 2026-09-03 by a Sonnet evaluation agent for REC_REPORTS_360_EVALUATION_AND_FINISH_PLAN.md; headline claims re-verified by the orchestrator. Screenshot and scratch paths referenced below were session-local and are not in the repo. -->

# Rec Reports — Plan vs. Code Ground-Truth Matrix

Evaluated at HEAD `8d9b0d7` (2026-08-19), tip of `main`, working tree clean, checked against
`MODULE_DEVELOPMENT_MASTER_PLAN.md` + `plans/*.md` (168 tasks) and `PHASED_MVP_ROADMAP.md` §1.2/§8.1.

**Status update 2026-09-06 (Wave 1 landed on `claude/wave1-review-fixes`, PR #18):** five rows changed
since the evaluation — DR-34, WO-27, OP-05 and OP-24 are DONE and IN-24 is PARTIAL, all on the strength of
`plans/SECURITY_REVIEW_2026-09.md` (the S-12 sign-off) and migrations 0040–0049; the rollup tables in §2
are updated in place and each changed row is dated. Everything else below is still as evaluated at
`8d9b0d7`. Claim 3 in §4 ("WO-27 / OP-24 are not closed by a dedicated artifact") is resolved by that
document; the `message_audiences.audience_ref_id` gap it mentions is closed by migrations 0047/0048.

**Status update 2026-09-07 (Wave 2 open as PRs #19, #20, #21, #24):** nine more rows changed — IN-10, IN-12,
SC-08, CM-09, CM-11 and OP-12 are DONE, IN-11 and CM-14 are PARTIAL (witness statements only; email but no
SMS), and CM-07's evidence now names a real FCM adapter. Every M1 task is now DONE or owner-only. Rollups
below are updated in place.

**Method notes**

- Local gate re-run during this evaluation: `npm test` → **1311/1311 pass**; `format:check`, `lint`,
  `typecheck` (26 permission codes, 15 settings keys) and `db:verify` (39 migrations) all **pass**.
  `db:test:rls` (`supabase/tests/*.sql`) could **not** be re-run here — no local Postgres/`DATABASE_URL`
  in this sandbox — so RLS SQL results below are taken from the commit record (`aefc28f`, `d6f5917`:
  "21/21" after the seed fix) plus source-level policy inspection, not independently re-executed.
- For every task marked DONE below I opened the named route file, confirmed the endpoint(s) exist with
  `router.register(...)`, and for a sample (≥3 per module, listed under "Spot-checks") traced
  route → validation → permission guard → PostgREST call → matching migration/RLS policy → test file.
- Git history from `3681e84` (the plan's baseline commit) to `HEAD` is 42 commits, all carrying explicit
  task-ID references in the subject/body except the RLS audit and one seed-fix commit (also inspected).
  I did not find a single M2 or M3 task ID implemented ahead of schedule; every M2/M3 mention found in
  code is a forward-reference comment ("X is unbuilt", "blocked on Y") — grepped and confirmed below.
- "OWNER-ONLY" = requires a human action outside the repo (Vercel/Supabase dashboard, DNS, billing) that
  cannot be verified from source; classified per the plan's own "Owner action?" column.

---

## 1. Per-module task tables

### Daily Reports (DR-01 … DR-34) — `plans/DAILY_REPORTS_PLAN.md`

| Task | Title | Status | Evidence | Missing (if not DONE) |
|---|---|---|---|---|
| DR-01 | PostgREST range filters (gte/lte/in, offset, count) | DONE | `src/lib/supabase-rest.mjs` operator-tagged filters; `test/supabase-rest.test.mjs`; commit `66380fb` | — |
| DR-02 | Write-side RLS for templates/versions | DONE | `supabase/migrations/0028_report_template_writes.sql` (INSERT/UPDATE on `reports.template.manage`, publish-immutability trigger); `supabase/tests/report_templates.sql`; commit `eadb7cf` | — |
| DR-03 | Template lifecycle domain lib | DONE | `src/lib/report-templates.mjs` (`nextTemplateVersionNumber`, `buildTemplateDraftUpdate`, `buildTemplatePublish`, `validateTemplateInput`) | — |
| DR-04 | Template management API | DONE | `src/lib/http/report-templates-routes.mjs` CRUD/publish/archive; `test/report-templates-routes.test.mjs` | — |
| DR-05 | Governance permission codes | DONE | `reports.publish`/`reports.workflow.manage`/`reports.distribution.manage` in `src/lib/permissions.mjs` + seed; commit `a2f3fc5` | — |
| DR-06 | Form-builder → report-template promote bridge | DONE | `POST /forms/:id/promote` in `src/lib/http/forms-routes.mjs`/`src/lib/admin/forms.mjs`; commit `1d0c827`; 47 tests | — |
| DR-07 | Draft/submit hardening (unknown-key rejection, submit_policy) | DONE | `src/lib/http/reports-routes.mjs:413-` PATCH/submit, `validateReportSubmissionPartial`, `unknownPayloadKeys`; commit `6b463cb` | — |
| DR-08 | List filters/pagination + detail-with-schema | DONE | `GET /facilities/:id/reports` (from/to/department/submitted_by/limit/offset), `GET /reports/:id/detail` — `src/lib/http/reports-routes.mjs:227-350` | — |
| DR-09 | Attachment upload via Storage | DONE | Delivered as the shared `src/lib/http/attachments-routes.mjs` (module=`reports`, parent `report_submissions`) atop `src/lib/storage.mjs` (OP-15/16); gated on `reports.submit` (fixed mid-Wave-1, see commit `9a025bb`) | — |
| DR-10 | Submission lifecycle audit events (hash-chained) | DONE | `fn_report_submission_audit` trigger, `supabase/migrations/0033_report_audit_and_scope.sql`; `supabase/tests/report_audit.sql`; commit `c3b899a` | — |
| DR-11 | Department-scoped reports RLS + JS guard parity | DONE | `hasDepartmentPermission`/`requireRowDeptPermission` in `reports-routes.mjs:121-`; 4-arg RLS policies in `0033`; commit `c3b899a` | — |
| DR-12 | Compliance dashboard endpoint | DONE | `GET /facilities/:id/reports/compliance`, `src/lib/reports-compliance.mjs`; `reports-routes.mjs:527-566` | — |
| DR-13 | Schema-driven entry UI | DONE | `src/public/js/report-form.mjs` (pure, unit-tested) + wiring in `app.js`; commit `31c4c1a`, 11 tests | — |
| DR-14 | Manager review inbox UI | DONE | Filter bar + detail pane in `app.js`, same commit `31c4c1a` | — |
| DR-15 | Single-submission PDF export | DONE | `GET /reports/:id/pdf`, `src/lib/admin/report-pdf.mjs`, gated `reports.export` + `reports.pdf_export` flag, draft→409; `reports-routes.mjs:571-` | — |
| DR-16 | Field-type/validation-rule expansion (13 types, regex, visibility) | NOT STARTED | `src/lib/report-schema.mjs:1-17` — still exactly 10 types, no `datetime`/`counter`/`rating`, no `validation_rules`/`visibility_rules` | Everything in the task |
| DR-17 | Signatures table + route | NOT STARTED | No `report_submission_signatures` table in any migration; grep for "signature" in reports schema empty | Table, route, submit-time check |
| DR-18 | Workflow rule engine (pure) | NOT STARTED | No `evaluateWorkflow` anywhere in `src/lib` | Whole task |
| DR-19 | Workflow event ledger + outbox | NOT STARTED | No `report_workflow_events` table | Whole task |
| DR-20 | Workflow execution → incidents/work orders | NOT STARTED | Dependent on DR-18/19, neither exists | Whole task |
| DR-21 | Report distribution lists/deliveries | NOT STARTED | No `report_distribution_lists`/`_deliveries` tables | Whole task |
| DR-22 | Email delivery worker + provider adapter | NOT STARTED | No `sendEmail`/provider code anywhere (see OP-12 below — platform-wide gap) | Whole task |
| DR-23 | PDF snapshot pipeline on submit | NOT STARTED | `pdf_status` still unwritten outside seed; no queue-driven renderer | Whole task |
| DR-24 | Lock/revise lifecycle | NOT STARTED | Explicitly flagged unbuilt in code comment, `reports-routes.mjs:662` ("DR-24 (lock/revise) has not landed yet") | `/reports/:id/lock`, `/revise`, RLS extension |
| DR-25 | Offline-first submission runtime | NOT STARTED | Comment in `0033_report_audit_and_scope.sql:8` flags it explicitly unbuilt; no IndexedDB code in `src/public/js` | Whole task |
| DR-26 | Template governance (two-step publish) | NOT STARTED | No use of `admin_change_requests` from report-template routes | Whole task |
| DR-27 | Reports settings registry keys (submit policy default, caps, digest hour, retention) | PARTIAL | `settings-registry.mjs` has only the pre-existing 3 `daily_reports` keys (unchanged since plan baseline) | New keys never added |
| DR-28 | PDF/report access audit (`report.pdf_downloaded`/`viewed`) | NOT STARTED | No such event types emitted; PDF route doesn't insert an audit row | Whole task |
| DR-29 | Scheduled reminders/digests | NOT STARTED | No `report.missing` cron/script | Whole task |
| DR-30 | Notification dedupe + severity routing | NOT STARTED | No correlation-key cooldown logic for reports | Whole task |
| DR-31 | Retention, purge, legal hold | NOT STARTED | No purge script/legal_hold column for reports | Whole task |
| DR-32 | Admin builder polish (version compare, preview) | NOT STARTED | No diff/preview code in `forms.js` beyond baseline | Whole task |
| DR-33 | Performance/index pass (GIN indexes) | NOT STARTED | No GIN index migrations found | Whole task |
| DR-34 | Security review / threat model | DONE (2026-09-06) | `plans/SECURITY_REVIEW_2026-09.md` — signed-URL path handling, cross-tenant object reads and the publish separation of duties reviewed and re-proved (H-1, M-1, M-2, H1). Re-review DR-18/DR-20 workflow escalation when those ship | — |

**Spot-checks (DR):** DR-04 (`report-templates-routes.mjs` read fully — CRUD/publish/archive all present and 409-gated), DR-09 (traced `attachments-routes.mjs` → `storage.mjs` → migration `0030_storage.sql` bucket policy → test), DR-12 (`reports-compliance.mjs` pure calculator + route, date-range cap enforced).

**DR rollup:** DONE 16, PARTIAL 1, NOT STARTED 17, OWNER-ONLY 0 (of 34). *(updated 2026-09-06: DR-34 done)*

---

### Incidents (IN-01 … IN-25) — `plans/INCIDENTS_PLAN.md`

| Task | Title | Status | Evidence | Missing |
|---|---|---|---|---|
| IN-01 | Permission codes + seed (6 fine-grained codes) | DONE | `permissions.mjs` (`incidents.review/.escalate/.tasks.create/.legal_hold.manage/.export.pdf/.audit.view`); commit `a2f3fc5` | — |
| IN-02 | Status transition machine | DONE | `src/lib/incidents.mjs` transition matrix; `test/incidents.test.mjs`; commit `a4cc7e8` | — |
| IN-03 | Submit + transition routes with audit events | DONE | `POST /incidents/:id/submit`, `/status` — `incidents-routes.mjs:600-` | — |
| IN-04 | Amendments (append-only, snapshot hashes) | DONE | `POST/GET /incidents/:id/amendments`, `incidents-routes.mjs:723-`; migration `0032_incident_amendment_hardening.sql` adds the INSERT policy that was missing since 0004; `supabase/tests/incident_immutability.sql`; commit `8ab7493` | — |
| IN-05 | Follow-up actions CRUD | DONE | `incidents-routes.mjs:747-805` GET/POST/PATCH `/followups` | — |
| IN-06 | Escalation lifecycle (acknowledge/resolve) | DONE | `/escalations/:id/acknowledge`, `/resolve`, `/facilities/:id/incident-escalations` — `incidents-routes.mjs:349-478`; also fixed a snake_case bug in `escalationDueAt` per commit `8ab7493` | — |
| IN-07 | Attachments + Storage integration | DONE | Delivered via shared `attachments-routes.mjs` (module=`incidents`) + `storage.mjs`; commit `9a025bb` | — |
| IN-08 | Incident summary PDF | DONE | `GET /incidents/:id/export.pdf`, `src/lib/incident-pdf.mjs`; amendment watermark, draft watermark, `incident.exported` audit event; commit `4865502`; `test/incident-pdf.test.mjs` | — |
| IN-09 | Server-generated incident numbers | DONE | `nextIncidentNo` in `incidents.mjs:304-`, retry-on-conflict in `incidents-routes.mjs:230-245` | — |
| IN-10 | Capture form + detail UI | DONE (2026-09-07) | Wave 2 (PR #21): the people section renders the real list, add-person form and statement history from the new IN-12 routes | — |
| IN-11 | Schema completion migration (witness statements, signatures, compliance checks) | PARTIAL (2026-09-07) | Wave 2 (PR #21): migration 0050 adds `incident_witness_statements` (versioned, append-only, sign-once) with RLS and tests; signatures, compliance checks and training triggers are not built | Signatures, compliance checks, training triggers (Wave 3 IN-13+) |
| IN-12 | People & witness statement routes | DONE (2026-09-07) | Wave 2 (PR #21): `src/lib/http/incidents-people-routes.mjs` — people list/add/update/remove, statements list/add/sign, audit events, 27 route tests, `supabase/tests/incident_people_statements.sql` | — |
| IN-13 | Signatures route | NOT STARTED | Depends on IN-11 | Whole task |
| IN-14 | OSHA recordability decision tree | NOT STARTED | `classifyOshaReview` in `incidents.mjs` is still the original stub (unchanged since plan baseline) | Whole task |
| IN-15 | Compliance-check routes + evidence-completeness gate | NOT STARTED | No route | Whole task |
| IN-16 | Legal hold + retention controls | NOT STARTED | No `POST /incidents/:id/legal-hold`; `legal_hold` remains settable only at create | Dedicated toggle route, RLS hardening |
| IN-17 | Cross-module creation (followup→work-order, followup→training) | NOT STARTED | No `/incidents/:id/followups/:fid/work-order` or `/training-triggers` route (WO-03 covers the *incident→WO* direction generically, but not this specific followup-linked path) | Whole task |
| IN-18 | Legal packet PDF bundle | NOT STARTED | IN-08's PDF is single-section; no statements/evidence-index/packet-hash extension | Whole task |
| IN-19 | Supervisor review workspace UI | NOT STARTED | No split-pane review workspace beyond IN-10's detail drawer | Whole task |
| IN-20 | Notification emission on submit/escalate/SLA breach | NOT STARTED | No `notification_jobs` insert from incidents routes | Whole task |
| IN-21 | SLA breach auto-escalation sweep | NOT STARTED | No `scripts/incident-sla-sweep.mjs` | Whole task |
| IN-22 | Chain verification + access-audit endpoint | NOT STARTED | No `GET /incidents/:id/audit`; chain verify exists only generically (`admin/audit`, `OP-21`'s verify-all), not incident-scoped | Whole task |
| IN-23 | Dashboard/analytics polish | NOT STARTED | No `/facilities/:id/incidents/summary` route | Whole task |
| IN-24 | Rate limiting + break-glass read path | PARTIAL (2026-09-06) | Security-review half closed by `plans/SECURITY_REVIEW_2026-09.md` (incident write-path guards, legal hold, audit payload, durable throttle). No 429 on incident submit/export and no justification-capturing break-glass read path | Feature half (Wave 4) |
| IN-25 | Retention/purge honoring legal hold | NOT STARTED | No purge script | Whole task |

**Spot-checks (IN):** IN-04 (traced amendment route → `buildAmendment`/hash → migration `0032` INSERT policy → `supabase/tests/incident_immutability.sql`), IN-08 (traced PDF route → `incident-pdf.mjs` → deterministic-render test), IN-09 (formatter + retry-on-unique-violation confirmed in route body).

**IN rollup:** DONE 11, PARTIAL 2, NOT STARTED 12, OWNER-ONLY 0 (of 25). *(updated 2026-09-07: IN-10, IN-12 done; IN-11 partial; 2026-09-06: IN-24 partial)*

---

### Work Orders (WO-01 … WO-27) — `plans/WORK_ORDERS_PLAN.md`

| Task | Title | Status | Evidence | Missing |
|---|---|---|---|---|
| WO-01 | Comment thread endpoints | DONE | `GET/POST /work-orders/:id/updates`, `work-orders-routes.mjs:523-570` | — |
| WO-02 | Status lifecycle + auto-history on PATCH | DONE | `canTransition`/`applyStatusChange` in `work-orders.mjs`; PATCH writes history rows — `work-orders-routes.mjs:427-` | — |
| WO-03 | Create work order from incident | DONE | `POST /incidents/:id/work-orders`, dual guard `incidents.read` + `work_orders.manage`; commit `c483f0d` | — |
| WO-04 | SLA-driven `due_at` + module-config loader | DONE | `src/lib/http/module-config.mjs`; wired into create route | — |
| WO-05 | List filters/sorting/pagination | DONE | `priority/assignee/asset/department/overdue/limit/offset/order` in list route | — |
| WO-06 | Attachment metadata endpoints | DONE | Delivered via shared `attachments-routes.mjs` (module=`work-orders`) | — |
| WO-07 | Fix manage-policy soft-delete leak | DONE | Migration `0026_soft_delete_policy_hardening.sql` re-creates 20 manage policies with `deleted_at is null`; commit `258044b`; `supabase/tests/work_orders_scope.sql` | — |
| WO-08 | RLS SQL proof for work-orders family | DONE | `supabase/tests/work_orders_scope.sql`; also closed cross-facility FK gaps via `0035_work_order_facility_consistency.sql`; commit `12982bf` | — |
| WO-09 | Input hardening + dead-code cleanup | DONE | `authCanAccessFacility` dead import removed (commit `0c291d9`); asset/department/assignee cross-facility validation added (commit `12982bf`) | — |
| WO-10 | Real end-user Work Orders UI | DONE | `src/public/js/work-order-filters.mjs` + `app.js`; filter chips, create form, comment thread, status/assign actions; commit `0188302` | — |
| WO-11 | Assets registry schema extension | NOT STARTED | No `category`/`criticality`/`metadata`/`install_date` columns added to `assets` beyond baseline | Whole task |
| WO-12 | Assets CRUD API | NOT STARTED | No `/facilities/:id/assets` route | Whole task |
| WO-13 | Asset UI + picker | NOT STARTED | No asset picker in `app.js` | Whole task |
| WO-14 | Storage/signed URLs for attachments | DONE (superseded) | Actually delivered — the platform storage primitive (OP-15/16/17) provides exactly this, generically, ahead of WO-14's module-specific plan; signed download URLs confirmed in `attachments-routes.mjs` | — |
| WO-15 | SLA tracking columns + domain state | NOT STARTED | No `sla_due_at`/`first_response_at`/`sla_breached_at` columns; no `slaState()` helper | Whole task |
| WO-16 | Overdue detection → notification enqueue | NOT STARTED | No `scripts/work-order-sla-scan.mjs`; nothing enqueues `notification_jobs` for `work_order.overdue` | Whole task |
| WO-17 | Recurring PM: schema | NOT STARTED | No `pm_plans`/`pm_plan_occurrences` tables | Whole task |
| WO-18 | PM cadence domain lib | NOT STARTED | No `preventive-maintenance.mjs` | Whole task |
| WO-19 | PM generation job | NOT STARTED | No `scripts/pm-generate.mjs` | Whole task |
| WO-20 | PM API + UI | NOT STARTED | Depends on WO-17/18/19 | Whole task |
| WO-21 | Report-defect auto-creation | NOT STARTED | No `isDefect`/`extractDefects` in `report-schema.mjs`; report submit route doesn't create work orders | Whole task |
| WO-22 | Backlog & SLA dashboard aggregates | NOT STARTED | No `/work-orders/summary` route | Whole task |
| WO-23 | Work order PDF/export | NOT STARTED | No WO-specific PDF renderer | Whole task |
| WO-24 | Audit + soft-delete/cancel semantics | NOT STARTED | `DELETE /work-orders/:id` doesn't exist; comment in `0026_soft_delete_policy_hardening.sql:67` explicitly flags this as future work needing a SECURITY DEFINER RPC | Whole task |
| WO-25 | Entitlement/module gating (Ops Plus) | NOT STARTED | No entitlement check wraps WO M2 features (none of which exist yet) | Whole task |
| WO-26 | Maintenance-window-aware PM scheduling | NOT STARTED | Depends on WO-17/18 | Whole task |
| WO-27 | Module security review + full gate | DONE (2026-09-06) | `plans/SECURITY_REVIEW_2026-09.md` — guard ordering, facility inheritance and storage paths reviewed end to end; full gate (unit, RLS, replay, seed) green on the reviewed commit | — |

**Spot-checks (WO):** WO-02 (`canTransition`/`applyStatusChange` traced into the PATCH handler, confirmed history-row-per-field write), WO-03 (dual-permission guard traced, confirmed facility always inherited from the incident not the body), WO-08 (`work_orders_scope.sql` read — cross-facility isolation + soft-delete assertions present).

**WO rollup:** DONE 12 (WO-14 counted as delivered via the platform primitive), PARTIAL 0, NOT STARTED 15, OWNER-ONLY 0 (of 27). *(updated 2026-09-06: WO-27 done)*

---

### Scheduling (SC-01 … SC-24) — `plans/SCHEDULING_PLAN.md`

| Task | Title | Status | Evidence | Missing |
|---|---|---|---|---|
| SC-01 | Period lifecycle routes + transition guard | DONE | `canTransitionPeriod`, POST/PATCH `/schedule-periods` — `scheduling-routes.mjs:339-460` | — |
| SC-02 | Shift template CRUD | DONE | GET/POST/PATCH/soft-DELETE `/shift-templates` — `scheduling-routes.mjs:460-583` | — |
| SC-03 | Template expansion (DST-safe generate) | DONE | `POST /schedule-periods/:id/generate`, idempotent; DST bug in `zonedTimeToUtcMs` fixed and swept minute-by-minute across both 2026 transitions; commit `8578fff` | — |
| SC-04 | Shift edit routes | DONE | `PATCH /shifts/:shiftId`, reason-required-on-published-period path — `scheduling-routes.mjs:741-` | — |
| SC-05 | Assignment routes (assign/unassign, overlap 409) | DONE | `POST`/`PATCH` `/shifts/:shiftId/assignments`, reuses `shiftsOverlap`; commit `8578fff` | — |
| SC-06 | Fix validate route (settings-aware, period-scoped) | DONE | `POST /schedule/validate` reads live config + `roleRequirements`; commit `1ce1510` | — |
| SC-07 | Publish flow | DONE | `POST /schedule-periods/:id/publish`, new `schedule.publish` code (migration `0034_scheduling_publish.sql`), `buildChangeSummary`, override-reason path; commit `306c0a7` | — |
| SC-08 | Weekly schedule board UI | DONE (2026-09-07) | Wave 2 (PR #21): `GET /facilities/:id/shift-assignments?period_id=|shift_id=` under `schedule.read`; the board seeds `assignmentsByShiftId` from the server on load | — |
| SC-09 | Facility employees listing route | DONE | `GET /facilities/:id/employees` — `scheduling-routes.mjs:655-` | — |
| SC-10 | Migration for swaps/time-off/claims/availability | NOT STARTED | No `open_shift_claims`/`shift_swap_requests`/`time_off_requests`/`employee_availability` tables | Whole task |
| SC-11 | Open-shift claim lifecycle | NOT STARTED | Depends on SC-10 | Whole task |
| SC-12 | Swap requests | NOT STARTED | Depends on SC-10 | Whole task |
| SC-13 | Time-off requests | NOT STARTED | Depends on SC-10 | Whole task |
| SC-14 | Availability editor | NOT STARTED | Depends on SC-10 | Whole task |
| SC-15 | Employee self-service `/me/schedule` + UI | NOT STARTED | No `/me/schedule` route | Whole task |
| SC-16 | Approvals queue | NOT STARTED | No `/approvals` route | Whole task |
| SC-17 | Publish/decision notifications | NOT STARTED | Publish route doesn't enqueue `notification_jobs` | Whole task |
| SC-18 | Printable weekly schedule PDF | NOT STARTED | No print route | Whole task |
| SC-19 | Cert-expiry mid-period sweep | NOT STARTED | No `findExpiringCertImpacts` | Whole task |
| SC-20 | Department scoping for scheduling reads | NOT STARTED | `schedule_shifts`/`shift_assignments` policies still facility-wide only | Whole task |
| SC-21 | Swap/claim expiration + escalation | NOT STARTED | Depends on SC-10 | Whole task |
| SC-22 | Admin settings surface for scheduling keys | NOT STARTED | No admin UI panel added for scheduling settings beyond what already existed | Whole task |
| SC-23 | Mobile/day-view polish | NOT STARTED | No day-view/next-shift card found | Whole task |
| SC-24 | Hardening pass (audit log for publish/override/approvals) | NOT STARTED | Publish route writes no `audit_events`/`incident_audit_events`-style row | Whole task |

**Spot-checks (SC):** SC-03 (traced `expandTemplates`/DST fix and its minute-sweep test), SC-07 (traced publish route → migration `0034` INSERT policy on `schedule_publications` → RLS test), SC-08 (confirmed the documented assignment-read gap directly in `app.js`).

**SC rollup:** DONE 9, PARTIAL 0, NOT STARTED 15, OWNER-ONLY 0 (of 24). *(updated 2026-09-07: SC-08 done)*

---

### Communications (CM-01 … CM-18) — `plans/COMMUNICATIONS_PLAN.md`

| Task | Title | Status | Evidence | Missing |
|---|---|---|---|---|
| CM-01 | Fix RLS: self-service INSERT/UPDATE on receipts/acks | DONE | Migration `0025_communications_self_service_rls.sql`; route fix for `employee_id` resolution; commit `543f0ed`; `supabase/tests/communications_self_service.sql` | — |
| CM-02 | `message_audiences` CRUD routes | DONE | `GET/POST /messages/:id/audiences` — `communications-routes.mjs:339-` | — |
| CM-03 | Wire `resolveMessageAudience` into publish flow | DONE | `POST /facilities/:id/messages/:id/publish`; commit `af49b08`; fixed a live ref-accessor bug during integration | — |
| CM-04 | `communication_channels` CRUD routes | DONE | `GET/POST /facilities/:id/channels` — `communications-routes.mjs:401-` | — |
| CM-05 | Receipts routes (delivered/read marking) | DONE | `POST /messages/:id/receipt` upsert — `communications-routes.mjs:463-` | — |
| CM-06 | Notification delivery worker (v1: in-app) | DONE | Delivered as the platform-wide worker, `src/lib/notifications/worker.mjs` (`claimDueJobs`, `processJob`), consumed by CM-03's publish enqueue; commits `5c8b272`, `3f75910` | — |
| CM-07 | Push notification channel (device tokens + send) | DONE (FCM adapter 2026-09-07) | Migration 0037, `/me/device-tokens`, `/me/notification-preferences`; Wave 2 (PR #20) adds `src/lib/notifications/fcm.mjs` (FCM HTTP v1, OAuth2 via service account) behind `PUSH_PROVIDER=fcm`; browser-side FCM token minting is a stub because the messaging SDK cannot load under the self-only CSP | Browser token minting; owner credentials (`FCM_SERVICE_ACCOUNT_JSON`, `FIREBASE_WEB_CONFIG_JSON`) |
| CM-08 | UI: compose + channel/audience picker | DONE | `src/public/js/comms-compose.mjs` + `app.js`; commit `0188302` | — |
| CM-09 | UI: read-receipt auto-marking + ack state | DONE (2026-09-07) | Wave 2 (PR #21): `GET .../messages/:id/acknowledgements|receipts` (`employeeId=me`), the panel seeds its acknowledged set from the server so ack state survives reload | — |
| CM-10 | Required-ack escalation ladder | NOT STARTED | No `ack_state` transition sweep; no tier logic in `communications.mjs` beyond the M1 pure fns | Whole task |
| CM-11 | Ack/read compliance reporting endpoint | DONE (2026-09-07) | Wave 2 (PR #21): `GET .../messages/:id/compliance` and `GET .../communications/compliance-summary?from&to`, computed by `summarizeAckCompliance` (tested); shift-window audiences are excluded, mirroring the publish path | — |
| CM-12 | Shift-targeted messaging | NOT STARTED | `communications-routes.mjs:183` comment: "full current/next shift window computation is CM-12" — only a caller-supplied window is honored today | Whole task |
| CM-13 | Emergency mode | NOT STARTED | No `emergency_alert_responses` table, no `/emergency-broadcast` route | Whole task |
| CM-14 | SMS/email delivery channels | PARTIAL (2026-09-07) | Wave 2 (PR #20): email via `src/lib/notifications/email.mjs` (Resend, one POST per recipient) consumed by the worker with `email_enabled` honoured; no SMS channel | SMS channel; owner credentials (`EMAIL_API_KEY`, `EMAIL_FROM`) |
| CM-15 | Outbox retry/DLQ for jobs | DONE (superseded) | Delivered generically as part of the platform worker (OP-11: exponential backoff, `dead_letter` status) rather than as a CM-scoped task — same code serves both | — |
| CM-16 | WebSocket/live counters | NOT STARTED | No realtime layer; explicitly a spike per the plan | Whole task |
| CM-17 | Admin Comms Console | NOT STARTED | No admin-side comms template/emergency-launch UI | Whole task |
| CM-18 | Immutable audit log for comms admin actions | NOT STARTED | No `fn_audit_admin_change()` trigger added to `communication_channels`/`messages` | Whole task |

**Spot-checks (CM):** CM-01 (migration `0025` read in full — self-insert/update policies with `fn_assert_same_facility`), CM-03 (traced publish route → `resolveMessageAudience` → job enqueue shape matching worker's `processJob` expectations), CM-07 (confirmed `push.mjs`'s adapter is genuinely a no-op, not a placeholder claim — this is accurately self-documented in the code, not a false "done").

**CM rollup:** DONE 11 (CM-15 folded into the platform worker), PARTIAL 1, NOT STARTED 6 (of 18). *(updated 2026-09-07: CM-09, CM-11 done; CM-14 partial)*

---

### Training (TR-01 … TR-16) — `plans/TRAINING_PLAN.md`

| Task | Title | Status | Evidence | Missing |
|---|---|---|---|---|
| TR-01 | Employee-scoped assignment queries + My Queue | DONE | `?employeeId=`, `GET /me/training-assignments` — `training-routes.mjs:466-518` | — |
| TR-02 | Certification wallet endpoint + UI | DONE | `GET /facilities/:id/employee-certifications`; wallet panel in `app.js`; commit `88be67e` | — |
| TR-03 | Evidence upload plumbing | DONE | `POST /employee-certifications/:id/evidence`, `GET .../evidence-url`; reuses `storage.mjs`; commit `d0774b6` | — |
| TR-04 | Certification lifecycle event writer | DONE | `certificationEventFor` derives created/renewed/revoked from before/after diff; migration `0031_training_cert_writes.sql` adds append-only INSERT policy; commit `d0774b6` | — |
| TR-05 | Course/module admin CRUD (Training Studio) | DONE | `POST/PATCH /courses`, `/courses/:id/modules`; `src/lib/admin/training.mjs`; commit `88be67e` | — |
| TR-06 | Progress-aware completion | DONE | `assignmentReadyToComplete`, per-module `/progress` route, migration `0036_training_progress_writes.sql`; commit `af68371`; ownership rule further hardened by `fd95ad9`/`0039` | — |
| TR-07 | Quizzes table + pass-threshold enforcement | NOT STARTED | No `quizzes` table | Whole task |
| TR-08 | Video/PDF module content + course player | NOT STARTED | `content_jsonb` still free-form; no player UI; comment in `0030_storage.sql:48` flags TR-08 as future | Whole task |
| TR-09 | Cert-rule/role-rule auto-assignment | NOT STARTED | No `scripts/sync-training-assignments.mjs`; no `assignmentsForGaps` | Whole task |
| TR-10 | Incident-triggered corrective training | NOT STARTED | No hook from `incident_followup_actions` (`action_type='training'`) into `training_assignments` | Whole task |
| TR-11 | Certification expiry evaluator + notifications | NOT STARTED | No evaluator script; no `cert.expiring_soon`/`cert.expired` event codes seeded | Whole task |
| TR-12 | Scheduling qualification-gate hardening (expiring vs missing) | NOT STARTED | `summarizeScheduleReadiness` still treats certs as a binary gap, no three-way split | Whole task |
| TR-13 | Retraining policies + recurrence | NOT STARTED | No `retraining_policies` table | Whole task |
| TR-14 | Compliance dashboards | NOT STARTED | No new analytics aggregation beyond `cert-gaps` | Whole task |
| TR-15 | Suspension workflow (`auto_suspend_roles`) | NOT STARTED | No suspension logic reading that column | Whole task |
| TR-16 | Audit trail polish + immutable event export | NOT STARTED | `certification_events`/`training_completions` feed the hash chain generically (0013), but no dedicated export wiring via `admin/export.mjs` was added | Whole task |

**Spot-checks (TR):** TR-04 (`certificationEventFor` traced, confirmed revoke-wins-over-expiry-bump rule and that PATCH guard keys off the loaded row's own facility), TR-06 (traced `assignmentReadyToComplete` gating + migration `0036`'s self-service policy + the later `0039` ownership fix), TR-03 (evidence route confirmed reusing `storage.mjs`, not a parallel client).

**TR rollup:** DONE 6, PARTIAL 0, NOT STARTED 10 (of 16).

---

### Platform / Ops (OP-01 … OP-24) — `plans/PLATFORM_OPS_PLAN.md`

| Task | Title | Status | Evidence | Missing |
|---|---|---|---|---|
| OP-01 | Set `SUPABASE_JWT_SECRET` in Vercel | OWNER-ONLY | `.env.example` still ships placeholder values; nothing in-repo can confirm a live Vercel project value | Dashboard action, unverifiable from source |
| OP-02 | Remaining Vercel env vars | OWNER-ONLY | Same as OP-01 | Dashboard action |
| OP-03 | Connect repo + deploy | OWNER-ONLY | No CI/CD evidence of a live deployment target in-repo | Dashboard action |
| OP-04 | `search_path` pin migration | DONE | `supabase/migrations/0024_advisor_hardening.sql`; commit `5b82345` | — |
| OP-05 | SECURITY DEFINER RPC review | DONE (2026-09-06; live apply pending) | Migration `0042_internal_helpers.sql` moves the six scope/permission helpers into an unexposed `internal` schema and revokes EXECUTE from PUBLIC/anon and from trigger functions; proven by `supabase/tests/internal_helpers.sql` and the CI replay. Applying 0040–0049 to the live project still needs the owner's go | Live apply + advisor re-run |
| OP-06 | Enable leaked-password protection | OWNER-ONLY | Dashboard toggle, unverifiable from source | Dashboard action |
| OP-07 | Env-var rename with fallbacks | DONE | `env.mjs` `legacyNames` fallback map; commit `5b82345`; `test/env.test.mjs` covers both spellings | — |
| OP-08 | Post-deploy smoke script | DONE | `scripts/smoke.mjs`; commit `0c291d9` | — |
| OP-09 | Email provider decision (Resend/Postmark/SES) | OWNER-ONLY | No `EMAIL_PROVIDER_API_KEY`/`EMAIL_FROM` anywhere in `.env.example` or `env.mjs`; grep for "resend"/"sendEmail" across the repo is empty; plan's own agent-assignment table lists this as owner-only ("signup/DNS") | Owner decision, then OP-12 |
| OP-10 | Migration: delivery bookkeeping columns | DONE | `supabase/migrations/0029_delivery_bookkeeping.sql` (`last_error`, `next_attempt_at`, `dead_letter` status); commit `5c8b272` | — |
| OP-11 | Worker core (claim/expand/deliver/retry/dead-letter) | DONE | `src/lib/notifications/worker.mjs`; `test/notifications-worker.test.mjs`; commit `5c8b272` | — |
| OP-12 | Email channel adapter | DONE (2026-09-07) | Wave 2 (PR #20): `src/lib/notifications/email.mjs` + `adapters.mjs` (`buildAdaptersFromEnv`), worker email path, test-send route `channel` | — |
| OP-13 | Drain entry points (script + guarded route + cron) | DONE | `src/lib/http/internal-routes.mjs` (`CRON_SECRET`-guarded, 503 when unset, never open); `vercel.json` crons block; `scripts/notifications-worker.mjs`; commit `3f75910` | — |
| OP-14 | Outbox drain (translate events → jobs) | DONE | `drainOutboxOnce` in `worker.mjs`; commit `3f75910` | — |
| OP-15 | Storage bucket + policies migration | DONE | `supabase/migrations/0030_storage.sql`; SELECT-only `storage.objects` policy scoped to caller's facilities; commit `b845a7f` | — |
| OP-16 | Storage client | DONE | `src/lib/storage.mjs` (`buildAttachmentPath`, `uploadObject`, `createSignedUrl`, mime/size caps); `test/storage.test.mjs`; commit `b845a7f` | — |
| OP-17 | Attachment routes (3 modules) | DONE | `src/lib/http/attachments-routes.mjs`; `test/attachments-routes.test.mjs`; commit `9a025bb` | — |
| OP-18 | UI wiring for attachments | DONE | Lazy-loaded attachment panels in `app.js`; same commit `9a025bb` | — |
| OP-19 | Structured request logging | DONE | `handleRequest` one-JSON-line-per-request in `scripts/server.mjs`; commit `f64479c`; no-secrets test | — |
| OP-20 | Error reporting to `OBSERVABILITY_DSN` | DONE | `src/lib/observability.mjs`; fire-and-forget with whitelist payload; commit `b9088b3` | — |
| OP-21 | Scheduled audit-chain verification | DONE | `POST /internal/audit/verify-all`, daily Vercel cron; commit `b9088b3` | — |
| OP-22 | Backup/retention review + runbook | OWNER-ONLY | No `docs/` runbook found in repo | Owner action + doc |
| OP-23 | Auth-proxy throttle | DONE | Sliding-window limiter on `/auth/sign-in`, 5/email + 20/IP per 15 min; commit `a5eca94` | — |
| OP-24 | Security review gate (Opus review of OP-05/11/13/15-17) | DONE (2026-09-06) | `plans/SECURITY_REVIEW_2026-09.md` — two adversarial reviews plus two re-verification rounds over Wave 1 (migrations 0040–0049), every High/Medium/Low closed or accepted with rationale, each bound to a named test | — |

**Spot-checks (OP):** OP-11/13/14 (`worker.mjs` read end-to-end: `claimDueJobs` optimistic-claim → `processJob` → `drainOnce`/`drainOutboxOnce`; `internal-routes.mjs` guard logic confirmed 503-when-unset), OP-15/16/17 (migration `0030` → `storage.mjs` → `attachments-routes.mjs`, full chain), OP-20 (`observability.mjs` read in full — AbortController+timeout, whitelist payload confirmed by description; not independently re-tested here but code matches commit's stated behavior and its own test file exists).

**OP rollup:** DONE 18, PARTIAL 0, NOT STARTED 0, OWNER-ONLY 6 (OP-01, OP-02, OP-03, OP-06, OP-09, OP-22) (of 24). *(updated 2026-09-07: OP-12 done; 2026-09-06: OP-05 and OP-24 done)*

---

## 2. Rollup table

| Module | DONE | PARTIAL | NOT STARTED | OWNER-ONLY | Total |
|---|---|---|---|---|---|
| Daily Reports (DR) | 16 | 1 | 17 | 0 | 34 |
| Incidents (IN) | 11 | 2 | 12 | 0 | 25 |
| Work Orders (WO) | 12 | 0 | 15 | 0 | 27 |
| Scheduling (SC) | 9 | 0 | 15 | 0 | 24 |
| Communications (CM) | 11 | 1 | 6 | 0 | 18 |
| Training (TR) | 6 | 0 | 10 | 0 | 16 |
| Platform/Ops (OP) | 18 | 0 | 0 | 6 | 24 |
| **Total** | **83** | **4** | **75** | **6** | **168** |

### By plan milestone (M1/M2/M3, per each module's own plan phasing)

Each module plan phases its own tasks M1/M2/M3; OP's P1/P2/P3 are treated as the M1/M2/M3 equivalents
(matching `MODULE_DEVELOPMENT_MASTER_PLAN.md` §6's own rollup table, which does the same).

| Milestone | Planned | Done | Partial | Not started | Owner-only |
|---|---|---|---|---|---|
| M1 (MVP) | 67 | 63 | 0 | 0 | 4 |
| M2 (design-complete) | 62 | 11 | 2 | 48 | 1 |
| M3 (polish) | 39 | 9 | 2 | 27 | 1 |
| **Total** | **168** | **83** | **4** | **75** | **6** |

**Headline: all of M1 (MVP) is built and working — 63 of 67 fully (OP-05 closed by Wave 1's migration
0042 on 2026-09-06; IN-10, SC-08 and CM-09 closed by Wave 2 on 2026-09-07); the remaining 4 are pure
dashboard actions (OP-01/02/03/06).
M2 is *not* uniformly untouched, contrary to a surface read of the wave commits: because the platform
workstream front-loaded its storage and notification-worker primitives (both nominally OP "P2"/M2-phase
work) ahead of schedule to unblock every module's M1 slice, 9 of M2's 62 tasks are done — all of them
either OP-10/11/13–18 (storage + worker core) or WO-14 (storage-dependent, delivered generically by the
same primitive). No module's own M2 phase (new tables, new cross-module automations, richer workflows)
has begun — DR-16 onward, IN-11 onward, WO-11/15/17 onward, SC-10 onward, CM-10 onward, and TR-07 onward
are all NOT STARTED. M3 progress is confined to Platform/Ops' P3 slice (observability, audit-verify
cron, sign-in throttle) plus two folded-in items (CM-15 via the worker, WO-27 partially via the RLS
audit) — no module's own M3 phase has begun.**

---

## 3. MVP roadmap coverage (`PHASED_MVP_ROADMAP.md` §1.2 and §8.1)

### §1.2 Capabilities A–F

| Cap | Capability | Usable end-to-end today? | Evidence |
|---|---|---|---|
| A | Scheduling (templates, board, assign/unassign, conflict checks) | **Yes**, with a caveat | Templates (SC-02), generation (SC-03), assignment with 409 conflicts (SC-05), board UI (SC-08) all work through the API. Caveat: the board's assignment view is session-local (no `GET /shift_assignments`), so a second visit or a second user does not see assignments made in a prior session until the page's local cache happens to include them — a real but narrow gap, not a broken feature. |
| B | Reports (submission by department, configurable required fields, photo attachment, dashboard) | **Yes** | Full lifecycle: template author → publish → fill (schema-driven UI, DR-13) → submit → review inbox (DR-14) → attachments (DR-09/OP-17) → compliance dashboard (DR-12) → PDF (DR-15). All confirmed via route + test inspection. |
| C | Incidents (form, severity/type, evidence attachment, follow-ups, exportable PDF) | **Yes** | Capture UI (IN-10, minus the People placeholder) → submit/transition (IN-03) → evidence upload (IN-07) → follow-ups (IN-05) → summary PDF (IN-08). Amendments and escalation also work, exceeding MVP scope. |
| D | Maintenance/work orders (create from report/incident or manual, priority/status/assignee/due date, comment thread + attachments) | **Yes** | Manual create + create-from-incident (WO-03) both work; comment thread (WO-01); attachments (WO-06/OP-17); UI (WO-10). "Create from report" specifically (auto-creation on defect flag) is **not** built (that's WO-21/M2) — only the incident path and manual entry exist, which still satisfies the roadmap's "or manual entry" phrasing. |
| E | Communication (department + all-ops channels, priority announcements, read receipts + required ack, push + in-app) | **Partial** | Channels (CM-04), compose+publish (CM-03/CM-08), required-ack (CM-01/route), in-app delivery via the worker (CM-06) all work. Read-receipt *display* is session-local (CM-09 gap — no GET for `message_acknowledgements`). Push exists only as a documented no-op adapter (CM-07) — tokens register and the worker marks them "sent," but no device actually receives a push notification without a real APNS/FCM integration (OP-12-equivalent, not built). |
| F | Training (manual assignment, completion tracking, cert record + expiry + evidence upload) | **Yes** | Manual assignment (TR-01), completion with progress gating (TR-06), certification wallet with expiry status (TR-02), evidence upload (TR-03). All confirmed working end to end. |

### §8.1 Eight E2E journeys

| # | Journey | Status | Evidence |
|---|---|---|---|
| 1 | Create shift | **Yes** | `POST /facilities/:id/shifts` and `POST .../schedule-periods/:id/generate` both work (SC-02/03/04). |
| 2 | Submit report | **Yes** | Full DR-13 → submit chain confirmed, including 422 field-level errors and autosave. |
| 3 | Log incident | **Yes** | IN-10 capture form → `POST /incidents` → `POST /submit`; severity-gated mandatory fields confirmed. |
| 4 | Create work order | **Yes** | Manual create (WO-10 UI → `POST /work-orders`) and create-from-incident (WO-03) both work. |
| 5 | Send required-ack message | **Yes** | Compose UI (CM-08) → `POST /messages` → `POST .../publish` (CM-03) → worker enqueues in-app delivery (CM-06). |
| 6 | Acknowledge message | **Yes, with a caveat** | `POST /messages/:id/acknowledge` works and is RLS-correct (CM-01 fix verified against a real facility-scoped policy) — but the UI's display of *whether* a message is acknowledged is session-local (CM-09 gap), so the acknowledgement itself persists correctly server-side even though the UI badge may not reflect it accurately on reload. |
| 7 | Assign training | **Yes** | `POST /facilities/:id/training-assignments` (manual) works; `?employeeId=`/`/me/training-assignments` confirm employee scoping. |
| 8 | Mark training complete | **Yes** | `POST /training-assignments/:id/complete`, gated by `assignmentReadyToComplete` (module progress must be done first) and by the TR-06/0039 ownership rule (self or `training.manage`). |

**Verdict: 7 of 8 journeys fully usable end-to-end today; the 8th (acknowledge) works correctly at the API/DB layer but has a cosmetic UI staleness gap.** All 6 of roadmap §1.2's MVP capabilities are usable; one (E, Communication) has two real but narrow gaps (session-local ack/receipt display, no-op push delivery) that a pilot facility would notice within the first week.

---

## 4. Claims that don't hold

1. **`MODULE_DEVELOPMENT_MASTER_PLAN.md` §1 table** — as of its own **2026-08-13** authoring date, correctly describes a much thinner state (read-only UIs, missing write RLS, etc.). It is **not** a claim about current HEAD, but a reader skimming only that table without checking `git log` past `e3822aa` would draw a false conclusion about the *current* repo. Flagging this only because the file has no "superseded" marker — the 42 commits since then invalidate most of its "Biggest gaps" column.
2. **`push.mjs`'s CM-07 "push delivery" is honestly documented as a no-op**, so this is *not* a false claim in the code itself — but the Wave-3 PR merge commit's body ("communications ... push delivery") reads, out of context, as if real push notifications ship. They do not: `noopAdapter` marks every token "sent" without any network call. Anyone relaying "push notifications work" to a pilot customer based on that commit line alone would be wrong.
3. **WO-27 / OP-24 "security review" tasks are not closed by a dedicated review artifact.** The schema-wide RLS audit (`plans/RLS_AUDIT.md`) is genuinely thorough and closes 30 real findings, but it is *not* the module-scoped Opus security pass either plan calls for, and it explicitly leaves two items open (`training_completions` ownership — since resolved by `fd95ad9`/0039 — and `message_audiences.audience_ref_id`'s polymorphic-reference gap, still open at HEAD). A reader could mistake "the RLS audit happened" for "WO-27/OP-24 are done"; they are PARTIAL at best.
4. **`message_audiences.audience_ref_id`** — this table has RLS **write** policies for publishers per CM-02, but the FK is polymorphic and was explicitly *not* probed for cross-facility injection by the RLS audit (`plans/RLS_AUDIT.md:286-295`). This is a live, acknowledged, unresolved security gap in a shipped M1 feature (CM-02/CM-03) — worth surfacing prominently since it sits in the "DONE" column above but carries an open finding.
5. **`db:test:rls` "21/21 passing"** (claimed in commit `d6f5917`) could not be independently re-verified in this evaluation sandbox (no local Postgres). This isn't a false claim — the commit's own before/after methodology (empirical, against a real bootstrapped Postgres 16) is credible and well-documented — but it should be re-run as part of any finishing plan's first step, not assumed still green without a fresh CI run.
6. **DR-09/IN-07/WO-06 "attachment upload" claims** in each per-module plan describe module-specific storage builds; what actually shipped is a **single shared** `attachments-routes.mjs` covering all three. This is a *better* outcome than the plan asked for (no duplicated client, per the master plan's Rule for the orchestrator), not a false claim, but a reader diffing task-by-task against each module's plan file alone would wrongly conclude DR-09/IN-07/WO-06 are separate, unaccounted-for pieces of work.

---

## 5. Top 10 highest-value unfinished items (priority order)

1. **CM-11 (ack/read compliance rollup endpoint) + wiring the UI to it.** The single biggest "looks done but isn't" gap: required-acknowledgement is the module's headline MVP feature (roadmap §1.2.E) and its state is currently only visible per-browser-session. A pilot facility's compliance dashboard would show stale data on day one.
2. **`message_audiences.audience_ref_id` cross-facility guard.** A live, unresolved security finding in a shipped feature (not hypothetical — documented and explicitly deferred in `plans/RLS_AUDIT.md`). Small, well-scoped fix; should not wait for a "finishing plan," it's a today-sized patch.
3. **SC-08's missing `GET /shift_assignments`.** The weekly board — the flagship MVP capability A — silently misrepresents who's assigned to what across sessions/users. Cheap fix (a list route, following every other module's pattern) with outsized trust impact for a scheduling product.
4. **CM-07/CM-14/OP-09/OP-12 real push+email delivery.** Communication's whole value proposition (roadmap §1.2.E: "Push + in-app notifications") is currently in-app only; push is a documented no-op and email doesn't exist at all. This is the platform's largest remaining infra gap and blocks a dozen downstream M2/M3 tasks across every module (escalations, reminders, expiry alerts) per the master plan's own dependency table.
5. **OP-01/02/03 — go-live itself.** Everything above is moot for a real pilot until the app is actually deployed and login works; still fully OWNER-ONLY and unverifiable from source. Should be sequenced first in wall-clock time even though it's a "cheap" task.
6. **OP-05 — SECURITY DEFINER RPC posture decision.** Explicitly and repeatedly flagged as deferred ("tracked separately as OP-05") across two migrations; blocks a clean Supabase advisor report and is a prerequisite the plan itself calls out before any RLS-adjacent work should be considered fully closed.
7. **IN-11/12/13/14/15 (witness statements, signatures, OSHA tree, compliance checks).** This is the incidents module's own stated "legal-defensibility core" continuing into M2 — the amendments/audit chain (M1, done) only gets full value once compliance sign-off exists; right now `classifyOshaReview` is still a stub.
8. **WO-15/16 (SLA tracking + overdue notifications).** Maintenance's other headline MVP-adjacent promise ("SLA tracking" is explicitly Phase-2 per the roadmap, but overdue detection is the most natural next win once the notification worker — already built — exists to consume it); currently `due_at` exists but nothing tracks breach or alerts on it.
9. **TR-11 (certification expiry evaluator).** `certificationStatus()` is a pure function sitting unused by any scheduled process — certifications silently go stale with no alert to anyone, undermining the module's core "certification record storage" promise (roadmap §1.2.F) the moment a cert actually expires.
10. **DR-16 (field-type/validation-rule expansion).** The most-visible remaining gap in the reports module for actual template authors: no `datetime`/`counter`/`rating` fields, no regex/visibility rules — template authors are currently limited to the 10 baseline types with no conditional logic, which will surface as a support request in week one of any pilot.
