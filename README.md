# RecReports

Multi-tenant SaaS for **recreation facility operations management** — daily documentation,
compliance reporting, and employee scheduling in one operations layer.

> **Read [`CLAUDE.md`](./CLAUDE.md) first.** It is the project constitution and overrides any
> conflicting task instruction. Functional spec: [`MODULE_SPEC.md`](./MODULE_SPEC.md).
> Build/orchestration plan: [`BUILD_PLAN.md`](./BUILD_PLAN.md).

## Status

**Phase 0 — Foundation** (per `BUILD_PLAN.md`):

- [x] 0.1 Repo & infrastructure: Next.js 15 (App Router, TS strict, Tailwind brand tokens),
      Supabase client wiring, Resend/Stripe env placeholders, folder layout (`CLAUDE.md` §10).
- [x] 0.2 Tenancy schema & RLS: `organization`, `facility`, `user_account`,
      `facility_membership`, `job_area`, `cert_type`, `job_area_required_cert`, `audit_event`;
      `current_user_role_at()` + role gates; RLS on every table; escalation guard + role-change
      audit; pgTAP tests for cross-facility isolation and role gating.
- [x] 0.3 Auth, session & offline shell: magic-link auth + SSO placeholder, server-side
      `facility_id` resolution, Dexie offline queue with manager-surfaced conflict flag and a
      visible sync-status indicator.

No live services are provisioned (code-only). Wire credentials in `.env.local` to run.

## Tech stack

See `CLAUDE.md` §2. Next.js 15 · TypeScript (strict) · Tailwind · Supabase (Postgres + Auth +
Storage + RLS) · Dexie (offline) · Zustand · Zod · react-big-calendar · Resend · Stripe · Vercel.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase/Resend/Stripe values
npm run dev                  # http://localhost:3000
```

Quality gates:

```bash
npm run typecheck
npm run lint
```

## Database

Migrations are **timestamp-named and append-only** (`CLAUDE.md` §6) and live in
`/db/migrations`. Seed defaults live in `/db/seed`. RLS tests (pgTAP) live in `/db/tests`.

To apply locally with the Supabase CLI, symlink (or copy) into the CLI's expected paths:

```bash
mkdir -p supabase/migrations supabase/tests
ln -sf ../../db/migrations/*.sql supabase/migrations/
ln -sf ../../db/tests/*.sql       supabase/tests/
supabase start
supabase db reset      # applies migrations + seed
supabase test db       # runs db/tests (cross-facility isolation + role gates)
```

After any schema change, regenerate types: `npm run db:types` (writes `types/supabase.ts`).

## Repository layout

See `CLAUDE.md` §10. Key directories: `/app` (routes), `/components`, `/modules`, `/lib`
(`supabase`, `auth`, `offline`), `/db` (`migrations`, `seed`, `tests`), `/types`.

## Security model (summary)

- `facility_id` is **server-injected** from the session — never trusted from client input
  (`CLAUDE.md` §3.1; see `lib/auth/session.ts`).
- **RLS on every facility-scoped table** (`CLAUDE.md` §6). Authorization resolves in Postgres
  via `current_user_role_at()` and the 5-tier role hierarchy (`CLAUDE.md` §5).
- Role assignment cannot escalate above the assigner's tier; every role change is audited.
</content>
