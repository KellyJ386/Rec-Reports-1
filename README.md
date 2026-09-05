# Rec Reports

Rec Reports is a recreation operations SaaS platform for multi-facility recreation, arena, aquatics, parks, and community operations teams.

## Stack

- Zero-runtime-dependency Node web app: static frontend + `/api/admin/v1/*` BFF served by `scripts/server.mjs` (security headers, HS256 JWT auth, PostgREST client over native `fetch`)
- Supabase Auth, Postgres, and RLS: 39 forward-only migrations with facility-scoped tenant isolation, platform super-admin and department-level permission scoping, append-only hash-chained audit trail, and idempotent policies
- Node built-in test runner for unit tests; SQL test suites under `supabase/tests/`
- Repository-local format, lint (JS-parse), permission-vocabulary, settings-registry, build, migration, and seed verification gates

## Signing in

`/signin` is the single entry point for both the end-user app at `/` and the Admin Control
Center at `/admin/`. It posts email and password to `POST /api/v1/auth/sign-in`, a
same-origin proxy to Supabase Auth — the browser never calls GoTrue directly, because the
`default-src 'self'` CSP forbids the cross-origin request and the app ships no bundler.

- The returned session is stored under `rr_admin_token` / `rr_refresh_token`.
- Both apps redirect to `/signin?next=…` when signed out and return you to the page you
  asked for. Only same-origin, path-only `next` values are honoured.
- An expired access token is refreshed silently once (single-flight, so concurrent 401s
  don't race for the single-use refresh token) and the request is replayed; only if that
  fails does the user get bounced to sign in again.
- `POST /api/v1/auth/sign-out` revokes the refresh token upstream. It always answers 200 —
  the browser drops its copy either way, so signing out cannot fail.
- The admin top bar shows the signed-in email from `/me` and picks the organization from
  the facilities that call returns, so no one pastes a token or an organization UUID.

## Admin Control Center

The admin area at `/admin/` governs the whole platform. All ten sections are live:

| Section | What it controls |
|---|---|
| Dashboard | Counts, links, unpublished-changes badge |
| Modules & Features | Org-level module toggles, facility tri-state overrides, per-module settings from the settings registry |
| Identity & Permissions | Roles, permission grid, memberships, effective-access simulator |
| Forms & Fields | Custom field registry, drag-and-drop multi-section form builder, versioned form definitions with draft editing and publish/retire |
| Notifications | Event catalog, distribution lists, routing rules, test sends |
| Facilities & Departments | Facility/department CRUD, timezone/locale/report settings |
| Certifications | Role requirements matrix, enforcement mode, policies, gaps report |
| Branding & Documents | Theme editor with live preview, change-request driven publish |
| Audit & Compliance | Searchable timeline, before/after diffs, hash-chain verification, CSV/JSON/PDF export (zero-dependency PDF renderer) |
| Billing & Subscription | Plan summary, entitlements, usage meters, feature flags |

Every admin mutation is validated at the API boundary, permission-gated (26-code catalog), RLS-backstopped, and audited by database trigger into a tamper-evident hash chain.

## Local setup

1. Install Node.js 20+ and npm 10+.
2. Copy `.env.example` to `.env.local` and fill in Supabase values (including `SUPABASE_JWT_SECRET` for the API).
3. Install dependencies with `npm ci`.
4. Run `npm run dev` (static only) or `npm start` after `npm run build` (static + API).

## Production readiness checks

Run these before opening a release candidate (CI runs the same list):

```bash
npm run format:check
npm run lint          # includes node --check parse of every .mjs
npm run typecheck     # includes permission-vocabulary + settings-registry checks
npm run test
npm run build
npm run db:verify     # RLS coverage, policy idempotency, required functions
npm run db:verify:seed
npm run db:test:rls   # runs supabase/tests/*.sql when DATABASE_URL is set
```

## Database

Apply migrations in `supabase/migrations` (0001–0039, in order) to an empty Supabase project, then load `supabase/seed.sql` for the demo organization, two facilities, module catalog, system roles, notification events, and subscription plans. Migrations 0009+ are idempotent and safe to re-run.

RLS/behavioral SQL tests live in `supabase/tests/` and run via `npm run db:test:rls` against any Postgres with the Supabase-style `authenticated` role and `auth.uid()` present.

## Project documents

- `REC_REPORTS_360_EVALUATION_AND_FINISH_PLAN.md` — current status (2026-09-03), 360° evaluation, and the wave-by-wave finishing plan; supersedes the status sections of the older documents below
- `ADMIN_AREA_AUDIT_REPORT.md` — the full platform audit (48 verified findings) that drove this build
- `ADMIN_CONTROL_CENTER_IMPLEMENTATION_PLAN.md` — the phased plan (Phases 0–7, all implemented on this branch)
- Module and platform design docs (`*_DESIGN.md`, `PLATFORM_ARCHITECTURE.md`, `POSTGRES_SUPABASE_SCHEMA.md`)
