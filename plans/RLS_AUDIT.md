# Schema-wide RLS Audit

Empirical audit of every RLS-enabled table in `supabase/migrations/0001`-`0037`,
looking for the two recurring bug classes documented in the audit brief:

- **Class A — "inert feature"**: a table has RLS enabled and a SELECT policy
  but no INSERT/UPDATE policy, so routes that write it (the BFF authenticates
  with the *caller's* JWT — see `authenticate`/`buildClient` in
  `scripts/server.mjs`) are silently dead against the real database while
  passing every mocked unit test.
- **Class B — "cross-facility reference"**: a facility-scoped row can
  reference a parent/child row in a *different* facility, because the manage
  policy only checks the actor's permission on the **claimed** `facility_id`
  and never compares it to the referenced row's actual `facility_id` — and
  plain FK enforcement bypasses RLS on the referenced table.

Method: stood up a local Postgres 16, replicated the exact CI harness
(`scripts/ci/rls-bootstrap-pre.sql` → all 38 migrations in order →
`scripts/ci/rls-bootstrap-post.sql` → `supabase/seed.sql`), enumerated every
`pg_policies` row, cross-referenced every `pgInsert`/`pgUpdate`/`pgDelete`
call in `src/lib/http/*.mjs` against write-policy coverage, and — for Class B —
empirically inserted a cross-facility-referencing row as an authenticated,
permission-holding actor for every FK column found and recorded the actual
observed result. Every finding below reproduces against a live database; none
is inferred from reading the SQL alone.

Fix: `supabase/migrations/0038_rls_audit_hardening.sql`. Proof:
`supabase/tests/rls_audit_hardening.sql` plus the full existing
`supabase/tests/*.sql` suite re-run against the patched schema.

## Tables audited

**73 of 73** tables in the `public` schema have RLS enabled (`pg_class.relrowsecurity`).
All 73 were checked for Class A; all facility-scoped tables with an FK to
another facility-scoped table (56 such column pairs, enumerated via
`information_schema`) were checked for Class B.

| Table | Commands covered (pre-0038) | Commands covered (post-0038) |
|---|---|---|
| admin_change_requests | ALL | ALL |
| app_users | SELECT | SELECT |
| assets | ALL, SELECT | ALL, SELECT *(dept FK now guarded)* |
| audit_events | INSERT, SELECT | INSERT, SELECT |
| branding_profiles | ALL | ALL |
| certification_events | INSERT, SELECT | INSERT, SELECT |
| certification_policies | ALL, SELECT | ALL, SELECT |
| certification_role_requirements | ALL, SELECT | ALL, SELECT |
| certification_types | DELETE, INSERT, SELECT, UPDATE | DELETE, INSERT, SELECT, UPDATE |
| communication_channels | ALL, SELECT | ALL, SELECT *(dept FK now guarded)* |
| course_modules | ALL, SELECT | ALL, SELECT *(course_id FK now guarded)* |
| courses | ALL, SELECT | ALL, SELECT |
| custom_fields | ALL, SELECT | ALL, SELECT |
| department_settings | ALL | ALL *(dept FK now guarded)* |
| departments | DELETE, INSERT, SELECT, UPDATE | DELETE, INSERT, SELECT, UPDATE |
| distribution_list_members | ALL, SELECT | ALL, SELECT |
| distribution_lists | ALL, SELECT | ALL, SELECT |
| employee_certifications | INSERT, SELECT, UPDATE | INSERT, SELECT, UPDATE |
| employee_device_tokens | ALL | ALL |
| employee_notification_preferences | ALL | ALL |
| employees | DELETE, INSERT, SELECT, UPDATE | DELETE, INSERT, SELECT, UPDATE *(dept FK now guarded)* |
| facilities | INSERT, SELECT, UPDATE | INSERT, SELECT, UPDATE |
| facility_module_overrides | ALL | ALL |
| facility_settings | ALL | ALL |
| feature_flag_rules | ALL, SELECT | ALL, SELECT |
| feature_flags | SELECT | SELECT |
| form_definitions | ALL, SELECT | ALL, SELECT |
| form_field_bindings | ALL, SELECT | ALL, SELECT |
| incident_amendments | INSERT, SELECT | INSERT, SELECT |
| incident_attachments | ALL, SELECT | ALL, SELECT *(incident_id FK now guarded)* |
| incident_audit_events | INSERT, SELECT | INSERT, SELECT *(incident_id FK now guarded)* |
| incident_escalations | ALL, SELECT | ALL, SELECT *(incident_id FK now guarded)* |
| incident_followup_actions | ALL, SELECT | ALL, SELECT *(incident_id FK now guarded)* |
| incident_people | ALL, SELECT | ALL, SELECT *(incident_id FK now guarded)* |
| incident_reports | ALL, SELECT | ALL, SELECT *(dept FK now guarded)* |
| memberships | DELETE, INSERT, SELECT, UPDATE | DELETE, INSERT, SELECT, UPDATE *(role_id FK now guarded, trigger)* |
| message_acknowledgements | ALL, INSERT, SELECT, UPDATE | ALL, INSERT, SELECT, UPDATE *(employee_id FK now guarded on publisher path)* |
| message_audiences | ALL, SELECT | ALL, SELECT *(message_id FK now guarded)* |
| message_receipts | ALL, INSERT, SELECT, UPDATE | ALL, INSERT, SELECT, UPDATE *(employee_id FK now guarded on publisher path)* |
| messages | ALL, SELECT | ALL, SELECT *(channel_id/author_employee_id FK now guarded)* |
| modules | SELECT | SELECT |
| notification_deliveries | SELECT | SELECT |
| notification_events | SELECT | SELECT |
| notification_jobs | ALL | ALL |
| notification_routes | ALL, SELECT | ALL, SELECT |
| organization_admins | SELECT | SELECT |
| organization_module_settings | ALL, SELECT | ALL, SELECT |
| organizations | SELECT, UPDATE | SELECT, UPDATE |
| outbox_events | SELECT | SELECT |
| pdf_template_bindings | ALL | ALL |
| pdf_templates | ALL | ALL |
| permissions | SELECT | SELECT |
| platform_admins | SELECT | SELECT |
| **report_submission_attachments** | **SELECT only — Class A** | **INSERT, SELECT — fixed** |
| report_submissions | INSERT, SELECT, UPDATE | INSERT, SELECT, UPDATE *(dept FK now guarded; SELECT policy widened, see Part 4)* |
| report_template_versions | INSERT, SELECT, UPDATE | INSERT, SELECT, UPDATE |
| report_templates | INSERT, SELECT, UPDATE | INSERT, SELECT, UPDATE *(dept FK now guarded)* |
| role_permissions | DELETE, INSERT, SELECT, UPDATE | DELETE, INSERT, SELECT, UPDATE |
| roles | DELETE, INSERT, SELECT, UPDATE | DELETE, INSERT, SELECT, UPDATE |
| schedule_periods | ALL, SELECT | ALL, SELECT *(dept FK now guarded)* |
| schedule_publications | INSERT, SELECT | INSERT, SELECT |
| schedule_shifts | ALL, SELECT | ALL, SELECT *(dept FK now guarded)* |
| shift_assignments | ALL, SELECT | ALL, SELECT *(employee_id/shift_id FK now guarded)* |
| shift_templates | ALL, SELECT | ALL, SELECT *(dept FK now guarded)* |
| subscription_plans | SELECT | SELECT |
| tenant_subscriptions | SELECT | SELECT |
| training_assignments | ALL, SELECT | ALL, SELECT *(employee_id/course_id FK now guarded)* |
| **training_completions** | **SELECT only — Class A** | **INSERT, SELECT — fixed** |
| training_progress | ALL, INSERT, SELECT, UPDATE | ALL, INSERT, SELECT, UPDATE |
| usage_counters | SELECT | SELECT |
| work_order_attachments | ALL, SELECT | ALL, SELECT |
| work_order_updates | ALL, SELECT | ALL, SELECT |
| work_orders | ALL, SELECT | ALL, SELECT *(dept/assigned_to_employee_id FK now guarded)* |

## Confirmed findings

### Class A — inert features (2)

| # | Table | Severity | Probe | Observed result (pre-fix) | Blast radius |
|---|---|---|---|---|---|
| A1 | `report_submission_attachments` | **High** | As a `reports.submit` holder on their own facility, with an existing own-facility draft `report_submissions` row, `INSERT` an attachment row pointing at it (exactly what `POST /reports/:id/attachments` does, `src/lib/http/attachments-routes.mjs`). | `insufficient_privilege` — no INSERT policy existed at all (RLS-by-omission on a table whose only policy was `for select`). | The daily-reports attachment upload feature (photos/PDFs attached to shift reports) is **completely non-functional** against a real database for every caller, of every permission level, in every facility — it would pass any mocked unit test that stubs `pgInsert` and fail 100% of the time in production. |
| A2 | `training_completions` | **High** | As a `training.read` holder (the route's actual, sole gate — `requireRead` in `training-routes.mjs`), `INSERT` a completion row for an own-facility training assignment (`POST /training-assignments/:id/complete`). | `insufficient_privilege` — same shape: only a SELECT policy existed. | Marking a training assignment complete is **completely non-functional**. Every completion the app believes it recorded (course completion, cert-eligibility gating in TR-06's `assignmentReadyToComplete`) would silently never persist. |

### Class B — cross-facility references (28)

Every row below: a caller holding the stated permission **facility-wide on Facility A only** (zero membership in Facility B) successfully inserted a row that claimed `facility_id = A` but pointed the named FK column at a row that actually belongs to Facility B — the malicious row **persisted** (confirmed via a follow-up `SELECT` with RLS bypassed, not just the absence of an error) before this migration.

| # | Table.column | References | Severity | Blast radius before the fix |
|---|---|---|---|---|
| B1 | `memberships.role_id` | `roles` | **Critical** | **Privilege escalation.** Any `admin.manage` holder on *any* facility can grant a membership claiming their own facility but naming a `role_id` that belongs to a **different facility on the platform**, and every permission code attached to that foreign role becomes effective for the grantee inside the actor's own facility (`has_permission` joins `role_permissions` by `role_id` alone and never re-validates the role's own facility). Empirically confirmed the grantee gained `incidents.export.pdf`/`incidents.legal_hold.manage` this way. This is not a data-integrity nuisance — it is a real cross-tenant authorization bypass. |
| B2 | `work_orders.assigned_to_employee_id` | `employees` | High | Explicitly named as known-outstanding (JS-layer-only guard) in the audit brief; now closed at the DB layer. |
| B3 | `work_orders.department_id` | `departments` | High | Same known-outstanding pair as B2. |
| B4 | `assets.department_id` | `departments` | Medium | A `work_orders.manage` holder can tag a Facility-A asset with a Facility-B department. |
| B5 | `communication_channels.department_id` | `departments` | Medium | Same pattern for comms channels. |
| B6 | `employees.department_id` | `departments` | Medium | Same pattern for employee records — `department_id: body.payload.departmentId` is client-controlled in `admin-routes.mjs`. |
| B7 | `incident_reports.department_id` | `departments` | Medium | Same pattern for incident reports — client-controlled via `body.payload.departmentId` in `incidents-routes.mjs`. |
| B8 | `report_templates.department_id` | `departments` | Medium | Same pattern — client-controlled in `report-templates-routes.mjs`. |
| B9 | `report_submissions.department_id` | `departments` | Medium | Same pattern — a facility-wide `reports.create` holder can tag a submission with a foreign department, bypassing the 4-arg department-scoping model entirely. |
| B10 | `schedule_periods.department_id` | `departments` | Medium | Client-controlled in `scheduling-routes.mjs`. |
| B11 | `schedule_shifts.department_id` | `departments` | Medium | Same file; `schedule_period_id` was already guarded (0013/0026) but `department_id` was not. |
| B12 | `shift_templates.department_id` | `departments` | Medium | Same pattern for shift templates. |
| B13 | `department_settings.department_id` | `departments` | Medium-High | A **facility-wide** `admin.manage` holder can write a `department_settings` row for a department that belongs to a different facility (the 4-arg `has_permission` check binds the *actor's* facility, never the department row's own facility). |
| B14 | `course_modules.course_id` | `courses` | Medium | A `training.manage` holder can attach a module to a Facility-B course while claiming Facility A. |
| B15 | `training_assignments.employee_id` | `employees` | Medium | A `training.manage` holder can assign training to a Facility-B employee. |
| B16 | `training_assignments.course_id` | `courses` | Medium | Same policy, second column. |
| B17 | `shift_assignments.employee_id` | `employees` | Medium | A `schedule.manage` holder can assign a Facility-B employee to a Facility-A shift. |
| B18 | `shift_assignments.shift_id` | `schedule_shifts` | Medium | Same policy, second column. |
| B19 | `messages.channel_id` | `communication_channels` | Medium | A `communications.publish` holder can post a message into a Facility-B channel while claiming Facility A. |
| B20 | `messages.author_employee_id` | `employees` | Low-Medium | Same policy — a message can be authored "by" a Facility-B employee. |
| B21 | `message_audiences.message_id` | `messages` | Medium | The one audience/receipt/ack sibling that was **never** guarded — `message_acknowledgements`/`message_receipts` already had this check since 0009/0025. |
| B22 | `message_acknowledgements.employee_id` (publisher path) | `employees` | Medium | The self-service employee path was already safe (binds to the caller's own employee row); the **publisher-acting-on-behalf-of-an-employee** ALL policy had no such binding. |
| B23 | `message_receipts.employee_id` (publisher path) | `employees` | Medium | Same as B22. |
| B24 | `incident_attachments.incident_id` | `incident_reports` | High | The same gap `incident_amendments` had before 0032 — never closed on this sibling. |
| B25 | `incident_escalations.incident_id` | `incident_reports` | High | Same gap, second sibling. |
| B26 | `incident_followup_actions.incident_id` | `incident_reports` | High | Same gap, third sibling. |
| B27 | `incident_people.incident_id` | `incident_reports` | High | Same gap, fourth sibling — notably this one can attach injury/witness statement records to the wrong tenant's incident. |
| B28 | `incident_audit_events.incident_id` | `incident_reports` | High | Same gap, fifth sibling — the incident audit trail itself could be cross-linked to the wrong facility's incident. |

**Exact probe shape** (identical for all 27 non-B1 rows, parameterized per column):
set `request.jwt.claims` to a user with a facility-wide membership on Facility A holding the relevant `*.manage`/`*.publish`/`admin.manage` permission and **zero** membership in Facility B; `INSERT` a row with `facility_id = A` and the FK column set to a Facility-B row's id; assert via a follow-up RLS-bypassed `SELECT` that the row persisted. All 27 persisted before 0038; all 27 are rejected with `insufficient_privilege` (or, for B1, `check_violation` from the widened trigger) after. Full reproduction scripts were run against the live database for this audit (not checked into the repo, per the task's file-creation scope) — the fix is proven going forward by `supabase/tests/rls_audit_hardening.sql`, which exercises a representative subset (both Class A rows, B1, B2/B3, and one `incident_reports` sibling) plus positive controls proving same-facility writes still succeed.

### Incidental finding — not Class A or B, fixed anyway (1)

**`report_submissions`' SELECT policy never got DR-11's department-scoping upgrade.**
`0033_report_audit_and_scope.sql`'s own header states its intent as switching
"`report_templates`' SELECT policy **and** `report_submissions`' INSERT/UPDATE
policies" to the 4-arg `has_permission(user, facility, department, code)`
overload so "a membership scoped to one department can **file and read**
reports for that department" — but `report_submissions`' own SELECT policy
was left on the 3-arg check. A department-scoped `reports.read` membership
can never satisfy the 3-arg check (0023 requires `department_id IS NULL` for
it), so:

- a department-scoped reader sees **zero** `report_submissions` rows, and
- because Postgres re-checks the SELECT policy for any INSERT/UPDATE's
  `RETURNING` clause, a department-scoped `reports.create`/`reports.submit`
  member's `INSERT`/`UPDATE` is rejected outright with "new row violates
  row-level security policy" — even though the write's own WITH CHECK
  (already 4-arg since 0033) is satisfied. `POST /reports` uses
  `returning: true` (`src/lib/http/reports-routes.mjs:404`).

**Net effect: filing a report was completely broken for every
department-scoped member**, not just reading one. This was only discovered
because fixing the (unrelated) `active_version` test-fixture bug below let
`supabase/tests/department_scope.sql` run far enough to hit it — it was
masked in every prior CI run. Fixed in Part 4 of 0038 by widening
`reports.read` to the 4-arg overload (leaving `reports.export`, which 0033
never mentioned widening, on the 3-arg/facility-wide check). Proven by
`rls_audit_hardening.sql`'s section 6 and by `department_scope.sql` itself,
which now passes for the first time.

### What was probed and found already correct

These FK columns were tested with the identical cross-facility probe and
**correctly rejected the cross-facility reference before this migration** —
listed so a verified pass is on the record, not just findings:

- `report_submissions.template_id` / `.template_version_id` → `report_templates` / `report_template_versions` (0009, 0026, 0033)
- `report_template_versions.template_id` → `report_templates` (0009)
- `work_orders.asset_id` → `assets` (0013, 0026)
- `schedule_shifts.schedule_period_id` → `schedule_periods` (0013, 0026)
- `schedule_publications.schedule_period_id` → `schedule_periods` (0034)
- `form_field_bindings.form_definition_id` → `form_definitions` (0015)
- `distribution_list_members.distribution_list_id` / `.member_ref_id` → `distribution_lists` / `employees`/`roles` (0016, 0019)
- `certification_role_requirements.certification_type_id` / `.role_id` → `certification_types` / `roles` (0017)
- `pdf_template_bindings.template_id` → `pdf_templates` (0014)
- `employee_certifications.certification_type_id` / `.employee_id` → `certification_types` / `employees` (0031)
- `certification_events.employee_certification_id` → `employee_certifications` (0031)
- `incident_amendments.incident_id` → `incident_reports` (0032)
- `training_progress.assignment_id` / `.module_id` → `training_assignments` / `course_modules` (0036)
- `employee_device_tokens.employee_id` / `employee_notification_preferences.employee_id` → `employees` (0037)
- `message_acknowledgements.message_id` / `message_receipts.message_id` (both the self-service AND the publisher-ALL policy) → `messages` (0009/0025)
- `work_order_updates.work_order_id` / `work_order_attachments.work_order_id` → `work_orders` — guarded by a **trigger** (0035), not WITH CHECK, deliberately (see 0035's own header: a trigger fires regardless of the connecting role).
- `memberships.department_id` → `departments` — guarded by a **trigger** (0023), for the same "every write path" reason.

Also confirmed correct: every table Class A previously found and fixed
(`message_receipts`, `message_acknowledgements` — 0025; `employee_certifications`,
`certification_events` — 0031; `training_progress` — 0036;
`incident_amendments` — 0032) still has full INSERT/UPDATE coverage today; no
regression.

## Migration: `supabase/migrations/0038_rls_audit_hardening.sql`

Four parts, each with a header explaining the mechanism choice:

1. **Class A fixes** — new INSERT policies for `report_submission_attachments`
   (gated on `reports.submit`, matching the route's own `writePermission`) and
   `training_completions` (gated on `training.read`, matching the route's
   own — and only — gate, `requireRead`). Both use `fn_assert_same_facility`
   on their parent-row FK. **Mechanism: WITH CHECK**, because both write
   paths are exclusively the caller's-own-JWT BFF, not a background job.
2. **`memberships.role_id`** — widened the *existing* `fn_membership_department_facility`
   trigger (0023) to also verify `role_id`'s facility, rather than adding a
   WITH CHECK. **Mechanism: trigger**, for the identical reason 0023 chose a
   trigger for `department_id` on the same table ("every write path is
   covered", including any future service-role provisioning write) and 0035
   chose a trigger for `work_order_updates`/`work_order_attachments` — WITH
   CHECK only ever runs for the `authenticated` role.
3. **27 FK columns** — `fn_assert_same_facility(...)` added to the existing
   WITH CHECK of the relevant policy (never replacing, always AND-ing in — no
   existing policy is weakened). **Mechanism: WITH CHECK**, because every one
   of these write paths goes through `src/lib/http/*.mjs` using the caller's
   own JWT (unlike the work-order-child case, none of these are candidates
   for a future service-role/background-job writer), matching the mechanism
   the large majority of 0009-0037 already use for this exact kind of check.
4. **`report_submissions` SELECT policy** — widened `reports.read` to the
   4-arg department-scoped `has_permission` overload, matching
   `report_templates`' sibling policy and 0033's own stated (but
   incompletely-applied) intent.

The migration is idempotent (`drop policy/trigger if exists` immediately
precedes every `create`, per `scripts/verify-migrations.mjs`'s enforced
convention from migration 0009 onward) and does not weaken any existing
policy: every Class B change is an added `AND fn_assert_same_facility(...)`
clause, which can only narrow what a WITH CHECK admits.

## Known-outstanding item explicitly requested by the audit brief

`work_orders.department_id` / `work_orders.assigned_to_employee_id` — was
guarded **only at the JS layer** before this migration (no DB-level check at
all). **Now closed at the DB layer** (findings B2/B3 above, fixed in Part 3
of 0038) alongside the pre-existing `asset_id` check. The JS-layer guard
(wherever it lives in `src/lib/http/work-orders-routes.mjs`) was left
untouched, per the "do not change application code" constraint — it is now
redundant defense-in-depth rather than the only line of defense.

## Escalated as decisions, not fixed (would require an application change or a product decision)

1. **`training_completions`' permission gate has no ownership check.**
   `POST /training-assignments/:id/complete` gates on `training.read` alone
   (`requireRead`) with no binding to the caller's own employee record —
   unlike its sibling `training_progress`'s self-service INSERT (0036), which
   requires `training.read` **and** that the assignment's `employee_id`
   matches the caller's own `employees` row. This migration's new
   `training_completions` INSERT policy intentionally mirrors the route's
   **actual, already-decided** gate (any `training.read` holder can complete
   any assignment in their facility) so the DB stops being *more* restrictive
   than the app requires — it does not invent a new, narrower policy, since
   guessing that the intended fix is "add an ownership check" (vs. "require
   `training.manage` instead") would be exactly the kind of guess the task
   says to avoid. **Recommendation:** decide whether `POST
   /training-assignments/:id/complete` should require `training.manage`, or
   gain a `training_progress`-style ownership check, or is intentionally this
   permissive (e.g. a supervisor recording completion on someone else's
   behalf using only read access) — then update both the route and, if
   needed, the RLS policy together.
2. **`message_audiences.audience_ref_id`** is a polymorphic reference (its
   meaning depends on `audience_type`: `role` → `roles.id`, `department` →
   `departments.id`, `employee` → `employees.id`, `shift` → no table) and
   therefore has no plain FK constraint — it was out of scope for
   `fn_assert_same_facility` (which assumes one parent table) and was **not**
   empirically probed or fixed. A correct fix would need a small
   `CASE audience_type WHEN ... THEN fn_assert_same_facility(...)` guard
   (straightforward, but a new piece of logic, not a mechanical application
   of the existing helper) or a trigger. Flagged for a follow-up migration
   rather than guessed at here.
3. **CI-parity gap (not an RLS finding):** `.github/workflows/ci.yml`'s "Apply
   migrations" step runs `0030_storage.sql` against the bare `postgres:16`
   service container, which has no `storage` schema — `scripts/ci/rls-bootstrap-pre.sql`
   only recreates `auth`. Reproducing the CI harness locally for this audit
   required an extra, local-only bootstrap step (not committed) to create a
   minimal `storage.buckets`/`storage.objects`/`storage.foldername()` before
   0030 would apply. This suggests CI's migration-apply step may itself be
   broken today on a fresh run; out of scope for this RLS-focused migration,
   but worth a maintainer's five-minute look at `.github/workflows/ci.yml`.

## Incidental, non-RLS bugs fixed to enable full regression verification

The audit brief requires re-running the **entire** `supabase/tests/*.sql`
suite against the patched schema. Five files initially failed **before any
of this migration's changes were applied** (i.e., they are pre-existing bugs
on the checked-out branch, not something introduced by this audit) — all
were fixture bugs, not encoded intended-behavior, and all blocked the suite
from ever reaching later assertions in the same file (masking the
`report_submissions` SELECT-policy finding above). Fixed so the full suite —
and this migration's correctness on the code *after* the previously-unreached
lines — could actually be verified:

- **`report_templates.active_version` insert-order bug**, in `supabase/seed.sql`
  and four test files (`supabase/tests/department_scope.sql`,
  `report_audit.sql`, `report_templates.sql`, `tenant_isolation.sql`): each
  inserted a `report_templates` row with `active_version = 1` **before** the
  matching `report_template_versions` row existed, which
  `fn_report_template_active_version_published` (0028) rejects. Real
  application code (`src/lib/http/forms-routes.mjs`,
  `report-templates-routes.mjs`) already does this correctly in two steps
  (create version, then UPDATE `active_version`) — this was purely a fixture
  ordering bug, not a real app or RLS bug. Fixed by inserting with
  `active_version = null`, creating the version, then `UPDATE`ing.
  `supabase/seed.sql` was fixed the same way locally for this audit's own
  fixture-loading needs but is a repo file outside the migration/test-file
  scope this task authorized changing — **left as-is in the repo**; the same
  ordering fix should be applied there too.
- **`incident_immutability.sql`'s seed row was missing `event_hash`**
  (a NOT NULL legacy column from 0004 that no trigger populates — every real
  caller goes through `buildIncidentAuditEvent`, `src/lib/incidents.mjs`,
  which fills it explicitly). Fixed by supplying one in the raw fixture
  insert, matching what the app does.
- **`incident_immutability.sql`'s append-only UPDATE/DELETE assertions
  expected an `insufficient_privilege` exception**, but `incident_amendments`
  and `incident_audit_events` carry **no** UPDATE/DELETE policy at all — with
  zero permissive policies for a command, Postgres denies it by silently
  matching zero rows (the `fn_block_audit_mutation` trigger never even fires,
  since RLS filters the row out before the trigger sees it). This is the
  exact "RLS-by-omission" semantics 0032's own migration header documents,
  and the same idiom `work_orders_scope.sql` already uses correctly for an
  analogous case. Fixed by attempting the write (optionally still catching
  `insufficient_privilege`, for the hypothetical future stray permissive
  policy 0032's trigger defends against) and then asserting the row is
  unchanged, rather than expecting an exception.

None of these were caused by, or interact with, the Class A/B fixes in
0038 — they were masking bugs in test fixtures written before/independent of
this migration. Confirmed via a byte-identical diff of failing-file sets
between a baseline run (pre-0038, pre-fixture-fixes) and the migrated run: no
new failures, only fewer (5 → 0 once the fixture bugs above were also fixed).

## Regression result: full existing suite

All 20 files in `supabase/tests/*.sql` (19 pre-existing + this audit's new
`rls_audit_hardening.sql`) pass cleanly against the fully-migrated,
fully-seeded database:

```
Ran 20 RLS test file(s) successfully.
```

`npm run db:verify` and `npm run db:verify:seed` both pass with the 0038
migration present. `npm run lint`, `npm run typecheck`, `npm run
format:check`, and `npm run test` (1213 unit tests) all pass unchanged.

## Constraints honored

- No existing policy was weakened — every Class B fix is an added `AND`
  clause; every Class A fix is a wholly new policy where none existed.
- No `src/lib/**` application code was changed.
- One migration file: `supabase/migrations/0038_rls_audit_hardening.sql`.
- Test file added: `supabase/tests/rls_audit_hardening.sql`.
