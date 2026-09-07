# Deployment

Operational reference for running Rec Reports in production on Vercel against a Supabase
project. Pair this with `plans/SECURITY_REVIEW_2026-09.md` (post-deploy verification checklist)
and `plans/WAVES_1_4_IMPLEMENTATION_PLAN.md` (`plans/PLATFORM_OPS_PLAN.md` for the underlying
OP-* task list) for the rationale behind each item below. Never put a real hostname, key, or
secret value into this file or any other file in this public repository — variable **names**
only; real values live in the Vercel project's environment settings and the Supabase dashboard.

## Environment variables

Read and validated by `src/lib/env.mjs`. `readClientEnv` enforces the required set;
`readServerEnv` (used by `scripts/server.mjs` and `api/[...path].mjs`) adds the optional set on
top. All of these are configured as Vercel project environment variables (Project Settings →
Environment Variables), scoped to the environments (Production/Preview/Development) they apply to.

### Required

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | The Supabase project URL. Returned as-is to the browser via `GET /api/v1/public-config` so the sign-in page can talk to Supabase Auth, and used server-side to build the PostgREST client and to fetch the JWKS for JWT verification. Must be a valid URL. |
| `SUPABASE_ANON_KEY` | The Supabase project's public anon key. Also returned via `public-config`; used as the PostgREST client key when no service-role key is configured. Safe to expose to the browser by design. |

### Optional (server-only)

| Variable | Purpose |
|---|---|
| `APP_URL` | The app's own public URL. Defaults to `http://localhost:3000` when unset; not currently read anywhere else in the request path. |
| `SUPABASE_SERVICE_ROLE_KEY` | Elevated PostgREST key. Used for: the durable auth-throttle client (`scripts/server.mjs`), the internal notification-drain and audit-verify-all cron routes (`src/lib/http/internal-routes.mjs`, both of which bypass RLS by design and require this key), and as the PostgREST client key in preference to the anon key wherever it is set. Required for the two Vercel cron routes below to do anything other than return 503. |
| `SUPABASE_JWT_SECRET` | The Supabase project's legacy HS256 JWT signing secret, for verifying access tokens without a JWKS round-trip. Optional because the verifier also accepts ES256/RS256 tokens via the project's published JWKS (needs only `SUPABASE_URL`); auth fails closed (503) only if **neither** is configured. |
| `DATABASE_URL` | A direct Postgres connection string. **Not read by the running application** — only by local/CI tooling (`scripts/run-rls-tests.mjs`, `scripts/verify-seed.mjs`) that needs a raw `psql` connection to run the RLS test suite or bootstrap a scratch database. Not required in the Vercel project; `SUPABASE_DB_URL` is accepted as an alternate name by that same tooling. |
| `OBSERVABILITY_DSN` | Destination for `src/lib/observability.mjs`'s `reportError`, used throughout the request-handling and worker code paths. Unset means errors are only logged to stdout (captured by Vercel's function logs), never sent anywhere external. Must be a valid URL when set. |
| `CRON_SECRET` | Bearer secret gating both internal cron routes (`POST`/`GET /api/v1/internal/notifications/drain` and `/api/v1/internal/audit/verify-all`). Unset means the routes return 503 (disabled) — never open. When a Vercel project env var of exactly this name is configured, Vercel's Cron Jobs feature automatically sends it as the `Authorization` header on its own invocations (see the `crons` block in `vercel.json`); no other caller can produce a valid value without knowing it. |
| `SUPABASE_STORAGE_BUCKET` | Name of the private Supabase Storage bucket used by `src/lib/storage.mjs` for report/incident/work-order/certification attachments (see `supabase/migrations/0030_storage.sql`). Defaults to `attachments` when unset — always present on the resolved server env even though it is optional to configure explicitly. |
| `EMAIL_PROVIDER` | Selects the notification worker's email adapter (`src/lib/notifications/email.mjs` + `adapters.mjs`, built by `buildAdaptersFromEnv` and used by both `src/lib/http/internal-routes.mjs`'s drain route and `scripts/notifications-worker.mjs`'s local loop). `resend` or unset/`noop`. Unset/`noop` marks every `channel: 'email'` delivery `sent` with no network call. `resend` requires `EMAIL_API_KEY` and `EMAIL_FROM`; a missing credential (or any other value) throws when the adapter is built, not silently on first send. |
| `EMAIL_API_KEY` | Resend API key. Required when `EMAIL_PROVIDER=resend`; sent as `Authorization: Bearer` on every `POST https://api.resend.com/emails` call — one call per recipient, never Resend's `/emails/batch` (a single bad address must never affect any other recipient's delivery). |
| `EMAIL_FROM` | The verified "From" address/name Resend sends every notification email as. Required when `EMAIL_PROVIDER=resend`. |
| `PUSH_PROVIDER` | Selects the notification worker's push adapter (`src/lib/notifications/fcm.mjs` + `adapters.mjs`). `fcm` or unset/`noop`. Unset/`noop` marks every `channel: 'push'` delivery `sent` with no network call. `fcm` requires `FCM_SERVICE_ACCOUNT_JSON`; a missing credential (or any other value) throws when the adapter is built. |
| `FCM_SERVICE_ACCOUNT_JSON` | Base64-encoded Google/Firebase service-account JSON (`client_email`, `private_key`, `project_id`, `token_uri`) used to mint the OAuth2 access token FCM HTTP v1 requires (`POST {token_uri}` with an RS256-signed JWT assertion, then `POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send` per device token). Base64 because the raw JSON embeds a multi-line PEM private key. Required when `PUSH_PROVIDER=fcm`; never sent to the browser. |
| `FIREBASE_WEB_CONFIG_JSON` | The owner-supplied Firebase Web SDK config object (`apiKey`, `authDomain`, `projectId`, `messagingSenderId`, `appId`, ...), as a raw (not base64) JSON string — this is the same public client config Firebase's own docs say is safe to ship to the browser, unlike `FCM_SERVICE_ACCOUNT_JSON` above. Returned verbatim as `firebaseWebConfig` by `GET /api/v1/public-config` when set to valid JSON; unset or malformed JSON simply omits the field, which is how the "Enable notifications" button in `src/public/js/app.js` decides to stay hidden. |

### Deprecated (one-release fallback)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL` — leftover
names from an abandoned Next.js stack. `src/lib/env.mjs` still reads them as a fallback when the
preferred name above is unset, so an existing deployment configured under the old names keeps
working. Prefer the new names for any new or reconfigured deployment; the fallback is scheduled
for removal once no deployment relies on it.

## Vercel cron jobs

Declared in `vercel.json`'s `crons` block; both routes live in
`src/lib/http/internal-routes.mjs` and require `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` to
be configured, or they answer 503:

| Path | Schedule | What it does |
|---|---|---|
| `/api/v1/internal/notifications/drain` | `*/5 * * * *` (every 5 minutes) | Drains queued notification jobs (`src/lib/notifications/worker.mjs`) and sweeps stale rows out of the durable auth-throttle table. |
| `/api/v1/internal/audit/verify-all` | `0 6 * * *` (daily, 06:00 UTC) | Re-walks the hash-chained audit trail for every facility and reports any chain-verification failure. |

Vercel invokes both via `GET`, passing `CRON_SECRET`'s value as the `Authorization` bearer
token; the routes also accept `POST` for manual or local invocation with the same header. If a
cron run is not showing up in logs, check the Vercel project's Cron Jobs tab for the invocation
history before suspecting the route itself.

## Applying migrations

Migrations live in `supabase/migrations/*.sql`, numbered and forward-only. Migrations 0009+ are
written to be idempotent (safe to re-run) — every `create policy` is preceded by its own
`drop policy if exists` — but they are still meant to be applied **once each, in ascending
numeric order, never skipping one**, against the target Supabase project.

1. Apply via the Supabase Dashboard's SQL Editor (paste and run one file at a time) or the
   Supabase MCP/CLI migration tooling connected to the target project — either way, in filename
   order, stopping immediately if any file errors rather than continuing past it.
2. After all files are applied, run `npm run db:verify` against a checkout of the same tree to
   confirm required functions, RLS coverage, and policy idempotency conventions hold.
3. Load or refresh `supabase/seed.sql` only against a non-production project (it is written to be
   idempotent, but it seeds demo data, not customer data).
4. Work through the post-deploy verification checklist in `plans/SECURITY_REVIEW_2026-09.md`
   (§"Post-deploy verification") before considering any migration batch shipped — migration
   application order, live RLS suites, the internal-schema helpers returning 404 through
   PostgREST, and cookie/throttle posture.

The live-project migration state as of Wave 1 sign-off is 0001 through 0049
(`plans/SECURITY_REVIEW_2026-09.md`); confirm the deployed project's applied-migration count
before starting a new batch.

## Rollback

- **Application code.** Vercel keeps every deployment; use the Vercel dashboard (or
  `vercel rollback`) to promote a previous deployment back to production. This is instantaneous
  and does not touch the database.
- **Database migrations are forward-only.** There is no down-migration tooling in this repo —
  rolling back a schema change means writing and applying a new forward migration that undoes
  it, not deleting or editing the file that shipped it. Two migrations in the current history are
  worth calling out as non-trivial to reverse even that way:
  - `0042_internal_helpers.sql` moves the permission/scope helper functions into a dedicated
    `internal` schema and repoints roughly 200 existing RLS policies at them via
    `alter database ... set search_path`. Reversing it requires moving the functions back **and**
    re-verifying every one of those policies still resolves — treat it as one-way in practice.
  - `0041_attachment_path_guard.sql` adds a trigger that rejects any attachment/evidence row
    whose path does not match the canonical `facilities/{id}/{module}/{recordId}/{file}` shape.
    Reversing the trigger is mechanical, but any row inserted while it was active is now
    guaranteed path-valid, so there is no "old" shape to restore for those rows.
  - No migration in the current tree (0001–0049) drops a column or table, so rolling the
    **application code** back to a pre-0040 deployment while the database is already migrated to
    0049 is safe in the sense that nothing the old code reads has been removed — but the old code
    also won't benefit from (or be gated by) any RLS policy added since, so this is a stopgap, not
    a supported long-term state.
- If a specific migration turns out to be wrong after it has shipped, prefer a new numbered
  migration that corrects it (matching the repo's own idempotent-policy convention) over editing
  or deleting the shipped file.

## Backup and point-in-time recovery

Backup cadence, retention, and point-in-time recovery (PITR) are configured and owned entirely
in the Supabase project dashboard (Database → Backups), not in this repository — there is no
in-repo backup tooling. This is tracked as **OP-22** in `plans/PLATFORM_OPS_PLAN.md`
("Supabase backups/retention review; enable PITR if plan allows; document restore runbook"),
an owner action gated on the project's Supabase plan and billing, not something an agent can
configure via API. Before relying on it in an incident:

1. Confirm in the dashboard which backup tier is active (nightly logical backups vs. PITR) and
   what the actual retention window is for the current plan.
2. If PITR is available on the plan, enable it and note the achievable recovery-point objective.
3. Once-test the restore procedure end to end (restore to a new/branch project, not in place)
   and record the actual steps and duration here or in a linked runbook — this has not yet been
   done as of this document's writing.

## Tenant deletion

There is **no dedicated tenant-deletion or GDPR-erasure endpoint in this codebase yet.** The
per-record retention/purge jobs that would eventually back this (`DR-31` in
`plans/DAILY_REPORTS_PLAN.md`, `IN-25` in `plans/INCIDENTS_PLAN.md` — both legal-hold-aware purge
jobs) are unbuilt Wave 4 tasks. Until they land, deleting a customer (organization) is a manual,
owner-run SQL procedure against the live Supabase project, in this order:

1. **Soft-delete first.** Where a soft-delete column exists on a table (most module tables carry
   a `deleted_at` column — see `supabase/migrations/0002_daily_reports.sql` onward, and its
   read/write hardening in `supabase/migrations/0026_soft_delete_policy_hardening.sql`), set it
   rather than deleting rows outright, so the organization stops appearing in the product
   immediately while the export/purge steps below are completed. Confirm no active `legal_hold`
   flag is set on any of the organization's incident rows before proceeding past this step —
   the incident schema (`supabase/migrations/0043_incident_report_guards.sql`) is explicitly
   designed to make legal-hold content resistant to modification.
2. **Export.** Use the existing generic export route (`GET
   /api/admin/v1/facilities/:facilityId/export/:table`, `src/lib/admin/export.mjs`,
   `EXPORTABLE_TABLES` allow-list) per facility and per exportable table to produce the customer's
   data as CSV/JSON before anything is purged, plus the Audit & Compliance area's own export for
   the audit trail. Do this for every facility under the organization — there is no
   organization-wide "export everything" endpoint today.
3. **Purge.** `organizations → facilities` and most facility-scoped tables cascade on delete
   (`references facilities(id) on delete cascade`, `references organizations(id) on delete
   cascade` — see `supabase/migrations/0001_foundation.sql`), so deleting the `organizations` row
   for the tenant, run directly in the Supabase SQL Editor by the project owner, removes its
   facilities and everything facility-scoped beneath them. This does **not** delete the
   corresponding Supabase Auth users (`auth.users`) or their `app_users` rows — those must be
   removed separately (via the Supabase Auth admin API or dashboard) for any user who belonged
   only to the deleted organization, after confirming they hold no membership in another
   organization.

This is manual SQL run by a human with project-owner access, not something this application's
API exposes; automating it (with dry-run mode, legal-hold checks, and an audit trail of the purge
itself) is out of scope until Wave 4.
