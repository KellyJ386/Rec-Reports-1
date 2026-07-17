# Rec Reports

Rec Reports is a recreation operations SaaS platform for multi-facility recreation, arena, aquatics, parks, and community operations teams.

## Stack

- Zero-runtime-dependency Node web app: static frontend + `/api/admin/v1/*` BFF served by `scripts/server.mjs` (security headers, HS256 JWT auth, PostgREST client over native `fetch`)
- Supabase Auth, Postgres, and RLS: 23 forward-only migrations with facility-scoped tenant isolation, platform super-admin and department-level permission scoping, append-only hash-chained audit trail, and idempotent policies
- Node built-in test runner for unit tests; SQL test suites under `supabase/tests/`
- Repository-local format, lint (JS-parse), permission-vocabulary, settings-registry, build, migration, and seed verification gates

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

Every admin mutation is validated at the API boundary, permission-gated (16-code catalog), RLS-backstopped, and audited by database trigger into a tamper-evident hash chain.

## Local setup

1. Install Node.js 20+ and npm 10+.
2. Copy `.env.example` to `.env.local` and fill in Supabase values (including `SUPABASE_JWT_SECRET` for the API).
3. Install dependencies with `npm ci`.
4. Run `npm run dev` (static only) or `npm start` after `npm run build` (static + API).

## Deploying to Vercel

The same codebase deploys to Vercel with no changes to `npm start`. Vercel builds
the static app and serves the `/api/admin/v1/*` BFF from a single Node serverless
function that reuses the exact router + auth pipeline as `scripts/server.mjs`.

- `vercel.json` sets `buildCommand: npm run build` and `outputDirectory: dist`,
  rewrites `/api/*` to the `api/index.mjs` function, and replicates the static
  security headers (CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Strict-Transport-Security`).
- `api/index.mjs` is a Node 20 ESM serverless function that delegates every
  request to `createRequestListener()` from `scripts/server.mjs`.
- Static app is served at `/`, the admin console at `/admin/`, and the API at
  `/api/admin/v1/*`.

Set these environment variables in the Vercel project settings (Production +
Preview):

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL (PostgREST base) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | recommended | Server-only key the BFF uses for privileged reads/writes; falls back to the anon key if unset |
| `SUPABASE_JWT_SECRET` | required for the API | HS256 secret used to verify bearer tokens; without it the API returns `503` |
| `NEXT_PUBLIC_APP_URL` | optional | Public app URL (defaults to `http://localhost:3000`) |

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

Apply migrations in `supabase/migrations` (0001–0023, in order) to an empty Supabase project, then load `supabase/seed.sql` for the demo organization, two facilities, module catalog, system roles, notification events, and subscription plans. Migrations 0009+ are idempotent and safe to re-run.

RLS/behavioral SQL tests live in `supabase/tests/` and run via `npm run db:test:rls` against any Postgres with the Supabase-style `authenticated` role and `auth.uid()` present.

## Project documents

- `ADMIN_AREA_AUDIT_REPORT.md` — the full platform audit (48 verified findings) that drove this build
- `ADMIN_CONTROL_CENTER_IMPLEMENTATION_PLAN.md` — the phased plan (Phases 0–7, all implemented on this branch)
- Module and platform design docs (`*_DESIGN.md`, `PLATFORM_ARCHITECTURE.md`, `POSTGRES_SUPABASE_SCHEMA.md`)
