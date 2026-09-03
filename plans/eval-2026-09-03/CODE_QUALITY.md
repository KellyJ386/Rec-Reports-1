<!-- Evidence report generated 2026-09-03 by a Sonnet evaluation agent for REC_REPORTS_360_EVALUATION_AND_FINISH_PLAN.md; headline claims re-verified by the orchestrator. Screenshot and scratch paths referenced below were session-local and are not in the repo. -->

# Rec Reports — Engineering Quality Review

Repo: /home/user/Rec-Reports-1 · Reviewed 2026-09-03 · `node --test`: **1311/1311 pass**, 2.9s.

## (a) Scored table

| Dimension | Score (1-5) | Justification |
|---|---|---|
| 1. Test quality | 4 | Tests assert real PostgREST query strings/filters (not just response shape), have explicit deny-403 tests per permission, and include true process-level integration tests (test/server-headers.test.mjs spawns the real server). Weak spots: notification-routes.mjs member/route CRUD (55.71% branch) and several admin-routes.mjs writes are essentially untested; app.js (3099 lines) has zero direct tests. |
| 2. Architecture | 3 | Route layer is genuinely consistent (`register*Routes(router, {authenticate, sendJson, readBody})`, shared `guard.mjs`/`supabase-rest.mjs`/`router.mjs` primitives; PDF rendering is properly centralized in admin/pdf.mjs). But the `requireRead`/`requirePerm` 403-wrapper boilerplate is copy-pasted near-verbatim into 7+ route files, and list-pagination limit/offset parsing is duplicated with drifted validation rules between reports-routes.mjs and work-orders-routes.mjs. server.mjs is a clean, well-commented composition root; per-request env re-parsing is wasteful (not a correctness bug) and the Vercel adapter is a thin, sensible re-export of the same dispatch. |
| 3. Domain libs vs routes | 3 | The dead-code claim is still partly true today: 10 exported functions across work-orders.mjs, scheduling.mjs, incidents.mjs, training.mjs are never imported by any route or script (only by their own module internals or nothing at all) — see list below. communications.mjs is now fully wired. |
| 4. Frontend code | 2 | app.js is one 3099-line file with ~7 mutable module-level globals (`currentUser`, `currentFacility`, `facilities`, etc.), no bundler, no tests. Rendering is a real mix: newer sections use a safe `el()` DOM builder (createElement+textContent, explicitly documented as a CSP-driven XSS defense), but older sections (training, certifications, attachments) still build HTML via string concatenation + innerHTML, with `escapeHtml` applied inconsistently (used correctly where checked, but easy to miss on new fields since nothing enforces it). The 6 extracted `src/public/js/*.mjs` pure-logic modules are all well tested (83–100% coverage); app.js itself has 0% direct coverage. |
| 5. Error handling / observability | 3 | PostgREST 4xx (mainly 409 conflict) is deliberately caught and translated in only 3 route files (scheduling, training, incidents) at specific mutation sites; every other PostgrestError (bad FK, check-constraint violation, RLS denial elsewhere) bubbles to the top-level catch and becomes an opaque 500. observability.mjs is real (bounded-timeout fire-and-forget POST, never throws, never blocks the response) and is wired into both scripts/server.mjs and api/[[...path]].mjs — but it only fires on thrown errors, so the many "swallowed" 4xx paths never get any telemetry, and with no `OBSERVABILITY_DSN` set it's a silent no-op by default. |
| 6. Tooling gates | 2 | "lint" = `node --check` (syntax only) + a tab-character/forbidden-import-pattern grep — no unused-var, no-shadow, no dead-code detection. "typecheck" = a permission-code vocabulary cross-check between permissions.mjs/seed.sql/migrations — zero static typing of any kind. "format:check" = trailing-newline check only. A real linter (ran eslint ad hoc) immediately found 6 unused-variable warnings the repo's own gates miss (see below). |
| 7. Maintainability risks | 3 | Deepest nesting found is 9 levels (scheduling-routes.mjs:859, an assignment-conflict check inside 3 nested `if`s inside a route handler). Route-registration "functions" are 500–1100 "lines" each, but this is a closure-factory pattern (many independent route handlers sharing helpers), not one flat procedure — still hurts navigability. README's "23 forward-only migrations" / "0001–0023" and "16-code catalog" are stale: repo actually has 39 migrations (0001–0039) and 26 permission codes. |

## (b) Top 10 concrete defects/risks (file:line)

1. **Most PostgREST errors surface as generic 500s, not 4xx.** Only scheduling-routes.mjs:390/886/1095, training-routes.mjs:320/360/413/453, and incidents-routes.mjs:250 catch `PostgrestError` and translate 409s; every other write path (e.g. work-orders-routes.mjs FK/constraint violations not already resolved in JS, communications-routes.mjs:449, notification-routes.mjs) lets it bubble to scripts/server.mjs:386-407 and becomes an unhandled 500 with a generic message. `src/lib/http/work-orders-routes.mjs:120-123`'s own comment confirms this was a known gap the authors closed only for FK fields they specifically resolved in JS.
2. **notification-routes.mjs is the weakest-tested route file**: 67.69% line / 55.71% branch / 76% func coverage (`src/lib/http/notification-routes.mjs`). PATCH `/facilities/:facilityId/distribution-lists/:id` (line ~123-153), GET/POST/DELETE `.../members` (155-203), and GET `/notification-routes` (207-224) have **no tests at all** (`test/notification-routes.test.mjs` only covers events, list-create, member-create, route-create, and route-test — 12 tests, none for PATCH/members-list/member-delete/routes-list). Deleting `requirePublish`/`requireEntitled` on those specific handlers would not fail any test.
3. **admin-routes.mjs PATCH /facilities/:facilityId is untested** (`src/lib/http/admin-routes.mjs:180-216`) — org-admin org-tree writes have no corresponding test in test/admin-routes.test.mjs asserting the 403/200 behavior for this specific endpoint (uncovered lines 181-219 in the coverage report).
4. **Dead exported domain-lib functions** (never imported by any route, script, or frontend file, only used internally or nowhere): `isWorkOrderOpen`, `sortWorkOrdersForDashboard`, `slaHoursForPriority` (`src/lib/work-orders.mjs:30,58,70`); `findMissingCertifications`, `PERIOD_STATUSES` (`src/lib/scheduling.mjs:24,100`); `shouldEscalateIncident`, `classifyOshaReview`, `formatIncidentNo` (`src/lib/incidents.mjs:10,41,310`); `certificationBlocksSchedule` (`src/lib/training.mjs:24`). `isWorkOrderOverdue` is exported but only ever called by `sortWorkOrdersForDashboard` in the same file, which is itself dead — a two-function dead chain.
5. **Duplicated 403-wrapper boilerplate.** Identical `requireRead`/`requirePerm` bodies (5-9 lines each, byte-for-byte the same) are copy-pasted into at least 7 files instead of one shared factory: `src/lib/http/scheduling-routes.mjs:72-88`, `src/lib/http/work-orders-routes.mjs:72-88`, `src/lib/http/reports-routes.mjs:70-90`, `src/lib/http/incidents-routes.mjs:79-99`, `src/lib/http/training-routes.mjs:142-158`, `src/lib/http/communications-routes.mjs:43-58`. Any future change to the 403 response shape must be made in 7 places.
6. **Duplicated, drifted pagination validation.** `src/lib/http/reports-routes.mjs:272-289` and `src/lib/http/work-orders-routes.mjs:203-222` each re-implement limit/offset parsing from query params; the two differ subtly (reports-routes returns 400 immediately per-field, work-orders-routes accumulates into an `errors` array and returns once) — a genuine "two implementations that could silently diverge further" risk, not shared with a `list-pagination.mjs`-style helper (which exists only client-side, in `src/public/js/list-pagination.mjs`, with no server equivalent).
7. **"typecheck" gate does not check permission-string literals used at call sites.** `scripts/typecheck.mjs` only validates the 26 codes in `src/lib/permissions.mjs` against `seed.sql` and migration `has_permission(...)` literals — it never inspects the raw string literals passed to `requireAuthPermission`/`requirePerm` inside `src/lib/http/*.mjs` route files (e.g. `"admin.manage"` appears as an inline literal 21 times — grep: `src/lib/http/admin-routes.mjs` and others). A typo'd permission string in a route file (e.g. `"incident.manage"` vs `"incidents.manage"`) would fail-closed silently and no gate would catch it unless a route test happens to exercise exactly that literal.
8. **Real linter finds what the repo's own "lint" gate misses.** Running eslint (`no-unused-vars`) over `src/**/*.mjs` found: `TRAINING_COMPLETIONS_COLUMNS` unused (`src/lib/http/training-routes.mjs:36`), `MESSAGE_ACKNOWLEDGEMENTS_COLUMNS`/`MESSAGE_RECEIPTS_COLUMNS`/`DEVICE_TOKEN_COLUMNS` unused (`src/lib/http/communications-routes.mjs:12,15,16`), `ESCALATION_STATUSES` and `documentHash` unused (`src/lib/http/incidents-routes.mjs:28,970`). `scripts/lint.mjs` (just `node --check`) is syntactically blind to all of these.
9. **README doc drift.** `README.md:8` claims "23 forward-only migrations" and `README.md:55` says "Apply migrations 0001–0023" — the repo actually ships 39 migrations (`ls supabase/migrations` → 0001…0039, confirmed via `wc -l`). `README.md:27` claims a "16-code catalog" of permissions — `src/lib/permissions.mjs` actually exports 26 codes (verified by import). Neither number is gated by any script, so it will keep drifting.
10. **RLS/SQL test suite silently no-ops in normal CI runs.** `scripts/run-rls-tests.mjs:5-15` skips all of `supabase/tests/*.sql` (4551 lines, 10 files covering audit chain integrity, department scope, incident immutability, etc.) with only a console.log and exit 0 whenever `DATABASE_URL`/`SUPABASE_DB_URL` is unset or `psql` isn't on PATH — the headline "1311 tests" from `npm test` never includes this at all; it's a separate, easy-to-forget invocation, and a CI pipeline that doesn't provision a live Postgres will report success while running zero RLS tests.

## (c) Top 5 refactors by payoff/cost ratio

1. **Extract the `requireRead`/`requirePerm` 403-wrapper into `guard.mjs`** as a factory (`makeGuards(sendJson)` returning `{requireRead, requirePerm, requireAnyPerm}`), used by all 7+ route files. Cheap (mechanical, well covered by existing tests to verify no behavior change), removes ~50 duplicated lines, and centralizes the 403 body shape for a future API contract change.
2. **Share the limit/offset pagination parser server-side** (a `parseListLimitOffset(qp, {defaultLimit, maxLimit})` helper next to `router.mjs` or in a new `list-query.mjs`), replacing the two divergent implementations in reports-routes.mjs and work-orders-routes.mjs. Removes drift risk before a third route file copies whichever version is nearest.
3. **Delete or explicitly re-export the 8 confirmed-dead domain-lib functions** (item b.4) — either wire them into the routes they were clearly designed for (e.g. `sortWorkOrdersForDashboard` for the work-orders list endpoint, `classifyOshaReview` for incident review) or remove them; right now they're maintenance liability with test coverage but no caller, which is worse than either fully-used or fully-removed.
4. **Add PATCH/members/DELETE tests for notification-routes.mjs and admin-routes.mjs PATCH /facilities/:id** (item b.2, b.3) — cheapest possible risk reduction: the test harness/fixtures already exist in the same files, it's a copy-and-adapt of an existing 403/200 test pair, and it closes the single biggest "permission check could be deleted silently" gap in the repo.
5. **Add a real linter to the gate** (swap `scripts/lint.mjs`'s `node --check`-only pass for `eslint` with just `no-unused-vars`/`no-unreachable`/`no-undef` — no style/formatting rules needed given the existing format-check). This is a low-cost addition (eslint is already resolvable via npx in this environment) that immediately catches the 6 unused-variable warnings found above and prevents the class of bug where a column-list constant silently goes stale after a refactor.

## (d) Coverage table (`node --test --experimental-test-coverage`, Node v22.22.2)

All src/lib/http/*.mjs and src/lib/*.mjs files, line / branch / function %:

| File | Line % | Branch % | Func % | Notable uncovered |
|---|---|---|---|---|
| src/lib/http/admin-routes.mjs | 82.88 | 57.14 | 86.79 | PATCH /facilities/:id (181-219), several 106-233 |
| src/lib/http/attachments-routes.mjs | 93.77 | 71.79 | 92.00 | error edges 251-326 |
| src/lib/http/audit-routes.mjs | 100.00 | 88.37 | 100.00 | — |
| src/lib/http/auth-routes.mjs | 95.18 | 82.35 | 100.00 | — |
| src/lib/http/auth.mjs | 100.00 | 85.71 | 100.00 | — |
| src/lib/http/billing-routes.mjs | 90.27 | 61.54 | 100.00 | 134-169, 237-246 |
| src/lib/http/cert-policy-routes.mjs | 71.54 | 59.65 | 84.21 | 119-203 (large block) |
| src/lib/http/communications-routes.mjs | 98.22 | 76.21 | 100.00 | scattered |
| src/lib/http/forms-routes.mjs | 94.62 | 68.33 | 95.83 | 165-194 |
| src/lib/http/guard.mjs | 100.00 | 87.50 | 100.00 | — |
| src/lib/http/incidents-routes.mjs | 98.77 | 72.57 | 100.00 | 900-903 |
| src/lib/http/internal-routes.mjs | 81.82 | 83.33 | 70.00 | 80-110 |
| src/lib/http/me-route.mjs | 100.00 | 72.22 | 100.00 | — |
| src/lib/http/module-config.mjs | 100.00 | 84.62 | 100.00 | — |
| **src/lib/http/notification-routes.mjs** | **67.69** | **55.71** | **76.00** | member/route CRUD + PATCH — see b.2 |
| src/lib/http/rate-limit.mjs | 96.81 | 80.65 | 100.00 | — |
| src/lib/http/report-templates-routes.mjs | 97.06 | 68.42 | 100.00 | — |
| src/lib/http/reports-routes.mjs | 83.43 | 57.54 | 87.50 | 237-346 (fetch/list branch) |
| src/lib/http/router.mjs | 100.00 | 88.24 | 100.00 | — |
| src/lib/http/scheduling-routes.mjs | 97.33 | 72.50 | 98.15 | 680-692 |
| src/lib/http/training-routes.mjs | 95.45 | 71.38 | 95.16 | scattered |
| src/lib/http/validate.mjs | 81.13 | 70.00 | 100.00 | 21-80 |
| src/lib/http/work-orders-routes.mjs | 98.95 | 84.24 | 100.00 | — |
| src/lib/http/workflow-routes.mjs | 99.05 | 72.06 | 100.00 | — |
| src/lib/incident-pdf.mjs | 99.13 | 50.96 | 100.00 | branch-heavy formatter |
| src/lib/incidents.mjs | 100.00 | 86.96 | 100.00 | — |
| src/lib/observability.mjs | 95.92 | 88.00 | 100.00 | — |
| src/lib/permissions.mjs | 100.00 | 100.00 | 100.00 | — |
| src/lib/report-schema.mjs | 95.83 | 82.43 | 100.00 | — |
| src/lib/report-templates.mjs | 100.00 | 91.18 | 100.00 | — |
| src/lib/reports-compliance.mjs | 100.00 | 88.64 | 100.00 | — |
| src/lib/scheduling.mjs | 100.00 | 91.74 | 100.00 | — |
| src/lib/settings-registry.mjs | 100.00 | 95.74 | 100.00 | — |
| src/lib/storage.mjs | 98.60 | 93.26 | 100.00 | — |
| src/lib/supabase-rest.mjs | 100.00 | 98.28 | 100.00 | — |
| src/lib/tenant.mjs | 100.00 | 100.00 | 100.00 | — |
| src/lib/training.mjs | 100.00 | 86.67 | 100.00 | — |
| src/lib/work-orders.mjs | 98.97 | 90.00 | 100.00 | — |
| src/lib/env.mjs | 84.71 | 93.33 | 75.00 | 73-85 (server-env optional fields) |
| src/lib/audit.mjs | 97.99 | 86.27 | 100.00 | — |
| src/lib/communications.mjs | 100.00 | 78.43 | 100.00 | — |
| src/public/js/*.mjs (6 files) | 100.00 (5 of 6) / 100.00 | 83-100 | 100.00 | all extracted logic modules well tested |

**Overall: 95.60% line / 83.84% branch / 93.93% func across all files.**

**Files below 60% line coverage:** none in src/lib/http or src/lib (lowest is notification-routes.mjs at 67.69%). Two script files fall below 60% line: `scripts/verify-seed.mjs` (59.32%) and `scripts/smoke.mjs` (15.96%) — both are standalone CLI/manual tools invoked outside `node --test`, not exercised by the automated suite (smoke.mjs is meant to be run manually against a live deployment). `scripts/server.mjs` shows only 40.79% in this report, but that's a coverage-instrumentation artifact, not a real gap: `test/server-headers.test.mjs` spawns server.mjs as a **child process** (`spawn(process.execPath, ["scripts/server.mjs"], ...)`), so its route-dispatch logic genuinely runs and is exercised by the test, but Node's `--experimental-test-coverage` only instruments the parent process, not the child — the real coverage of server.mjs's request path is understated by this measurement, not actually missing.

**Riskiest 5 untested/weakly-tested code paths (ranked):**
1. `src/lib/http/notification-routes.mjs` — distribution-list PATCH, member add/list/delete, notification-routes list (0 tests; 55.71% branch coverage). Permission checks here could be deleted without any test failing.
2. Non-409 `PostgrestError` handling across nearly every write route — untested because nothing exercises a non-409 PostgREST failure (e.g. a 400 malformed-filter or 403 RLS-denied response from Postgres itself); these paths fall through to a bare 500 and no test asserts the client-facing shape of that failure.
3. `src/lib/http/admin-routes.mjs` PATCH `/facilities/:facilityId` (org-admin write, no dedicated test).
4. `src/lib/http/cert-policy-routes.mjs` lines 119-203 (59.65% branch) — a large block of policy-gap-report logic with thin branch coverage.
5. `src/public/js/app.js` in its entirety — 3099 lines of DOM/state logic with zero direct unit tests (only reachability-checked by test/build-admin.test.mjs's module-graph walk); all correctness here depends on the developer's manual testing or the `run` skill's live smoke pass, not the automated suite.
