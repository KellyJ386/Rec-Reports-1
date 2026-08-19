# Training & Certifications Module — Development Plan

## 1. Current state

- **Schema**: `supabase/migrations/0007_training.sql` defines `courses`, `course_modules`, `training_assignments`, `training_progress`, `training_completions`, `certification_events`, all with `facility_id` scoping, RLS enabled, and `training.read`/`training.manage` policies. `employee_certifications` and `certification_types` (issued_at/expires_at/evidence_path/status) live in `supabase/migrations/0003_scheduling.sql`, extended by `0007` (validity_days, grace_days, auto_suspend_roles) and hardened in `0009_rls_hardening.sql`.
- **Admin cert policy layer** (`supabase/migrations/0017_cert_policy.sql`, `src/lib/admin/cert-policy.mjs`, `src/lib/http/cert-policy-routes.mjs`) adds `certification_role_requirements` and `certification_policies`, a 402-gated `cert_policies` entitlement, and a `/facilities/:id/cert-gaps?roleId=` report — fully implemented, tested, and wired into `src/public/admin/js/pages/certifications.js`.
- **Domain lib** `src/lib/training.mjs` is three pure functions only: `certificationStatus`, `trainingAssignmentState`, `certificationBlocksSchedule`. Well tested but `trainingAssignmentState` is imported into `src/lib/http/training-routes.mjs` and never called — assignment progress state is not surfaced by any route today.
- **End-user routes** `src/lib/http/training-routes.mjs`: `GET /facilities/:id/courses` (published-only by default), `GET /facilities/:id/training-assignments` (facility-wide list, no employee filter), `POST /facilities/:id/training-assignments` (manual assignment only — `sourceType` accepted but nothing ever sets `role_rule`/`incident_rule`/`certification_rule`), `POST /training-assignments/:id/complete` (inserts a `training_completions` row directly — no `training_progress` per-module tracking, no quiz/module gating). Covered by `test/training-routes.test.mjs` (9 cases).
- **UI**: one panel in `src/public/index.html`; `loadTraining()` in `src/public/js/app.js` fetches the facility-wide assignment list, renders the first 5 as cards with due date + "Mark complete" button. No course browsing, no module/quiz player, no certification wallet, no evidence upload UI, no employee-scoped "My Queue".
- **Scheduling integration exists one-way**: `src/lib/http/scheduling-routes.mjs` loads certs and calls `summarizeScheduleReadiness` to flag `missingCertifications` at publish time — the only cross-module consumer of certification data today.
- **No file/storage plumbing anywhere in the module.** `employee_certifications.evidence_path` and `certification_events.event_type='evidence_uploaded'` exist in schema, but there is no route to write them and no UI to pick a file. The only precedent is metadata-only attachment rows plus a path-shape validator in `src/lib/admin/branding.mjs` (`LOGO_PATH_RE`).
- **No quizzes, no video/PDF module player, no retraining automation, no incident→training auto-assignment** (despite `incident_followup_actions.action_type` already including `'training'`), **no cert-expiry notification jobs** (the generic notification engine exists but nothing emits `cert.expiring`/`cert.expired` events into it).

## 2. Gap analysis

| Capability (design doc) | Implemented today | Gap |
|---|---|---|
| Courses / modules (video, pdf, sop_link, quiz, checklist) | Tables + `GET /courses` route; module `content_jsonb` schema-free | No course/module admin CRUD (Training Studio), no content authoring UI, no per-module-type rendering, no `quizzes` table |
| Assignments (manual, role_rule, incident_rule, certification_rule) | Manual only; unique constraint on `(employee_id, course_id, source_type, source_ref_id)` | No role-based, certification-rule, or incident-rule auto-assignment; no bulk/role-targeted assignment UI |
| Progress tracking (per-module state/attempts/score) | `training_progress` table + RLS exist | No route reads/writes `training_progress`; `trainingAssignmentState()` never called; no course-player progress persistence |
| Completions | `training_completions` insert on `/complete` | No validation that required modules/quizzes passed before completion; status is caller-supplied, not derived |
| Certification events (created/renewed/expired/revoked/evidence_uploaded) | Table + read-only RLS policy | **No writer anywhere inserts into this table** |
| Expiry tracking (status lifecycle, dashboards) | `certificationStatus()` pure fn; consumed by cert-gaps report and scheduling publish check | No scheduled evaluator writing events/updating status; no "expiring in 30/14/7" dashboard; no employee-facing wallet |
| Evidence uploads | `evidence_path` column exists | No upload route, no storage bucket/RLS policy, no UI, no checksum capture |
| Quizzes / passing thresholds (Phase 2) | Nothing | No `quizzes` table, no attempt tracking beyond unused columns, no pass-score enforcement |

## 3. Phased task list

### Phase M1 — MVP-complete (roadmap "Training MVP-light": manual assignment, completion tracking, cert records with expiry + evidence upload)

**TR-01 — Employee-scoped training assignment queries** — *M*
`?employeeId=` filter on the facility list + `GET /me/training-assignments` ("My Queue") resolving the caller's `employees.user_id` row, each assignment including a derived `state` from `trainingAssignmentState()`.
- Files: `src/lib/http/training-routes.mjs`, `src/lib/http/me-route.mjs`, `src/public/js/app.js`.
- Acceptance: reader without `training.manage` can list only their own assignments via `/me/...`; facility-wide list still requires `training.read`; every assignment includes `state`.
- Tests: route unit tests (403 non-member, filter correctness, state derivation).

**TR-02 — Certification wallet read endpoint + UI** — *M*
`GET /facilities/:id/employee-certifications?employeeId=` (or `/me/certifications`) returning cert type name, status via `certificationStatus`, expiry date, evidence path; "Certification wallet" section with active/expiring/expired/revoked badges.
- Files: `src/lib/http/training-routes.mjs` (or new `certifications-routes.mjs`), `src/public/index.html`, `src/public/js/app.js`.

**TR-03 — Evidence upload plumbing (storage bucket + record route)** — *M*
Supabase Storage bucket (e.g. `certification-evidence`) with facility-scoped storage RLS; `POST /employee-certifications/:id/evidence` accepting `{storagePath, checksumSha256}` (bytes uploaded client-side to the signed URL), validating path shape, updating `evidence_path`, inserting a `certification_events` row with `event_type='evidence_uploaded'`.
- Files: new storage migration, new `src/lib/admin/cert-evidence.mjs` (pure validators/event builders), routes.
- Acceptance: malformed path 400s before any write; non-`training.manage` caller 403s; storage RLS denies cross-facility object reads.
- Tests: unit tests for validator/event-builder; route tests; RLS SQL test for cross-facility denial. **Coordinate with the platform storage primitive — reuse `src/lib/storage.mjs` rather than building a parallel client.**

**TR-04 — Certification lifecycle event writer (created/renewed/revoked)** — *M*
On `employee_certifications` insert/update, write the corresponding `certification_events` row (`created`/`renewed`/`revoked`) with a `payload_jsonb` snapshot; requires a manage route for `employee_certifications` if none exists.
- Tests: unit tests for event-type derivation (pure fn) + route tests confirming the extra insert.

**TR-05 — Course/module admin CRUD (Training Studio, minimal)** — *M*
`POST/PATCH /facilities/:id/courses`, `POST/PATCH /facilities/:id/courses/:id/modules` gated by `training.manage`, matching the validate → guard → insert/update pattern from `cert-policy-routes.mjs`. Module content stays `content_jsonb` free-form for M1 (URL/text only).
- Files: routes, new `src/lib/admin/training.mjs` (validators), new `src/public/admin/js/pages/training.js` (mirroring `certifications.js`), admin router registration.
- Acceptance: draft courses invisible to `GET /courses` default until status flips; `order_no` uniqueness constraint error surfaced cleanly.

**TR-06 — Progress-aware completion** — *L*
`POST /training-assignments/:id/modules/:moduleId/progress` upserts a progress row (`state`, `started_at`, `completed_at`, `score_pct`, `attempts`); `/complete` only allows `passed` when all `required=true` modules have `training_progress.state='completed'` (new pure helper `assignmentReadyToComplete(modules, progressRows)`).
- Acceptance: completing with incomplete required modules 400s with a clear error.

### Phase M2 — design-complete (LMS + certification + integration gaps)

**TR-07 — Quizzes table + pass-threshold enforcement** — *L*
New `quizzes(id, module_id, pass_score_pct, max_attempts, question_pool_jsonb)` (RLS mirrors `course_modules`); attempt submission route computes score, writes `training_progress`, rejects completion until `score_pct >= pass_score_pct` within `max_attempts`.
- Acceptance: attempt beyond `max_attempts` 409s; below threshold leaves `state='failed'`. Add `quizzes` to `verify-migrations.mjs` `requiredRlsTables`; RLS SQL test for facility scoping through the module→course chain.

**TR-08 — Video/PDF module content + course player UI** — *L*
Extend `content_jsonb` contract for `video`/`pdf` types (file reference via the TR-03 storage pattern); resume-where-left-off course player using `training_progress.started_at`/`completed_at`; per-type content validators.

**TR-09 — Certification-rule and role-rule auto-assignment** — *L*
When a `certification_role_requirements` row creates a gap (via `certGaps`), or a role is added, auto-create `training_assignments` with `source_type='certification_rule'`/`'role_rule'`. Batch sync script (`scripts/sync-training-assignments.mjs`) + pure `assignmentsForGaps(gaps, courseByCertType)`.
- Acceptance: exactly one assignment per employee/requirement pair, idempotent via the existing unique constraint; re-running does not duplicate.

**TR-10 — Incident-triggered corrective training** — *M*
When an `incident_followup_actions` row is created with `action_type='training'`, auto-insert a `training_assignments` row with `source_type='incident_rule'`, `source_ref_id=<followup id>`.
- Acceptance: visible via `GET /training-assignments?sourceType=incident_rule`; cross-module RBAC decided and tested explicitly (dual permission vs documented server-side elevation). Coordinate with incidents plan task IN-17.

**TR-11 — Certification expiry evaluator + notification wiring** — *L*
Scheduled evaluator script scanning `employee_certifications`, computing status via `certificationStatus`, writing `certification_events` (`expired`) on transitions and enqueuing `notification_jobs` (via `buildNotificationJob`) for `cert.expiring_soon`/`cert.expired` — new `event_code`s registered in `notification_events`.
- Acceptance: exactly one event + one job per transition; idempotent re-runs produce nothing.

**TR-12 — Scheduling qualification-gate hardening** — *M*
Extend `summarizeScheduleReadiness` to distinguish `expiring` certs (soft warning) from `missing`/`expired` (hard block), matching `certGaps`'s three-way status split, consuming `certificationStatus`/`certGaps` rather than re-deriving expiry logic. Coordinate with scheduling plan tasks SC-06/SC-19.

### Phase M3 — polish / automation

**TR-13 — Retraining policies + recurrence** — *L* — `retraining_policies` table (fixed_interval, incident, sop_revision, failed_quiz triggers) + evaluator auto-creating recurring assignments.

**TR-14 — Compliance dashboards** — *M* — Admin analytics aggregating certs/assignments by department/role/expiry bucket (30/14/7), building on the `cert-gaps` report and `export.mjs` patterns.

**TR-15 — Suspension workflow (auto_suspend_roles)** — *M* — When a cert with `auto_suspend_roles=true` expires past `grace_days`, flip employee eligibility (integrates with the TR-12 scheduling gate) and emit an escalation event.

**TR-16 — Audit trail polish + immutable event export** — *S* — Every write path touching `certification_events`/`training_completions` feeds the audit chain (0013) and is exportable via `admin/export.mjs`.

## 4. Dependencies

- **Admin cert-policy**: TR-04, TR-09, TR-11, TR-12 all extend or reuse `certGaps`/`effectiveEnforcementMode`/`certificationStatus`. Any change to `certificationStatus`'s signature must stay backward-compatible with `cert-policy.mjs`'s `normalizeCert` adapter.
- **Scheduling**: consumes `employee_certifications` for publish-time gates; TR-12 is a two-way dependency — keep the "required codes per shift" interface stable so the source can widen without route changes.
- **Incidents**: TR-10 depends on an incident followup-action creation route existing (incidents plan IN-05); the `action_type='training'` check constraint is already in 0004, so schema is ready but the JS-side link is net-new.
- **Storage/evidence**: TR-03 has no existing bucket/policy precedent — this is new infrastructure and should reuse the platform storage primitive (`src/lib/storage.mjs`) once it lands; TR-08 (video/PDF content) reuses the same pattern.
- **Notifications**: TR-11 is purely a producer into the existing engine — needs new `event_code`s (`cert.expiring_soon`, `cert.expired`, `training.due_soon`) seeded in `notification_events`; delivery depends on the platform worker.
- **Entitlements**: decide whether TR-05 (Training Studio) and TR-13 (retraining) sit behind a `training_studio`/`retraining_automation` entitlement for packaging alignment with the roadmap's "Ops Plus" tier.

## 5. Suggested agent/model assignment per task

| Task | Model | Rationale |
|---|---|---|
| TR-01 (employee-scoped queries) | Sonnet | Auth/RLS-adjacent filtering, facility scoping |
| TR-02 (cert wallet endpoint/UI) | Haiku, Sonnet review | Pattern-copy from `cert-gaps`/existing list routes |
| TR-03 (evidence upload + storage RLS) | Sonnet, **Opus review** | New storage RLS policy design is security-sensitive |
| TR-04 (lifecycle event writer) | Sonnet | Event-type derivation + write-path correctness |
| TR-05 (course/module admin CRUD) | Haiku | Mirrors `cert-policy-routes.mjs`/`certifications.js` almost 1:1 |
| TR-06 (progress-aware completion) | Sonnet | Gating logic with judgment calls on error semantics |
| TR-07 (quizzes) | Sonnet | New table + RLS + scoring judgment |
| TR-08 (video/PDF player) | Haiku (UI) / Sonnet (content validators) | Split: mechanical UI, judgment-heavy validation |
| TR-09 (cert-rule auto-assignment) | Sonnet, **Opus review** | Cross-cutting idempotency and duplicate prevention |
| TR-10 (incident-triggered training) | Sonnet | Cross-module RBAC decision |
| TR-11 (expiry evaluator + notifications) | Sonnet, **Opus review** | Idempotent transition detection is easy to get subtly wrong |
| TR-12 (scheduling gate hardening) | Sonnet | Touches shared enforcement semantics |
| TR-13 (retraining policies) | Sonnet | New recurrence/trigger domain modeling |
| TR-14 (dashboards) | Haiku | Pattern-copy from existing analytics/export surfaces |
| TR-15 (suspension workflow) | Sonnet, **Opus review** | Employee-eligibility side effects are compliance-sensitive |
| TR-16 (audit trail polish) | Haiku | Mechanical wiring into existing audit chain |
| **Integration review across all phases** | Opus/orchestrator | Cross-module consistency (scheduling ↔ training ↔ incidents ↔ notifications), RLS security review before each migration ships, `requiredRlsTables` sync |

### Critical files
- `src/lib/training.mjs`, `src/lib/http/training-routes.mjs`, `src/lib/admin/cert-policy.mjs`, `src/lib/http/cert-policy-routes.mjs`, `supabase/migrations/0007_training.sql`, `scripts/verify-migrations.mjs`, `src/public/js/app.js`
