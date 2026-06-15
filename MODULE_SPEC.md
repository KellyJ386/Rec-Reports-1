# MODULE_SPEC.md — RecReports Functional Module Spec (Reconciled)

> **Subordinate to `CLAUDE.md`.** This is the single source the build plan means whenever a
> prompt cites **"Module Spec §x.y"**. It reconciles the original `*_DESIGN.md` docs into
> the build-plan vocabulary and the `CLAUDE.md` role model. Where this file and `CLAUDE.md`
> ever disagree, **`CLAUDE.md` wins** — flag the conflict.
>
> **Per-table conventions** (from `CLAUDE.md` §6; not repeated below): `id uuid default
> gen_random_uuid()`; non-null `facility_id references facility(id)` on every
> facility-scoped table; `created_at`/`updated_at`, and `created_by references
> user_account(id)` where a user authors the row; soft-delete columns where retention
> applies; UTC `timestamptz`; **RLS on every table** (read = facility membership; writes
> role-gated via `current_user_role_at(facility_id)`); catalog values come from admin
> config (§5), **never hardcoded** (`CLAUDE.md` §3.2). `facility_id` is **server-injected,
> never client-trusted** (`CLAUDE.md` §3.1). Workflow *states* may be enums; *catalog
> values* may not.
>
> **Roles** (`CLAUDE.md` §5): `super_admin` › `org_admin` › `facility_manager` ›
> `supervisor` › `staff`, each inheriting the tier below. "+" means that tier and above
> (e.g. `supervisor+`). **Staff see only records they authored; supervisor+ see
> facility-wide** (`CLAUDE.md` §5).

---

## §1 Overview & module map

| Stream | §  | Modules |
|--------|----|---------|
| Operations Core | §2 | Injury/Illness, Incident, Daily Log, EOD Report, Memo Board |
| Facility Management | §3 | Tasks, Utilization Counts, Forms & Inspections, SOPs, ERPs, Work Orders & Assets |
| Workforce | §4 | Scheduling (shifts/templates/availability/swaps/conflict engine/communication), Staff Certifications |
| Admin Control Center | §5 | Config framework, config CRUD, user management |
| Cross-cutting | §6 | Compliance Dashboard, Reporting & Export |
| Foundation | §7 | Tenancy & data model |

**Deferred cross-module links** (nullable/stubbed FKs during parallel streams; wired in
Phase 5): Incident → Task; EOD → Injury/Incident + Work Order; Asset inspection history ←
completed PM/Inspection form responses.

---

## §2 Operations Core

Report modules follow the `CLAUDE.md` §7 status machine `Draft → Submitted → Reviewed →
Closed`: Draft is author-editable and invisible to reviewers; Submitted locks the author
out and becomes visible to `supervisor+`; Reviewed = acknowledged; Closed = read-only
(reopen needs `facility_manager` override, audited). **Every** create/edit/state-change/
lock/export writes an immutable audit row (`CLAUDE.md` §8).

### §2.1 Injury / Illness Reports

Legally sensitive PII. **No photo/image documentation** (`CLAUDE.md` §3.3). PII (names,
contact, DOB) **encrypted at rest** (`CLAUDE.md` §8).

**Tables**
- `injury_report` — `incident_no` (unique per facility), `report_type`
  (`injury|illness`), `severity_level_id` (→ §5 config, **not** an enum), `occurred_at`,
  `reported_at`, `area_id` (→ §5 `area`), `summary`, `immediate_actions`, `status`
  (`draft|submitted|reviewed|closed`), `submitted_by`, `submitted_at`, `reviewed_by`,
  `reviewed_at`, `legal_hold boolean`.
- `report_person` *(polymorphic, reused by §2.2)* — `parent_id`, `parent_type`
  (`injury_report|incident_report`), `person_role` (`injured|involved|completing`),
  `full_name`, `contact` (jsonb, encrypted), `details` (jsonb). Stores its own
  `facility_id` (= parent's); **RLS resolves/validates `facility_id` via the parent**
  (`CLAUDE.md` §6).
- `report_witness` *(polymorphic, reused)* — `parent_id`, `parent_type`, `full_name`,
  `contact` (jsonb), `statement`.

**Sub-sections (form):** Person(s) Involved · Witnesses · Person Completing Report ·
incident detail · severity · immediate actions.

**Workflow/roles:** create/submit = `staff+`; on Submit the record **locks** against
author edits; review/close/lock + `legal_hold` = `supervisor+`. Corrections after submit
are append-only amendments (reason + actor + timestamp + before/after; `CLAUDE.md` §8).
Email alert on submit/review per §5 recipient groups.

**Acceptance:** polymorphic children RLS-isolated by facility; lock prevents author edits;
audit rows written on every transition.

### §2.2 Incident Reports

Reuses the §2.1 pattern (`report_person`/`report_witness`, status machine, locking,
audit). **No photos** (`CLAUDE.md` §3.3).

**Tables**
- `incident_report` — `incident_no`, `incident_category_id` (→ §5),
  `severity_level_id` (→ §5), `occurred_at`, `reported_at`, `area_id`, `summary`,
  `immediate_actions`, `status` (same machine as §2.1), **`follow_up_required boolean`**,
  **`follow_up_task_id uuid null`** (stubbed FK → `task`, wired Phase 5).

When `follow_up_required` is checked, Phase 5 creates a linked `task` via the
`createTask()` server action (§3.1). **Roles/acceptance:** as §2.1. Sonnet reviews RLS +
polymorphic reuse.

### §2.3 Daily Log

Running operational log; mobile-first, offline-capable (`CLAUDE.md` §8).

**Tables**
- `daily_log_entry` — `log_date`, `task_category_id`/`area_id` (→ §5 as applicable),
  `body`, `entry_at`. Tagging staff via `daily_log_entry_tag` (`daily_log_entry_id`,
  `user_id`) **notifies** tagged users. Optional non-PII attachments allowed. Filterable
  by date/category/area/tagged user.

**Roles:** create = `staff+` (author-visible per §5; tagged users and `supervisor+` see
facility-wide).

### §2.4 EOD (End-of-Day) Report

**One per day per facility.** Auto-locks at a **configurable cutoff** (§5 facility config).

**Tables**
- `eod_report` — `report_date` (unique per facility), fields per facility template,
  **`incidents_occurred boolean`**, **`equipment_issues boolean`**, `status`
  (`draft|submitted|locked`), `locked_at`. Stubbed FKs (wired Phase 5): links to that
  day's `injury_report`/`incident_report` (when `incidents_occurred`) and to `work_order`
  (when `equipment_issues`).

**Roles:** submit = `staff+`; cutoff/lock config = `facility_manager+`.

### §2.5 Memo Board

Broadcast messaging with recipient groups and read tracking.

**Tables**
- `memo` — `to_group_id` (→ §5 `recipient_group`), `from_user_id`, `subject`,
  `body_richtext`, `priority`, `optional_email boolean`, `posted_at`.
- `memo_receipt` — `memo_id`, `user_id`, `read_at` (unread badge = count of rows with
  `read_at is null` for the current user).

**Roles:** post = `supervisor+` (configurable); read = recipients. Optional email send via
Resend, logged.

---

## §3 Facility Management

### §3.1 Tasks

**Tables**
- `task` — `title`, `description`, `task_category_id` (→ §5), `priority` (→ §5 / ordered
  config), `assigned_to` (`user_id`), `due_at`, `recurrence`
  (`one_time|daily|weekly|custom` + rule), `status`
  (`open|in_progress|done|cancelled`), `completion_notes`, `completion_signature_path`,
  `source_type`/`source_ref_id` (e.g. `incident`). Reminders via Resend. Offline-capable.
- Expose a **`createTask()` server action** (Server Action per `CLAUDE.md` §2) so Incident
  follow-ups (§2.2) and other modules create linked tasks.

**Roles:** assign/manage = `supervisor+`; complete own assigned tasks = `staff+`.

### §3.2 Utilization Counts

Quick-entry attendance/usage counts; time-series.

**Tables**
- `utilization_count` — `count_area_id` (→ §5), `count_type_id` (→ §5), `counted_at`,
  `count_value int`. Daily/weekly/monthly summaries are aggregations, not stored
  dashboards (`CLAUDE.md` §12 — exports only).

**Roles:** record = `staff+`. Offline-capable (`CLAUDE.md` §8).

### §3.3 Forms & Inspections (dynamic form builder)

Most complex Facility-Mgmt module. Schema-driven; **server-side validation against the
form's own schema is mandatory** (client validation is UX only).

**Tables**
- `form` — `form_category_id` (→ §5), `name`, `schema_json` (fields + layout),
  `schedule` (`ad_hoc|daily|weekly|event`), `status` (`draft|published|archived`),
  `version_no`. Published versions immutable; each `form_response` pins a version.
- `form_response` — `form_id`, `form_version_no`, `answers_json`, `submitted_by`,
  `submitted_at`, `source` (`web|mobile|offline_sync`).

**Field types (all required):** text, textarea, number, yes/no, single-select,
multi-select, date, time, datetime, rating, section header, instructions,
signature/acknowledgment, file upload.

**PM/Inspection link:** completed PM/Inspection form responses feed `asset` inspection
history (§3.6, wired Phase 5).

**Roles:** build/publish = `facility_manager+` (or `supervisor+` per config);
respond = `staff+`. **Acceptance:** build a form, submit a response, **export CSV**; schema
validated server-side; RLS verified.

### §3.4 SOPs (Standard Operating Procedures)

**Tables**
- `sop` — `sop_category_id` (→ §5), `title`, `current_version_no`,
  `acknowledgment_required boolean`, `visibility_role` (min role to view; one of the §5
  role tiers), full-text searchable.
- `sop_version` — `sop_id`, `version_no`, `body_richtext`, `effective_at`,
  `change_summary`, `published_by`. Archived versions **retained** (never deleted).
- `sop_acknowledgment` — `sop_version_id`, `user_id`, `acknowledged_at`.

**Roles:** author/publish = `facility_manager+`; acknowledge = users in scope.

### §3.5 ERPs (Emergency Response Plans)

Always-accessible, read-only per facility.

**Tables**
- `erp` — `erp_scenario_type_id` (→ §5), `response_level` (→ §5), `title`, ordered
  `protocol_steps_json`, `evacuation_ref`, `aed_ref`.
- `erp_role_assignment` — `erp_id`, `role`/`user_id`, `responsibility`.
- `erp_emergency_contact` — `erp_id`, `name`, `phone`, `org`, `display_order`.

**Roles:** edit = `facility_manager+`; **read = all members (always available)**.

### §3.6 Work Orders & Assets

Sub-sections: **My Work Orders / Create / PM & Inspections**. **Photos allowed here** (the
one place — `CLAUDE.md` §3.3 forbids them only on injury/incident).

**Tables**
- `work_order` — `work_order_category_id` (→ §5), `priority` (→ §5), `asset_id null`,
  `title`, `description`, `status` (`open|assigned|in_progress|completed|closed`),
  `assigned_to` (`user_id`; **assignment is manager-only**), `due_at`.
- `work_order_photo` — `work_order_id`, `storage_path` (short-TTL signed-URL access),
  `checksum`.
- `asset` — `asset_type_id` (→ §5), `area_id` (→ §5), `name`, `asset_tag`,
  `pm_schedule_json` (preventive-maintenance cadence).
- `asset_inspection_history` — `asset_id`, `form_response_id` (→ §3.3), `performed_at`.
  **Auto-populated** from completed PM/Inspection form responses (wired Phase 5).

**Roles:** create = `staff+`; assign = `supervisor+`; close = `supervisor+`. Sonnet
reviews the asset ↔ work_order ↔ form relations + RLS.

---

## §4 Workforce

The differentiator (`CLAUDE.md` §1). Build **Certifications (§4.2) first** — the
scheduling conflict engine (§4.1.2) depends on cert data.

### §4.1 Employee Scheduling

Recreation-focused, intentionally simplified: **no payroll, no clock-in/out, no labor
forecasting** (`CLAUDE.md` §1, §12). `facility` is the tenant boundary; `org_admin`
context can span facilities.

#### §4.1.1 Shifts
- `shift` — `schedule_period_id`, `job_area_id` (→ §5; drives required certs), `area_id`
  null, `starts_at`, `ends_at`, `status` (`draft|open|assigned|published|cancelled`),
  `source` (`template|manual`), `notes`. **Open (unassigned) shifts are visually
  distinct** in the UI.
- `shift_assignment` — `shift_id`, `user_id`, `assignment_type` (`primary|cover`),
  `status` (`pending|approved|declined|cancelled`), `assigned_by`.
- `schedule_period` — `week_start_date`, `week_end_date`, `status`
  (`draft|published|locked`), `publish_version`.

**Publish workflow:** `Draft → Published → Locked`. **Publish is gated by the conflict
engine** (§4.1.2): a schedule with **any Block** conflict cannot move Draft→Published.
Scheduling publish requires connectivity (`CLAUDE.md` §8).

#### §4.1.2 Conflict detection engine *(logic-critical — Sonnet, do not delegate)*

Evaluate **every assignment in real time**, resolving to **Allow / Warn / Block**:

| Rule | Outcome |
|------|---------|
| Double-booking (overlapping shifts) | **Block** |
| Back-to-back across facilities | Warn |
| Max hours/day | Warn (configurable → Block) |
| Max hours/week | Warn (configurable → Block) |
| Doubles not allowed | **Block** |
| Outside availability window | Warn |
| Availability closed (unavailable) | **Block** |
| Missing required cert | Warn |
| Expired required cert | **Block** |
| Cert expiring before shift | Warn (configurable → Block) |
| Understaffed template | Warn |
| Open (unassigned) shift | Warn |

- **Cert check three-hop join:** `shift.job_area_id → job_area_required_cert → cert_type`,
  cross-referenced with `staff_certification` for the assigned user.
- **Publish gate:** return **all** blocking conflicts with deep links; Draft→Published is
  blocked while any exist. Warn conflicts are listed and **acknowledgeable with one
  confirmation** (logged).
- **Surface conflicts with text/icon labels, not color alone** (`CLAUDE.md` §4).
- **Acceptance:** unit tests for **each rule** + the publish gate.

#### §4.1.3 Shift templates
- `shift_template` — `job_area_id`, `area_id` null, `days_of_week int[]`,
  `start_time_local`, `end_time_local`, `recurrence_rule`, `required_count`, `active`.
  Generates a week of `shift` rows. **Acceptance:** templates generate a week.

#### §4.1.4 Availability *(self-scoped)*
- `availability` — `user_id`, per-day status (available/unavailable window),
  `max_hours_per_day`, `max_hours_per_week`, `doubles_allowed boolean`,
  `effective_from`/`effective_to`. Staff edit/submit own; `supervisor+` read all.

#### §4.1.5 Swap requests
- `swap_request` — `offered_assignment_id`, `requested_assignment_id null`,
  `requester_user_id`, `target_user_id null`, `swap_type` (`direct|drop_pickup`),
  `status` (`pending|approved|denied|cancelled|expired`), `reason`. Approval =
  `supervisor+`; re-validates conflicts (§4.1.2) before commit; denial reason required.

#### §4.1.6 Schedule communication
- Send schedule by **date range**, per-employee **email toggle**, **delivery log**.
- `schedule_delivery` — `schedule_period_id`, `recipient_user_id`, `channel`
  (`email|in_app`), `status` (`queued|sent|failed`), `provider_message_id`, `sent_at`.
  **Acceptance:** schedule messages send and log.

**Staff self-service UI:** My Schedule, Pick Up Open Shifts, Request Swap, Availability
editor. Mobile-first; offline drafts for manager edits. **Printable weekly PDF** (§6).

### §4.2 Staff Certifications Tracker

Build **before** the scheduling conflict engine.

**Tables**
- `cert_type` — from admin config (§5): `name`, `validity_days`, `renewal_window_days`.
- `staff_certification` — `user_id`, `cert_type_id`, `issued_on`, `expires_on`,
  `document_url` (Supabase Storage, short-TTL signed URL), **auto status** computed from
  `expires_on`: `active` / `expiring` / `expired`. Cert history retained indefinitely
  (`CLAUDE.md` §8).
- `job_area_required_cert` — `job_area_id`, `cert_type_id` (the three-hop join target for
  §4.1.2).

**Expiry alert engine:** Resend notifications at **60 / 30 / 7 days** before expiry. Staff
see/upload **own** certs (self-scoped RLS); `supervisor+` manage all; expiring certs
surface in a manager view. **Acceptance:** status auto-computes from `expires_on`;
expiring certs surface to managers; RLS verified.

---

## §5 Admin Control Center *(accessible to `facility_manager+`)*

### §5.1 Config framework & schema

All config tables are facility-scoped, RLS-protected, support active/inactive toggle and
display ordering where noted, and ship defaults via **seed/migration** (not app code —
`CLAUDE.md` §3.2). Disabling a used value preserves history (never hard-delete a value
that has been referenced).

**Config catalog tables (one row-type each):**
`area` (location) · `severity_level` (per module) · `incident_category` ·
`task_category` · `count_type` · `count_area` · `form_category` · `sop_category` ·
`erp_scenario_type` · `work_order_category` · `asset_type` · `job_area` ·
`position_type` · `cert_type` · `job_area_required_cert` · `recipient_group`.

**Facility configuration:** the `facility` row holds `name`, `facility_type`
(`campus_rec|aquatic|fitness|parks_rec|ymca|multi_sport|other`), operating hours, logo,
`time_zone`, and module cutoffs (e.g. EOD auto-lock time, conflict-engine Warn→Block
toggles).

**Seed defaults (illustrative — refine in seed files):**
- `severity_level`: Low, Medium, High, Critical (ordered).
- `incident_category`: Slip/Fall, Equipment, Behavioral, Security, Facility, Other.
- `area`: Front Desk, Pool, Gym Floor, Locker Room, Field, Office, Other.
- `cert_type`: CPR/AED (validity 730d), First Aid (730d), Lifeguard (365d).
- `job_area`: Lifeguard, Front Desk, Fitness Floor, Maintenance, Supervisor.
- `task_category`, `work_order_category`, `count_type`, etc.: sensible starter sets.

**Acceptance:** a fresh facility boots with working defaults; all values editable; RLS
verified.

### §5.2 Config CRUD screens

- Under `/app/(admin)`: list / create / edit / **reorder** / **disable** for every §5.1
  table, **grouped by module**.
- **One reusable config-list component** parameterized per table. Mobile-first,
  keyboard-accessible, brand tokens (`CLAUDE.md` §4).
- Reordering and active/inactive toggles where the spec calls for them.
- Sonnet RLS review before done.

### §5.3 User Management *(security-critical — role assignment = privilege grant)*

- Invite staff by email (Resend), assign role, grant **multi-facility access** via
  `facility_membership` (one row per facility), deactivate/archive (**soft-delete, records
  preserved**), SSO toggle (SAML placeholder).
- **Only `facility_manager+` can assign roles.** A manager **cannot grant a role above
  their own tier** (e.g. `facility_manager` cannot mint `org_admin`/`super_admin`).
  **Every role change is audited** (`CLAUDE.md` §8).
- **Acceptance:** role-gate enforced; manager cannot escalate; archive preserves history.

---

## §6 Compliance Dashboard & Reporting

### §6.1 Compliance Dashboard *(manager-scoped, `supervisor+`)*
Aggregate per-facility view, cross-module, RLS-safe: **open incidents**, **overdue
tasks**, **cert expirations**, **unfilled/open shifts**. Color **and** label, never color
alone (`CLAUDE.md` §4). Reads are scoped to facilities the user belongs to.

### §6.2 Reporting & Export
- **CSV** for all tabular reports; **PDF** for filed reports (injury/incident summaries)
  and the **postable weekly schedule**.
- Filters: date / type / severity per module. **No BI dashboards — exports only**
  (`CLAUDE.md` §12).
- PDF includes facility/date metadata and an "Amended" marker when amendments exist
  (`CLAUDE.md` §8).

---

## §7 Tenancy & Data Model

Tenancy chain (`CLAUDE.md` §6): `organization → facility → everything`. Facility-scoped
tables carry `facility_id`; org-scoped tables carry `org_id`.

### §7.1 Core entities (foundation — Phase 0.2)

| Entity | Key fields | Notes |
|--------|------------|-------|
| `organization` | `name`, `status`, `plan_tier` | Parent of facilities; org-scoped tables carry `org_id` |
| `facility` | `org_id`, `name`, `facility_type`, `time_zone`, operating hours, logo, `status` | **Tenant boundary** |
| `user_account` | `id` = `auth.users.id`, `email`, `phone`, `display_name`, `status` | Identity mirror |
| `facility_membership` | `facility_id`, `user_id` (→ `user_account.id`), `role` (5-tier, `CLAUDE.md` §5), `status` (`active|inactive|archived`) | User ↔ facility ↔ role; multi-facility via multiple rows |
| `job_area` | config (§5) | Drives required certs |
| `job_area_required_cert` | `job_area_id`, `cert_type_id` | Three-hop join for conflict engine §4.1.2 |
| `cert_type` | config (§5) | `validity_days`, `renewal_window_days` |

- **Role resolution:** facility roles (`facility_manager`/`supervisor`/`staff`) come from a
  `facility_membership` row at that facility. `org_admin` granted at the org reaches every
  facility in the org. `super_admin` is platform-level (cross-org, not a customer role).
  The single helper **`current_user_role_at(facility_id)`** (`CLAUDE.md` §6) folds these
  into one effective role; all role gates derive from it. No separate
  permission-catalog tables.
- RLS on **every** table (`CLAUDE.md` §6). `SECURITY DEFINER` only where justified with a
  comment (`CLAUDE.md` §3.6) — e.g. a membership-resolving helper that must avoid RLS
  recursion.
- **Acceptance (Phase 0.2):** cross-facility reads/writes blocked by tests; role gates
  hold (no escalation); a logged-in user resolves to exactly their `facility_membership`
  rows.

---

## §8 Build order & gating (pointer)

Execution sequence, agent assignments, and concurrency gates live in `BUILD_PLAN.md`.
Summary: **Phase 0** foundation → **Phase 1** admin config (must precede modules) →
**Streams A/B/C** concurrent (Workforce / Operations / Facility) → **Phase 5**
integration + dashboard + reporting → **Phase 6** security & NFR audit.
</content>
