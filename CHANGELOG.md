# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to follow
[Semantic Versioning](https://semver.org/) once a first tagged release ships.

## [Unreleased]

### Added

- Reports: expanded field types (datetime, counter, rating) with validation and visibility rules;
  submission signatures; a workflow engine that turns a submitted report into incident, work order and
  notification actions, run under a server-side execution path so a submitter cannot mint an incident or
  work order directly; template-bound distribution lists and a delivery ledger; PDF snapshots taken at
  submit time; lock/revise lifecycle; two-step template-publish governance for facilities that require it
  (migrations 0052–0055).
- Incidents: signatures and a closure gate requiring supervisor signoff on recordable incidents; a
  configurable OSHA recordability decision tree; compliance checks; legal hold with retention controls
  that extend to child rows and block re-pointing a held row; cross-module work order creation from a
  follow-up action; a legal packet PDF (statements, evidence index, packet-level integrity hash); a
  supervisor review workspace; deduplicated notification jobs on submit/escalate/SLA breach; an SLA
  breach auto-escalation sweep (migrations 0056–0058).
- Work orders: an assets registry (category, criticality, metadata, install date) with CRUD routes and a
  picker UI; SLA tracking columns written only through a service-role-only path, plus a scheduled overdue
  scan; recurring preventive maintenance (plans, cadence rules, a generation job, routes and UI); work
  orders auto-created from a report field flagged as a defect (migrations 0059–0061).

### Changed

- Report distribution deliveries are drained through the existing email adapter rather than a
  report-specific one.

### Security

- Independent security reviews of all three slices, each re-verified on the fixed head until every
  finding was closed (reports: four rounds; incidents: three; work orders: three). Sign-off recorded in
  `plans/SECURITY_REVIEW_2026-09_WAVE3.md` with a post-deploy verification checklist.

## [Wave 2] - 2026-09-07

### Added
- Role-based home: permission-gated quick actions and tiles for reports due, my open work orders, open
  incidents, unacknowledged messages, expiring certifications and today's shifts; collapsible module panels.
- Global search across incidents, work orders, employees and messages (per-module read permission), with
  trigram indexes (migration 0051).
- Incident people and witness statements: versioned, append-only, sign-once statements (migration 0050),
  routes and UI.
- Acknowledgement and receipt read paths, per-message compliance and a facility compliance rollup; the app
  shows persisted acknowledgement state across sessions.
- Shift assignments read path; the schedule board loads persisted assignments.
- Email delivery through Resend and push delivery through FCM HTTP v1 behind `EMAIL_PROVIDER` and
  `PUSH_PROVIDER`; test-send route accepts a channel; optional Firebase web config in public-config.
- Smoke test in CI against the built app; `DEPLOYMENT.md` runbook; on-demand contrast and accessibility
  checks; the caller's employee id in `/me`.

### Changed
- Route guards come from one `makeGuards()` factory; list pagination parsing is shared and consistent.
- PostgREST errors are translated centrally to 409/400/401/403; query-shape errors stay reported 500s;
  error detail is hidden in production unless `DEBUG_ERRORS` is set.
- Lint now checks unused bindings, duplicate imports and interpolated `innerHTML`; typecheck validates
  every permission literal passed to a guard.
- Minimum 44px tap targets, visible focus, labelled form controls, live status regions, skip link.

### Fixed
- `PATCH /facilities/:id` accepted only bodies that included a name.
- The certification gap report was readable by any facility member; it now requires `training.read`.
- Soft-deleting an incident person failed the row-visibility check for every actor.
- Search stripped accented and non-Latin characters from queries.

## [Wave 1] - 2026-09-06

Security hardening wave. Full scope, findings, and proving tests are in
`plans/SECURITY_REVIEW_2026-09.md`; migrations 0040-0049.

### Added

- Storage read policies scoped to module and permission code (`reports`, `incidents`,
  `work_orders`, `certifications`), with certification-evidence reads bound to the owning row
  rather than a path-string match (S-1, S-2 — `supabase/migrations/0040`, `0041`).
- `internal` Postgres schema holding the definer permission/scope primitives
  (`has_permission`, `current_facility_ids`, `is_organization_admin`, `is_platform_admin`,
  `fn_assert_same_facility`); no longer reachable through PostgREST (S-3, closes OP-05 —
  `supabase/migrations/0042`).
- Incident audit trigger and status-transition guard enforcing the documented state machine at
  the database layer, plus a narrow legal-hold write path (S-4 — `supabase/migrations/0043`).
- RLS policies for permission codes that previously existed only in the BFF layer:
  `reports.publish`, `incidents.escalate`, `incidents.tasks.create`,
  `incidents.legal_hold.manage`, `incidents.audit.view` (S-5 — `supabase/migrations/0044`).
- Durable, cross-instance sign-in/refresh throttle backed by a service-role-only Postgres table,
  layered behind the existing in-memory limiter (S-7 — `supabase/migrations/0046`).
- Facility-scoped guard on the polymorphic `message_audiences.audience_ref_id` reference
  (S-8 — `supabase/migrations/0047`).
- HttpOnly, Secure, `SameSite=Strict` refresh-token cookie; sign-in and refresh responses no
  longer return a refresh token in the JSON body (S-11).
- `plans/SECURITY_REVIEW_2026-09.md`: sign-off document covering two independent adversarial
  security reviews and two re-verification rounds, with a post-deploy verification checklist.

### Changed

- Employee/certification SELECT policies tightened to `training.read` or self-ownership; audit
  event writers aligned with the routes that actually write them (S-6 — `supabase/migrations/0045`).
- `requireOrgAdmin` replaced by `requireAuthOrgAdminRow`, which consults `organization_admins`
  directly instead of the looser pre-0019 rule (S-6, M4).
- JWT verifier now validates `iss`, de-duplicates concurrent JWKS fetches, tolerates a missing
  `kid` by trying each key of the header's algorithm, and no longer accepts 512-bit signing
  algorithms (S-13).
- ~125 RLS policies rewritten to evaluate `(select auth.uid())` once per query instead of once
  per row; covering indexes added for previously-unindexed foreign keys flagged by the Supabase
  performance advisor (S-10 — `supabase/migrations/0049`).
- Low-severity findings batch: `router.mjs` now returns 404 on a malformed URI instead of
  throwing, timestamp filters use the correct PostgREST operator, `from`/`to` query parameters
  are validated across several routes, and audit-write failures are surfaced (S-9).

### Fixed

- Removed the standing `"admins can write audit events"` policy; every audit row is now written
  only by a definer trigger, closing a forgery path (S-6).
- Migration replayability after the `internal` schema move: replaying a pre-0042 migration file
  against a post-0042 database no longer silently drops RLS policies and fails to recreate them
  (H-2, proved by the CI replay probe in `.github/workflows/ci.yml`).
- `report_template_versions` publish separation of duties, previously enforced on UPDATE only,
  now also enforced on INSERT (Review B H1).
- Incident audit-event INSERT policy widened to match the permission codes that write incident
  audit events, so a widened child-row writer can no longer commit a row and then fail the
  accompanying audit write (Review B H2).
- Incident audit trigger payload changed from a full before/after row snapshot to an explicit
  allow-list, so free-text incident narratives are no longer disclosed through a disjoint admin
  read permission (Review B H4).
- Amendment RPC (`apply_incident_amendment`) made reachable through a `SECURITY INVOKER` wrapper
  in the served schema, after re-verification found the definer function unreachable through
  PostgREST despite every other CI signal passing (NEW-1).

### Security

- Wave 1 exit gate: Supabase security advisor findings for definer-function exposure and
  mutable `search_path` addressed; post-deploy verification checklist added to
  `plans/SECURITY_REVIEW_2026-09.md` covering migration application order, live RLS suites,
  the six internal helper names returning 404 through PostgREST, refresh-cookie attributes, and
  throttle-table posture.
- Review A: 2 High, 3 Medium, 9 Low findings closed or accepted with documented rationale.
  Review B: 4 High, 5 Medium, 5 Low findings closed or accepted. 1 High and 2 Low introduced by
  the first round of fixes were caught and closed during re-verification (NEW-1/2/3). Full
  detail in `plans/SECURITY_REVIEW_2026-09.md`.

## [Wave 0] - 2026-09-05

Production blockers closed. This wave is what made the previously-built product reachable and
usable in production for the first time.

### Fixed

- API routing on Vercel: the catch-all serverless function was renamed to the filename Vercel's
  router requires, so `/api/*` requests reach the BFF instead of 404ing.
- Sign-in is now a working end-to-end login: the same-origin auth proxy correctly exchanges
  email and password with Supabase Auth and returns a usable session.
- `.mjs` files served by the local Node server now get a `text/javascript` content type instead
  of the default, so ES module imports resolve correctly.

### Added

- Security headers (`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Strict-Transport-Security`) on Vercel's static responses, matching the
  headers the Node server already sent.
- Role-based sign-in destination: after authenticating, a user is routed to the admin control
  center or the end-user app based on their role, and the chosen facility persists across the
  session.

### Changed

- README corrected (migration counts, status references) and superseded status documents marked
  as such.
