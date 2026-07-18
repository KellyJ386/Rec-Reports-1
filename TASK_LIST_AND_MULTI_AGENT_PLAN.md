# Rec Reports — Task List & Multi-Agent Execution Plan

Date: 2026-07-18
Basis: `STATUS_REPORT_AND_FIX_PLAN.md` (2026-07-17) plus a fresh file-level code
inventory performed by three parallel recon agents (Haiku) on this branch.

This document is the actionable companion to the status report. The status report says
*what* is wrong and *why*; this document breaks it into concrete tasks, orders them by
dependency, and assigns each one to a specific agent running the **cheapest model that
can do the job**.

---

## 0. Progress log — updated 2026-07-18

Decisions locked by the owner: new Supabase project `rec-reports` (us-east-1); host on
**Vercel** (serverless); **email + password** auth; **legacy HS256** JWT secret.

**Done (built, tested, pushed):**
- ✅ **Workstream E (all six modules)** — end-user `/api/v1` routes + tests for daily
  reports, incidents, work orders, scheduling, communications, training. Built by 1 Opus
  reference module + 5 parallel **Haiku** agents. 61 route tests; live dispatch smoke-tested.
- ✅ **Workstream C (live database)** — the `rec-reports` project (`ynrwmlrbpaddmknzckyt`)
  was already fully stood up: all 23 migrations + seed applied, every table the new routes
  need exists. Credentials (URL + anon key) retrieved; security advisor run (findings below).
- ✅ **Workstream B (Vercel adaptation)** — `handleRequest()` extracted and shared by the
  Node server and a new `api/[[...path]].mjs` serverless function; `vercel.json` added
  (build `dist/`, serve static, route `/api/*` to the function).
- ✅ **Workstream D (auth), backend + UI** — server-side auth proxy `/api/v1/auth/sign-in`
  + `/auth/refresh` (forwards to GoTrue; keeps the browser same-origin under the strict
  CSP; reuses the `rr_admin_token` bearer), `GET /api/v1/public-config`, and a CSP-safe
  `/signin` page. 490 tests pass overall.

Also done since: ✅ **`GET /api/v1/me`** (facility context for the end-user app); ✅ **first
admin user (D5)** — `kgjohn02@gmail.com` was already provisioned as a platform super-admin,
temp password set; ✅ **E[d] end-user UIs wired** — `src/public/index.html` +
`src/public/js/app.js` gate on the login token, drive a facility switcher from `/me`, and
render all six modules from their live `/api/v1` endpoints (CSP-safe; actions wired only
where an endpoint exists). 493 tests pass.

**Remaining to actually go live (need the owner):**
- ⏳ **JWT secret** — set `SUPABASE_JWT_SECRET` (project's legacy HS256 secret, from
  Supabase → Settings → API → JWT Secret) as a Vercel env var; confirm the project signs
  tokens with it. Not retrievable via MCP. **This is the one true blocker for login.**
- ⏳ **Vercel env vars** — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (known), `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (secret, from dashboard).
- ⏳ **Deploy** — owner connects the repo to a Vercel project and ships (outward action).
- ⏳ **Advisor follow-ups** (deferred by owner) — 3 `search_path` trigger-function warnings
  (safe migration fix); SECURITY DEFINER RPC helpers callable by anon/authenticated (needs
  a decision — fixing risks the tested RLS); enable leaked-password protection.
- ⏳ **Workstream F** (notification worker, storage, observability) — carries its own
  provider decisions; not started.

---

## 1. Model & agent strategy

We use three tiers. The rule: push work down to the cheapest tier that can do it
correctly, and only escalate for genuine judgment (security, data integrity, novel
design).

| Tier | Model | Used for |
|---|---|---|
| **Cheap** | **Haiku 4.5** | Reconnaissance, mechanical edits (env rename), scaffolding from an existing template, boilerplate route modules that copy a proven pattern, static UI wiring, unit tests that mirror existing tests, doc updates. |
| **Mid** | **Sonnet 5** | Work needing judgment: auth flow, RLS/SQL test authoring, notification worker with retry/dead-letter, storage + signed URLs, CI/secrets, and **review of Haiku output** on permission-gated paths. |
| **Orchestrator** | **Opus 4.8 (this session)** | Planning, sequencing, integration, user decisions, and final security review of auth + RLS before anything ships. |

Agent types (from the SDK registry): `Explore` (read-only recon), `general-purpose`
(read/write/execute), `Plan` (design only). File-mutating module work runs with
`isolation: worktree` where modules would otherwise collide on shared files.

---

## 2. What can start now vs. what is blocked on a decision

**Startable immediately with cheap agents (no live infra, no user decision):** the entire
end-user module build-out (Workstream E) and most operational code (Workstream F) — all of
it is testable against the existing mocked-PostgREST unit-test harness without a live
database. This is the bulk of the remaining work and the bulk of the value.

**Blocked on a user decision (see §6):** creating the Supabase project, choosing a host,
picking the auth mode, and the JWT strategy. These gate Workstreams C, B, and D.

---

## 3. Master task list (grounded in the code)

Checkboxes so this doubles as a tracking sheet. Each task shows its **owner** = agent/model.

### Workstream A — Repo hygiene  *(owner: Haiku; A1/A3 need user OK — outward-facing)*
- [ ] **A1.** Close stale PR **#3** (abandoned Next.js/TS impl) as superseded. *(confirm first)*
- [ ] **A2.** Rename env vars with one-release fallbacks: `NEXT_PUBLIC_SUPABASE_URL`→`SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`→`SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`→`APP_URL`. Touch: `src/lib/env.mjs`, `.env.example`, `.github/workflows/ci.yml`, `README.md`, `scripts/`.
- [ ] **A3.** Prune dead `codex/follow-production-readiness-plan-*` branches. *(confirm first)*

### Workstream B — Deployment config  *(owner: Haiku scaffold + Sonnet CI; blocked on B0)*
- [ ] **B0.** 🔵 DECISION: hosting target (Render / Fly.io / Railway — natural fits for the long-running `scripts/server.mjs`; Vercel only if adapted to serverless).
- [ ] **B1.** Add deploy config for the chosen host (Dockerfile + `render.yaml`/`fly.toml`/`Procfile`). Server runs `node scripts/server.mjs dist`, `PORT` env, default 3000.
- [ ] **B2.** Add a CI deploy job after existing gates on `main`. *(Sonnet — touches secrets)*

### Workstream C — Live database  *(owner: Opus/Sonnet via Supabase MCP; blocked on C0/C1)*
- [ ] **C0.** 🔵 DECISION: create a **new** Supabase project (name, region; **has a cost**). Do **not** touch "Rink Reports 5-6" — its schema is a different app.
- [ ] **C1.** 🔵 DECISION: JWT strategy — enable the legacy shared HS256 secret (works with today's `auth.mjs`) **or** extend `auth.mjs` for JWKS/ES256 (Workstream D1).
- [ ] **C2.** Apply migrations `0001`–`0023` in order to the new project.
- [ ] **C3.** Load `supabase/seed.sql` (demo org, 2 facilities, roles, catalog, plans).
- [ ] **C4.** Run `npm run db:test:rls` against the live connection string — all 10 SQL suites must pass live.
- [ ] **C5.** Store `SUPABASE_URL`, anon key, service-role key, JWT secret as deploy secrets (never in repo).

### Workstream D — Real authentication  *(owner: Sonnet logic + Haiku UI; Opus security review)*
- [ ] **D1.** *(only if C1 = JWKS)* Extend `src/lib/http/auth.mjs` to fetch JWKS and verify ES256 (currently HS256-only, hardcoded). **Opus reviews.**
- [ ] **D2.** Build a `/signin` page using Supabase Auth JS (anon key) — email/password or magic link. Plain ES modules, no bundler. *(Sonnet auth logic, Haiku markup/CSS)*
- [ ] **D3.** Update `src/public/admin/js/api.js` to populate the token (localStorage `rr_admin_token`) from the Supabase session; keep the paste-drawer as a hidden debug tool.
- [ ] **D4.** Token refresh, sign-out, and show the active user in the top bar. *(Sonnet)*
- [ ] **D5.** Create the first real admin user and map to seeded org/facility memberships. *(Supabase MCP)*

### Workstream E — End-user modules (the big one)  *(owner: Haiku build + Sonnet review)*
Reference pattern to copy: `src/lib/http/forms-routes.mjs` — `register*Routes(router, {authenticate, sendJson, readBody})`, `withAuth` → `requireAuthPermission(auth, facilityId, "code")` → validate → `pgSelect/pgInsert/pgUpdate`. Register end-user routes under a new **`/api/v1`** prefix in `scripts/server.mjs`. Each module already has a tested domain lib and DB tables; only the route + UI layers are missing.

Per module, four tasks — **[a]** `/api/v1` routes, **[b]** unit tests mirroring `test/*-routes.test.mjs`, **[c]** RLS SQL test if new query shapes appear (Sonnet), **[d]** replace the static mockup panel in `src/public/index.html` with a real fetch-driven flow.

- [ ] **E1. Daily reports** — lib `report-schema.mjs`; tables `report_templates`, `report_template_versions`, `report_submissions`, `report_submission_attachments`; perms `reports.read`/`reports.create`/`reports.submit`; submitted snapshots immutable. *(smallest gap — do first)*
- [ ] **E2. Incidents** — lib `incidents.mjs`; tables `incident_reports`, `incident_people`, `incident_escalations`, `incident_followup_actions`, `incident_amendments`; perms `incidents.read`/`incidents.manage`; capture + escalation queue + OSHA review.
- [ ] **E3. Work orders** — lib `work-orders.mjs`; tables `assets`, `work_orders`, `work_order_updates`; perms `work_orders.read`/`work_orders.manage`; create-from-incident, SLA sorting.
- [ ] **E4. Scheduling** — lib `scheduling.mjs`; tables `schedule_periods`, `shift_templates`, `schedule_shifts`, `shift_assignments`, `schedule_publications`; perms `schedule.read`/`schedule.manage`; publish + double-booking/cert conflict checks.
- [ ] **E5. Communications** — lib `communications.mjs`; tables `messages`, `message_audiences`, `message_receipts`, `message_acknowledgements`; perms `communications.read`/`communications.publish`; send + acknowledgement tracking.
- [ ] **E6. Training** — lib `training.mjs`; tables `courses`, `course_modules`, `training_assignments`, `training_progress`, `training_completions`, `certification_events`; perms `training.read`/`training.manage`; assignments + completions.

### Workstream F — Operational completeness  *(owner: Sonnet; parallel with E)*
- [ ] **F1.** Notification delivery worker (`scripts/`): drain `notification_jobs` / `outbox_events`, deliver to email first, with retries + dead-lettering. Config lives in `src/lib/admin/notifications.mjs` (`resolveRoute`, `expandDistributionList`, `isWithinQuietHours`); today nothing drains the queue.
- [ ] **F2.** File storage: Supabase Storage wiring for `report_submission_attachments`, `incident_attachments`, `work_order_attachments` (all have `storage_path` columns, no I/O today). Facility-scoped paths + signed URLs.
- [ ] **F3.** Observability: actually use `OBSERVABILITY_DSN` (validated in `src/lib/env.mjs`, referenced nowhere) — request logs, error reporting, scheduled audit-verify. *(Haiku for logging, Sonnet for error reporting)*
- [ ] **F4.** Supabase backups/retention review; enable PITR if the plan allows. *(manual/user)*

### Workstream G — Integration & release gate  *(owner: Opus)*
- [ ] **G1.** After each E/F slice: run the full gate — `format:check`, `lint`, `typecheck`, `test`, `build`, `db:verify`, `db:verify:seed`.
- [ ] **G2.** Security review of auth (D1–D4) and any new RLS query shapes before deploy.
- [ ] **G3.** Production smoke test (post-deploy): sign in, load every admin section, hash-chain verify, export a PDF, exercise one end-user module end-to-end.

---

## 4. Dependency graph (execution order)

```
A2 (env rename) ─────────────┐
                             ├─► G1 gate ─► ... iterate
E1..E6 routes+tests+UI ──────┤   (all startable NOW, cheap agents, mocked PostgREST)
F1 worker, F2 storage, F3 obs┘

C0/C1 decisions ─► C2 migrate ─► C3 seed ─► C4 live RLS ─► C5 secrets
                        │
B0 decision ─► B1 config ──────┴─► B2 CI deploy ─► (deploy)
                                        │
C1 decision ─► D1 verifier ─► D2 signin ─► D3 api.js ─► D4 refresh ─► D5 first user
                                        │
                                        └─► G2 security review ─► G3 smoke test
```

**Critical path to a usable product:** C-decisions → migrate/seed → auth → deploy.
**Highest-value parallel work needing no decision:** E + F (build the actual product).

---

## 5. How the agents run (concrete orchestration)

**Phase now — fan out the module build-out (all Haiku, worktree-isolated to avoid
collisions on `index.html`/`server.mjs`):**
- 6 × `general-purpose` @ **Haiku**, one per module (E1–E6), each: read `forms-routes.mjs`
  + its domain lib → write `src/lib/http/<module>-routes.mjs` under `/api/v1` → write
  `test/<module>-routes.test.mjs` mirroring an existing route test → wire the module's
  panel in a copy of `index.html`.
- 1 × `general-purpose` @ **Haiku** for **A2** (env rename) — independent, no worktree needed.
- 2 × `general-purpose` @ **Sonnet** for **F1** (worker) and **F2** (storage) in parallel.

**Then — verify each slice (Sonnet review + Opus gate):**
- Each module slice reviewed by 1 × Sonnet reviewer focused on permission-gating and
  input validation (the security-sensitive parts of a route). Opus runs `G1` after merge
  of each slice and resolves cross-module integration in `server.mjs` / `index.html`.

**When decisions land — infra track (Opus/Sonnet):**
- Opus drives C (Supabase MCP: `create_project` → `apply_migration` ×23 → seed → live RLS).
- Sonnet builds D (auth), Haiku does D2 markup; Opus security-reviews D1–D4.
- Haiku scaffolds B1 for the chosen host; Sonnet wires B2 CI deploy.

**Cost note:** roughly 8–10 Haiku agents carry the module + hygiene load; ~4 Sonnet agents
carry worker/storage/auth/review; Opus stays in the orchestrator seat. The expensive model
touches only auth, RLS, and integration — everything mechanical is Haiku.

---

## 6. Decisions needed from you (these unblock C, B, D)

1. **New Supabase project** — OK to create one (it has a cost)? Preferred name + region
   (recommend same org, `us-east-1` to match the existing account)?
2. **Hosting** — Render, Fly.io, Railway, or adapt the server to Vercel serverless?
3. **Auth mode** — magic link or email + password for the first users?
4. **JWT strategy** — enable the legacy shared HS256 secret (no code change) or add
   JWKS/ES256 support to `auth.mjs`?
5. **Module order** — accept the suggested order (reports → incidents → work orders →
   scheduling → communications → training) or reprioritize?

Until 1–4 are answered, I'll run the unblocked cheap-agent work (Workstream E + F + A2),
which is the majority of the remaining product build, and hold C/B/D for your call.
