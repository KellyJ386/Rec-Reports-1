# Configurable Daily Operational Reports Module (Recreation Facilities)

## Scope
A configurable, mobile-first, offline-capable daily reports module for recreation operations.

### Supported report examples
- Opening checklist
- Closing checklist
- Supervisor log
- Maintenance issue
- Shift summary
- Attendance counts
- Weather notes
- Safety inspection

### Required capabilities
- Customizable forms
- Admin-configurable fields
- Photos and signatures
- PDF export
- Email distribution
- Incident escalation
- Task creation
- Auditability
- Offline-first submission

---

## 1) Architecture

### 1.1 Logical components
1. **Form Definition Service**
   - Stores versioned templates and field schemas.
   - Controls publish/unpublish lifecycle for templates.
2. **Submission Runtime**
   - Renders forms from schema.
   - Handles draft, submit, validation, and attachments.
3. **Workflow Engine**
   - Runs post-submit automations (incident escalation, task creation, notification routing).
4. **Document Service**
   - Generates PDFs from immutable submission snapshots.
5. **Distribution Service**
   - Handles recipient lists, email delivery, and retry logic.
6. **Audit/Event Service**
   - Writes audit records for template changes and submission lifecycle events.

### 1.2 Tenant model
- All module entities are facility-scoped via `facility_id`.
- Optional department scoping for template visibility and approvals.
- RLS enforces facility isolation for definitions, submissions, attachments, and workflows.

### 1.3 Data flow (high-level)
1. Admin configures template + workflow rules.
2. Staff completes report on mobile (online/offline).
3. Submission saved as draft -> submitted.
4. Workflow engine evaluates rules:
   - create incident/task if triggered
   - notify recipients
   - queue PDF generation + email distribution
5. Actions and outputs logged in audit trail.

---

## 2) Schema

### 2.1 Template and field configuration
- `report_templates`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `department_id uuid null`
  - `code text` (e.g., `opening_checklist`)
  - `name text`
  - `description text`
  - `status enum('draft','published','archived')`
  - `active_version int`
  - audit/soft-delete fields

- `report_template_versions`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `template_id uuid fk`
  - `version_number int`
  - `schema_json jsonb` (full field schema + layout)
  - `validation_json jsonb` (cross-field rules)
  - `workflow_json jsonb` (automation triggers)
  - `pdf_layout_json jsonb`
  - `is_published boolean`
  - audit/soft-delete fields

- `report_fields_catalog` (optional reusable field defs)
  - `id uuid pk`
  - `facility_id uuid not null`
  - `field_key text`
  - `field_type enum('text','textarea','number','select','multiselect','checkbox','date','time','datetime','photo','signature','counter','rating')`
  - `default_config jsonb`
  - audit/soft-delete fields

### 2.2 Submission tables
- `report_submissions`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `template_id uuid fk`
  - `template_version_id uuid fk`
  - `report_date date`
  - `shift_ref text null`
  - `status enum('draft','submitted','locked','revised')`
  - `submitted_by uuid fk auth.users`
  - `submitted_at timestamptz`
  - `department_id uuid null`
  - `payload_json jsonb` (answers)
  - `validation_results jsonb`
  - `source enum('web','mobile','offline_sync')`
  - `pdf_status enum('not_requested','queued','generated','failed')`
  - audit/soft-delete fields

- `report_submission_attachments`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `submission_id uuid fk`
  - `field_key text`
  - `storage_path text`
  - `mime_type text`
  - `checksum text`
  - `metadata jsonb`
  - audit/soft-delete fields

- `report_submission_signatures`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `submission_id uuid fk`
  - `field_key text`
  - `signed_by_user_id uuid fk auth.users`
  - `signed_name text`
  - `signed_at timestamptz`
  - `signature_path text`
  - audit/soft-delete fields

### 2.3 Workflow and distribution tables
- `report_workflow_events`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `submission_id uuid fk`
  - `event_type enum('submitted','escalated_incident','task_created','email_queued','pdf_generated','notification_sent')`
  - `event_payload jsonb`
  - `status enum('pending','processed','failed')`
  - `processed_at timestamptz`
  - `error_text text`

- `report_distribution_lists`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `template_id uuid fk`
  - `name text`
  - `channels jsonb` (email/in_app)
  - `filters_json jsonb` (department/role/report_status)
  - audit/soft-delete fields

- `report_distribution_deliveries`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `submission_id uuid fk`
  - `recipient_user_id uuid null`
  - `recipient_email text`
  - `channel enum('email','in_app')`
  - `delivery_status enum('queued','sent','failed','bounced')`
  - `provider_message_id text`
  - `attempt_count int`
  - `last_attempt_at timestamptz`

### 2.4 Suggested indexes
- `report_submissions(facility_id, report_date desc) where deleted_at is null`
- `report_submissions(facility_id, template_id, status) where deleted_at is null`
- `report_submission_attachments(facility_id, submission_id)`
- `report_workflow_events(facility_id, status, created_at)`
- `report_distribution_deliveries(facility_id, delivery_status, created_at)`
- GIN indexes on `schema_json`, `payload_json`, `workflow_json` as needed.

---

## 3) Form Builder Strategy

### 3.1 Builder model
- **Schema-driven JSON form builder** with drag/drop sections and fields.
- Field schema attributes:
  - `key`, `label`, `type`, `required`, `help_text`, `default_value`
  - `visibility_rules` (show/hide by role/department/answer)
  - `validation_rules` (min/max, regex, dependency rules)
  - `photo_constraints` (count/size)
  - `signature_requirements`

### 3.2 Versioning strategy
- Draft edits create new template version.
- Published version immutable.
- New submissions always pin to a specific `template_version_id`.
- Existing submissions never re-bind to newer version.

### 3.3 Reusable blocks
- Shared checklist sections (e.g., “Facility Safety Walk”).
- Field presets for common operations:
  - pass/fail checklist
  - incident detail block
  - weather capture block
  - attendance counter block

### 3.4 Validation strategy
- Client validation for UX speed.
- Server validation for source of truth.
- Policy options:
  - `strict_block` (cannot submit)
  - `warn_and_submit` (requires reason)

---

## 4) PDF Workflow

1. Submission enters `submitted` status.
2. PDF job queued with immutable payload snapshot + template version.
3. Edge Function fetches submission + assets (photos/signatures).
4. Renderer applies template layout and branding.
5. Output stored in Supabase Storage:
   - `/facility/{facility_id}/reports/{submission_id}/report-v{version}.pdf`
6. `report_submissions.pdf_status` updated to `generated`.
7. Download link and email attachment/reference enabled.

### PDF content standards
- Header: facility, department, report type, date/time.
- Body: sectioned responses with media references.
- Footer: signatures, submission metadata, revision marker.
- Include QR/hash for tamper-evidence verification.

---

## 5) Email Workflow

1. Submission event triggers distribution resolver.
2. Resolve recipients from:
   - static list
   - role/department filters
   - escalation rules
3. Create `report_distribution_deliveries` rows.
4. Worker sends emails (batched + retry policy).
5. Delivery status updated with provider IDs/errors.

### Email modes
- Immediate send for critical/safety reports.
- Digest mode for lower-priority supervisor logs.
- Attachment policy:
  - include PDF for finalized submissions
  - include secure link for large/photo-heavy submissions

---

## 6) Notification Logic

### Trigger examples
- Report submitted -> supervisor + configured stakeholders.
- Critical flag detected (e.g., safety fail) -> immediate escalation chain.
- Incident trigger in form response -> create incident + notify safety manager.
- Maintenance defect -> create work order/task + notify maintenance queue.
- PDF generation failed -> notify admins + retry queue.

### Priority and routing
- Severity mapping in workflow config:
  - low -> in-app only
  - medium -> in-app + email
  - high/critical -> in-app + email + push (optional)

### Deduplication
- Correlation key: `submission_id + event_type + recipient`.
- Suppress duplicates in configurable cooldown window.

---

## 7) Audit Trail Strategy

### Audit coverage
- Template lifecycle: create, edit, publish, archive.
- Field-level changes between versions.
- Submission lifecycle: draft/save/submit/lock/revise.
- Automation outcomes: incidents, tasks, notifications, email sends.
- Access events: PDF view/download for sensitive reports.

### Audit table pattern
- `audit_events`
  - `id bigserial`
  - `facility_id uuid`
  - `actor_user_id uuid`
  - `entity_type text`
  - `entity_id uuid`
  - `action text`
  - `before_json jsonb`
  - `after_json jsonb`
  - `request_id text`
  - `created_at timestamptz`

### Compliance posture
- Append-only audit model.
- Retention policy by report type/severity.
- Optional legal-hold flag to prevent archival purge.

---

## 8) UI Recommendations

### 8.1 Mobile-first report entry
- Stepper-based form sections with progress indicator.
- Sticky action bar: Save Draft / Submit.
- Inline camera capture and annotation for photos.
- Signature pad optimized for touch.
- Auto-save every N seconds and on section transition.

### 8.2 Manager review UI
- Inbox with filters:
  - type, status, date, department, flagged items.
- Quick actions:
  - escalate incident
  - create task
  - export PDF
  - resend distribution
- Side-by-side “Form Response + Generated Actions” pane.

### 8.3 Admin form builder UI
- Left: section/field tree.
- Center: live form preview (mobile + desktop tabs).
- Right: field properties + validation + workflow rules.
- Version compare view before publish.

---

## 9) Offline Strategy

### 9.1 Local stores (IndexedDB)
- `report_template_cache`
- `draft_submissions`
- `offline_media_queue`
- `submission_mutation_queue`
- `sync_receipts`

### 9.2 Offline submission flow
1. Staff loads cached template version.
2. Completes form offline with local draft autosave.
3. Photos/signatures stored locally with temp IDs.
4. Submission queued with `client_mutation_id`.
5. On reconnect:
   - upload media first
   - remap temp media IDs
   - submit payload
   - receive canonical IDs/version
6. Mark local draft as synced.

### 9.3 Conflict handling
- If template changed while offline:
  - if old version still valid -> accept submission on pinned version
  - if retired/invalid -> manager review queue with migration guidance

---

## 10) Admin Configuration System

### 10.1 Configurable entities
- Template catalog by department/facility.
- Field definitions, required logic, conditional visibility.
- Workflow rules:
  - thresholds
  - escalation recipients
  - auto-create incident/task toggles
- Distribution policies:
  - recipient groups
  - channel preferences
  - digest schedules

### 10.2 Governance controls
- Permissions:
  - `reports.templates.manage`
  - `reports.publish`
  - `reports.workflow.manage`
  - `reports.distribution.manage`
- Two-step publish (optional): author + approver.
- Sandbox test mode for new templates/workflows before production publish.

### 10.3 Safety and quality guardrails
- Required metadata per template (owner, review cadence).
- Expiry reminders for stale templates.
- Validation coverage checklist before publish.
- Change log summary required on each new version.

---

## Practical rollout plan (daily reports module)
1. Core template/submission schema + RLS.
2. Mobile runtime + offline drafts.
3. PDF generation + storage linkage.
4. Distribution engine + notification routing.
5. Workflow automations (incident/task creation).
6. Admin builder polish + version governance.
