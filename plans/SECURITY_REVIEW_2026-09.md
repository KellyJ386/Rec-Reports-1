# Wave 1 Security Review — Sign-off

**Date:** 2026-09-06
**Task:** S-12 (`plans/WAVES_1_4_IMPLEMENTATION_PLAN.md`)
**Verdict:** signed off at commit `4df98ce`.

---

## Scope

Two independent adversarial reviews plus two rounds of targeted re-verification, covering:

- **Wave 1 slices 1A–1E** — storage-path and module-read hardening (S-1, S-2), internal helper
  schema move (S-3), incident audit and transition guards (S-4), BFF-only permission codes pushed
  into RLS (S-5), audit/HR-read/org-admin semantics (S-6), durable auth throttle (S-7), polymorphic
  audience references (S-8), the low-findings batch (S-9), the advisor performance backlog (S-10),
  the HttpOnly refresh cookie (S-11) and the JWT verifier follow-ups (S-13).
- **Migrations 0040–0049.**
- **Commits on `claude/wave1-review-fixes` up to and including `4df98ce`** (the review baselines
  were `claude/wave1-security` and `claude/wave1-security-b`).

**Method.** Each review and each re-verification was performed against a PostgreSQL 16 database
built from scratch by the reviewer — `scripts/ci/rls-bootstrap-pre.sql` → every
`supabase/migrations/*.sql` in order → `scripts/ci/rls-bootstrap-post.sql` → `supabase/seed.sql` —
using fixtures in a uuid namespace deliberately disjoint from the shipped test suites, so no
finding was ever "confirmed" by re-running the authors' own assertions. Findings were reproduced
before the fix and re-proved after it.

**Gate status at `4df98ce`:**

| Check | Result |
| --- | --- |
| `npm test` | 1477 pass, 0 fail |
| `npm run db:test:rls` | 29 RLS test files, all pass |
| `npm run db:verify` | 49 migration files verified |
| `npm run lint` | pass (152 `.mjs` files) |
| `npm run typecheck` | pass (26 permission codes consistent; settings registry valid) |
| `npm run format:check` | pass |

No pre-existing assertion was deleted or weakened across either round of fixes. The JS suite grew
from 1414 to 1477 tests and the RLS suite from 23 to 29 files.

---

## Findings summary

**Review A** (slices 1A/1B/1D/1E storage, helpers, cookie, JWT): 2 High, 3 Medium, 9 Low, plus one
non-defect coverage note (L-10).
**Review B** (slices 1C/1D/1E policy alignment, incident guards, throttle, audiences): 4 High,
5 Medium, 5 Low.
**Introduced by the review fixes and caught in re-verification:** 1 High, 2 Low (NEW-1/2/3).
**Raised during re-verification as follow-ups:** N-1, N-2, N-3.

Status legend: **Closed** — fixed and proved. **Accepted** — understood, documented in code or in
the section below, and judged acceptable. **Deferred** — real but non-blocking; tracked for a later
wave.

### Review A

| ID | Sev | Finding | Status | Proving test |
| --- | --- | --- | --- | --- |
| H-1 | High | A stored attachment path using relative segments could satisfy both the database path trigger and the application-side facility guard, and normalize into another facility's object when a service-role signed URL was minted | Closed | `test/storage.test.mjs` — "assertPathInFacility rejects the exact cross-facility traversal string from the Wave 1A security review" (+3 sibling negatives); DB half: `supabase/migrations/0041` anchored path regex, positive shape asserted in `supabase/tests/rls_audit_hardening.sql` §1 and eleven non-canonical shapes (traversal, empty segments, unknown module, missing filename) rejected in `supabase/tests/storage_module_reads.sql` ("H-1" block) |
| H-2 | High | Re-running any pre-0042 migration against a post-0042 database dropped RLS policies and then failed to recreate them (repair-path damage; fail-closed) | Closed | `.github/workflows/ci.yml` — "Re-apply representative migrations to prove post-0042 replayability (H-2)" step and its policy assertions |
| M-1 | Med | A certification-evidence read branch matched on a path string without binding it to the owning certification row, so a manage-only actor could read another employee's evidence object | Closed | `supabase/tests/storage_module_reads.sql` §3 ("M-1 regression") |
| M-2 | Med | The CI `storage.foldername` shim was more permissive than the real Supabase function, so the storage-policy proof validated a different function than production | Closed | `scripts/ci/rls-bootstrap-pre.sql` shim corrected; `supabase/tests/storage_module_reads.sql` §1a/1b/2 |
| M-3 | Med | `verify-migrations.mjs` did not enforce the schema-qualification contract 0042's header documents | Closed | `scripts/verify-migrations.mjs` bare-helper-call guard for files ≥ 0043, run by `npm run db:verify` |
| L-1 | Low | The database path trigger did not constrain the module segment that the application-side guard did | Closed | Swept up by H-1's anchored regex; same tests |
| L-2 | Low | 0042's EXECUTE revoke sweep missed three later trigger/parser functions | Closed (deliberately partial, rationale in-migration) | `supabase/tests/internal_helpers.sql`; `supabase/tests/storage_module_reads.sql` §3 |
| L-3 | Low | Policies evaluated as `anon` now raise instead of returning zero rows | Accepted | No route runs as `anon`; grant shape asserted in `supabase/tests/internal_helpers.sql` |
| L-4 | Low | Refresh-cookie write/read encoding asymmetry | Closed | `test/cookies.test.mjs` — "buildRefreshCookie + parseCookies round-trip a token containing reserved cookie characters" |
| L-5 | Low | Optional-chained `setHeader?.()` could silently drop the session cookie and still return 200 | Closed | `test/auth-routes.test.mjs` cookie-attribute and rotation tests |
| L-6 | Low | `sec-fetch-site` absent is treated as allowed; sibling-subdomain requests are rejected | Accepted | `test/auth-routes.test.mjs` cross-site refresh tests |
| L-7 | Low | `iss` is mandatory and pinned to `SUPABASE_URL`; a custom-domain project would fail closed with an indistinguishable 401 | Accepted | `test/http-auth.test.mjs` — the two `iss` acceptance/rejection tests |
| L-8 | Low | An audit-write failure had no local signal when the observability DSN was unset | Closed | `test/incidents-routes.test.mjs` — the `console.error` case alongside the "audit write failed" assertions |
| L-9 | Low | Sign-out clears the cookie but cannot revoke upstream when the access token has expired | Accepted as documented | Behaviour unchanged; rationale recorded in `src/lib/http/auth-routes.mjs` |
| L-10 | note | Test-coverage gaps (none weakening) | Closed | Superseded by the tests added for H-1, M-1 and M-2 |

### Review B

| ID | Sev | Finding | Status | Proving test |
| --- | --- | --- | --- | --- |
| H1 | High | The `reports.publish` separation of duties was enforced on UPDATE only, so a template-manage-only actor could still publish via the INSERT path | Closed | `supabase/tests/wave1b_review_fixes.sql` — "H1: report_template_versions INSERT bypass" (plus the draft-insert positive that follows it) |
| H2 | High | Newly widened child-row writers were not admitted by the audit-event INSERT policy, so two incident routes committed a child row and then failed the audit write | Closed | `supabase/tests/wave1b_review_fixes.sql` — "H2: incident_audit_events INSERT widened" (with read-only and cross-facility negatives) |
| H3 | High | The legal-hold route had no working UPDATE path for its own permission holder; it silently no-opped and then failed the audit write | Closed | `supabase/tests/wave1b_review_fixes.sql` — "H3: incidents.legal_hold.manage-only actor"; `supabase/tests/incident_report_guards.sql` §7a/§7b |
| H4 | High | The incident audit trigger copied full incident narratives into a table readable under a disjoint admin permission | Closed | `supabase/tests/wave1b_review_fixes.sql` — "H4: fn_incident_report_audit's payload is an allow-list" |
| M1 | Med | Amendable incident fields stayed directly writable on a non-draft incident with no amendment record | Closed | `supabase/tests/incident_report_guards.sql` §4a (direct write rejected) and §4b (same change succeeds through the amendment RPC); `supabase/tests/wave1b_review_fixes.sql` "M1 (RPC guard rails)" |
| M2 | Med | Legal hold was gated on UPDATE only, so it could be set at creation by an actor without the legal-hold permission and never lifted | Closed | `supabase/tests/wave1b_review_fixes.sql` — "M2: legal_hold may only be created true by …" |
| M3 | Med | The migration's stated rationale for permitting a null polymorphic audience reference did not match the resolver's behaviour for the employee type | Closed | `supabase/tests/wave1b_review_fixes.sql` — "M3: message_audiences.audience_ref_id must be non-null …"; `supabase/tests/message_audience_refs.sql` §1–§3; `test/communications*.test.mjs` |
| M4 | Med | Two routes still called the deprecated pre-0019 org-admin rule (fail-closed at the database, but inconsistent) | Closed | `test/http-guard.test.mjs` — the four `requireAuthOrgAdminRow` tests; no `requireAuthOrgAdmin(` caller remains in `src/` or `scripts/` |
| M5 | Med | Durable throttle keys were attacker-shaped and unbounded, and the per-IP bucket was trivially evaded | Closed (residual accepted — see below) | `test/durable-rate-limit.test.mjs` key-cap and row-cap tests; `test/auth-routes.test.mjs` — the "client IP: …" tests and the hashed-key assertions; `supabase/tests/auth_throttle.sql` |
| L1 | Low | Plaintext sign-in addresses were stored in the throttle table and could reach the external error DSN | Closed | `test/auth-routes.test.mjs` — "the durable key must never carry the raw email" assertion |
| L2 | Low | Submission attribution columns stayed rewritable after an incident left draft | Closed | `supabase/tests/wave1b_review_fixes.sql` — "L2: submitted_by/submitted_at are frozen …" |
| L3 | Low | The soft-delete column was frozen with no service-role exemption, blocking a future retention job | Closed | `supabase/tests/wave1b_review_fixes.sql` — "L3: deleted_at is exempted …" |
| L4 | Low | The migration guard's regex is narrower than its header comment implies (informational) | Closed by M-3's fix | `npm run db:verify` |
| L5 | Low | The durable limiter failed open on errors but not on a hang (no request timeout) | Closed | `test/durable-rate-limit.test.mjs` — "every fetch carries an AbortSignal" and "an aborted (timed-out) PostgREST request fails open" |

### Introduced by the fixes, caught in re-verification

| ID | Sev | Finding | Status | Proving test |
| --- | --- | --- | --- | --- |
| NEW-1 | High | The amendment RPC was created only in the schema PostgREST never serves, so the amendment route was unreachable end to end while all CI signals stayed green | Closed | `supabase/tests/incident_report_guards.sql` §4d (calls the wrapper unqualified as `authenticated`; treats "function does not exist" and "insufficient privilege" as explicit failures); `supabase/tests/wave1b_review_fixes.sql` "NEW-1 grant shape" |
| NEW-2 | Low | The transition-guard bypass flag was never cleared, so it stayed armed for the remainder of the transaction | Closed | `supabase/tests/incident_report_guards.sql` §4c |
| NEW-3 | Low | A throttle key containing list delimiters could wedge the row-cap sweep's delete filter | Closed | `test/supabase-rest.test.mjs` — "in filters double-quote (and escape) values containing PostgREST list delimiters"; `test/durable-rate-limit.test.mjs` — "a poisoned key (list delimiters) is quoted …" |

### Re-verification follow-ups

| ID | Sev | Finding | Status | Proving test |
| --- | --- | --- | --- | --- |
| N-1 | Low | The CI replay probe asserts on policy *names* only and replays four representative files, so a later same-name policy redefinition can be silently reverted for the rest of the job | Deferred | n/a — CI-only, ephemeral database; see Accepted risks |
| N-2 | Low | 0042's `alter database … set search_path` was unguarded, so a non-owner migration runner failed the whole migration | Closed | `supabase/migrations/0042_internal_helpers.sql` now catches `insufficient_privilege` and raises a notice with the manual step (`ad3577c`) |
| N-3 | Low | The migration guard strips SQL comments but not string literals, so a comment marker inside a literal can mask a bare helper call on the same line | Deferred | n/a — convention check only; a bare call still resolves correctly at runtime |

---

## What changed, per High

### H-1 — attachment path validation

The database trigger's prefix test was replaced by a positive, anchored regular expression matching
the full canonical five-segment path shape (facility, module from a fixed allow-list, record id,
filename), and the application-side guard gained an explicit segment check that rejects empty,
`.` and `..` segments in addition to the facility-prefix test. Both halves now reject every
non-canonical shape and the write path is unaffected — the only module values the product emits are
the four in the allow-list, and generated filenames can never be a dot segment. L-1 (unconstrained
module segment) is closed as a side effect.

### H-2 — migration replayability after the helper schema move

0042 now sets the database-level `search_path` to `public, internal`, so the ~200 policies written
before the helper move still resolve their helper names when an older migration is replayed. The
drop-then-create idempotency convention the repo documents therefore holds again. CI proves it by
replaying representative migrations after the RLS suite and asserting the affected policies survive.
Following N-2, the statement degrades to a notice instead of failing the migration when the runner
does not own the database.

### H1 — `reports.publish` separation of duties

The publish predicate that 0044 added to the template-version UPDATE policy is now also present in
the INSERT policy's `WITH CHECK`, so a version cannot be created already published by an actor who
holds only the template-management permission. The ordinary draft-insert path is unchanged, and the
regression test asserts both the negative and that positive.

### H2 — audit-event writers aligned with the widened child-row writers

The incident audit-event INSERT policy's permission set was widened to the full set of codes whose
routes write incident audit events, still conjoined with the same-facility check. The
"child row committed, audit row rejected, 500 returned" condition is gone, and the widening was
verified not to become a blanket grant: a read-only actor and a cross-facility actor are both still
rejected.

### H3 — legal hold has a working, narrow write path

A permissive UPDATE policy for the legal-hold permission was added to the incident table, and the
transition guard confines an actor holding only that permission to the legal-hold column (plus the
updated-at timestamp). The route now works for its own permission holder in both directions, and
the new policy did not become a side channel into the rest of the row — including when a legal-hold
change and another column change are attempted in a single statement.

### H4 — audit payload is an allow-list

The incident audit trigger no longer serializes whole rows. It builds an explicit payload of the
status, severity, legal-hold, OSHA-review and changed-column fields the audit trail needs. The
free-text narrative columns appear only as *names* inside the changed-column list, never as values,
so the disjoint admin read path no longer discloses incident narratives. The equivalent
pre-existing pattern on report submissions is unchanged and is recorded below as a known limitation.

### NEW-1 — the amendment RPC is reachable, and only the intended callers can reach it

A thin `SECURITY INVOKER` wrapper was added in the served schema; it carries no logic and simply
delegates to the internal `SECURITY DEFINER` function, which keeps every check (caller identity,
permission, draft status, amendable-field allow-list, cross-facility safety, atomicity). EXECUTE
is granted to the authenticated role (and the service role where it exists) and revoked from PUBLIC
and the anonymous role, and because the wrapper is invoker-rights it confers nothing on its own.
The internal schema remains unexposed: it grants `USAGE` to the authenticated and service roles only,
and exactly one internal function has a wrapper — the six primitives moved out of the served schema
have none. The migration verifier now requires the wrapper to exist, and the SQL suite calls it the
way the API does (unqualified, as the authenticated role) so a future schema-reachability
regression fails the suite rather than passing it.

---

## Accepted risks and known limitations

1. **Durable throttle read-then-upsert race.** The durable limiter reads the current counter and
   then upserts; concurrent requests for the same key can interleave and undercount. Documented in
   `src/lib/http/durable-rate-limit.mjs`. The in-memory per-instance limiter remains the first line
   and the counters are advisory, so the failure mode is a slightly higher effective threshold, not
   an unbounded one.
2. **IP-derived throttle buckets are header-derived.** The client address used for per-IP throttle
   bucketing comes from the rightmost `x-forwarded-for` hop, else `x-real-ip`, else the socket peer
   address, and is accepted only if it parses as an IPv4/IPv6 address. This is correct on the
   deployment target, which overwrites the forwarded-for header at the edge, and correct behind a
   proxy that appends (the rightmost hop is the one the proxy wrote, and it outranks a possibly
   pass-through `x-real-ip`). On a deployment fronted by no proxy a caller can still obtain a
   private throttle bucket. Accepted: the value is
   never an identity, an audit fact or an authorization input; evading it degrades to "no per-IP
   throttle for that request", and the per-account counter (derived from the credential, not from a
   header) is the load-bearing control. Key space is closed to a valid address, a shared "invalid"
   sentinel, or "unknown", and every durable key is a fixed-width hash.
3. **In-memory limiter is per instance.** `src/lib/http/rate-limit.mjs` is a per-process map, so it
   provides no bound across cold-started serverless instances. That is precisely why the durable
   table exists; the in-memory limiter is retained as a cheap first line and as the test double.
4. **Throttle table growth is bounded, not eliminated.** Row count is capped and stale rows are
   swept, but the sweep rides along with the cron-guarded drain rather than running on its own
   schedule. A standalone schedule is a follow-up.
5. **Incident content rewrites are prevented at the database layer but attributed, not prohibited.**
   Amendable fields on a non-draft incident can change only through the amendment RPC, which writes
   an amendment record and an audit event atomically. An actor with the incident management or
   review permission can therefore still amend content — by design — and the control is that every
   such change is recorded, not that it is impossible.
6. **The report-submission audit trigger still serializes whole rows.** H4 fixed the incident
   trigger; the older submission trigger writes a full before/after envelope into the same
   admin-readable table. Pre-existing, out of this review's scope, and tracked as a follow-up.
7. **Anonymous-role policy evaluation raises rather than returning zero rows** (A/L-3), and
   **sign-out cannot revoke upstream once the access token has expired** (A/L-9). Both are
   documented in code; neither is reachable by a current route in a way that changes the outcome.
8. **CSRF defence on the refresh endpoint leans on `SameSite=Strict` plus a `sec-fetch-site` check
   that treats an absent header as allowed** (A/L-6). The residual is legacy non-browser or
   pre-2020-browser clients, which have no ambient cookie to ride; a successful request would yield
   only a rotated `HttpOnly` cookie the caller cannot read.
9. **The issuer claim is pinned to the configured project URL** (A/L-7). A project moved to a custom
   auth domain would fail closed for every user at once. Accepted; an explicit issuer override is a
   follow-up.
10. **N-1 (CI replay probe) and N-3 (convention-guard string-literal blind spot)** are open,
    non-blocking follow-ups. N-1 affects an ephemeral CI database only, and its underlying hazard —
    replaying an old migration reverts every later same-name policy redefinition — is a property of
    the drop-then-create convention, not of any fix in this wave. N-3 weakens a style guard only;
    the call it might miss still resolves correctly at runtime.
11. **Coverage note.** The database half of H-1 has a positive in-tree assertion (the canonical path
    shape is accepted) but no in-tree negative for the rejected shapes; those were proved by the
    reviewer against a live database across twenty path shapes. Adding a negative case to the SQL
    suite is a cheap follow-up.

---

## Closes

This review is the module-scoped security gate that the following plan tasks call for. All four are
**closed** by this artifact:

- **OP-24** (`plans/PLATFORM_OPS_PLAN.md`) — security review gate over the definer RPCs (OP-05), the
  worker and internal endpoints (OP-11/13), and storage paths, signed URLs and cross-tenant checks
  (OP-15–17). OP-05 in particular is resolved: the scope/permission primitives were moved out of the
  served schema, EXECUTE was revoked from PUBLIC and the anonymous role, and exactly one deliberate,
  invoker-rights wrapper is served.
- **WO-27** (`plans/WORK_ORDERS_PLAN.md`) — module security review and full gate: guard ordering,
  facility inheritance and storage paths were reviewed end to end (H-1, L-1, M-1) and no route
  trusts a body-supplied facility identifier.
- **DR-34** (`plans/DAILY_REPORTS_PLAN.md`) — threat model over signed-URL path handling, cross-tenant
  object reads, and the publish separation of duties (H-1, M-1, M-2, H1).
- **IN-24** (`plans/INCIDENTS_PLAN.md`) — its **security-review half only**: the abuse surface on the
  incident write paths (transition and amendment guards, legal hold, audit completeness and audit
  payload minimization — H2, H3, H4, M1, M2, L2, L3, NEW-1, NEW-2) plus the durable sign-in/refresh
  throttle (S-7, M5, L1, L5). IN-24's feature scope — a 429 rate limit on incident submit/export and a
  justification-capturing break-glass read path — is **not built** and stays open for Wave 4; that
  work needs its own review when it lands.

---

## Post-deploy verification

Run against the live project after deploying this branch. All items must pass before Wave 1 is
considered shipped.

- [ ] **Migrations applied.** `0040` through `0049` applied to the live project in order, with no
      errors, and `npm run db:verify` green against the deployed tree.
- [ ] **RLS suites green against the live project** (29 files), in addition to locally.
- [ ] **Security advisors clean.** `get_advisors(security)` reports **zero** `SECURITY DEFINER`
      exposure findings and **zero** mutable-`search_path` warnings. Every definer function in the
      tree carries an explicit `search_path`.
- [ ] **Internal helpers are not served.** For each of the six moved primitives —
      `has_permission` (both overloads), `is_platform_admin`, `is_organization_admin`,
      `current_facility_ids`, `fn_assert_same_facility` — a request to
      `/rest/v1/rpc/<name>` returns **404**.
- [ ] **The amendment wrapper is served.** A request to `/rest/v1/rpc/apply_incident_amendment` as
      an authenticated caller is **not** 404. (A caller without the incident management or review
      permission should be rejected by the function's own check, not by a missing-function error.)
- [ ] **Leaked-password protection enabled** in the project's auth settings.
- [ ] **Refresh cookie attributes confirmed on a live response:** `HttpOnly`, `Secure`,
      `SameSite=Strict`, path-scoped to the auth routes, and no refresh token in any JSON body.
- [ ] **Throttle table posture confirmed:** row-level security enabled with no permissive policy
      (service role only), and the sweep observed to run.

---

## Sign-off

Every finding from both reviews is **Closed** or **Accepted with a stated rationale**; the three
findings introduced by the first round of fixes (NEW-1/2/3) were caught in re-verification and are
closed; two follow-ups (N-1, N-3) are deferred and neither affects a deployed system. Each closure
was re-proved against a database built independently by the reviewer, and each is bound to a named
test in the tree so it cannot silently regress.

Wave 1 slices 1A–1E and migrations 0040–0049 are **signed off at commit `4df98ce`**, subject to the
post-deploy verification checklist above.

**Amendments landed with this document** (same pull request, after the re-verification): the
per-IP bucket now reads the rightmost `x-forwarded-for` hop before `x-real-ip` (the reviewer's R-1
note); an empty `in.(...)` list value is quoted rather than emitted bare (R-2); and the H-1 database
guard gained the in-tree negative test noted above. None of these change a reviewed verdict.
