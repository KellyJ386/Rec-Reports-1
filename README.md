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

**Phase 1 — Admin Control Center**:

- [x] 1.1 Config framework & schema: 13 uniform catalog tables (area, categories, count
      types, form/sop/erp catalogs, work-order/asset/position types, recipient groups) +
      `severity_level` (per-module, weighted); `facility.settings`; RLS on all; per-facility
      seed via `provision_facility_defaults()` (MODULE_SPEC.md §5.1 defaults).
- [x] 1.2 Config CRUD screens: one reusable `ConfigList` + generic facility_manager-gated
      server actions (create/edit/reorder/disable); admin pages grouped by module.
- [x] 1.3 User management: invite by email (Resend/Auth admin), assign role, multi-facility
      membership, deactivate/archive (soft, history preserved), SSO toggle (placeholder);
      no privilege escalation, every role change audited.

**Stream A — Workforce** (the differentiator):

- [x] A.1 Staff Certifications: `staff_certification` + `cert_computed_status()` +
      `staff_certification_status` view (auto active/expiring/expired); self-service add +
      optional Storage document; manager expiring view; 60/30/7-day alert cron
      (`/api/cron/cert-alerts`, Resend).
- [x] A.2 Scheduling core: `schedule_period`, `shift`, `shift_template`, `shift_assignment`,
      `availability`, `swap_request`, `schedule_delivery` (+ RLS); Draft→Published→Locked;
      create-week + publish UI. (react-big-calendar drag UI is the next increment.)
- [x] A.3 Conflict detection engine: pure, fully unit-tested module (`npm test` — 18 tests
      covering every rule + the publish gate); cert three-hop join; publish blocked on any
      Block conflict, with all blockers surfaced.

**Stream B — Operations Core**:

- [x] B.1 Injury/Illness: `injury_report` + polymorphic `report_person`/`report_witness`
      (facility derived from parent by trigger; access follows parent). Draft→Submitted→
      Reviewed→Closed with lock-on-submit, manager-only reopen, and audit on every
      create/edit/status-change (centralized `guard_report_state` trigger). No photos; no
      hard-delete (≥7yr retention). Create + person/witness + status-action UI.
- [x] B.2 Incident: `incident_report` reusing the same pattern + trigger; category/severity
      from config; `follow_up_required`/`follow_up_task_id` stub (wired in Phase 5).
- [x] B.3 Daily Log (shared log + tagging), Memo Board (post + recipient groups + read
      receipts/unread), EOD (one per facility/day, save/submit, lock-ready).

No live services are provisioned (code-only). Wire credentials in `.env.local` to run.
`provision_facility_defaults(facility_id)` is invoked during facility onboarding (the
facility-creation UI is wired when org/facility provisioning is built). The
`certifications` Storage bucket must exist for document uploads. PII columns rely on
platform at-rest encryption for now; column-level encryption is a Phase 6 hardening item.

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
