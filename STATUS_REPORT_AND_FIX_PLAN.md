# Rec Reports — Status Report and Fix Plan

Date: 2026-07-17
Scope: full repository audit at commit `fd34ffd` (tip of `main`), plus live-infrastructure
review of the connected Supabase and Vercel accounts.

---

## 1. Executive summary

The codebase itself is in good shape: every quality gate passes locally, CI on `main` is
green, and the Admin Control Center is a genuinely complete, tested, permission-gated
product surface backed by 23 migrations with row-level security.

The problem is everything **around** the code:

1. **The app has never run against a real database.** The only Supabase project in the
   connected account ("Rink Reports 5-6") contains a completely different application's
   schema. This repo's 23 migrations have never been applied anywhere live.
2. **The app is not deployed.** There is no hosting for this repo (the only Vercel project
   belongs to the older Rink Reports app). No one can visit this product today.
3. **There is no way to log in.** The admin area authenticates by pasting a Supabase
   access token into a drawer — but with no Supabase Auth integration and no sign-in
   page, there is no way for a real user to obtain such a token.
4. **The end-user product is a static mockup.** All six operational modules (daily
   reports, scheduling, incidents, work orders, communications, training) have database
   schema, domain libraries, and unit tests — but zero API routes and zero functional UI.
   Only the admin area (`/admin/`) is a working application.
5. **A stale, conflicting PR (#3) is still open** — an abandoned Next.js/TypeScript
   implementation from June that no longer matches the current architecture.

In short: this is a well-built engine sitting on a workbench. Nothing is wired to the
chassis yet. The fix plan below gets it on the road in five phases.

---

## 2. What is healthy (verified today)

All commands run on a clean clone, Node v22:

| Gate | Result |
|---|---|
| `npm run format:check` | Pass |
| `npm run lint` | Pass (88 `.mjs` files parsed) |
| `npm run typecheck` | Pass (16 permission codes consistent; 15 settings across 6 modules) |
| `npm test` | **423/423 pass**, 0 fail, ~1.5 s |
| `npm run build` | Pass (static app built into `dist/`) |
| `npm run db:verify` | Pass (23 migrations meet RLS requirements) |
| `npm run db:verify:seed` | Pass (40 seed blocks, 16 permission codes) |
| `npm run db:test:rls` | Skips locally (no `DATABASE_URL`); runs in CI against a bootstrapped Postgres 16 |
| GitHub Actions on `main` | Green (latest runs 2026-07-12/13 succeeded; earlier June failures were fixed) |

Strengths worth keeping:

- **Zero-runtime-dependency architecture** — static frontend plus a Node BFF
  (`scripts/server.mjs`) with security headers, HS256 JWT verification, and a PostgREST
  client over native `fetch`. Nothing to patch, no supply-chain surface.
- **Admin Control Center is complete**: all ten sections (dashboard, modules/features,
  identity/permissions, forms builder, notifications, facilities/departments,
  certifications, branding, audit/compliance with hash-chain verification and
  CSV/JSON/PDF export, billing/entitlements) have live pages and permission-gated API
  routes under `/api/admin/v1/*`.
- **Database design is production-grade**: 23 forward-only migrations, facility-scoped
  tenant isolation via RLS on every table, platform super-admin and department-level
  permission scoping, append-only hash-chained audit trail, idempotent policies, and ten
  SQL behavior-test suites that CI executes against real Postgres.

---

## 3. Findings — full detail

### Finding A (critical): no live database has this schema

The connected Supabase account contains exactly one project:

- **"Rink Reports 5-6"** (`bqbdgwlhbhabsibjgwmk`, us-east-1, ACTIVE_HEALTHY, created
  2026-05-06)

Its schema is a **different application**: `ice_operations_*`, `refrigeration_*`,
`air_quality_*`, `ice_depth_*`, `accident_*`, per-facility `users`/`employees`, etc.,
with live data (103 employees, 658 audit log rows, 382 ice-depth measurements). This
repo's migrations instead create `organizations`, `memberships`, `report_templates`,
`admin_change_requests`, `notification_events`, and so on — none of which exist in that
project. The two schemas are incompatible; this repo's migrations must go to a **new**
Supabase project (or a wiped one), not the Rink Reports project.

### Finding B (critical): no deployment exists

The Vercel account has two projects — `rink-reports-5-6` (the older app) and
`max-facility-website-12-19-25`. Neither builds this repo. There is also no deployment
configuration in the repo (no `vercel.json`, Dockerfile, or Procfile). Note that
`scripts/server.mjs` is a long-running Node HTTP server, which fits a Node host
(Render/Fly/Railway) more naturally than Vercel's serverless model.

### Finding C (critical): no login flow

- The admin SPA reads a bearer token from `localStorage`, populated by **manually pasting
  a Supabase access token** into the "Session token" drawer (`src/public/admin/index.html`,
  `src/public/admin/js/api.js`).
- There is no sign-in page, no Supabase Auth JS integration, and no other way to mint a
  token. Real users cannot get in.
- `src/lib/http/auth.mjs` verifies **HS256 only**. New Supabase projects default to
  asymmetric JWT signing (ES256 with JWKS); the legacy shared JWT secret must be enabled
  on the project, or the verifier needs JWKS/ES256 support. This must be decided in
  Phase 1/2 or auth will fail against a new project.

### Finding D (major): end-user modules are schema + libraries only

| Module | DB schema | Domain lib + tests | API routes | Working UI |
|---|---|---|---|---|
| Daily reports | ✅ 0002 | ✅ `report-schema.mjs` | ❌ | ❌ mockup |
| Scheduling | ✅ 0003 | ✅ `scheduling.mjs` | ❌ | ❌ mockup |
| Incidents | ✅ 0004 | ✅ `incidents.mjs` | ❌ | ❌ mockup |
| Work orders | ✅ 0005 | ✅ `work-orders.mjs` | ❌ | ❌ mockup |
| Communications | ✅ 0006 | ✅ `communications.mjs` | ❌ | ❌ mockup |
| Training | ✅ 0007 | ✅ `training.mjs` | ❌ | ❌ mockup |
| Admin control center | ✅ 0008–0023 | ✅ | ✅ `/api/admin/v1/*` | ✅ `/admin/` |

`src/public/index.html` is a hard-coded demo page: the facility switcher, "Save draft",
"Submit final report", "Validate schedule" etc. are dead buttons with no JavaScript.

### Finding E (moderate): operational gaps

- **No notification delivery worker.** Notification events, distribution lists, routing
  rules, and test-send endpoints exist, but nothing dequeues/delivers (no email/SMS/push
  integration anywhere in `src/`). Same for the `outbox_events` table.
- **No file storage integration.** Attachment tables exist (report, incident, work-order
  attachments) but no Supabase Storage wiring.
- **No observability.** `OBSERVABILITY_DSN` is read but unused beyond validation.
- **Env naming drift.** Variables are still `NEXT_PUBLIC_*` although the Next.js stack
  was abandoned; harmless but confusing (see Finding F).

### Finding F (hygiene): stale PR and leftover artifacts

- **PR #3** ("Phase 0–1: Foundation, tenancy, admin config, and core modules", opened
  2026-06-19) is a parallel Next.js/TypeScript implementation from an abandoned session.
  It conflicts with the current zero-dependency architecture and should be closed as
  superseded.
- June CI history shows several failed `codex/follow-production-readiness-plan-*`
  branches; those branches are dead and can be pruned.

---

## 4. Plan to fix

Ordered so each phase produces a visible result. Phases 1–3 make the existing product
real; phases 4–5 finish the product.

### Phase 0 — Repo hygiene (half a day)
1. Close PR #3 as superseded by the current architecture; delete dead `codex/*` branches.
2. Rename env vars (`NEXT_PUBLIC_SUPABASE_URL` → `SUPABASE_URL`, etc.) across
   `env.mjs`, server, docs, CI; keep temporary fallbacks for one release.
3. Add a deployment config for the chosen host (Phase 3) so deploys are reproducible.

### Phase 1 — Stand up the real database (1 day)
1. Create a **new** Supabase project for Rec Reports (do not touch Rink Reports 5-6).
2. Decide the JWT strategy now: either enable the legacy shared JWT secret (works with
   today's HS256 verifier) or extend `auth.mjs` to fetch JWKS and verify ES256.
3. Apply migrations 0001–0023 in order; load `supabase/seed.sql`.
4. Run `npm run db:test:rls` against the live project's connection string — all ten SQL
   suites must pass there, not just in CI.
5. Store `SUPABASE_URL`, anon key, service-role key, and JWT secret as deployment
   secrets (never in the repo).

### Phase 2 — Real authentication (1–2 days)
1. Build a sign-in page using Supabase Auth (email/password or magic link via the anon
   key) for both `/` and `/admin/`.
2. Replace the paste-a-token drawer as the primary flow (keep it as a hidden debug tool).
3. Handle token refresh and sign-out; surface the active user in the top bar.
4. Create the first real admin user and map them to the seeded organization/facility
   memberships.

### Phase 3 — Deploy (1 day)
1. Host the Node server (serves `dist/` + `/api/admin/v1/*`) on a long-running Node
   platform — Render, Fly.io, or Railway are the natural fits; Vercel is possible only if
   the server is adapted to serverless handlers.
2. Add a CI deploy job on `main` after the existing gates.
3. Smoke-test in production: sign in, load every admin section, run an audit hash-chain
   verify, export a PDF.
4. Point a domain at it and confirm the security headers/TLS posture.

### Phase 4 — Turn the mockup into the product (the big one; ~1–2 weeks per module slice)
Work module by module, reusing the already-tested domain libraries:
1. **Daily reports first** (smallest gap): add `/api/v1/facilities/:id/reports` routes
   over `report-schema.mjs`, replace the mockup panel with a real template list → fill →
   submit flow, with submitted snapshots immutable per the schema.
2. Then **incidents** (capture + escalation queue), **work orders** (from incidents),
   **scheduling** (periods, shifts, publish + conflict checks), **communications**
   (messages + acknowledgements), **training** (assignments + completions).
3. Each slice ships with: route guards using the existing 16-code permission catalog,
   unit tests alongside the existing 423, and an RLS SQL test where new query shapes
   appear.

### Phase 5 — Operational completeness (parallel with Phase 4)
1. Notification delivery worker: drain `notification_jobs`/`outbox_events` to a real
   channel (email first), with retries and dead-lettering.
2. Attachments via Supabase Storage with facility-scoped paths and signed URLs.
3. Observability: wire `OBSERVABILITY_DSN` (request logs, error reporting, audit-verify
   scheduled check).
4. Backups/retention review on the Supabase project; enable PITR if the plan allows.

### Decisions needed from you
- **New Supabase project**: creating one has a cost implication on the account — confirm
  and pick a name/region (recommend same org, us-east-1 to match Rink Reports).
- **Hosting choice** for the Node server (Render / Fly / Railway / adapt to Vercel).
- **Auth mode**: magic link vs. email+password for the first users.
- **Module order** for Phase 4 if different from the suggested one.

---

## 5. Verification evidence

- Local gates: run 2026-07-17 on Node v22.22.2 / npm 10.9.7 (results in §2).
- CI: `main` runs 29285877915 (2026-07-13) and 29206977692 (2026-07-12) succeeded.
- Supabase: `list_projects` and `list_tables` on `bqbdgwlhbhabsibjgwmk` (2026-07-17)
  show the Rink Reports schema, not this repo's.
- Vercel: `list_projects` (2026-07-17) shows no project building this repo.
- Route inventory: every registered route in `src/lib/http/*.mjs` is admin-scoped;
  no `/api/v1` end-user routes exist.
