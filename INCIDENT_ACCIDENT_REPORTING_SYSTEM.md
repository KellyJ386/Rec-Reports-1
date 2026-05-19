# Recreation Facility Incident & Accident Reporting System (Risk Management Design)

## Scope
Design a legally defensible, mobile-first incident/accident reporting module for recreation facilities with immutable auditability, OSHA-style handling, emergency escalation, and structured follow-up.

---

## 1) Workflows

### 1.1 Primary incident workflow (end-to-end)
1. **Event occurs** (incident or accident).
2. **Initial capture** by frontline/supervisor on mobile:
   - time, location, involved parties, severity, immediate actions.
3. **Evidence collection**:
   - photos, witness statements, diagrams/notes, signatures.
4. **Triage + severity classification**:
   - low / medium / high / critical.
5. **Immediate escalation** (if high/critical):
   - safety lead, facility manager, emergency responders policy path.
6. **Supervisor review**:
   - completeness check, factual corrections via append-only amendments.
7. **Compliance path**:
   - OSHA-style tasks, deadlines, documentation checklist.
8. **Corrective actions**:
   - create follow-up tasks, work orders, and training assignments.
9. **Closure review**:
   - all actions complete, legal package generated (PDF bundle), status closed.

### 1.2 OSHA-style workflow mapping (configurable)
- **Recordability decision step** (decision tree).
- **Classification outcome** (first aid vs recordable/investigation required).
- **Regulatory timer starts** for reportable classes.
- **Submission checklist**: witness statements, supervisor signature, manager sign-off.
- **Retention controls** by incident class and legal-hold flag.

### 1.3 Amendment workflow (legal-safe)
- No destructive edits after submit.
- Changes are **amendments** with:
  - amendment reason,
  - actor,
  - timestamp,
  - before/after snapshot hash.
- Original submission remains immutable and always discoverable.

---

## 2) Database Schema

### 2.1 Core tables
- `incident_reports`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_no text unique per facility`
  - `report_type enum('incident','accident','near_miss')`
  - `status enum('draft','submitted','under_review','escalated','action_pending','closed')`
  - `severity enum('low','medium','high','critical')`
  - `occurred_at timestamptz`
  - `reported_at timestamptz`
  - `location_text text`
  - `department_id uuid null`
  - `summary text`
  - `immediate_actions text`
  - `requires_osha_review boolean`
  - `legal_hold boolean`
  - `submitted_by uuid fk auth.users`
  - `submitted_at timestamptz`
  - audit + soft-delete fields

- `incident_people`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `person_role enum('injured_party','witness','staff','contractor','visitor')`
  - `full_name text`
  - `contact_json jsonb`
  - `injury_json jsonb`
  - `statement_text text`
  - `statement_submitted_at timestamptz`
  - audit + soft-delete fields

- `incident_witness_statements`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `witness_person_id uuid fk incident_people`
  - `statement_payload jsonb`
  - `signed boolean`
  - `signed_at timestamptz`
  - `signature_path text`
  - `version_no int`
  - audit + soft-delete fields

- `incident_attachments`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `attachment_type enum('photo','document','video','audio')`
  - `storage_path text`
  - `captured_at timestamptz`
  - `captured_by uuid fk auth.users`
  - `checksum_sha256 text`
  - `metadata jsonb`
  - audit + soft-delete fields

- `incident_signatures`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `signature_role enum('reporter','witness','supervisor','manager')`
  - `signed_by_user_id uuid null fk auth.users`
  - `signed_name text`
  - `signed_at timestamptz`
  - `signature_path text`
  - `attestation_text text`
  - audit + soft-delete fields

### 2.2 Compliance and response tables
- `incident_escalations`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `escalation_level int`
  - `reason_code text`
  - `target_role text`
  - `target_user_id uuid null`
  - `status enum('pending','acknowledged','resolved','expired')`
  - `due_at timestamptz`
  - `acknowledged_at timestamptz`
  - audit fields

- `incident_followup_tasks`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `task_id uuid fk tasks`
  - `task_type enum('corrective_action','investigation','documentation','equipment_fix')`
  - `required boolean`
  - audit fields

- `incident_training_triggers`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `employee_id uuid fk employees`
  - `training_assignment_id uuid fk training_assignments`
  - `trigger_reason text`
  - `status enum('queued','assigned','completed','waived')`
  - audit fields

- `incident_compliance_checks`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `check_type enum('osha_recordability','supervisor_signoff','evidence_complete','legal_review')`
  - `result enum('pass','fail','waived')`
  - `notes text`
  - `checked_by uuid`
  - `checked_at timestamptz`

### 2.3 Immutability / legal audit tables
- `incident_audit_events` (append-only)
  - `id bigserial pk`
  - `facility_id uuid not null`
  - `incident_id uuid not null`
  - `event_type text`
  - `actor_user_id uuid`
  - `event_payload jsonb`
  - `prev_event_hash text`
  - `event_hash text`
  - `created_at timestamptz not null default now()`

- `incident_amendments`
  - `id uuid pk`
  - `facility_id uuid not null`
  - `incident_id uuid fk`
  - `amendment_reason text`
  - `before_snapshot jsonb`
  - `after_snapshot jsonb`
  - `amended_by uuid`
  - `amended_at timestamptz`

### 2.4 Key indexes
- `incident_reports(facility_id, occurred_at desc, severity, status) where deleted_at is null`
- `incident_reports(facility_id, incident_no) unique where deleted_at is null`
- `incident_escalations(facility_id, status, due_at)`
- `incident_followup_tasks(facility_id, incident_id)`
- `incident_training_triggers(facility_id, status, created_at)`
- `incident_audit_events(facility_id, incident_id, id desc)`
- GIN on `incident_people.injury_json`, `incident_witness_statements.statement_payload`.

---

## 3) UI Design Recommendations

### 3.1 Mobile-first incident capture
- Wizard flow with short sections:
  1. What happened
  2. Who was involved
  3. Severity + immediate actions
  4. Evidence upload (photos/video/docs)
  5. Witness statements
  6. Signatures + submit
- Sticky “Save Draft” + “Submit” actions.
- Offline banner + sync state indicator.
- Mandatory field gating for high/critical severity.

### 3.2 Supervisor review workspace
- Split-pane view:
  - left: incident summary timeline,
  - right: evidence, witness, signatures, compliance checklist.
- Review actions:
  - request clarification,
  - escalate,
  - create follow-up task,
  - assign training.
- Immutable history panel showing amendments and who made them.

### 3.3 Legal/compliance view
- Case packet preview (PDF bundle + hashes).
- Compliance checklist status cards.
- Retention + legal-hold controls.

---

## 4) Legal / Audit Recommendations

1. **Append-only event ledger** for all material actions.
2. **No hard delete** for submitted/closed incidents.
3. **Hash-chain audit events** (`prev_event_hash` -> `event_hash`) for tamper evidence.
4. **Immutable submission snapshots** on each status transition.
5. **Signature attestation text** stored with every signature event.
6. **Clock synchronization standard** (UTC) and trusted server timestamps.
7. **Legal hold** flag blocks purge/archive jobs.
8. **Evidence integrity checks** with SHA-256 checksums.
9. **Access audit** for view/download/export of sensitive reports.
10. **Retention schedule** configurable by incident type and jurisdiction.

---

## 5) PDF Strategy

### 5.1 Outputs
- **Incident Summary PDF** (single report).
- **Legal Packet PDF bundle** (incident + witness statements + signatures + evidence index + audit timeline).

### 5.2 Generation workflow
1. Incident reaches `submitted` or `closed`.
2. PDF job queued with referenced version snapshot.
3. Render service fetches immutable data set + attachment references.
4. Generate PDF with case metadata and page numbering.
5. Store in Supabase Storage with version path.
6. Log generation event in `incident_audit_events`.

### 5.3 PDF legal formatting
- Include incident number, facility, created/submitted/review timestamps.
- Include “Amended” watermark if any amendments exist.
- Add integrity block (document hash + generation timestamp).

---

## 6) Escalation Workflows

### 6.1 Severity-driven escalation
- **Low**: supervisor notification only.
- **Medium**: supervisor + department manager.
- **High**: supervisor + manager + safety/compliance officer.
- **Critical**: immediate emergency chain + executive + optional emergency services SOP prompt.

### 6.2 SLA timers
- High severity acknowledgement required within X minutes.
- Critical severity acknowledgement required within shorter X.
- Auto-escalate to next level on breach.

### 6.3 Escalation states
- pending -> acknowledged -> resolved/expired.
- Every transition creates immutable audit event.

---

## 7) Notification Rules

### 7.1 Core triggers
- Incident submitted.
- Severity upgraded/downgraded.
- Escalation created/SLA breached.
- Supervisor review requested/completed.
- Follow-up task assigned/overdue.
- Training trigger assigned/completed.

### 7.2 Routing logic
- Recipients resolved by role + department + on-call overrides.
- De-dup key: `incident_id:event_type:recipient_id`.
- Quiet hours bypass for high/critical events.

### 7.3 Channels
- In-app (default)
- Email (all review-critical events)
- Push/SMS optional for high/critical escalations

---

## 8) Permissions Matrix

| Capability | Frontline Staff | Supervisor | Safety/Compliance | Facility Admin | Legal/Auditor |
|---|---:|---:|---:|---:|---:|
| Create draft incident | ✅ | ✅ | ✅ | ✅ | ❌ |
| Submit incident | ✅ | ✅ | ✅ | ✅ | ❌ |
| Edit submitted incident | ❌ (amendment only) | ❌ (amendment only) | ❌ (amendment only) | ❌ (amendment only) | ❌ |
| Add evidence before closure | ✅ | ✅ | ✅ | ✅ | ❌ |
| Review/approve case | ❌ | ✅ | ✅ | ✅ | ❌ |
| Trigger escalation | ❌ | ✅ | ✅ | ✅ | ❌ |
| Create follow-up tasks | ❌ | ✅ | ✅ | ✅ | ❌ |
| Assign training triggers | ❌ | ✅ | ✅ | ✅ | ❌ |
| Place legal hold | ❌ | ❌ | ✅ | ✅ | ✅ |
| Export legal packet PDF | ❌ | ✅ | ✅ | ✅ | ✅ |
| View immutable audit trail | own only | dept/facility scope | facility scope | facility scope | read-only global scoped |

### Suggested permission codes
- `incidents.create`
- `incidents.submit`
- `incidents.review`
- `incidents.escalate`
- `incidents.tasks.create`
- `incidents.training.assign`
- `incidents.legal_hold.manage`
- `incidents.audit.view`
- `incidents.export.pdf`

---

## 9) Compliance Recommendations

1. Implement configurable OSHA-style decision trees per jurisdiction.
2. Enforce required fields for recordable classes.
3. Require supervisor signoff before closure.
4. Require evidence checklist completion for high/critical cases.
5. Maintain incident retention matrix (e.g., 3/5/7+ years by class/policy).
6. Periodic compliance audits using immutable event ledger.
7. Automated overdue alerts for unresolved corrective actions.
8. Link recurring incident categories to mandatory refresher training.

---

## 10) Security Recommendations

1. **RLS on every incident table** with strict `facility_id` filtering.
2. **Least privilege RBAC** for review/escalation/export capabilities.
3. **Signed URLs** for private evidence attachments with short TTLs.
4. **Encryption at rest + TLS in transit** for all PII/evidence.
5. **PII minimization** in forms and exports where legally allowed.
6. **MFA requirement** for privileged roles (supervisor and above).
7. **Immutable logs** protected from update/delete by policy.
8. **Anomaly detection** for unusual evidence access/download patterns.
9. **Rate limiting + anti-automation controls** on submission and exports.
10. **Break-glass emergency access** audited with mandatory justification.

---

## Supabase/RLS Implementation Notes
- `public.users.id -> auth.users.id` as identity anchor.
- Membership gate helper: `is_facility_member(facility_id)`.
- Permission gate helper: `has_permission(facility_id, 'incidents.review')`.
- Soft delete only for draft/non-final artifacts; submitted/closed records should transition to archival state, not deletion.
- Realtime channels:
  - `facility:{facility_id}:incidents`
  - `facility:{facility_id}:incident_escalations`
  - `facility:{facility_id}:incident_tasks`
