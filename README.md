# Rec Reports

Rec Reports is a production-grade recreation operations SaaS platform for multi-facility recreation, arena, aquatics, parks, and community operations teams.

## Stack

- Static Node-served web foundation with zero runtime dependencies
- Supabase Auth, Postgres, RLS, and Storage architecture targets
- Node built-in test runner for unit tests
- Repository-local format, lint, type-contract, build, and migration verification scripts

## Local setup

1. Install Node.js 20+ and npm 10+.
2. Copy `.env.example` to `.env.local` and fill in Supabase values.
3. Install dependencies with `npm ci`.
4. Run `npm run dev`.

## Production readiness checks

Run these before opening a release candidate:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run db:verify
```

## Database

Apply migrations in `supabase/migrations` to an empty Supabase project, then load `supabase/seed.sql` for demo organization, two facilities, and baseline permissions.
