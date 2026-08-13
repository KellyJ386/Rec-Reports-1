# Platform & Operations Workstream — Development Plan

## 1. Current state

- **Runtime/architecture** — Zero-dependency Node app. `scripts/server.mjs` is the BFF: exports `handleRequest`, `readBody` (1 MB `maxBodyBytes` cap), two routers (`router` for `/api/admin/v1`, `userRouter` for `/api/v1`), strict security headers including CSP `default-src 'self'`. `api/[[...path]].mjs` is the Vercel serverless adapter delegating every `/api/*` request to the shared `handleRequest`. `vercel.json` builds `dist/`, rewrites `/admin` and `/signin`; **no `crons` block exists**.
- **Auth (done per progress log, confirmed in code)** — `src/lib/http/auth.mjs` (HS256-only `verifySupabaseJwt`, `loadMemberships`, `loadPlatformAdmin`); `src/lib/http/auth-routes.mjs` (same-origin GoTrue proxy: `POST /api/v1/auth/sign-in`, `/auth/refresh`, CSP-safe); `src/public/signin/`; `src/lib/http/me-route.mjs` (`GET /api/v1/me`); `GET /api/v1/public-config`. First admin user (kgjohn02@gmail.com) provisioned as platform super-admin.
- **Live DB** — Supabase project `rec-reports` (`ynrwmlrbpaddmknzckyt`), all 23 migrations + seed applied. CI runs the full gate incl. RLS suites against bootstrapped Postgres 16. 493 tests pass.
- **Notifications: logic without delivery** — `src/lib/admin/notifications.mjs` has `resolveRoute`, `expandDistributionList`, `isWithinQuietHours`, `buildNotificationJob` (pure, no I/O). Tables exist: `notification_jobs` (status pending/processing/sent/failed/cancelled, `attempts`, `scheduled_for`) and `notification_deliveries` in `0006_communications.sql`; `outbox_events` in `0002_daily_reports.sql`; routing/distribution-list tables in `0016_notifications.sql`; admin routing CRUD + test-send in `src/lib/http/notification-routes.mjs`. **Nothing dequeues or delivers anything.**
- **Storage: columns without I/O** — `report_submission_attachments` (0002), `incident_attachments` (0004), `work_order_attachments` (0005) all have `storage_path`, mime/checksum/metadata columns. No storage client, no bucket, no upload/download route anywhere in `src/`.
- **Observability** — `OBSERVABILITY_DSN` validated in `src/lib/env.mjs` and referenced nowhere else. No request logging, no error reporting, no scheduled checks. Audit hash-chain verify exists on demand (`GET /api/admin/v1/facilities/:facilityId/audit/verify`) but is never scheduled.
- **Env naming drift** — `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_APP_URL` still used in `src/lib/env.mjs`, `scripts/server.mjs`, `src/lib/http/auth-routes.mjs`, `.env.example`, and three test files.
- **Not deployed** — no Vercel project builds this repo; `SUPABASE_JWT_SECRET` unset anywhere (the single true login blocker); security-advisor findings (3 `search_path` trigger warnings, SECURITY DEFINER RPCs callable by anon/authenticated, leaked-password protection off) deferred.

## 2. Gap analysis

| Capability | What exists | What's missing | Risk if unaddressed |
|---|---|---|---|
| **Notification delivery worker** | Queue tables, routing/quiet-hours/fan-out logic, admin CRUD + test-send routes | Any dequeue/deliver process; email provider integration; retry w/ backoff; dead-letter path (`failed` exists but no `last_error`/`next_attempt` bookkeeping); a way to *run* a worker on Vercel serverless (needs Vercel Cron + guarded internal endpoint) | Communications "sends" silently go nowhere; incident escalations, cert-expiry alerts, report reminders are dead letters from day one |
| **File storage** | Three attachment tables with `storage_path`/mime/checksum columns and RLS read policies | Supabase Storage bucket; `storage.objects` RLS policies; server-side storage client (native `fetch`, no SDK); upload/download routes (CSP `default-src 'self'` forbids browser→Supabase direct upload, so uploads must proxy through the BFF like auth does); signed URLs; type/size/ownership validation; body-limit handling (1 MB `maxBodyBytes` vs Vercel's ~4.5 MB function cap) | Reports, incidents, and work orders cannot carry evidence — a launch-blocker item in `MASTER_PRODUCTION_READINESS_PLAN.md` §7 |
| **Observability** | `OBSERVABILITY_DSN` env validation only; on-demand audit verify route | Structured request logging in `handleRequest`; error capture to the DSN; scheduled audit hash-chain verify with alerting; delivery-failure visibility | Blind production: no way to monitor a pilot; silent audit-chain corruption |
| **Go-live blockers** | Code fully ready; DB stood up; first admin exists | `SUPABASE_JWT_SECRET` set in Vercel (dashboard-only); the four Vercel env vars; repo connected to a Vercel project + deploy; advisor items | No one can log in; known privilege-escalation and account-security gaps ship as-is |
| **Env-var hygiene** | Works, with `NEXT_PUBLIC_*` names | Rename to `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`APP_URL` with one-release fallbacks | Confusion at exactly the moment env vars get configured in Vercel; risk of misconfigured deploys |

## 3. Phased task list

### Phase P1 — Go-live unblockers

| ID | Task | Files | Acceptance criteria | Tests | Size | Owner action? |
|---|---|---|---|---|---|---|
| OP-01 | Retrieve legacy HS256 JWT secret from Supabase dashboard (Settings → API) and set `SUPABASE_JWT_SECRET` in Vercel; confirm project signs HS256 | none (dashboard) | A token from `/api/v1/auth/sign-in` verifies in `auth.mjs`; `/api/v1/me` returns memberships | Manual smoke | S | **OWNER — dashboard only** |
| OP-02 | Set remaining Vercel env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (+ new names once OP-07 lands, + `CRON_SECRET` for P2) | none (dashboard) | `/api/v1/public-config` returns real values in prod | Manual | S | **OWNER — dashboard** |
| OP-03 | Connect repo to a new Vercel project, first production deploy, point domain | none (dashboard) | `/signin` loads over TLS with security headers; all admin sections load | OP-08 smoke script | S | **OWNER — dashboard** |
| OP-04 | Migration `advisor_hardening`: pin `set search_path = ''` (schema-qualified bodies) on the 3 advisor-flagged trigger functions | new migration | Advisor `search_path` warnings clear; CI migration apply + RLS suites still green | Existing CI SQL suites; `npm run db:verify` | S | Agent writes; apply via Supabase MCP |
| OP-05 | SECURITY DEFINER RPC review: enumerate definer functions (`current_facility_ids`, `has_permission`, etc.), decide which need `revoke execute from anon`, ship as migration | same migration file(s) | Advisor findings resolved or explicitly accepted in writing; all 10 RLS suites still pass (this is the regression risk) | `npm run db:test:rls` in CI **and** against live | M | **OWNER decision** + Opus review |
| OP-06 | Enable leaked-password protection (HIBP) in Supabase Auth settings | none (dashboard) | Advisor finding cleared; breached password rejected at sign-in | Manual | S | **OWNER — dashboard toggle** |
| OP-07 | Env-var rename with one-release fallbacks: `NEXT_PUBLIC_SUPABASE_URL`→`SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`→`SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`→`APP_URL` | `src/lib/env.mjs`, `scripts/server.mjs`, `src/lib/http/auth-routes.mjs`, `.env.example`, three test files, `README.md` | Old names still work (fallback), new names preferred; full gate green | Extend `test/env.test.mjs` for both spellings | S | No |
| OP-08 | Post-deploy smoke script: sign in, `/me`, one admin section per group, audit verify, PDF export, one `/api/v1` module round-trip | `scripts/smoke.mjs` (new), `package.json` | Runs against a deployed URL with a test credential; non-zero exit on any failure | Script is the test; unit-test its assertion helpers | M | No (owner supplies credential) |

### Phase P2 — Notification worker + file storage

| ID | Task | Files | Acceptance criteria | Tests | Size | Owner action? |
|---|---|---|---|---|---|---|
| OP-09 | Email provider decision (Resend / Postmark / SES — must have a plain HTTPS API usable via native `fetch`; recommend Resend) + account, sender domain, API key in Vercel env | none | Provider chosen; `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM` set | n/a | S | **OWNER decision + signup/DNS** |
| OP-10 | Migration `delivery_bookkeeping`: add `last_error text`, `next_attempt_at timestamptz` to `notification_jobs`/`outbox_events`; add `dead_letter` status (or document `failed`+max-attempts) | new migration | Applies cleanly on empty DB and live; RLS untouched (worker uses service role) | CI migration apply; `db:verify` | S | Apply via MCP |
| OP-11 | Worker core `src/lib/notifications/worker.mjs`: claim pending due jobs via service-role PostgREST with optimistic claim (`pending`→`processing` conditional update), expand recipients (reuse `expandDistributionList`/`resolveRoute`), defer via quiet hours, write per-recipient `notification_deliveries`, retry with exponential backoff via `next_attempt_at`, dead-letter after N attempts with `last_error` | new worker lib, reuses `src/lib/admin/notifications.mjs`, `src/lib/supabase-rest.mjs` | Idempotent claims (no double-send on concurrent drains); quiet-hours jobs rescheduled not dropped; failures increment attempts and set `last_error` | `test/notifications-worker.test.mjs` (mocked PostgREST): happy path, retry, dead-letter, quiet hours, concurrent claim | L | No |
| OP-12 | Email channel adapter `src/lib/notifications/email.mjs`: provider HTTP API via `fetch`, records `provider_message_id`, maps provider errors to retryable/permanent | new adapter | Permanent failures (bad address) dead-letter immediately, transient ones retry | Unit tests with stubbed fetch (2xx, 4xx, 5xx, timeout) | M | Needs OP-09 |
| OP-13 | Drain entry points: `scripts/notifications-worker.mjs` (local dev loop) + guarded internal route `POST /api/v1/internal/notifications/drain` (checks `CRON_SECRET` bearer, never facility-token auth) + `crons` block in `vercel.json` (every 5 min) | scripts, `scripts/server.mjs`, `vercel.json` | Wrong/missing secret → 401; drain bounded per invocation (batch limit) to fit serverless timeout | Route test: auth rejection, batch invocation | M | OP-02 adds `CRON_SECRET` |
| OP-14 | Outbox drain: extend worker to process `outbox_events` (pending→processed), translating event types into `notification_jobs` via `resolveRoute`/`buildNotificationJob` — this makes cert-expiry, escalation, and report-reminder events actually fan out | worker, same drain endpoint | Outbox rows reach `processed`; unrouteable events marked processed with a logged skip, not failed forever | Unit tests: routed, unrouted, retry | M | No |
| OP-15 | Storage bucket + policies migration: private `attachments` bucket, `storage.objects` RLS policies enforcing path prefix `facility_id/...` against `current_facility_ids()` — defense-in-depth even though all access is service-role via BFF | new migration | Bucket exists; direct anon/authenticated object access denied; policies idempotent | New SQL suite wired into `db:test:rls` | M | Apply via MCP |
| OP-16 | Storage client `src/lib/storage.mjs`: Supabase Storage REST via `fetch` + service role — `buildAttachmentPath(facilityId, module, recordId, filename)` (sanitized), `uploadObject`, `createSignedUrl(ttl)`, `deleteObject`; mime allow-list + size cap | new lib | Path builder rejects traversal/odd chars; signed URLs expire; all I/O injectable for tests | `test/storage.test.mjs`: path safety, mime/size rejection, stubbed REST | M | No |
| OP-17 | Attachment routes for the three modules: `POST .../attachments` (raw body upload through BFF, per-route body limit ~4 MB, distinct from the 1 MB JSON cap), `GET .../attachments` (list), `GET .../attachments/:id/url` (short-TTL signed URL). Permission-gated with the module's existing codes; ownership checked (parent row must be in caller's facility) | new `src/lib/http/attachments-routes.mjs`, `scripts/server.mjs`, module route link points | Upload+list+download round-trip per module; cross-facility access 403s; oversize/bad-mime 400s | `test/attachments-routes.test.mjs` with explicit cross-tenant denial cases | L | No |
| OP-18 | UI wiring: attachment pickers + lists in the three module panels (CSP-safe fetch to the BFF routes) | `src/public/index.html`, `src/public/js/app.js` | User can attach a photo to an incident and download it via signed URL | Manual + smoke-script extension | M | No |

### Phase P3 — Observability + hardening

| ID | Task | Files | Acceptance criteria | Tests | Size | Owner action? |
|---|---|---|---|---|---|---|
| OP-19 | Structured request logging in `handleRequest`: one JSON line per request (method, path template, status, duration ms, user id if authed, request id) to stdout — Vercel picks these up natively; no bodies/tokens ever logged | `scripts/server.mjs` | Every request logs exactly one line; secrets/bearer tokens provably absent | stdout-capturing test | S | No |
| OP-20 | Error reporting: `src/lib/observability.mjs` posting caught errors (route handlers, worker, serverless catch) to `OBSERVABILITY_DSN`; fire-and-forget, never blocks or crashes the response path. DSN format decision: Sentry store endpoint vs generic webhook | new lib, `scripts/server.mjs`, `api/[[...path]].mjs`, worker | Unhandled route error produces one report; DSN unset = silent no-op; reporter failure never surfaces to users | Unit tests incl. DSN-unset and reporter-throws | M | **OWNER decision: DSN provider** |
| OP-21 | Scheduled audit verify: internal route `POST /api/v1/internal/audit/verify-all` (CRON_SECRET-guarded) iterating facilities → `verifyDbChain`; broken chain → error report via OP-20; daily `vercel.json` cron | internal routes, `vercel.json` | A tampered chain in a test fixture triggers a report | Route test: valid and broken chain | M | No |
| OP-22 | Supabase backups/retention review; enable PITR if plan allows; document restore runbook | `docs/` runbook | Backup cadence confirmed; restore procedure written and once-tested | Manual | S | **OWNER — dashboard/billing** |
| OP-23 | Auth-proxy hardening: per-IP/per-email throttle on `/api/v1/auth/sign-in` (in-memory acceptable per-instance on serverless; document limits), uniform error timing | `src/lib/http/auth-routes.mjs` | Burst of failed sign-ins → 429; success path unaffected | Extend `test/auth-routes.test.mjs` | M | No |
| OP-24 | Security review gate: Opus review of OP-05 (definer RPCs), OP-11/13 (worker + internal endpoints), OP-15–17 (storage paths, signed URLs, cross-tenant checks) before each ships | review only | Written findings; blockers fixed before merge | n/a | M | No |

## 4. Dependencies — which module features are blocked on each platform capability

| Platform capability | Blocked module features |
|---|---|
| **OP-01/02/03 (JWT secret, env vars, deploy)** | *Everything user-facing.* No login → all six modules and the admin area are unreachable in production. OP-01 is the single critical-path item. |
| **File storage (OP-15–17)** | Daily reports: attachments on submissions (DR-09, DR-23, DR-25). Incidents: evidence uploads (IN-07) and mobile filing. Work orders: attachments (WO-06/WO-14). Training: certification evidence (TR-03) and video/PDF content (TR-08). Communications: `signature_path` on acknowledgements. |
| **Notification worker (OP-10–14)** | Communications: delivery beyond in-app, escalation ladder, emergency fan-out (CM-06/07/10/13/14). Incidents: high-severity escalation notifications (IN-20/21). Training: cert-expiry alerts (TR-11). Daily reports: missing-report reminders (DR-29) and distribution (DR-21/22). Scheduling: publish notifications (SC-17). Work orders: overdue alerts (WO-16). Admin: the notification test-send currently enqueues into a queue nothing drains. |
| **Observability (OP-19–21)** | Pilot launch itself: monitorable errors/logs are on the launch-blocker checklist; scheduled audit verify protects the compliance story the admin area sells. |
| **OP-05 (definer RPC decision)** | None functionally, but it gates the security sign-off for go-live and touches `has_permission`/`current_facility_ids`, which every RLS policy depends on — hence the live-RLS retest requirement. |

Sequencing: OP-07 before OP-02 (configure Vercel with final names once, fallbacks cover the gap). OP-09 gates OP-12 only; OP-10/11/13/14 are mock-testable immediately. OP-15 gates live verification of OP-16/17, not their unit tests.

## 5. Agent/model assignment

| Task | Model | Rationale |
|---|---|---|
| OP-01, OP-02, OP-03, OP-06, OP-09, OP-22 | **Owner (human)** | Dashboard/billing/DNS actions; secrets not retrievable via MCP |
| OP-04 | **Sonnet** (write) → apply via MCP | Small SQL but touches trigger functions |
| OP-05 | **Opus** decision framing + **Sonnet** migration + live RLS rerun | Explicit RLS-regression risk; needs judgment |
| OP-07 | **Haiku** | Mechanical rename with fallbacks |
| OP-08, OP-18 | **Haiku**, Sonnet spot-review | Scripted checks / UI wiring copying existing CSP-safe patterns |
| OP-10 | **Sonnet** | Schema change to live queue tables |
| OP-11, OP-12, OP-13, OP-14 | **Sonnet**, worker core reviewed by **Opus** (OP-24) | Concurrency (claim semantics), retry/dead-letter correctness, secret-guarded internal endpoints |
| OP-15, OP-16, OP-17 | **Sonnet**, **Opus** security review | Tenant-isolation surface: path construction, signed URLs, cross-facility ownership |
| OP-19 | **Haiku** | Mechanical logging middleware with a clear no-secrets rule |
| OP-20, OP-21, OP-23 | **Sonnet** | Failure-path design, throttling semantics |
| OP-24 | **Opus / orchestrator** | Final security gate over auth-adjacent, RLS-adjacent, and internal-endpoint code |

### Critical files
- `scripts/server.mjs`, `src/lib/admin/notifications.mjs`, `src/lib/supabase-rest.mjs`, `src/lib/env.mjs`, `vercel.json`
