# Rec Reports — Module Development Master Plan

Date: 2026-08-13
Basis: seven parallel planning agents (one per operational module plus one for platform/operations), each grounded in a file-level read of this branch (tip of `main`, commit `3681e84`), the module design docs, and the live progress log in `TASK_LIST_AND_MULTI_AGENT_PLAN.md`.

This document is the synthesis and execution strategy. The full per-module detail — current state, gap analysis, every task with files, acceptance criteria, and tests — lives in `plans/`:

| Plan | Tasks | Planner model |
|---|---|---|
| `plans/DAILY_REPORTS_PLAN.md` | DR-01 … DR-34 | Opus |
| `plans/INCIDENTS_PLAN.md` | IN-01 … IN-25 | Fable (orchestrator tier) |
| `plans/WORK_ORDERS_PLAN.md` | WO-01 … WO-27 | Opus |
| `plans/SCHEDULING_PLAN.md` | SC-01 … SC-24 | Fable (orchestrator tier) |
| `plans/COMMUNICATIONS_PLAN.md` | CM-01 … CM-18 | Sonnet |
| `plans/TRAINING_PLAN.md` | TR-01 … TR-16 | Fable-directed (Sonnet) |
| `plans/PLATFORM_OPS_PLAN.md` | OP-01 … OP-24 | Fable (orchestrator tier) |

**168 tasks total** across six modules and the platform workstream, each sized (S/M/L), with acceptance criteria, test requirements (unit + RLS SQL where new query shapes appear), and a per-task agent/model assignment.

---

## 1. Where the product stands

Every module now has DB schema + RLS, a tested pure domain library, basic `/api/v1` routes, and a minimally wired end-user panel. The admin control center is complete. What remains is **depth**: lifecycle state machines, the write paths that don't exist yet, the two platform primitives every module is waiting on (file storage and a notification delivery worker), and the go-live steps only the owner can perform.

| Module | Schema | Domain lib | Routes | UI | Biggest gaps |
|---|---|---|---|---|---|
| Daily reports | ✅ | ✅ | 6 routes (draft/submit work) | Read-only list | Template management has **no write RLS at all**; no schema-driven entry form; attachments/PDF/workflow/distribution unbuilt |
| Incidents | ✅ (7 tables) | ✅ | 4 routes | Read-only list | Incidents are **stuck in `draft`** (no transition endpoint); amendments + audit ledger (the module's legal core) unwritten; no evidence, no PDF |
| Work orders | ✅ (4 tables) | ✅ | 4 routes | Read-only list | Comment thread/assets/create-from-incident routes missing; domain lib never called by routes; **manage-policy soft-delete leak** (WO-07) |
| Scheduling | ✅ (8 tables) | ✅ | 3 routes | Read-only stub | No templates/assignments/publish endpoints; validate route ignores live settings and role requirements; swaps/time-off tables don't exist |
| Communications | ✅ (7 tables) | ✅ | 4 routes | List + ack button | **Production RLS bug**: no INSERT policy on `message_receipts`/`message_acknowledgements` — the existing acknowledge route fails under real RLS (CM-01); no channels/audiences/receipts routes; nothing delivers |
| Training | ✅ (6+ tables) | ✅ | 4 routes | List + complete button | `certification_events` has **no writer anywhere**; no progress tracking, no evidence upload, no expiry evaluator, no Training Studio |
| Platform/ops | 23 migrations live | — | Auth + serverless adapter done | Sign-in done | **No notification worker, no storage client, no observability, not deployed**; `SUPABASE_JWT_SECRET` is the single true login blocker |

### Defects the planning agents found in existing code (fix first, they're cheap)

1. **CM-01** — missing self-service INSERT/UPDATE RLS on `message_receipts`/`message_acknowledgements`. The shipped acknowledge route is broken against the live database (routes use the user's JWT, so RLS applies). One migration + one RLS SQL test.
2. **WO-07** — the `for all` manage policies on the work-orders family (and the same pattern in incidents/reports) still expose soft-deleted rows to managers; 0009 only hardened the reader policies.
3. **SC-06** — the schedule validate route loads facility-wide data instead of per-period, never reads the registered `scheduling.*` settings, and ignores cert-policy role requirements — admin toggles currently do nothing.
4. Dead code: unused `authCanAccessFacility` imports in reports and work-orders routes; a create-route comment in reports claiming validation that isn't performed.

---

## 2. Shared platform primitives (build once, consume six times)

Four pieces of infrastructure appear as dependencies in nearly every module plan. They must be built **once**, by the platform workstream, and consumed everywhere — the module plans all flag this explicitly.

| Primitive | Built by | Consumed by |
|---|---|---|
| **File storage** (`src/lib/storage.mjs` + bucket/policies migration + attachment routes) | OP-15/16/17 | DR-09/23/25 (report attachments, PDF snapshots, offline media), IN-07 (evidence), WO-06/14 (work-order attachments), TR-03/08 (cert evidence, video/PDF content), CM (ack signatures) |
| **Notification delivery worker** (claim/expand/deliver/retry/dead-letter + Vercel cron + guarded drain endpoint) | OP-10/11/12/13/14 | CM-06/07/10/13/14 (all delivery), IN-20/21 (escalations), TR-11 (cert expiry), DR-21/22/29 (distribution, reminders), SC-17 (publish notices), WO-16 (overdue alerts) |
| **Effective-config loader for `/api/v1`** (`src/lib/http/module-config.mjs`) | WO-04 (first consumer) | SC-06 (settings-aware validation), DR-07/12 (submit policy, due hour), IN (SLA hours), every module reading its registered settings at request time |
| **PostgREST client filter extension** (`gte`/`lte`/`in`, offset, count) | DR-01 (first consumer) | WO-05 (list filters), DR-08, SC period-scoped queries, all pagination work |

Rule for the orchestrator: **no module may fork a parallel implementation of any of these.** The communications plan and the daily-reports plan both note the temptation (report distribution tables vs 0016; a module-local storage client) — the master plan resolves it: one storage client, one worker, one config loader.

---

## 3. Execution waves

Ordered so each wave produces a verifiable result, maximizes safe parallelism, and never blocks cheap work on owner decisions.

### Wave 0 — Go-live + known-bug fixes (days, not weeks)

- **Owner (human, dashboard):** OP-01 set `SUPABASE_JWT_SECRET` in Vercel ← *the single blocker for login*; OP-02 remaining env vars; OP-03 connect repo + deploy; OP-06 leaked-password protection.
- **Agents, immediately parallel:** OP-07 env rename (Haiku), OP-04 `search_path` migration (Sonnet), OP-08 smoke script (Haiku), CM-01 RLS fix (Sonnet), WO-07 soft-delete policy fix + the same audit for incidents/reports (Sonnet, Opus review), SC-06 validate-route fix (Sonnet), dead-code cleanup WO-09/DR-07(e) (Haiku).
- **Owner decision queued:** OP-05 SECURITY DEFINER RPC posture (Opus frames it; live RLS retest required after).

**Exit gate:** production deploy up, sign-in works end-to-end, full local gate green, advisor findings resolved or explicitly accepted.

### Wave 1 — Platform primitives + module M1 foundations (parallel tracks)

Track A (Sonnet, Opus reviews): storage — OP-15 bucket/policies → OP-16 client → OP-17 attachment routes → OP-18 UI wiring.
Track B (Sonnet, Opus reviews): worker — OP-10 bookkeeping columns → OP-11 worker core → OP-13 cron/drain endpoint → OP-14 outbox drain; OP-12 email adapter as soon as the owner picks a provider (OP-09, recommend Resend).
Track C (Sonnet): WO-04 config loader + DR-01 PostgREST filters — small, unblock everything downstream.
Track D (module M1 tasks with no platform dependency, fanned out to Haiku/Sonnet in **isolated worktrees** since they collide on `index.html`/`app.js`/`server.mjs`):
- DR-02..DR-05 (template write RLS, lifecycle lib, management API, permission codes)
- IN-01..IN-03 (permission codes, transition machine, submit/transition routes)
- WO-01/02/05 (comment thread, status lifecycle, list filters)
- SC-01/02/04/09 (period lifecycle, template CRUD, shift edits, employees route)
- CM-02/04/05 (audience, channel, receipt routes)
- TR-01/02/05 (employee-scoped queries, cert wallet, Training Studio CRUD)

**Exit gate:** storage + worker merged with Opus security review (OP-24); every module has its M1 API skeleton; full gate + RLS suites green.

### Wave 2 — Module M1 completion (the MVP)

Each module finishes its M1 column, now consuming the Wave-1 primitives. Highest-value order (matches the roadmap): **reports → incidents → work orders → scheduling → communications → training.**

- Daily reports: DR-06 builder bridge (**Opus decision**: promote-path from `form_definitions`), DR-07..DR-15 (hardening, filters, attachments, audit, dept scoping, compliance endpoint, entry UI, review inbox, PDF).
- Incidents: IN-04..IN-10 (amendments, follow-ups, escalation lifecycle, evidence via platform storage, summary PDF, incident numbers, capture UI).
- Work orders: WO-03 (create-from-incident), WO-06/08/10 (attachment metadata, RLS SQL proof, real UI).
- Scheduling: SC-03 (template expansion, DST-safe), SC-05 (assignments + conflict 409s), SC-07 (publish flow + new RLS), SC-08 (schedule board UI).
- Communications: CM-03 (publish flow wiring), CM-06/07 (worker consumption, push prefs), CM-08/09 (compose UI, receipts).
- Training: TR-03 (evidence via platform storage), TR-04 (cert event writer), TR-06 (progress-aware completion).

**Exit gate per module slice:** full gate + module RLS SQL suite + Sonnet review of permission-gating and input validation + Opus integration check in `server.mjs`/`index.html`. **Product milestone:** every roadmap MVP capability usable in production by a pilot facility.

### Wave 3 — Design-complete (M2)

Cross-module features now that both sides exist. Key integration pairs to coordinate (single implementation, two consumers):

| Integration | Tasks (both sides) |
|---|---|
| Incident → work order | IN-17 ↔ WO-03 (shared row shape lives in `src/lib/work-orders.mjs`) |
| Incident → corrective training | IN-17 ↔ TR-10 |
| Report defects → work orders | DR-18/19/20 ↔ WO-21 (one defect convention in `report-schema.mjs`) |
| Cert expiry → scheduling gates | TR-11/12 ↔ SC-19 (one status vocabulary from `certificationStatus`) |
| Shift-targeted messaging | CM-12 ↔ scheduling's `shift_assignments` window queries |
| Publish/decision notifications | SC-17, IN-20, WO-16, DR-21/22 — all producers into the one worker |

Plus each module's remaining M2 column (witness statements/signatures/OSHA tree, swaps/time-off/availability, quizzes/auto-assignment, emergency mode, lock/revise/offline, SLA columns/PM schema chain WO-17→20).

### Wave 4 — Polish, automation, hardening (M3)

Scheduled sweeps (incident SLA, cert expiry, ack escalation, PM generation, report reminders — all cron entries on the one drain pattern), dashboards/analytics, PDF exports, retention/legal hold, entitlement gating ("Ops Plus" packaging), department-scope extensions, realtime spike (CM-16, **architecture decision first**), and the module-by-module Opus security reviews (DR-34, WO-27, IN-24, OP-24 continuation).

---

## 4. Multi-agent execution strategy

Three tiers, same rule as before: push work to the cheapest model that can do it correctly; escalate only for genuine judgment.

| Tier | Model | Carries |
|---|---|---|
| **Cheap** | Haiku 4.5 | Pattern-copy route CRUD, UI wiring, mechanical migrations (`add column if not exists`), settings/permission catalog edits, dashboards, table-driven tests, doc updates — ~55 of the 168 tasks |
| **Mid** | Sonnet | Everything touching RLS policies, auth guards, state machines, idempotency, retries/concurrency, storage paths, recipient resolution, cross-module writes — ~90 tasks, plus review of every Haiku task on a permission-gated path |
| **Orchestrator** | Fable/Opus (this session) | Sequencing, migration-number assignment, cross-module decisions (DR-06 template stores, permission naming, CM-16 realtime, entitlement packaging), integration in `server.mjs`/`index.html`, and the security review gate on: amendments/audit chain (IN-04), storage (OP-15..17), worker + internal endpoints (OP-11/13), definer RPCs (OP-05), workflow privilege elevation (DR-20/WO-21), legal hold (IN-16), emergency mode (CM-13), offline idempotency (DR-25) |

**Concurrency mechanics**
- Module tasks that touch shared files (`index.html`, `app.js`, `server.mjs`, `settings-registry.mjs`, `permissions.mjs`, `seed.sql`) run with **worktree isolation**; the orchestrator merges and resolves.
- **Migration numbers are assigned centrally by the orchestrator at merge time.** Five plans independently claimed `0024` — the numbers inside each plan are ordering hints, not literals. Every new table goes into `scripts/verify-migrations.mjs` `requiredRlsTables` in the same commit.
- Every slice ships with its tests; the full gate (`format:check`, `lint`, `typecheck`, `test`, `build`, `db:verify`, `db:verify:seed`, and `db:test:rls` when migrations changed) runs at every merge, exactly as CI does.
- A typical Wave-1/2 burst: 6 Haiku builders (one per module, worktree-isolated) + 3–4 Sonnet agents (storage, worker, RLS fixes, reviews) + the orchestrator integrating — the same shape that built Workstream E successfully.

---

## 5. Decisions needed from the owner

Only these block work; everything else proceeds.

1. **OP-01/02/03** — set `SUPABASE_JWT_SECRET` + env vars in Vercel and connect the repo (dashboard-only; login is blocked until then).
2. **OP-05** — SECURITY DEFINER RPC posture (fix vs accept; fixing needs a live RLS retest).
3. **OP-09** — email provider (recommend Resend: plain HTTPS API, fits the zero-dependency `fetch` client).
4. **OP-20** — observability DSN provider (Sentry-compatible vs generic webhook).
5. **DR-06 side-decision** — whether report-template authoring inherits the `custom_forms` entitlement (Enterprise-only) or the promote path is exempted.
6. **Permission naming** — keep the implemented `schedule.*` codes and amend the design doc (recommended) vs migrate to the doc's `scheduling.*` family.
7. **CM-16** — realtime approach (Supabase Realtime vs SSE vs polling) before any live-counter work is sized.
8. **Module order** — accept reports → incidents → work orders → scheduling → communications → training, or reprioritize.

---

## 6. Task and effort rollup

| Module | M1 (MVP) | M2 (design-complete) | M3 (polish) | Total |
|---|---|---|---|---|
| Daily reports | 15 | 13 | 6 | 34 |
| Incidents | 10 | 9 | 6 | 25 |
| Work orders | 10 | 11 | 6 | 27 |
| Scheduling | 9 | 8 | 7 | 24 |
| Communications | 9 | 5 | 4 | 18 |
| Training | 6 | 6 | 4 | 16 |
| Platform/ops | 8 (P1) | 10 (P2) | 6 (P3) | 24 |
| **Total** | **67** | **62** | **39** | **168** |

Sizing across the plans skews M (about half), with the L items concentrated exactly where the security reviews sit: storage, worker, amendments, publish flows, offline sync, and the workflow engines. Wave 0 is days; Wave 1 + Wave 2 together correspond to the roadmap's Phase-1 MVP (10–14 weeks for a human team — substantially compressed with the agent fan-out above since most M1 tasks are independent and mock-testable); Waves 3–4 map to the roadmap's Phase 2.
