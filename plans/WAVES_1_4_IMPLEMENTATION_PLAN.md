# Rec Reports — Implementation Plan for Waves 1–4

## Context

The 360° evaluation (`REC_REPORTS_360_EVALUATION_AND_FINISH_PLAN.md`) found a built-but-unusable product and laid out five waves. Wave 0 (production blockers) is done and open as PR #15 against `main`; CI is green. This plan turns the remaining waves into executable work:

- **Wave 1 — Security hardening.** 3 High and 7 Medium findings from the Opus review, the JWT verifier follow-ups deferred from W0-4, the Supabase advisor backlog, and the owner's decision to move the refresh token into an HttpOnly cookie.
- **Wave 2 — Pilot-ready.** The "looks done but isn't" gaps a pilot facility hits in week one (session-local ack state and shift assignments, no home dashboard, no email or push, incident people stub, mobile/a11y), plus the engineering debt that makes every later wave cheaper (guard factory, central error translation, real lint, missing tests, smoke in CI).
- **Wave 3 — M2 design-complete.** 51 not-started module tasks from `plans/*.md`.
- **Wave 4 — M3 polish.** 31 tasks: scheduled sweeps, dashboards, PDFs, retention, packaging.

Owner decisions taken (2026-09-05): scope = all waves; email = Resend; push = FCM HTTP v1; refresh token → HttpOnly cookie in Wave 1.

Every fact below (policy names, line numbers, route lists, column names) was read from the repo at `claude/rec-reports-360-evaluation-94ajht` @ `b4af101`.

---

## Ground rules (apply to every task)

1. **Branching.** Wave 1 starts from `main` after PR #15 merges; if it is still open, branch from the PR head and rebase later. One PR per wave *slice* (the groups marked ▶ below), opened against `main` so CI runs; the orchestrator watches CI via `subscribe_pr_activity` and drives each to green before the next slice starts.
2. **Gate before every push:** `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run db:verify && npm run db:verify:seed`, plus `npm run db:test:rls` on local Postgres 16 (start with `pg_ctlcluster 16 main start`; DB replay = `scripts/ci/rls-bootstrap-pre.sql` → all migrations → `rls-bootstrap-post.sql` → `supabase/seed.sql`) whenever a migration or SQL test changes.
3. **Migration numbers are pre-assigned in this plan** (0040–0058). Every new table is appended to the `requiredRlsTables` literal in `scripts/verify-migrations.mjs:15-79`; every new required function to the array at `:88-98`. Every `create policy` in a file ≥ 0009 must be immediately preceded by its `drop policy if exists` (verify-migrations enforces it). New settings keys go contiguously inside their module's block in `src/lib/settings-registry.mjs` (gen-settings-check enforces it).
4. **Agents and models.** Orchestrator = this session. Opus = security review of anything touching RLS/auth/storage/definer functions, and Wave 1 sign-off. Sonnet = everything touching RLS, guards, state machines, migrations, workers, query shapes, UI flows with auth. Haiku = mechanical edits, pattern-copy CRUD, tests mirroring existing ones, docs. **Haiku output on a permission-gated path is reviewed by Sonnet before commit; any factual claim from Haiku is re-verified** (two false claims in the evaluation, one worktree cut from the wrong base in Wave 0).
5. **Worktree isolation** (`isolation: "worktree"`) for any task touching `src/public/js/app.js`, `src/public/index.html`, `scripts/server.mjs`, `src/lib/settings-registry.mjs`, `src/lib/permissions.mjs`, `supabase/seed.sql`, `scripts/verify-migrations.mjs`. **Confirm the worktree's base commit before the agent starts** (the W0-6/7 worktree was cut from old `main`). Agents never commit; the orchestrator applies the diff, reviews, commits.
6. **Test conventions to reuse.** Route tests: `stubFetch(t, respond)` + `mount({memberships, userId})` + `call(method, path, body)` as in `test/work-orders-routes.test.mjs:13-49`; fixtures `MANAGER/READER/OUTSIDER`; 403 asserted by mounting an under-permissioned membership. SQL tests: one `begin; … rollback;` file per feature in `supabase/tests/`, claims via `set_config('request.jwt.claims', …, true); set local role authenticated;`, assertions as `do $$ … raise exception … $$`. Pure frontend logic goes in `src/public/js/*.mjs` (or `.js` for anything the signin page imports) with a `test/*.test.mjs` twin.
7. **Definition of done per slice:** gate green locally, PR CI green, Sonnet review of permission gating on new routes, Opus sign-off where rule 4 says so, plan doc and `plans/eval-2026-09-03/PLAN_RECONCILIATION.md` status rows updated in the same PR.

---

## Wave 1 — Security hardening (≈1 week)

### ▶ Slice 1A — Storage and signed URLs (migrations 0040, 0041) — Sonnet build, Opus review

**S-1 — Module-aware storage read policy (0040_storage_module_reads.sql).**
Today `supabase/migrations/0030_storage.sql:91-100` grants SELECT on `storage.objects` to any facility member. Path convention (`src/lib/storage.mjs:191-198`): `facilities/{facilityId}/{module}/{recordId}/{uuid}-{name}` with module ∈ `reports | incidents | work_orders | certifications` (`attachments-routes.mjs:99,131,160`; `training-routes.mjs:25`).
- Add `fn_storage_attachment_module(object_name text) returns text` (plain invoker, `set search_path = ''`, same shape as `fn_storage_attachment_facility_id` at 0030:66-83) returning `storage.foldername(name)[3]`.
- Replace the policy: `bucket_id = 'attachments' and ((module = 'reports' and has_permission(auth.uid(), fid, 'reports.read')) or (module = 'incidents' and … 'incidents.read') or (module = 'work_orders' and … 'work_orders.read') or (module = 'certifications' and (has_permission(auth.uid(), fid, 'training.read') or <owner check>)))` where `fid = fn_storage_attachment_facility_id(name)`. Owner check for certifications: `exists (select 1 from employee_certifications ec join employees e on e.id = ec.employee_id where ec.evidence_path = name and e.user_id = auth.uid())`.
- New `supabase/tests/storage_module_reads.sql`: insert `storage.objects` rows for two modules as superuser, prove a `reports.read`-only member sees only `.../reports/...`, an incidents reader only incidents, an employee sees their own certification evidence.
- Add `fn_storage_attachment_module` and `fn_storage_attachment_facility_id` to the required-functions array in `scripts/verify-migrations.mjs`.

**S-2 — Signed URLs assert the row's facility prefix (0041_attachment_path_guard.sql + code).**
Call sites: `src/lib/http/attachments-routes.mjs:375` (`attachment.storage_path`) and `src/lib/http/training-routes.mjs:981` (`cert.evidence_path`).
- `src/lib/storage.mjs`: export `assertPathInFacility(path, facilityId, module)` → throws `StorageValidationError("path_outside_facility")` unless `path.startsWith(\`facilities/${facilityId}/${module}/\`)`. Call it before both `createSignedUrl` calls; respond 404 (not 403) on failure, matching the existing `notFoundOnDeny` posture. Unit tests in `test/storage.test.mjs`; route tests asserting a row whose path names another facility yields 404 and never calls the storage client.
- Migration 0041: one `security definer` trigger function `fn_attachment_path_facility()` raising `check_violation` unless `storage_path` (or `evidence_path` when not null) starts with `'facilities/' || facility_id::text || '/'`; BEFORE INSERT OR UPDATE triggers on `report_submission_attachments`, `incident_attachments`, `work_order_attachments`, `employee_certifications`. Follow the trigger-over-WITH-CHECK rationale from `0035_work_order_facility_consistency.sql:24-32`. Extend `supabase/tests/storage_module_reads.sql` (or a sibling) with a negative insert per table.

### ▶ Slice 1B — Definer helpers off the API, OP-05 (migration 0042) — Sonnet build, Opus review, orchestrator applies live

**S-3 — 0042_internal_helpers.sql.** Facts: 15 `security definer` functions in `public`, zero grant/revoke statements in any migration (`0024:27-28` deferred it), nothing in `src/` calls rpc. Policy expressions store resolved function OIDs, so `ALTER FUNCTION … SET SCHEMA` moves a function without touching the ~200 policies that reference it.
- `create schema if not exists internal; revoke all on schema internal from public;`
- `alter function public.current_facility_ids() set schema internal;` and likewise `has_permission(uuid,uuid,text)`, `has_permission(uuid,uuid,uuid,text)`, `fn_assert_same_facility(uuid,text,uuid)`, `is_organization_admin(uuid,uuid)`, `is_platform_admin(uuid)`.
- **Mandatory after the move:** `alter function internal.X(...) set search_path = internal, public;` for each of the six. `has_permission` (both overloads, `0023:47,72`) and `current_facility_ids` (`0022:44`) are `language sql` bodies that call `is_platform_admin(...)` unqualified and resolve it at call time under the function's own `set search_path = public`; without this every permission check fails after the move. The RLS suite catches it, but only if run.
- `grant usage on schema internal to authenticated; grant execute on all functions in schema internal to authenticated;` then `revoke execute on all functions in schema internal from public;` and, guarded by `do $$ if exists (select 1 from pg_roles where rolname = 'anon') …`, revoke from `anon` and grant to `service_role` (the CI bootstrap creates neither role). End with `notify pgrst, 'reload schema';`.
- Trigger functions (`fn_block_audit_mutation`, `fn_audit_admin_change`, `fn_protect_system_role`, `fn_audit_chain_link`, `fn_enforce_change_request_transition`, `fn_membership_department_facility`, `fn_report_template_version_immutable`, `fn_report_template_active_version_published`, `fn_report_submission_audit`, `fn_work_order_child_facility`, and 0041's new one): `revoke execute … from public, authenticated` (+ anon guarded). EXECUTE is checked at `CREATE TRIGGER`, not at fire time; the RLS suite proves it.
- `alter function fn_report_template_version_immutable() set search_path = public;` (the remaining mutable-search_path advisor).
- Guard rails: `scripts/verify-migrations.mjs` gains a check that no file ≥ 0043 contains `create or replace function <one of the six>` unqualified in `public`; `scripts/typecheck.mjs:52` regex is unanchored so `internal.has_permission(` already matches — add a test proving it. **Delete `scripts/ci/rls-bootstrap-post.sql:13`** (`grant execute on all functions in schema public to authenticated`): it runs after migrations and would re-grant the trigger functions 0042 just revoked; plain Postgres already grants EXECUTE to PUBLIC on creation and 0042 carries its own grants.
- New `supabase/tests/internal_helpers.sql`: create a throwaway `nologin` role `probe`, assert `not has_function_privilege('probe', 'internal.has_permission(uuid,uuid,text)', 'execute')` and `has_function_privilege('authenticated', …)`, then exercise one `has_permission`-backed policy as `authenticated` to prove the search_path fix.
- Verification: full RLS suite locally; then apply 0042 to the live project via Supabase MCP `apply_migration` and re-run `get_advisors(security)` — expected result: zero `*_security_definer_function_executable` warnings and zero `function_search_path_mutable`. Also `curl -H "apikey: <anon>" $SUPABASE_URL/rest/v1/rpc/has_permission` → 404.
- Risk to test first: any `supabase/tests/*.sql` that calls `has_permission(…)` directly (grep) must be qualified `internal.has_permission` or the test's `set local role authenticated` session needs `set local search_path = public, internal`.

### ▶ Slice 1C — Policy/permission alignment (migrations 0043–0045) — Sonnet build, Opus review

**S-4 — Incident audit + transition guard (0043_incident_report_guards.sql).** `incident_reports` has no triggers (`0004`, `0009:162`, `0038:264-271`). Transition graph lives only in JS (`src/lib/incidents.mjs:90-97`, comment at :60-65).
- `fn_incident_report_audit()` mirroring `fn_report_submission_audit()` (`0033:115-176`): AFTER INSERT OR UPDATE, emits `incident.created | incident.submitted | incident.status_changed | incident.updated` into `audit_events` with `{before, after}`; security definer so a reviewer without `admin.manage` still lands an audit row.
- `fn_incident_report_transition_guard()` BEFORE UPDATE: raise `check_violation` when `old.status <> new.status` and the pair is not in the JS graph (encode the six-state table in SQL); also block any column change other than `status`, `updated_at`, `submitted_*`, `closed_*`, and amendment-owned fields once `status <> 'draft'` unless the row is going through `incident_amendments` (compare with what `incidents-routes.mjs:570` and the amendment route actually update; list the allowed columns explicitly).
- Fix the pre-existing DB/BFF mismatch found on the way: `incident_audit_events` INSERT policy requires `incidents.manage` (`0010:100`, `0038:486`) but reviewers with only `incidents.review` transition via `incidents-routes.mjs:536-593` and insert audit rows at `:580` → widen the policy to `incidents.manage or incidents.review`. SQL test `supabase/tests/incident_report_guards.sql`.

**S-5 — BFF-only permission codes into RLS (0044_permission_alignment.sql).** The eight codes with no `has_permission()` occurrence: `reports.publish`, `reports.workflow.manage`, `reports.distribution.manage`, `incidents.escalate`, `incidents.tasks.create`, `incidents.legal_hold.manage`, `incidents.export.pdf`, `incidents.audit.view`.
- `reports.publish`: split `report_template_versions` UPDATE (publish) out of the `reports.template.manage` policy at `0028:114-140`; a version's `status` may move to `published` only under `reports.publish`.
- `incidents.tasks.create`: INSERT on `incident_followup_actions` allowed for `incidents.tasks.create or incidents.manage` (route at `incidents-routes.mjs:764`).
- `incidents.escalate`: route `POST /incidents/:id/escalate` (`incidents-routes.mjs:293`) currently gates on `incidents.manage`; change route to `escalate or manage` and make `incident_escalations` INSERT policy match.
- `incidents.legal_hold.manage`: add a `legal_hold` boolean column if absent (check `0004`); UPDATE of it only under that code (trigger or column-level policy via `fn_incident_report_transition_guard`).
- `incidents.audit.view`: SELECT on `incident_audit_events` for `incidents.audit.view or incidents.manage or incidents.review`.
- `incidents.export.pdf`: no table write beyond the audit event; keep BFF-only but document in the code catalog comment. `reports.workflow.manage` / `reports.distribution.manage`: reserved for DR-18/DR-21; mark "reserved, no route" in `src/lib/permissions.mjs` comments.
- `scripts/typecheck.mjs`: add a rule that every code except an explicit `bffOnly` allow-list appears in at least one `has_permission()` literal in migrations, so this cannot regress. SQL test `supabase/tests/permission_alignment.sql`.

**S-6 — Audit forgery, HR reads, org-admin semantics (0045_read_and_audit_policies.sql).**
- Drop `"admins can write audit events"` (`0019:107-117`); the only writers are the definer triggers. Confirm no route inserts into `audit_events` directly (grep `pgInsert(.*"audit_events"`) — if any, convert it to a trigger path first.
- `employees`, `certification_types`, `employee_certifications` SELECT policies (`0009:133-143`) → `has_permission(auth.uid(), facility_id, 'training.read') or <self: employees.user_id = auth.uid()>` for the certification tables; `employees` stays member-readable but only exposing the columns the schedule board needs is not possible in RLS — leave `employees` as is and document.
- `requireOrgAdmin` in `src/lib/http/guard.mjs:10-20` → make it consult `organization_admins` via a `pgSelect` (the 0019 rule), exposed as `requireAuthOrgAdmin(auth, orgId)`; update the three admin routes that use it and `test/http-guard.test.mjs`.

### ▶ Slice 1D — Session and throttle (migration 0046) — Sonnet build, Opus review

**S-11 — Refresh token to HttpOnly cookie.** Contract:
- `POST /api/v1/auth/sign-in` → body `{access_token, expires_in, token_type}` only (`sessionPayload` in `auth-routes.mjs` drops `refresh_token`); `Set-Cookie: rr_refresh=<token>; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000` (omit `Secure` only when the request arrived over plain http on localhost, per `x-forwarded-proto`). `POST /api/v1/auth/refresh` → reads `request.headers.cookie` (tiny parser in the same file), rejects unless `sec-fetch-site` is `same-origin`/`none`/absent (CSRF check on top of SameSite=Strict; no token needed for a same-origin app with no CORS), calls GoTrue, rotates the cookie, returns a new access token; on GoTrue 401 it clears the cookie. Body `refresh_token` fallback kept for one release so live sessions survive, removed in Wave 2. `POST /api/v1/auth/sign-out` → revokes upstream and sets `Max-Age=0`. Cookies go through `response.setHeader("Set-Cookie", …)`; Node merges it into the later `writeHead` in `sendJson` (`scripts/server.mjs:55-61`, the same mechanism `sendThrottled` uses for `Retry-After` at `auth-routes.mjs:98`); the auth test harness already fakes `setHeader`.
- Access token stays in localStorage (≤1h life). Pure in-memory would cost a refresh round-trip on every hard reload and break multi-tab; S-11's value is that XSS can no longer mint indefinite sessions.
- Frontend: `src/public/signin/app.js` `storeSession` keeps only the access token; `src/public/admin/js/auth.js` and `src/public/js/app.js:120-168` (`exchangeRefreshToken`) drop `REFRESH_TOKEN_KEY`, POST `{}` with `credentials: "same-origin"`; `clearSession`/sign-out must call `/auth/sign-out` so the cookie is cleared server-side. One-release migration: if a legacy `rr_refresh_token` is in localStorage on load, exchange it once through the body fallback and delete it.
- Tests: `test/auth-routes.test.mjs` (cookie attributes, rotation, body lacks `refresh_token`, cross-site `sec-fetch-site` → 403, sign-out clears), Playwright (sign in → reload → API call succeeds after silent refresh). **Risk to test:** two tabs refreshing concurrently — the loser's stale `Set-Cookie` can overwrite the newer token; verify GoTrue's refresh-token reuse interval covers it, and serialize refreshes per tab with the existing single-flight promise.

**S-7 — Durable throttle (0046_auth_throttle.sql).** Replace the per-instance `createRateLimiter` (`src/lib/http/rate-limit.mjs`) for production with a table `auth_throttle(key text primary key, window_start timestamptz, failures int, updated_at)` written by the service-role client via one `on_conflict` upsert; keep the in-memory limiter as a first-line shield and as the test double. Add `/auth/refresh` to the throttle (per cookie hash + IP). Sweep stale rows inside `handleDrain` (`internal-routes.mjs:80`). No RLS exposure: `enable row level security` with no policies (service role only) and add to `requiredRlsTables`.

**S-13 — JWT verifier follow-ups** (`src/lib/http/auth.mjs`): validate `iss` accepting both the legacy `supabase` value and `${SUPABASE_URL}/auth/v1`; de-duplicate concurrent JWKS fetches (in-flight promise map); tolerate missing `kid` by trying each key of the header's algorithm; drop `ES512`/`RS512` from `JWS_ALGORITHMS` unless Supabase documents them. Tests in `test/http-auth.test.mjs`.

### ▶ Slice 1E — Data-integrity and low findings (migrations 0047, 0048) — Sonnet

**S-8 — `message_audiences.audience_ref_id` guard (0047_message_audience_refs.sql).** Table `0006:32-41` (nullable, no FK, polymorphic). Extend the WITH CHECK at `0038:409-416` with the dispatch pattern from `0019:150-163`: `(audience_type='employee' and fn_assert_same_facility(facility_id,'employees',audience_ref_id)) or (='department' … 'departments') or (='shift' … 'schedule_shifts') or (='role' … 'roles')`, and a BEFORE trigger for the service-role path (mirroring `fn_work_order_child_facility`). SQL test.

**S-9 — Low findings batch (no migration).** In `src/lib/http/router.mjs:29` wrap `decodeURIComponent` → 404 on `URIError`; the `published_at` filter that rejects on timestamptz → `extra: { published_at: "not.is.null" }`; validate `from`/`to` in `me-route.mjs:35`, `entitlements.mjs:120`, `worker.mjs:228,274,494`; fix the create path whose WITH CHECK can never pass (resolve `employees.id` via `loadCallerEmployeeId`); widen the audit partial-write. Each with a test.

**S-10 — Advisor performance backlog (0048_policy_performance.sql).** Generate (Haiku script, Sonnet verifies) a migration that re-creates the 125 flagged policies with `(select auth.uid())` in place of `auth.uid()`, adds covering indexes for the 78 unindexed FKs, and drops the 71 unused indexes only where a Wave-2/3 query will not need them (list each decision). Full RLS suite must stay green; re-run `get_advisors(performance)` live afterwards. Consolidating duplicate permissive policies is out of scope unless semantics are provably identical.

**S-12 — Sign-off artifact.** Opus writes `plans/SECURITY_REVIEW_2026-09.md`: every H/M/L finding with status and the test that proves it, closing OP-24, WO-27, DR-34, IN-24. Wave 1 exit gate: Supabase security advisor = 0 WARN; RLS suites green locally and against the live project; sign-off committed.

---

## Wave 2 — Pilot-ready (≈2 weeks, tracks in parallel worktrees)

### ▶ Slice 2A — Engineering foundation first (unblocks every later slice) — Haiku build, Sonnet review

**P-12 — `makeGuards` factory.** `src/lib/http/guard.mjs` gains `makeGuards({ authenticate, sendJson, readBody })` returning `{ withAuth, requireRead(code), requirePerm, requireMember, parseJsonBody, queryParams, parseListLimitOffset }`. Replace the 15 `withAuth`, 7 `requirePerm`, 6 `requireRead`, 14 `parseJsonBody`, 12 `queryParams` copies (list in the evaluation) file by file; behaviour must be byte-identical (existing route tests are the proof). `parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 })` returns `{ ok, limit, offset, error }` and replaces `reports-routes.mjs:272-289` and `work-orders-routes.mjs:204-223`; reconcile the two error shapes to `{ error: "limit must be a positive integer" }` and default offset `0` (update the two tests).

**P-9 — Central `PostgrestError` translation (staged).** Step 1 (lands with 2A, tiny): new `src/lib/http/errors.mjs` exporting `translatePostgrestError(error)` → `{status, body}` or null: 409→409 `{error:"conflict"}`, 400/422→400 `{error:"invalid request"}`, 401→401, 403→403 `{error:"forbidden"}` (PostgREST returns 403/42501 for RLS WITH CHECK violations on INSERT/UPDATE; filtered reads return 200 with zero rows, so route-level 404s stay in routes), 404 (PGRST205, unknown table)→500 (server bug), else 500. Use it in the `scripts/server.mjs:404` catch (shared by local and `api/[...path].mjs`) — respond and return without rethrow/report. Step 2 (P-12): the factory's `withAuth` calls the same helper so route unit tests see the 4xx without `server.mjs`. The nine bespoke 409 catch sites return before throwing and stay; the `incidents-routes.mjs:250` retry loop is unaffected. Fix the duck-typed catch in `communications-routes.mjs` (channel create) to `instanceof`. Detail leak: no `NODE_ENV` usage exists; key off Vercel's automatic `VERCEL_ENV === "production"` with a `DEBUG_ERRORS` override (add to `optionalServerFields`), applied in both `server.mjs:445-466` and `api/[...path].mjs:28`, always including `requestId`. **Risk to test:** a PostgrestError from a service-role path (worker, internal drain) must still surface as 5xx and be reported, not masked as a client 4xx.

**P-11 — Real lint without breaking zero-deps.** Keep `package.json` dependency-free (the invariant is deliberate). Extend `scripts/lint.mjs` with an AST-free but real check set using `node --check` plus a small ESM import/export graph analysis: unused top-level `const`/`import` (regex on declarations vs. references per file), duplicate imports, and forbidden patterns (`innerHTML =` with interpolation outside `escapeHtml`). Delete the six unused constants found (`training-routes.mjs:36`, `communications-routes.mjs:12,15,16`, `incidents-routes.mjs:28,970`). Extend `scripts/typecheck.mjs` to check every permission-string literal passed to `requireAuthPermission`/`requirePerm`/`requireRead` in `src/lib/http/*.mjs` against the catalog. Add a `test/build-user-app.test.mjs` twin of `test/build-admin.test.mjs` walking `dist/js/app.js`'s import graph.

**P-10 — Missing tests.** `test/notification-routes.test.mjs`: PATCH distribution list (403/400/200), GET/DELETE members, GET notification-routes list, DELETE route. `test/admin-routes.test.mjs`: `PATCH /facilities/:facilityId` (403 non-admin, 400 bad timezone, 200 happy). `test/cert-policy-routes.test.mjs`: gap-report branches (`cert-policy-routes.mjs:119-203`).

**P-13 — Smoke in CI, changelog, runbook.** `ci.yml`: after `build`, start `node scripts/server.mjs dist` with `SUPABASE_URL=https://example.invalid SUPABASE_ANON_KEY=x PORT=8000 &`, wait for `/api/v1/public-config`, run `SMOKE_BASE_URL=http://localhost:8000 npm run smoke` (steps 2–5 SKIP without credentials, by design). Add `CHANGELOG.md` (Keep-a-Changelog; Wave 0 and 1 entries), `DEPLOYMENT.md` (env vars, crons, rollback, backup/PITR, tenant deletion procedure = OP-22), tag `v0.2.0` at Wave 2 exit.

### ▶ Slice 2B — Truthful state (Sonnet routes, Haiku UI)

**P-1 — Ack/read state + compliance (CM-09, CM-11).** No migration: SELECT policies already allow `communications.read` (`0006:115-116`).
- `GET /facilities/:facilityId/messages/:id/acknowledgements` and `.../receipts` (paginated; `?employeeId=me` resolves via `loadCallerEmployeeId` at `communications-routes.mjs:79`).
- `GET /facilities/:facilityId/messages/:id/compliance` → `{delivered, read, acknowledged, pending, overdue, total}` computed by a pure `summarizeAckCompliance(audienceEmployeeIds, receipts, acks, now)` in `src/lib/communications.mjs`; `GET /facilities/:facilityId/communications/compliance-summary?from&to` for the facility rollup (CM-11 acceptance in `plans/COMMUNICATIONS_PLAN.md:93-97`).
- `src/public/js/app.js` comms panel: on load fetch the caller's acks/receipts and seed `state.ackedMessageIds` (`app.js:2801`) from the server; publishers see per-message counts. Remove the "session-local" comments at `app.js:2785-2789` and `comms-compose.mjs` header once true.

**P-2 — Shift assignments GET (SC-08).** No migration (`0009:157-159`). `GET /facilities/:facilityId/shift-assignments?period_id=|shift_id=` → `ASSIGNMENT_COLUMNS` rows, `schedule.read`, 400 without a filter. `schedule-board.mjs`: add `indexAssignmentsByShift(assignments)`; `app.js` `schedulePanel.reloadWeek()` (≈1438) fetches assignments alongside shifts and seeds `state.assignmentsByShiftId`; delete the "assigned outside this session" caption (`app.js:1646`) and the comment at 1383-1391. Route + pure-helper tests.

**P-6 — Incident people and witnesses (IN-11 schema, IN-12 routes, UI).** Migration **0049_incident_people_statements.sql**: `incident_witness_statements(id, facility_id, incident_id, person_id, version_no, statement_text, submitted_by, submitted_at, signed_at, deleted_at)` with `unique(person_id, version_no)`, RLS `incidents.read` / `incidents.manage or incidents.review` + `fn_assert_same_facility` on both parents, append-only trigger (copy `incident_amendments_block_mutation`, `0032:75-78`), and add to `requiredRlsTables`. Routes in a new `src/lib/http/incidents-people-routes.mjs` (registered next to incidents in `scripts/server.mjs`): `GET/POST /incidents/:id/people`, `PATCH/DELETE /incidents/:id/people/:personId` (soft delete), `GET/POST /incidents/:id/people/:personId/statements` (new version each time; 409 once `signed_at` is set). `incident-form.mjs`: `validatePersonInput` / `buildPersonPayload`. Replace the placeholder at `app.js:2245-2246` with a people list + add form + statement history. Route tests + SQL test.

### ▶ Slice 2C — Delivery (Sonnet; owner supplies credentials)

**P-4 — Email via Resend (OP-12, CM-14).**
- `src/lib/notifications/email.mjs` mirroring `push.mjs`: `PROVIDER_OUTCOMES`, `classifyOutcome`, `noopAdapter`, `createResendAdapter({ apiKey, from, fetchImpl })` posting to `https://api.resend.com/emails` with `Authorization: Bearer`, mapping 2xx→`ok`, 422→`invalid_recipient`, 429→`rate_limited`, 5xx→`server_error`, timeout→`timeout`; `sendEmail({ messages: [{to, subject, text, html}] }, { adapter, fetchImpl })` → per-message `{ to, code, outcome, providerMessageId }`.
- Recipient resolution: `employees` has no email column; `app_users.email` exists (`0001_foundation.sql:20`, `not null unique`, app-written) and `employees.user_id → app_users(id)` is nullable. One service-role select per job: `pgSelect(client, "employees", { filters: { facility_id, id: { in: recipients } }, select: "id,user_id,app_users(email)" })` — the `app_users(...)` embed is already proven at `admin-routes.mjs:407`. Null `user_id`/email → reason `no_email` → status `failed` (mirrors the push path's `no_token`).
- **Send one `POST /emails` per recipient with bounded concurrency, never `/emails/batch`:** Resend's batch endpoint is all-or-nothing on validation, so one bad address would mark every recipient `bounced`.
- `worker.mjs`: `buildEmailDeliveryStatuses(...)` beside `buildPushDeliveryStatuses` (`:338`), honouring `email_enabled` from `PREFERENCE_COLUMNS` (fetched today, ignored), writing `provider_message_id`; branch `if (channel === "email")` at the delivery loop (`:425`). `config.emailAdapter` constructed in `internal-routes.mjs:108` and `scripts/notifications-worker.mjs` from `EMAIL_PROVIDER=resend|noop`, `EMAIL_API_KEY`, `EMAIL_FROM` (append to `optionalServerFields` in `src/lib/env.mjs:3-9`; document in `.env.example`). Admin "test send" route already exists (`notification-routes.mjs`) — make it pick the email channel.
- Tests: `test/email.test.mjs` adapter with injected `fetchImpl` (2xx, 422 permanent, 429 retryable, timeout); `test/notifications-worker.test.mjs` gains an email-channel job with a fake adapter (pref opt-out → `opted_out`, `no_email` → `failed`, provider id persisted). A recipient with no `app_users` row must record `failed`, never throw the whole job into `handleFailure`.

**P-5 — Push via FCM HTTP v1 (CM-07).** `src/lib/notifications/fcm.mjs`: `createFcmAdapter({ serviceAccountJson, fetchImpl })` implementing the `push.mjs` contract — mint a Google OAuth2 access token from the service account (RS256 JWT via `node:crypto`, cached until expiry), POST `https://fcm.googleapis.com/v1/projects/{id}/messages:send` per token, map `UNREGISTERED`/`INVALID_ARGUMENT`→`unregistered`/`invalid_token`, `QUOTA_EXCEEDED`→`rate_limited`, 5xx→`server_error`. Wire `config.pushAdapter` from `PUSH_PROVIDER=fcm|noop`, `FCM_SERVICE_ACCOUNT_JSON` (base64). Frontend: a minimal web-push registration in `src/public/js/app.js` behind a "Enable notifications" button posting to `/me/device-tokens` (requires a Firebase web config — owner supplies). Tests with `fetchImpl`.

### ▶ Slice 2D — Frontend for frontline staff (Sonnet design, Haiku cards)

**P-3 — Role-based home.** Replace the hero + six static cards (`src/public/index.html:19-40`) with a `#home-dashboard` section rendered first by `loadAllModules()` (`app.js:290`): quick actions (Submit report → `startNewReport`, Log incident → `incidentsPanel` create, New work order → `workOrdersPanel` create) above the fold on mobile; tiles fed by existing endpoints — reports due (`GET /facilities/:id/reports/compliance?from=today&to=today`), my open work orders (`GET .../work-orders?assignee=<my employee id>&status=open`; expose the caller's `employees.id` in `/me` since no route does today), open incidents (`GET .../incidents?status=submitted`), unacknowledged messages (P-1's acks), expiring certs (`GET .../employee-certifications`, already status-enriched), today's shifts (P-2 + `?period_id` of the current period). Pure tile logic in `src/public/js/home-dashboard.mjs` with tests. Keep module panels below, collapsed by default on mobile.

**P-7 — Mobile and accessibility pass.** `src/public/styles.css`: 44×44 minimum tap targets, sticky quick-action bar under 640px; `app.js` incident form (`≈1949-1955`): `label for`/`id` association; add `aria-live="polite"` status regions for load/error/autosave (`setLoading`/`setError` at `:3153-3165`); focus management after create/submit; contrast check against the CSS variables. Playwright assertions (labels associated, no tap target under 44px in the quick-action bar).

**P-8 — Global search.** `GET /api/v1/search?facilityId=&q=` in a new `src/lib/http/search-routes.mjs`: fan-out over incidents (`incident_no,summary,location_text`), work orders (`title,description`), employees (`first_name,last_name,employee_no`), messages (`subject,body_text`) — each leg only when the caller holds that module's read permission, each via `extra: { or: "(col.ilike.*q*,…)" }` with `q` sanitized to `[\w\s-]` (PostgREST reserves `, . ( ) *`), `limit 10` per leg. Migration **0050_search_indexes.sql**: `create extension if not exists pg_trgm` + GIN trgm indexes on those columns. UI: a search box in the app header rendering grouped results that deep-link into each panel.

Wave 2 exit gate: pilot walkthrough on a phone (sign in → home → submit report with photo → log incident → ack a message → see it counted → receive the email); `v0.2.0` tagged; `DEPLOYMENT.md` complete.

---

## Wave 3 — M2 design-complete (51 tasks; 4–6 weeks of agent time)

Run as six module slices, each one PR, in this order; cross-module pairs are built once with two consumers. Task specs (files/acceptance) are in `plans/*.md`; the exploration confirmed they still match the code. Migration numbers: reports 0051–0053, incidents 0054–0055, work orders 0056–0057, scheduling 0058, communications 0059, training 0060–0061.

| Slice | Tasks | Build | Review | Notes from exploration |
|---|---|---|---|---|
| 3A Reports workflow & distribution | DR-16, 17, 18, 19, 20, 21, 22, 23, 24, 26 | Sonnet (DR-18/19/20 engine, DR-24 lock/revise policies), Haiku (DR-16 field types in `report-schema.mjs`, DR-17, DR-23 snapshot job) | Opus on DR-20 (server-side privilege elevation) | `plans/DAILY_REPORTS_PLAN.md` M2 table has no files column; use `report-schema.mjs`, `reports-routes.mjs`, worker. DR-22 is now "consume P-4's adapter", not "build email". |
| 3B Incidents legal core | IN-13, 14, 15, 16, 17, 18, 19, 20, 21 | Sonnet | Opus on IN-16 (legal hold) and IN-17 (cross-module writes) | IN-11/12 already landed in Wave 2 (P-6). IN-14 needs a `settings-registry` key `incidents.oshaDecisionTree`. IN-17 ↔ TR-10 and WO-03 share the row-shape helpers already exported by `work-orders.mjs`. |
| 3C Work orders assets, SLA, PM | WO-11, 12, 13, 15, 16, 17, 18, 19, 20, 21 | Haiku (WO-12/13/20 CRUD+UI), Sonnet (WO-15/16/18/19/21) | Sonnet; Opus on WO-21 (submitter creates WO without `work_orders.manage`) | WO-17 adds `pm_plans`, `pm_plan_occurrences` → `requiredRlsTables`. WO-19/WO-16 are cron handlers registered in `internal-routes.mjs` + `vercel.json` crons (test in `test/vercel-config.test.mjs` will require the route to exist). Wire the dead `sortWorkOrdersForDashboard`, `slaHoursForPriority`. |
| 3D Scheduling self-service | SC-10, 11, 12, 13, 14, 15, 16, 17 | Sonnet (state machines, SC-10 migration + 3 new permission codes → `permissions.mjs`, seed, typecheck), Haiku (SC-14/15 UI) | Sonnet | New codes `schedule.approve.swaps`, `schedule.approve.time_off`, `schedule.manage.open_shifts` must appear in RLS (S-5 rule). Wire dead `findMissingCertifications`. |
| 3E Communications escalation | CM-10, 12, 13 | Sonnet | Opus on CM-13 (emergency mode, quiet-hours bypass) | CM-10 sweep runs in the drain cron; CM-12 extends `resolveMessageAudience` with a shift window; CM-13 adds `emergency_alert_responses`. |
| 3F Training content & automation | TR-07, 08, 09, 10, 11, 12 | Sonnet (TR-09/10/11), Haiku (TR-07/08) | Sonnet | TR-11 evaluator = cron handler; TR-12 consumes `certificationStatus`/`certGaps` in `scheduling.mjs`. Wire dead `certificationBlocksSchedule`, `classifyOshaReview` (IN-14). |
| 3G Platform | CM-16 realtime spike (owner decides Supabase Realtime vs SSE vs polling), OP-05 closed in 1B | Sonnet spike | Orchestrator | Polling every 30s from the home dashboard is the zero-dependency default if no decision. |

Per slice: worktree, its migration(s), unit + RLS tests, Sonnet review of permission gating, orchestrator integrates `server.mjs` / `index.html` / `app.js`, PR, CI green, reconciliation rows flipped to DONE.

---

## Wave 4 — M3 polish and scale (31 tasks; 3–4 weeks)

Mostly Haiku with Sonnet review; Opus on retention/legal hold.
- Scheduled sweeps on the one drain pattern: IN-21 (SLA), TR-11 (already 3F), CM-10 (3E), WO-19 (3C), DR-29 (reminders), SC-19 (cert-expiry mid-period), SC-21.
- Dashboards/analytics: IN-23 (`GET /facilities/:id/incidents/summary`), WO-22, TR-14, DR-33 indexes.
- PDFs: SC-18, WO-23, IN-18 packet, DR-23 already 3A.
- Retention/legal hold: DR-31, IN-25, OP-22 runbook.
- Packaging: WO-25 entitlement gating ("Ops Plus"), DR-27 settings keys, SC-22 admin settings surface.
- Frontend: split `src/public/js/app.js` (3204 lines) along the four IIFE seams (`schedulePanel` 1392, `incidentsPanel` 1771, `workOrdersPanel` 2379, `commsPanel` 2790) into `src/public/js/panels/*.mjs`, each with the DOM-free parts tested; remove the remaining 10 `innerHTML` writes (`:258, 457, 462, 494, 3078, 3093, 3130, 3146, 3155, 3161`) in favour of `el()`. SC-23 mobile day view, DR-32 builder polish.
- Hardening: SC-24, CM-18, TR-16 audit coverage; IN-24's feature half (429 on incident submit/export, justification-capturing break-glass reads — its review half is closed by S-12); DR-34/WO-27 closed by S-12.

---

## Owner actions (only these block work)

| When | Action |
|---|---|
| Now | Merge PR #15; confirm Vercel env vars; enable leaked-password protection; approve deleting 12 dead branches. |
| Slice 1B | Approve applying migration 0042 to the live project (orchestrator does it via Supabase MCP after the local RLS suite passes). |
| Slice 2C | Create a Resend account + verified sending domain → `EMAIL_API_KEY`, `EMAIL_FROM`. Create a Firebase project → service-account JSON (`FCM_SERVICE_ACCOUNT_JSON`) and web config. Set all in Vercel. |
| Slice 3G | Realtime approach. |
| Wave 2 exit | Pilot facility walkthrough sign-off. |

---

## Verification (end-to-end, per wave)

- **Every slice:** the gate from ground rule 2; PR CI green; for RLS changes the local Postgres replay and `db:test:rls`.
- **Wave 1:** `mcp__Supabase__get_advisors(security)` on the live project → 0 WARN after 0042; `curl` the six helper names under `/rest/v1/rpc/` with the anon key → 404; Playwright sign-in → reload → authenticated call succeeds through the cookie refresh; `plans/SECURITY_REVIEW_2026-09.md` committed.
- **Wave 2:** Playwright pilot journey on 390×844 against the built app served by `scripts/server.mjs dist` with mocked Supabase (sign in → home → quick actions → submit report → log incident with a person → ack a message → counts update → board shows assignments after reload); worker unit tests with fake adapters; one real Resend send and one real FCM send from a staging drain (owner credentials); `npm run smoke` in CI; `v0.2.0` tag.
- **Waves 3–4:** each slice's SQL test + route tests; `PLAN_RECONCILIATION.md` rollup moves to 168/168 with evidence; final `get_advisors` both types clean; production smoke after each deploy.

## Effort

| Wave | Slices | Calendar (agent-driven) | Migrations |
|---|---|---|---|
| 1 | 1A–1E | ~1 week | 0040–0048 |
| 2 | 2A–2D | ~2 weeks | 0049–0050 |
| 3 | 3A–3G | 4–6 weeks | 0051–0061 |
| 4 | — | 3–4 weeks | 0062+ |

## Execution status (2026-09-06) — Wave 1 complete, pending merge and live apply

- **Landed:** all of Wave 1 (S-1 … S-13) on PR #18 `claude/wave1-review-fixes` against `main`. Migration
  numbering shifted during execution: 0040 storage reads, 0041 path guard, 0042 internal helpers, 0043
  incident guards, 0044 permission alignment, 0045 read/audit policies, 0046 auth throttle, 0047 audience
  refs, **0048 part B review fixes** (incl. `internal.apply_incident_amendment` + its public wrapper), **0049
  policy performance**. Wave 2's migrations therefore start at **0050** (P-6 people/statements → 0050,
  P-8 search indexes → 0051) and later waves shift by two.
- **Reviews:** two adversarial reviews (parts A and B) and two re-verification rounds; every finding
  closed or accepted with rationale in `plans/SECURITY_REVIEW_2026-09.md` (S-12). The re-verification
  caught one High introduced by the first fix round (the amendment RPC was unreachable through
  PostgREST) — a reminder that unit tests with a stubbed fetch cannot prove API reachability.
- **Gate on the signed-off head:** 1478 unit tests, 29 RLS suites, 49-migration replay, seed applied twice,
  0031/0038/0040 re-apply probe after the RLS run, CI green.
- **Owner actions now due:** merge PR #18; give the explicit go to apply 0040–0049 to the live project
  (then the advisor re-run and the post-deploy checklist in the sign-off); enable leaked-password
  protection.
- **Lessons folded into later waves:** the Agent tool's worktree isolation cuts from `main` — create
  worktrees manually from the slice base; set `core.fileMode false` in them; the H-2 re-apply probe must
  run after the RLS suite; Haiku factual claims are re-verified before use.
- **Next:** Wave 2, Slice 2A first (guard factory, error translation, lint, missing tests, smoke in CI,
  changelog and runbook), branched from `main` once PR #18 merges.

## Execution status (2026-09-07) — Wave 2 built, open as a stacked chain

- **Landed:** every Slice 2A–2D task. Chain on GitHub: #19 (2A, targets `main`), #20 (2C, on 2A), #21 (2B +
  2D after the owner merged #22 into it, on 2A), #24 (P-7 accessibility + Unicode search, on 2B). Migrations
  0050 (`incident_witness_statements`) and 0051 (trigram search indexes); Wave 3 migrations therefore start at
  **0052**.
- **Reviews:** four independent reviews (2A gating, 2C secrets/fail-safety/OAuth, 2B routes + migration 0050
  with an RLS probe, 2D search injection + dashboard gating): no defects; one Medium in 2A fixed before
  merge (query-shape PostgREST errors were translated to unreported 400s). Two real bugs found by the new
  tests and fixed: facility PATCH required a name; the cert-gap report was gated by membership only. One
  pre-existing RLS bug fixed: soft-deleting an `incident_people` row failed the row-visibility check for
  everyone.
- **Deliberately not done:** browser-side FCM token minting (messaging SDK cannot load under the self-only
  CSP; button, permission prompt and device-token POST are complete); SMS (CM-14's other half); IN-11's
  signatures/compliance checks/training triggers (Wave 3); arrow-key navigation in search results; the admin
  control centre's own accessibility pass (Wave 4).
- **Owner actions now due:** merge the chain (#19 → #20/#21 → #24); apply migrations 0040–0051 to the live
  project on an explicit go, then the sign-off's post-deploy checklist; set `EMAIL_PROVIDER`, `EMAIL_API_KEY`,
  `EMAIL_FROM`, `PUSH_PROVIDER`, `FCM_SERVICE_ACCOUNT_JSON`, `FIREBASE_WEB_CONFIG_JSON` in Vercel; tag
  `v0.2.0` once merged; pilot walkthrough on phones.
- **Lesson:** a stacked PR merged into its base by the owner, followed by a rebase of that base, leaves the
  other stacked branches without shared history; they were rebased (content-identical) rather than merged.
- **Next:** Wave 3, Slice 3A (reports workflow and distribution: DR-16 … DR-26, migrations 0052–0054) once
  #19 merges; 3B–3F follow per the table above with numbering shifted by two.
