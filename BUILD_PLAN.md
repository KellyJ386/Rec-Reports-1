# BUILD_PLAN.md — RecReports Build Plan & Agent Prompts

> **Subordinate to `CLAUDE.md`.** This is the execution/orchestration plan only. It never
> overrides `CLAUDE.md` (constitution) or `MODULE_SPEC.md` (functional spec) on naming,
> security, schema, or non-functional requirements. Every agent reads `CLAUDE.md` first
> and obeys it over any prompt below. "Module Spec §x.y" citations refer to
> `MODULE_SPEC.md`.

**Strategy:** sequential foundation → admin-first config layer → three concurrent module
streams → sequential integration & security pass.

**Delegation:** Haiku for mechanical CRUD, Sonnet for security/stateful logic. Every Haiku
build that touches tenant data gets a Sonnet RLS review.

**Prerequisite:** every agent reads `CLAUDE.md` before any task and obeys it over the prompt.

## Execution map

```
PHASE 0  Foundation (SEQUENTIAL — Sonnet)          ── must finish before anything else
PHASE 1  Admin Control Center (SEQUENTIAL — Sonnet+Haiku)  ── must finish before modules
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   STREAM A              STREAM B              STREAM C        ── RUN CONCURRENTLY
   Workforce            Operations Core       Facility Mgmt
   (Agent 1)            (Agent 2)             (Agent 3)
        └─────────────────────┼─────────────────────┘
                              ▼
PHASE 5  Integration + Compliance Dashboard + Reporting (SEQUENTIAL — Sonnet)
PHASE 6  Security & NFR audit (SEQUENTIAL — Sonnet)
```

## Gating rules

- Phase 1 cannot start until Phase 0's tenancy + RLS helpers exist.
- Streams A/B/C cannot start until Phase 1 seeds the config tables they read (job areas,
  cert types, categories, areas, severity levels).
- Phase 5 cannot start until all three streams report done.
- Within a stream, items are listed in dependency order.

---

## PHASE 0 — Foundation (Sonnet, sequential)

### Prompt 0.1 — Repo & infrastructure
Provision a new RecReports project from scratch per `CLAUDE.md`.
- Initialize Next.js 15 (App Router, TypeScript strict, Tailwind). Configure brand tokens:
  Forest Green #1B4332, Amber #D97706, Navy #1E3A5F.
- Create a new Supabase project. Wire server + browser Supabase clients in `/lib/supabase`
  with generated types.
- Set up Resend (`noreply@send.recreports.com`), Stripe (annual billing placeholder),
  Vercel deploy config.
- Establish `/db/migrations` (timestamp-named) and `/db/seed`.
- Folder structure exactly as `CLAUDE.md` §10.

**Deliverable:** a deploying skeleton app with auth-ready Supabase wiring. No modules yet.
**Acceptance:** app builds, deploys to Vercel, connects to Supabase, types generate.

### Prompt 0.2 — Tenancy schema & RLS foundation
Implement the core tenancy + identity entities per `CLAUDE.md` §6 and the Module Spec §7.1:
`organization`, `facility`, `user_account`, `facility_membership` (user↔facility↔role),
`job_area`, `job_area_required_cert`, `cert_type`.
- `facility_id`/`org_id` FKs as specified. UTC `timestamptz`, uuid PKs, `created_by` where
  authored.
- Write the SQL helper `current_user_role_at(facility_id)` and the standard read/write RLS
  policies from `CLAUDE.md` §6.
- RLS on EVERY table. SECURITY INVOKER by default; justify any DEFINER in a comment.
- Implement the 5-tier role hierarchy enforcement.

Security-critical: do not delegate to Haiku. Self-review RLS for privilege escalation (a
staff user must not read another facility's rows, and must not elevate role).
**Acceptance:** write tests proving cross-facility reads are blocked and role gates hold.

### Prompt 0.3 — Auth, session & offline shell
Implement Supabase Auth flows (email + SSO/SAML placeholder), session-based `facility_id`
injection (server-side only — never from client), and the role helpers in `/lib/auth`.
Set up the Dexie offline shell in `/lib/offline`: schema + a generic sync queue with a
visible sync-status indicator and the conflict-flag pattern from `CLAUDE.md` §8
(last-write-wins + manager-surfaced flag, never silent overwrite).
**Acceptance:** a logged-in user resolves to exactly their `facility_membership` rows;
offline queue persists and replays on reconnect.

---

## PHASE 1 — Admin Control Center (Sonnet for framework, Haiku for screens)

Admin-first: this is the config spine. Modules read everything from here.

### Prompt 1.1 — Config framework & schema (Sonnet)
Build the Admin Control Center foundation (Module Spec §5; accessible to
`facility_manager+`). Create the config tables that all modules depend on, each
facility-scoped with RLS:
- `area`, `severity_level` (per module), `incident_category`, `task_category`,
  `count_type`, `count_area`, `form_category`, `sop_category`, `erp_scenario_type`,
  `work_order_category`, `asset_type`, `job_area`, `position_type`, `cert_type`,
  `job_area_required_cert`, `recipient_group`.
- Facility configuration: name, `facility_type`
  (`campus_rec/aquatic/fitness/parks_rec/ymca/multi_sport/other`), operating hours, logo,
  `time_zone`.

Seed every config table with the sensible defaults from the Module Spec (NOT hardcoded in
app code — seed/migration only). Severity, categories, cert types, job areas etc.
**Acceptance:** a fresh facility boots with working defaults; all values editable; RLS verified.

### Prompt 1.2 — Config CRUD screens (Haiku → Sonnet RLS review)
Build the Admin Control Center UI under `/app/(admin)`: list/create/edit/reorder/disable for
every config table from 1.1, grouped by module per Module Spec §5.2. Mobile-first,
keyboard-accessible, brand tokens.
Pattern: one reusable config-list component parameterized per table. Reordering and
active/inactive toggles where the spec calls for them.
Hand off to Sonnet for an RLS review before marking done.

### Prompt 1.3 — User management (Sonnet)
Build User Management (Module Spec §5.3): invite staff by email, assign role, grant
multi-facility access via `facility_membership`, deactivate/archive (soft-delete, records
preserved), SSO toggle.
Security-critical (role assignment = privilege grant). Audit every role change.
**Acceptance:** only `facility_manager+` can assign roles; a manager cannot grant a role
above their own; archive preserves history.

---

## STREAM A — Workforce (Agent 1, Sonnet-led) — runs concurrently with B & C

The differentiator. Highest complexity. Build Certs first (Scheduling depends on it).

### Prompt A.1 — Staff Certifications Tracker (Sonnet)
Build the Staff Certifications module (Module Spec §4.2). Tables: `cert_type` (from admin),
`staff_certification` (user↔cert_type, issue/expiry, document_url, auto status
Active/Expiring/Expired).
- Document upload to Supabase Storage.
- Expiry alert engine: notifications at 60/30/7 days before expiry (Resend).
- Staff see/upload own certs; managers manage all.
**Acceptance:** status auto-computes from expiry date; expiring certs surface in a manager
view; RLS verified.

### Prompt A.2 — Scheduling core: shifts, templates, availability (Sonnet for model, Haiku for calendar UI shell)
Build Employee Scheduling core (Module Spec §4.1.1, 4.1.3–4.1.6):
- `shift`, `shift_template` (generates shifts), `availability` (per user/facility: day
  status, max hrs/day, max hrs/week, doubles), `swap_request`, staff management view,
  schedule communication (send schedule by date range, per-employee email toggle, delivery
  log).
- Week-view calendar with react-big-calendar: drag-to-create, drag-to-move,
  drag-to-resize. Open (unassigned) shifts visually distinct.
- Publish workflow: Draft → Published → Locked.
**Acceptance:** templates generate a week; drag interactions persist; schedule messages
send and log.

### Prompt A.3 — Conflict detection engine (Sonnet — do not delegate)
Implement the conflict detection engine (Module Spec §4.1.2). Evaluate every assignment in
real time, resolving to Allow / Warn / Block:
double-booking (Block), back-to-back across facilities (Warn), max hrs/day & /week (Warn,
configurable Block), doubles-not-allowed (Block), outside availability window (Warn),
availability closed (Block), missing required cert (Warn), expired required cert (Block),
cert expiring before shift (Warn/Block configurable), understaffed template (Warn), open
shift (Warn).
- Cert checks use the three-hop join: `shift.job_area_id → job_area_required_cert →
  cert_type`, cross-referenced with `staff_certification` for the assigned user.
- Publish gate: a schedule with ANY Block conflict cannot move Draft→Published; return all
  blocking conflicts with deep links. Warn conflicts listed but acknowledgeable with one
  confirmation.
- Surface conflicts with text/icon labels, not color alone.
**Acceptance:** unit tests for each rule + the publish gate.

---

## STREAM B — Operations Core (Agent 2, mixed) — concurrent with A & C

Build Injury/Illness first; Incident reuses its pattern.

### Prompt B.1 — Injury/Illness Reports (Sonnet)
Build Injury/Illness (Module Spec §2.1). Tables: `injury_report` + polymorphic
`report_person` and `report_witness` (`parent_id`/`parent_type`, RLS resolves parent
`facility_id`).
Fields, sub-sections (Person(s) Involved, Witnesses, Person Completing Report), severity
(admin-configurable — NO hardcoded values), status flow Draft→Submitted→Reviewed→Closed,
manager-review locking, email alerts.
NO photo documentation. PII encrypted at rest. Audit every state change.
**Acceptance:** polymorphic children RLS-isolated by facility; lock prevents author edits;
audit rows written.

### Prompt B.2 — Incident Reports (Haiku scaffold from B.1 → Sonnet review)
Build Incident Reports (Module Spec §2.2) reusing the Injury/Illness pattern from B.1.
Incident category + severity from admin config. Reuse `report_person`/`report_witness`. Add
"Follow-Up Required?" that, when checked, creates a linked task (wire the link in Phase 5 if
Tasks isn't ready — stub the FK).
Sonnet reviews RLS + the polymorphic reuse.

### Prompt B.3 — Daily Log, Memo Board, EOD (Haiku → Sonnet review)
Build three modules from the Module Spec, reading categories/areas/recipient groups from
admin config:
- Daily Log §2.3 (entries, tag staff → notify, attachments, filterable).
- Memo Board §2.5 (To/From/Subject broadcast, recipient groups, unread badge, optional
  email).
- EOD Report §2.4 (one per day/facility, auto-lock at configurable cutoff, fields per spec;
  links to incidents/work orders wired in Phase 5 — stub FKs).
Mobile-first, offline-capable per `CLAUDE.md` §8. Sonnet RLS review before done.

---

## STREAM C — Facility Management (Agent 3, mixed) — concurrent with A & B

Forms & Inspections first (most complex; form builder).

### Prompt C.1 — Forms & Inspections + form builder (Sonnet)
Build Forms & Inspections (Module Spec §3.3). `form` (category from admin, `schema_json`) +
`form_response` (`answers_json`, `submitted_by`).
- Form builder supporting all field types in the spec: text, textarea, number, yes/no,
  single/multi select, date, time, datetime, rating, section header, instructions,
  signature/acknowledgment, file upload.
- Forms grouped by admin-configurable category; schedulable (daily/weekly/event). Responses
  stored, viewable, exportable.
Dynamic schema is the tricky part — validate answers against the form's schema server-side.
**Acceptance:** build a form, submit a response, export CSV; RLS verified.

### Prompt C.2 — Tasks & Utilization Counts (Haiku → Sonnet review)
- Tasks §3.1: assignable, recurrence (one-time/daily/weekly/custom), categories+priority
  from admin, completion notes + signature, reminders (Resend). Expose a `createTask()`
  server action so Incident follow-ups can call it.
- Utilization Counts §3.2: quick-entry per area/count-type (admin config), time-series
  storage, daily/weekly/monthly summaries.
Offline-capable. Sonnet RLS review.

### Prompt C.3 — SOPs & ERPs (Haiku → Sonnet review)
- SOPs §3.4: versioned rich-text docs by category, full-text search,
  acknowledgment-required toggle, role-scoped visibility, archived versions retained.
- ERPs §3.5: scenario-based (type + response level from admin), step-by-step protocol, role
  assignments table, emergency contacts, evacuation/AED references, always-accessible
  read-only per facility.
Sonnet RLS review.

### Prompt C.4 — Work Orders & Asset Management (Haiku scaffold → Sonnet for relations)
Build Work Orders & Assets (Module Spec §3.6). Sub-sections: My Work Orders / Create / PM &
Inspections.
- `work_order` (status flow Open→Assigned→In Progress→Completed→Closed, category+priority
  from admin, photo attachments ALLOWED here, assignment manager-only).
- `asset` (type/location from admin, PM schedule, inspection history auto-populated from
  completed PM forms — integrates with Stream C.1 forms).
Sonnet reviews the asset↔work_order↔form relations + RLS.

---

## PHASE 5 — Integration, Dashboard, Reporting (Sonnet, sequential)

### Prompt 5.1 — Cross-module links
Wire the deferred links now that all modules exist:
- Incident "Follow-Up Required" → creates a Task via the Tasks server action.
- EOD "Incidents Occurred?" / "Equipment Issues?" → link to that day's Injury/Incident
  reports and create/link Work Orders.
- Asset inspection history ← completed PM/Inspection form responses.
Verify each link respects facility isolation.

### Prompt 5.2 — Compliance Dashboard (Sonnet)
Build the Compliance Dashboard (Module Spec §6): aggregate facility view of open incidents,
overdue tasks, cert expirations, and unfilled/open shifts. Cross-module reads, RLS-safe,
manager-scoped. Color + label, never color alone.

### Prompt 5.3 — Reporting & Export (Haiku → Sonnet review)
Implement per-module reports + exports (Module Spec §6): CSV for all tabular reports, PDF
for filed reports and the postable weekly schedule. Date/type/severity filters per spec. No
BI dashboards — exports only.

---

## PHASE 6 — Security & NFR audit (Sonnet, sequential, do not skip)

### Prompt 6.1 — Security audit
Full RLS audit across every table: prove no cross-facility read/write, no role escalation,
polymorphic children resolve parent facility correctly. Review every SECURITY DEFINER
function. Confirm `facility_id` is never client-trusted on any write path. Produce a
findings report and fix everything Critical/High before sign-off.

### Prompt 6.2 — NFR pass
Verify `CLAUDE.md` §8 across all modules: audit logging on all report state changes;
retention windows enforced (≥7yr incident/injury, no hard-delete in window); offline capture
+ sync + conflict-flag (no silent overwrite); WCAG 2.1 AA (keyboard, focus, contrast,
labels); PII encryption at rest. File gaps as fix tasks and close them.

---

## Quick reference — who runs what

| Phase | Agent(s) | Mode | Gate |
|---|---|---|---|
| 0 Foundation | Sonnet | Sequential | none |
| 1 Admin | Sonnet + Haiku | Sequential | after 0 |
| A Workforce | Agent 1 (Sonnet-led) | Concurrent | after 1 |
| B Operations | Agent 2 (mixed) | Concurrent | after 1 |
| C Facility Mgmt | Agent 3 (mixed) | Concurrent | after 1 |
| 5 Integration | Sonnet | Sequential | after A+B+C |
| 6 Security/NFR | Sonnet | Sequential | after 5 |

**Concurrency win:** Streams A, B, and C are independent after Phase 1 because each reads
from the shared admin config but writes to its own tables. The only cross-stream couplings
(Incident→Task, EOD→Incident/WorkOrder, Asset→Form) are deliberately deferred to Phase 5 and
stubbed as nullable FKs during the parallel phase, so no stream blocks another.
</content>
