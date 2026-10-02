# Rec Reports — 360° Evaluation and Finishing Plan

Date: 2026-09-03
Basis: HEAD `main` @ `8d9b0d7` (2026-08-19), the live Supabase project `rec-reports`, the live Vercel
project `rec-reports-1`, GitHub Actions history, and five parallel evaluation agents (Opus, Sonnet ×3,
Haiku) whose findings were independently re-verified by the orchestrator before inclusion.

**This document supersedes** `STATUS_REPORT_AND_FIX_PLAN.md` (2026-07-17),
`TASK_LIST_AND_MULTI_AGENT_PLAN.md` (2026-07-18) and the "where the product stands" section of
`MODULE_DEVELOPMENT_MASTER_PLAN.md` (2026-08-13) as the statement of current status. The per-module task
catalogs in `plans/*.md` remain the task definitions; their status is tracked in
`plans/eval-2026-09-03/PLAN_RECONCILIATION.md`.

---

## 0. Verdict

**The product is built, but nobody can use it.** Every quality gate is green, 73 of 168 planned tasks
are done, all six MVP modules work end to end against the mocked and the local Postgres harness — and
in production:

1. **Every `/api/*` request returns Vercel `NOT_FOUND`.** [Certain] Verified live:
   `GET https://rec-reports-1-xi.vercel.app/api/v1/public-config` → 404, `x-vercel-error: NOT_FOUND`.
   Cause: `api/[[...path]].mjs` uses Next.js optional-catch-all naming; plain Vercel Functions need
   `api/[...path].mjs`. The one-line fix exists on the unmerged branch
   `claude/rec-reports-module-plan-twr8bp` (`0ad01d0`). The two Vercel crons (notification drain,
   audit verify) therefore also never fire.
2. **No user has ever signed in.** [Certain] `auth.users.last_sign_in_at` is NULL on the live project;
   `report_submissions`, `notification_jobs` are empty. The working login flow (session refresh,
   sign-out, JWKS/ES256 verification, removal of the paste-a-token drawer) sits on the unmerged branch
   `claude/rec-reports-login-pswfgi` (`74d4303`), based on July-18 main; a trial merge onto today's main
   produces exactly one conflict (`test/auth-routes.test.mjs`).
3. **The end-user app cannot run under the repo's own server.** [Certain] `scripts/server.mjs` and
   `scripts/dev-server.mjs` serve `.mjs` as `text/plain` with `nosniff`; `src/public/js/app.js` imports
   six `.mjs` modules, so the browser refuses them and `/` renders an empty skeleton. Vercel's CDN sets
   the right type, so this is masked in production — where the API is down anyway.
4. **Sign-in always lands in `/admin/`** with no link back to the operations app, so even with 1–3 fixed
   a frontline worker cannot reach "submit today's report" from the UI.
5. **Production HTML ships with no security headers.** [Certain] The Node server adds CSP/XFO/HSTS/nosniff,
   but on Vercel static files bypass it and `vercel.json` has no `headers` block; verified on the live
   domain. Access and refresh tokens live in `localStorage`. Clickjacking is trivially possible and any
   XSS is a durable account takeover.

None of these is more than a day of work. Together they are the difference between "impressive repo"
and "pilot-able product". Wave 0 below is exactly this list.

Below Wave 0 the picture is genuinely good: tenant isolation has been empirically audited, the RLS suites
pass on a fresh Postgres, unit coverage is 95.6% line, and the MVP capability set is real. The remaining
work is (a) a security hardening pass with three High findings, (b) a short list of "looks done but
isn't" product gaps a pilot would hit in week one, and (c) the M2/M3 backlog (83 tasks not started).

---

## 1. Method

| Lens | Agent / model | What it did | Orchestrator re-verification |
|---|---|---|---|
| Live infrastructure | Orchestrator (Fable) | Supabase MCP: migrations, tables, row counts, advisors. Vercel MCP: project, deployments, live HTTP probes. GitHub: CI runs, PRs, remote branches. | n/a (primary) |
| Local DB truth | Orchestrator | Replicated the CI job on local Postgres 16: bootstrap + 39 migrations + seed (twice) + `db:test:rls`. | 21/21 SQL suites pass; seed idempotent |
| Plan ↔ code reconciliation | Sonnet | All 168 task IDs in `plans/*.md` classified DONE / PARTIAL / NOT STARTED / OWNER-ONLY by opening the named files, ≥3 end-to-end traces per module. | Spot-checked; rollup accepted |
| Security | Opus | Adversarial review of auth, guards, RLS, storage, cron, PostgREST client, frontend. | Top 3 Highs re-read in code and confirmed; H1 confirmed on the live domain |
| Code & test quality | Sonnet | Coverage run, test-assertion quality, duplication, dead code, gate honesty, eslint pass. | Dead-code list and gate claims confirmed |
| Frontend / UX | Sonnet | Built and ran the app, Playwright at 1280×800 and 390×844, unauthenticated + authenticated with a minted JWT and mocked API; 43 screenshots. | `.mjs` MIME bug and `/admin/` redirect reproduced by hand |
| Ops / docs | Haiku | README vs reality, doc contradictions, env coverage, crons, worker adapters, secrets scan, release process. | **Two of its claims were wrong** (36 permission codes → actually 26; "no serverless handler" → exists, misnamed). Corrected below. |

The Haiku error rate is itself a finding for the plan: cheap-tier output on anything factual must be
verified by a mid-tier agent before it drives work (§5.1).

---

## 2. Scorecard

| Dimension | Score /5 | One-line justification |
|---|---|---|
| Data model & RLS | 4.5 | 73 tables, RLS on all, hash-chained audit, 21 SQL suites pass on fresh Postgres; 30 isolation findings closed empirically in Aug. Remaining: 3 High + 7 Medium security items (§4.2). |
| API / BFF | 4 | Consistent route pattern, permission-gated, input-validated, 1311 unit tests asserting real PostgREST queries. Weak: most PostgREST errors become opaque 500s; 8 permission codes exist only in the BFF. |
| Product completeness (MVP) | 4 | 59/67 M1 tasks done; 7 of 8 roadmap E2E journeys work; all six modules have real create/edit/submit flows. Gaps: ack state and shift assignments are session-local, push is a no-op. |
| Product completeness (M2/M3) | 1.5 | 9/62 M2 and 5/39 M3 done, all of them platform primitives. No module's M2 phase has begun. |
| Frontend / UX | 2 | Works once JS runs, but broken under the repo server, no role-based home, no global search, facility resets on refresh, 94% of mobile tap targets under 44px, no `aria-live`, form labels unassociated. |
| Security posture | 2.5 | Strong tenant isolation; but no security headers in production, storage read policy bypasses module permissions, signed URLs never check facility prefix, definer helpers exposed to `anon` via RPC. |
| Deploy / ops | 1.5 | Deployed but API dead; nobody has logged in; crons never fire; notification delivery is in-app only; no runbook, backup policy, changelog or smoke-in-CI. |
| Code quality & gates | 3 | Clean architecture, 95.6% line coverage, but `lint` is `node --check`, `typecheck` has no types, `format:check` checks trailing newlines only; 10 dead exported functions; 7× duplicated 403 wrapper. |
| Docs / source of truth | 1.5 | README says 23 migrations / 16 permissions / 10 suites (actual 39 / 26 / 21); three status docs contradict each other; none marked superseded. |

---

## 3. Verified state

### 3.1 Repository and gates (main @ 8d9b0d7)

| Gate | Result |
|---|---|
| `format:check`, `lint` (143 .mjs), `typecheck` (26 codes, 15 settings / 6 modules) | pass |
| `npm test` | 1311 / 1311 pass, 2.5 s |
| `build`, `db:verify` (39 migrations), `db:verify:seed` (executable, seed applied twice) | pass |
| `db:test:rls` on local Postgres 16 via the CI bootstrap | 21 / 21 suites pass |
| Coverage (`--experimental-test-coverage`) | 95.6% line / 83.8% branch; lowest `src/lib` file is `notification-routes.mjs` at 67.7% |
| GitHub Actions on `main` | green (2026-08-19) |
| Open PRs | none |

CI triggers only on `pull_request` and pushes to `main`/`master`/`work`; pushes to `claude/*` branches
do not run CI until a PR is opened.

Unmerged branches carrying real code:

| Branch | Commit | Content | Merge status |
|---|---|---|---|
| `claude/rec-reports-login-pswfgi` | `74d4303` (2026-08-14) | Working end-to-end login: `admin/js/auth.js` single-flight refresh, 401-retry, `/signin?next=` redirect, sign-out route, `/me` double-registration fix, JWT verifier extended to JWKS ES256/RS256 fail-closed. 26 files, +934/−316. | One conflict in `test/auth-routes.test.mjs` (~250-line region); 1308/1309 tests pass before resolution |
| `claude/rec-reports-module-plan-twr8bp` | `0ad01d0` (post-PR #14) | Rename `api/[[...path]].mjs` → `api/[...path].mjs`. 3 files. | Clean |
| 12 `codex/*` and `claude/*` branches | — | All merged or superseded | Delete |

### 3.2 Live Supabase — project `rec-reports` (`ynrwmlrbpaddmknzckyt`, us-east-1, PG 17.6, healthy)

- All 39 migrations applied (0038 in three parts; two extra live-only search_path fixes). 73 public
  tables, RLS enabled on all. Seed loaded (1 org, 2 facilities, 26 permissions, 4 roles, 6 modules).
- 1 auth user, 1 app_user, 1 membership, 1 platform admin. **`last_sign_in_at` is NULL.** Zero
  submissions, zero notification jobs, last audit event 2026-08-14 (migration time).
- Storage bucket `attachments` exists.
- Security advisors: 12 `SECURITY DEFINER` functions executable by `anon` and `authenticated` through
  `/rest/v1/rpc` (`has_permission` ×2, `is_platform_admin`, `is_organization_admin`,
  `current_facility_ids`, `fn_assert_same_facility`, and six trigger functions); one mutable
  `search_path` (`fn_report_template_version_immutable`); leaked-password protection disabled.
- Performance advisors: 510 lints — 235 multiple-permissive-policies, 125 `auth_rls_initplan`
  (`auth.uid()` not wrapped in `(select …)`, re-evaluated per row), 78 unindexed foreign keys, 71
  unused indexes. Irrelevant at pilot scale, material at 50+ facilities.

### 3.3 Live Vercel — project `rec-reports-1` (pro team, Node 24.x, framework null)

- Production = `main@8d9b0d7`, READY. Latest preview = `0ad01d0` (the routing fix), READY but behind
  Vercel SSO so unverifiable from here.
- `GET /api/v1/public-config` on the production domain → **404 NOT_FOUND**. Static pages serve.
  Runtime error log for 7 days: empty (nothing reaches the function).
- Static responses carry HSTS from Vercel only; no CSP, `X-Frame-Options`, `nosniff` or
  `Referrer-Policy`.
- Env vars are not inspectable via MCP. Whether `SUPABASE_JWT_SECRET` and `CRON_SECRET` are set is
  unknown [Guessing: probably set, since the July task list called it out and the project was
  redeployed three times on 2026-08-12].

### 3.4 Plan reconciliation (168 tasks)

| Module | Done | Partial | Not started | Owner-only |
|---|---|---|---|---|
| Daily reports (DR, 34) | 15 | 1 | 18 | 0 |
| Incidents (IN, 25) | 9 | 1 | 15 | 0 |
| Work orders (WO, 27) | 11 | 1 | 15 | 0 |
| Scheduling (SC, 24) | 8 | 1 | 15 | 0 |
| Communications (CM, 18) | 9 | 1 | 8 | 0 |
| Training (TR, 16) | 6 | 0 | 10 | 0 |
| Platform/ops (OP, 24) | 15 | 1 | 2 | 6 |
| **Total** | **73** | **6** | **83** | **6** |

| Milestone | Planned | Done | Partial | Not started | Owner-only |
|---|---|---|---|---|---|
| M1 (MVP) | 67 | 59 | 3 | 1 | 4 |
| M2 (design-complete) | 62 | 9 | 1 | 51 | 1 |
| M3 (polish) | 39 | 5 | 2 | 31 | 1 |

Partial: DR-27 (settings keys), IN-10 (people section is a stub), WO-27 / OP-24 (no standalone security
sign-off), SC-08 (no `GET` for shift assignments), CM-09 (no `GET` for acknowledgements).

MVP roadmap §1.2: capabilities A, B, C, D, F usable end to end; E (communications) partial — ack/read
display is session-local and push delivery is a documented no-op. Roadmap §8.1: 7 of 8 journeys work;
"acknowledge message" persists correctly but the UI badge is stale on reload.

Claims that do not hold: the PR #14 merge message implies push notifications ship (they do not);
`plans/RLS_AUDIT.md` explicitly leaves `message_audiences.audience_ref_id` cross-facility injection
unprobed in a shipped feature; WO-27 / OP-24 "security review" have no artifact.

---

## 4. Findings by dimension

### 4.1 Blockers (all must close before anyone is invited in)

| # | Finding | Evidence | Fix | Size |
|---|---|---|---|---|
| B1 | Production API 404 on every path | live probe; `api/[[...path]].mjs` | merge `0ad01d0`, redeploy, probe `public-config` | S |
| B2 | Login flow unmerged; nobody has ever signed in | `last_sign_in_at` NULL; branch `74d4303` | merge, resolve `test/auth-routes.test.mjs`, re-run gate | M |
| B3 | `.mjs` served as `text/plain` by both Node servers | `scripts/server.mjs:36`, `scripts/dev-server.mjs:7` | add `".mjs": "text/javascript"`; add a header test | S |
| B4 | Sign-in hardcodes `/admin/`; no route to `/` | `src/public/signin/app.js:56` (main), `:3` (login branch) | destination by permissions from `/me`; "Operations app" link in admin top bar | S |
| B5 | No security headers on production HTML | live headers; `vercel.json` has no `headers` | `headers` block mirroring `securityHeaders` (CSP must allow `'self'` module scripts and `connect-src 'self'`) | S |
| B6 | Crons never fire (consequence of B1); `CRON_SECRET` unverified | `vercel.json` crons → 404 | after B1, confirm 200/503 from drain endpoint with the secret | S + owner |

### 4.2 Security (Opus review, orchestrator-verified top three)

Framing: `/api/v1/public-config` hands every visitor the Supabase URL and anon key, so any signed-in
user can talk to PostgREST, Storage and `rpc/*` directly. RLS, not the BFF, is the real boundary; every
place they diverge is a finding.

| ID | Sev | Finding | Fix |
|---|---|---|---|
| H1 | High | No CSP/XFO/nosniff on production HTML; access + refresh tokens in `localStorage` | = B5. Longer term: refresh token in an `HttpOnly` cookie set by the auth proxy |
| H2 | High | `storage.objects` SELECT policy (`0030_storage.sql:93`) grants every facility *member* read+list of all attachments in the facility, bypassing `reports.read` / `incidents.read` / `work_orders.read` | parse the module segment from the object path and require the module's read permission |
| H3 | High | Signed-URL routes (`attachments-routes.mjs:375`, `training-routes.mjs:981`) sign a row's `storage_path` with the service-role key without asserting it starts with `facilities/{row.facility_id}/`; the INSERT policies let the caller set that path | assert prefix before signing; add a CHECK or trigger on `storage_path` prefix |
| M1 | Med | `incident_reports` has no audit trigger and no status/immutability guard; `incidents.manage` can silently rewrite or close a filed incident | AFTER trigger mirroring `fn_report_submission_audit`; BEFORE trigger enforcing the transition machine |
| M2 | Med | 8 of 26 permission codes enforced only in the BFF (e.g. `reports.publish`) | push each into the owning RLS policy |
| M3 | Med | `requireOrgAdmin` in the BFF keeps semantics `0019` removed from SQL | consult `organization_admins` |
| M4 | Med | Sign-in throttle is per-instance memory (ineffective on Vercel); `/auth/refresh` has none | Postgres-backed counter table with atomic upsert |
| M5 | Med | 12 definer helpers exposed as RPC to `anon`/`authenticated` (= OP-05) | see §5.3 S-3 — schema move, not a blind revoke |
| M6 | Med | `admin.manage` holders can insert audit rows that verify as chain-intact | drop the client INSERT policy on `audit_events`; triggers are the only writers |
| M7 | Med | HR/certification tables readable by any member while the BFF requires `training.read` | switch four SELECT policies to `has_permission(…, 'training.read')` |
| L1–L8 | Low | JWT `exp` not required for some flows; `detail` leaked in error bodies; `URIError` on malformed paths → 500; a `published_at` filter that rejects on timestamptz; unvalidated date ranges in `me-route`/`entitlements`/`worker`; one create path whose WITH CHECK can never pass; partial-write on audit failure | batch into one Sonnet task |

Also open from `plans/RLS_AUDIT.md`: `message_audiences.audience_ref_id` polymorphic reference with no
cross-facility guard (shipped, documented, unfixed).

Checked and correct (so the reader knows coverage): HS256 verification with algorithm pinning, body size
cap, PostgREST value encoding, cross-facility FK triggers from 0035/0038, membership/role facility
consistency, append-only audit triggers, sign-in error uniformity, `next` open-redirect guard on the login
branch.

### 4.3 Product gaps a pilot would hit in week one

| # | Gap | Task IDs | Why it matters |
|---|---|---|---|
| P1 | Ack/read state visible only in the current browser session; no compliance rollup | CM-09 (partial), CM-11 | Required-acknowledgement is the comms module's headline promise |
| P2 | Schedule board has no `GET` for shift assignments; second user/session sees stale board | SC-08 (partial) | Flagship scheduling capability misrepresents who is on shift |
| P3 | No role-based home dashboard; hero + six placeholder cards; real content 2.6–4.8 mobile screens below the fold | roadmap §6.1 #2 | "3-tap completion" is impossible; frontline adoption dies here |
| P4 | Facility context resets to the first facility on every refresh | — | Multi-facility users lose their place; wrong-facility data entry risk |
| P5 | Email delivery does not exist; push is a no-op adapter | OP-09/12, CM-07/14 | Escalations, reminders, expiry alerts all depend on it |
| P6 | Incident "people involved" is a placeholder; no witness/people routes | IN-10 (partial), IN-12 | Injury incidents are unusable without the injured party |
| P7 | Mobile: 94% of tap targets under 44 px; incident form labels unassociated; no `aria-live` anywhere | — | Field staff are on phones; accessibility is a procurement checkbox for municipalities |
| P8 | No global search | roadmap §6.2 | Stated UX principle, unbuilt |

### 4.4 Code quality

- Strong: consistent route registration signature, shared guard/router/PostgREST primitives, tests assert
  actual query strings and 403 paths, one true process-level integration test, centralized PDF renderer.
- Ten dead exported functions across `work-orders.mjs`, `scheduling.mjs`, `incidents.mjs`,
  `training.mjs` (e.g. `sortWorkOrdersForDashboard`, `classifyOshaReview`, `certificationBlocksSchedule`)
  — all designed for M2 features not yet wired.
- `requireRead`/`requirePerm` copied near-verbatim into 7 route files; pagination parsing duplicated
  with drifted validation between reports and work orders.
- Only 3 route files translate `PostgrestError` into 4xx; everything else becomes a generic 500.
- Untested: `notification-routes.mjs` PATCH/members/routes-list (permission checks could be deleted with
  no test failing), `admin-routes.mjs` facility PATCH, `cert-policy-routes.mjs:119-203`.
- Gates are weaker than their names: `lint` = `node --check` + tab grep; `typecheck` = permission
  vocabulary cross-check, no static types; `format:check` = trailing newline. An ad-hoc eslint run found
  six unused constants the gates miss.
- `app.js` is 3099 lines, ~7 module-level globals, mixed `el()` builder and `innerHTML` string
  rendering, zero direct tests (its six extracted `.mjs` helpers are 83–100% covered).

### 4.5 Ops and documentation

- README: 23 → 39 migrations, 16 → 26 permission codes, 10 → 21 SQL suites, "0001–0023" → 0039.
- Three status docs contradict each other and none is marked superseded (fixed by this document).
- `scripts/smoke.mjs` exists (16% covered, never run by CI or post-deploy).
- Notification worker delivers in-app only; email/SMS/push have no provider integration.
- Observability reporter is real and wired but only fires on thrown errors and is a no-op without a DSN.
- No CHANGELOG, tags, release process, backup/PITR policy, tenant deletion procedure, or deployment runbook.
- Secrets hygiene clean (no keys in tracked files or history). `.env.example` matches `env.mjs`.

---

## 5. Finishing plan

### 5.1 Principles

1. **Wave 0 is a single PR, shipped before anything else.** Everything in it is small and already
   diagnosed. Do not start Wave 1 until a real user has signed in on production and
   `scripts/smoke.mjs` passes against it.
2. **Model tiers, with a verification rule.**

   | Tier | Model | Carries | Rule |
   |---|---|---|---|
   | Orchestrator | Fable 5.1 (this session) | sequencing, migration numbers, merges, owner decisions, final gate | reads every diff touching RLS, auth, storage, cron |
   | Review | Opus 5 | security review of every RLS/auth/storage/definer change; Wave 1 sign-off | blocks merge on High/Medium |
   | Build (mid) | Sonnet 5 | anything touching RLS, guards, state machines, migrations, workers, PostgREST query shapes, UI flows with auth | reviews every Haiku deliverable on a permission-gated path |
   | Build (cheap) | Haiku 4.5 | mechanical edits, pattern-copy CRUD routes, tests mirroring existing ones, docs, index migrations, UI wiring from a spec | **all factual claims and any file it says it changed are verified by Sonnet before merge** (Haiku produced two false statements in this evaluation) |

3. **Every task ships with its tests**; the full gate (`format:check`, `lint`, `typecheck`, `test`,
   `build`, `db:verify`, `db:verify:seed`, and `db:test:rls` on local Postgres whenever a migration
   changes) runs before every merge, exactly as CI does. Local Postgres 16 is available in this
   environment; use it, don't rely on CI alone.
4. **Worktree isolation** (`isolation: "worktree"`) for any task touching `src/public/js/app.js`,
   `src/public/index.html`, `scripts/server.mjs`, `settings-registry.mjs`, `permissions.mjs`,
   `seed.sql`. The orchestrator merges. **Migration numbers are assigned by the orchestrator at merge
   time**, starting at 0040; plans' numbers are ordering hints.
5. **One PR per wave slice**, opened against `main` so CI runs; the orchestrator watches CI and
   review comments via `subscribe_pr_activity`.
6. The Workflow tool can run the fan-outs in §5.4–5.6 deterministically (pipeline: build → Sonnet
   review → Opus security check for RLS-touching slices). It requires the owner to opt in ("use a
   workflow"); otherwise the same shape runs as background Agent calls.

### 5.2 Wave 0 — Make production real (1–2 days, one PR)

| # | Task | Agent | Depends |
|---|---|---|---|
| W0-1 | Merge `0ad01d0` (`api/[...path].mjs`); update the two comments and `README` mention | Haiku | — |
| W0-2 | `.mjs` content type in `scripts/server.mjs` + `scripts/dev-server.mjs`; extend `test/server-headers.test.mjs` to assert `text/javascript` for a `.mjs` path | Haiku, Sonnet verify | — |
| W0-3 | Merge `74d4303` (login) onto main; resolve `test/auth-routes.test.mjs` (keep both the throttle tests from main and the sign-out/refresh tests from the branch); re-run gate | Sonnet | — |
| W0-4 | Opus review of the JWKS/ES256 verifier introduced by W0-3 (`src/lib/http/auth.mjs`): kid pinning, cache TTL, fail-closed on fetch error, `alg` allow-list | Opus | W0-3 |
| W0-5 | `vercel.json` `headers` block: CSP `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS. Verify the module scripts and `/api` calls still work under it (Playwright smoke) | Sonnet | — |
| W0-6 | Sign-in destination: land on `/` unless the user holds only admin permissions; add "Operations app" link to the admin top bar and "Admin" link on `/` (already exists) | Sonnet | W0-3 |
| W0-7 | Persist facility selection in `localStorage` (mirror `rr_admin_context`); restore on load, fall back to first facility | Haiku | — |
| W0-8 | README counts (39 / 26 / 21 / 0001–0039), link this document, mark the two July docs and the master plan's status section as superseded (banner at top of each) | Haiku | — |
| W0-9 | Open PR, CI green, merge, confirm Vercel production deploy | Orchestrator | all above |
| W0-10 | **Owner:** confirm `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `CRON_SECRET`, `OBSERVABILITY_DSN` (optional) in Vercel project env; enable leaked-password protection in Supabase Auth (OP-06); confirm JWT signing mode (legacy HS256 or asymmetric — W0-3 handles both) | Owner | — |
| W0-11 | Run `scripts/smoke.mjs` against production with the seeded admin credentials; sign in in a browser; submit one daily report; verify `last_sign_in_at` and `report_submissions` are non-null on the live DB; confirm the drain cron returns 200 | Orchestrator | W0-9, W0-10 |
| W0-12 | Delete the 12 dead remote branches | Owner confirms, Haiku executes | — |

Exit gate: production API answers, a real user is signed in, one report exists in the live database,
smoke passes, security headers present on `/`.

### 5.3 Wave 1 — Security hardening (≈1 week; Sonnet builds, Opus signs off, one PR per row group)

| # | Task | Migration | Agent |
|---|---|---|---|
| S-1 | H2: `storage.objects` read policy → module read permission derived from the path's module segment (`fn_storage_attachment_module(name)`); RLS test in `supabase/tests/storage_reads.sql` | 0040 | Sonnet + Opus |
| S-2 | H3: `assertPathInFacility(path, facilityId)` in `storage.mjs`, called before every `createSignedUrl`; trigger on the three attachment tables and `employee_certifications.evidence_path` enforcing the `facilities/{facility_id}/` prefix | 0041 | Sonnet + Opus |
| S-3 | M5 / OP-05: move the RLS helper functions (`has_permission` ×2, `is_platform_admin`, `is_organization_admin`, `current_facility_ids`, `fn_assert_same_facility`) into an unexposed `internal` schema with `EXECUTE` granted to `authenticated` only (policies still call them; PostgREST no longer exposes them); `REVOKE EXECUTE` from `anon` and `authenticated` on the six trigger functions (triggers do not need caller EXECUTE at fire time); pin `search_path` on `fn_report_template_version_immutable`. **Requires the full RLS suite on local Postgres and a live advisor re-run.** | 0042 | Sonnet + Opus; orchestrator applies live |
| S-4 | M1: incident audit trigger + transition-guard trigger on `incident_reports`; RLS test | 0043 | Sonnet |
| S-5 | M2: the 8 BFF-only permission codes into RLS (`reports.publish`, and the rest from the review); extend `scripts/typecheck.mjs` to fail if a code in `permissions.mjs` appears in no migration policy | 0044 | Sonnet |
| S-6 | M6 + M7 + M3: drop client INSERT on `audit_events`; four HR/cert SELECT policies → `training.read`; `requireOrgAdmin` → `organization_admins` | 0045 | Sonnet |
| S-7 | M4: Postgres-backed sign-in/refresh throttle (`auth_throttle` table, atomic upsert, sweep in the drain cron) | 0046 | Sonnet |
| S-8 | `message_audiences.audience_ref_id` cross-facility trigger by `audience_type` (department / employee / distribution list) | 0047 | Sonnet |
| S-9 | L1–L8 batch (JWT `exp` required, drop `detail` in production errors, `URIError` → 404 in router, `published_at` filter, date-range validation, the never-passing WITH CHECK, audit partial-write) | — | Sonnet |
| S-10 | Performance advisors: generated migration wrapping `auth.uid()` as `(select auth.uid())` in all 125 flagged policies; covering indexes for the 78 FKs; drop or justify the 71 unused indexes; consolidate duplicate permissive policies where semantics are identical | 0048–0049 | Haiku generates, Sonnet verifies with full RLS suite |
| S-11 | Refresh token to `HttpOnly` cookie set by the auth proxy (access token stays in memory/localStorage); CSRF consideration documented | — | Sonnet + Opus |
| S-13 | JWT verifier follow-ups deferred by the W0-4 review: validate `iss` accepting both the legacy `supabase` value and the project URL form; de-duplicate concurrent JWKS fetches; tolerate a missing `kid` by trying each published key of the header's algorithm; drop ES512/RS512 from the allow-list unless Supabase documents issuing them | — | Sonnet + Opus |
| S-12 | Security sign-off artifact `plans/SECURITY_REVIEW_2026-09.md` closing OP-24 / WO-27 / DR-34 / IN-24 | — | Opus |

Exit gate: Supabase security advisor shows zero WARN; RLS suites 21+N pass locally and against the live
project; Opus sign-off written.

**Status 2026-09-06:** every row above is built, reviewed and signed off on PR #18
(`claude/wave1-review-fixes`, migrations 0040–0049; note the renumbering: 0048 carries the part B review
fixes and the performance migration became 0049). Two adversarial reviews and two re-verification rounds
are recorded in `plans/SECURITY_REVIEW_2026-09.md` (S-12). Gate on the signed-off head: 1478 unit tests,
29 RLS suites, 49-migration replay, seed twice, re-apply probe, CI green. Still open from the exit gate:
applying 0040–0049 to the live project and the live advisor re-run, both waiting on the owner's go
(one-way change), and the in-browser cookie-refresh check against production afterwards.

### 5.4 Wave 2 — Pilot-ready product (≈2 weeks, parallel tracks in worktrees)

| # | Task | IDs | Agent |
|---|---|---|---|
| P-1 | `GET /messages/:id/acknowledgements` + receipts; CM-11 compliance rollup endpoint; wire `comms-compose.mjs` and the panel to it | CM-09, CM-11 | Sonnet route + Haiku UI |
| P-2 | `GET /facilities/:id/shift-assignments?periodId=`; board loads persisted state | SC-08 | Haiku, Sonnet review |
| P-3 | Role-based home dashboard replacing the hero: today's shifts, my open reports, open incidents/work orders, unacknowledged messages, expiring certs; quick actions "Submit report" / "Log incident" / "New work order" above the fold on mobile | roadmap §6.1 #2 | Sonnet (design + `app.js` restructure), Haiku (cards) |
| P-4 | Email adapter (recommend Resend — plain HTTPS, fits the zero-dependency `fetch` client) behind `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`; worker consumes; test-send route | OP-09 (owner), OP-12, CM-14 | Owner decides; Sonnet builds |
| P-5 | Push: decide FCM (Android + web) now, APNs later; implement FCM HTTP v1 adapter behind the existing `push.mjs` interface | CM-07 | Owner decides; Sonnet builds |
| P-6 | Incident people/witness routes and the capture form section | IN-12, IN-10 | Sonnet route, Haiku UI |
| P-7 | Mobile + accessibility pass: 44 px targets, label association on all forms, `aria-live` status regions, focus management after actions, contrast check | — | Sonnet |
| P-8 | Global search across incidents, work orders, employees, messages (single `GET /search?q=` fan-out, permission-filtered) | roadmap §6.2 | Sonnet |
| P-9 | Central `PostgrestError` → 4xx translation in `guard.mjs`/`router.mjs`; remove the three local copies | — | Sonnet |
| P-10 | Tests for `notification-routes.mjs` PATCH/members/list and `admin-routes.mjs` facility PATCH; `cert-policy-routes.mjs` gap-report branches | — | Haiku, Sonnet verify |
| P-11 | Gate upgrade: eslint (`no-unused-vars`, `no-undef`, `no-unreachable`) into `scripts/lint.mjs`; typecheck extended to route-file permission literals; delete the six unused constants | — | Haiku |
| P-12 | Refactors: `makeGuards()` factory in `guard.mjs` replacing the 7 copies; server-side `parseListLimitOffset`; delete or wire the 10 dead domain functions (wire `sortWorkOrdersForDashboard`, `classifyOshaReview`, `certificationBlocksSchedule` where their M2 tasks land, delete the rest) | — | Haiku, Sonnet review |
| P-13 | Smoke in CI: post-deploy job hitting the Vercel preview URL with `scripts/smoke.mjs`; CHANGELOG.md; tag `v0.2.0` at Wave 2 exit; `DEPLOYMENT.md` runbook (env vars, crons, rollback, backup/PITR, tenant deletion) | OP-22 | Haiku, Sonnet for runbook |

Exit gate: a pilot facility can run a day end to end on phones; ack compliance and the board are truthful
across sessions; email goes out; `v0.2.0` tagged.

**Status 2026-09-07:** P-1 … P-13 are built, reviewed and open as a stacked chain of PRs: #19 (2A: P-9,
P-10, P-11, P-12, P-13), #20 (2C: P-4, P-5), #21 (2B + 2D: P-1, P-2, P-6, P-3, P-8; migrations 0050–0051)
and #24 (P-7 plus a Unicode-aware search fix). Independent reviews of each slice found no defects. Gate on
the top of the stack: 1756 unit tests, 31 RLS suites, 51-migration replay, contrast check 21/21, on-demand
accessibility check pass. Still open from the exit gate: the owner's credentials for Resend and FCM (email
"goes out" only once `EMAIL_API_KEY`/`EMAIL_FROM` are set), browser-side FCM token minting (blocked by the
self-only CSP, deliberately not loosened), the pilot-facility walkthrough on real phones, and the `v0.2.0`
tag after the chain merges to `main`.

### 5.5 Wave 3 — Design-complete (M2, 51 tasks; 4–6 weeks of agent time)

Order by module value, same as before: reports → incidents → work orders → scheduling → communications
→ training. Cross-module pairs are built once with two consumers (from the master plan §3):

| Slice | Tasks | Build | Review |
|---|---|---|---|
| Reports workflow + distribution | DR-16, 17, 18, 19, 20, 21, 22, 23, 24, 26 | Sonnet (DR-18/19/20 engines), Haiku (DR-16 field types, DR-17, DR-23) | Opus on DR-20 (privilege elevation) |
| Incidents legal core | IN-11, 13, 14, 15, 16, 17, 18, 19, 20, 21 | Sonnet | Opus on IN-16 (legal hold) |
| Work orders assets, SLA, PM | WO-11, 12, 13, 15, 16, 17, 18, 19, 20, 21 | Haiku CRUD (WO-12/13/20), Sonnet (WO-15/16/18/19/21) | Sonnet |
| Scheduling self-service | SC-10, 11, 12, 13, 14, 15, 16, 17, 19 | Sonnet (state machines), Haiku (SC-15 UI) | Sonnet |
| Communications escalation | CM-10, 12, 13 | Sonnet | Opus on CM-13 (emergency mode) |
| Training content + automation | TR-07, 08, 09, 10, 11, 12 | Sonnet (TR-09/10/11), Haiku (TR-07/08) | Sonnet |
| Platform | OP-05 already in S-3; CM-16 realtime spike (owner decision: Supabase Realtime vs SSE vs polling) | Sonnet spike | Orchestrator decides |

Every slice: worktree, its own migration(s), unit + RLS tests, Sonnet review of permission gating,
orchestrator integration in `server.mjs` / `index.html` / `app.js`.

### 5.6 Wave 4 — Polish and scale (M3, 31 tasks)

Scheduled sweeps on the one drain pattern (IN-21, TR-11, CM-10, WO-19, DR-29), dashboards/analytics
(IN-23, WO-22, TR-14), PDFs (SC-18, WO-23, IN-18), retention/legal hold (DR-31, IN-25), entitlement
packaging (WO-25), department-scope extensions (SC-20), `app.js` split into per-module modules with
tests, admin builder polish (DR-32), performance/index pass (DR-33). Mostly Haiku with Sonnet review;
Opus on retention/legal hold.

### 5.7 Concurrency shape

A typical Wave 2 burst: 4 Sonnet builders (P-1, P-3, P-4, P-7) + 4 Haiku builders (P-2, P-10, P-11,
P-12) in worktrees + 1 Opus reviewer on anything touching auth/RLS + the orchestrator merging and running
the gate on local Postgres. That is the shape that built Waves 1–3 in August, with the added rule that
Haiku output is verified before it drives a merge.

### 5.8 Owner decisions (only these block work)

1. **W0-10** — confirm Vercel env vars and Supabase Auth settings; the JWT signing mode.
2. **OP-09** — email provider (recommend Resend).
3. **Push provider** — FCM first (recommend), APNs when there is an iOS app.
4. **S-11** — accept `HttpOnly` refresh cookie (changes the sign-in proxy contract).
5. **CM-16** — realtime approach before any live-counter work.
6. **W0-12** — approve deleting the 12 dead branches.
7. **Public repo** — this repository is public and the deployed app is reachable. The security backlog
   above is written at "what to fix" level, not exploit level, but the owner should decide whether the
   repo stays public while Wave 1 is open.

---

## 6. Effort rollup

| Wave | Tasks | Calendar (agent-driven) | Cost weight |
|---|---|---|---|
| 0 — production real | 12 | 1–2 days | mostly Haiku; one Opus review |
| 1 — security | 12 | ~1 week | Sonnet-heavy; Opus sign-off |
| 2 — pilot-ready | 13 | ~2 weeks | balanced |
| 3 — M2 | 51 | 4–6 weeks | Sonnet-heavy |
| 4 — M3 | 31 | 3–4 weeks | Haiku-heavy |

Waves 0–2 are the path to a pilot. Waves 3–4 are the path to the design docs.

---

## 7. Evidence

- `plans/eval-2026-09-03/PLAN_RECONCILIATION.md` — per-task status matrix (the tracking sheet for Waves 3–4).
- `plans/eval-2026-09-03/CODE_QUALITY.md` — scored table, defects with file:line, coverage table.
- `plans/eval-2026-09-03/FRONTEND_UX.md` — scores, defect list, screenshot inventory, roadmap comparison.
- The security review and screenshots are held outside the repository (public repo); findings are
  summarized in §4.2 at fix level.
