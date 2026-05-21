# Recreation Operations Communication + Training Platform Design

## 1) Architecture

### 1.1 Objectives
- Deliver **shift-aware communications** and **role-targeted training** in one platform.
- Guarantee compliance with **required acknowledgements**, **read receipts**, **certification tracking**, and **retraining cycles**.
- Support frontline execution with **mobile-first, offline-resilient** workflows.

### 1.2 Core architecture (modular monolith with event-driven internals)
1. **Client apps**
   - Web admin portal (operations managers, training coordinators, supervisors).
   - Employee web/mobile app (PWA + native wrapper optional).
2. **API/BFF layer**
   - REST/GraphQL endpoints for CRUD and query.
   - AuthN/AuthZ boundary with RBAC + department/role/shift scoping.
3. **Domain modules**
   - Communications module.
   - Training & LMS module.
   - Certification compliance module.
   - SOP/Knowledge module.
   - Notification orchestration module.
4. **Data + storage**
   - PostgreSQL for transactional data.
   - Object storage for PDF/video/attachments.
   - Search index for SOP/content lookup.
5. **Realtime/event backbone**
   - WebSocket/pub-sub for live feeds, emergency alerts, and receipts.
   - Outbox/event bus for durable async workflows.
6. **Integration layer**
   - Scheduling system adapters.
   - Incident management adapters.
   - Optional HRIS/LMS content import adapters.

### 1.3 Bounded contexts
- **Comms**: channels, posts, acknowledgements, read receipts, emergency blasts.
- **Learning**: courses, modules, quizzes, assignments, completion records.
- **Compliance**: certifications, expirations, retraining plans, enforcement.
- **Knowledge**: SOP docs, versions, audience mapping, attestation.

---

## 2) Database Schema

> Representative relational schema (multi-tenant via `facility_id`).

### 2.1 Identity and org context
- `facilities(id, name, timezone, ...)`
- `departments(id, facility_id, name, active)`
- `employees(id, facility_id, user_id, first_name, last_name, employment_status, ...)`
- `roles(id, facility_id, code, name)`
- `employee_roles(employee_id, role_id, starts_at, ends_at)`
- `shift_assignments(id, facility_id, employee_id, shift_id, starts_at, ends_at, department_id)`

### 2.2 Communications
- `channels(id, facility_id, type, name, department_id nullable, shift_scoped bool, emergency_enabled bool)`
- `messages(id, facility_id, channel_id, author_employee_id, message_type, subject, body_richtext, priority, is_required_ack, ack_due_at, created_at)`
- `message_audiences(id, message_id, audience_type, audience_ref_id, rule_jsonb)`
  - audience types: role, department, shift, employee, certification-status.
- `message_receipts(id, message_id, employee_id, delivered_at, read_at, device_id)`
- `message_acknowledgements(id, message_id, employee_id, ack_state, acknowledged_at, ack_method, signature_blob nullable)`
- `message_attachments(id, message_id, file_id)`

### 2.3 Content/files
- `files(id, facility_id, bucket, path, filename, content_type, size_bytes, checksum, uploaded_by, created_at)`
- `videos(id, file_id, duration_sec, transcript_file_id nullable, thumbnail_file_id nullable)`
- `pdf_documents(id, file_id, doc_type, extracted_text_tsv, retention_class)`

### 2.4 LMS/training
- `courses(id, facility_id, code, title, description, status)`
- `course_modules(id, course_id, module_type, title, order_no, content_ref_id, required bool)`
  - module types: video, pdf, sop-link, quiz, checklist.
- `quizzes(id, module_id, pass_score_pct, max_attempts, question_pool_jsonb)`
- `training_assignments(id, facility_id, employee_id, course_id, assigned_by, assigned_at, due_at, reason_code, source_type, source_ref_id)`
  - source_type: manual, role_rule, incident_rule, certification_rule.
- `training_progress(id, assignment_id, module_id, state, started_at, completed_at, score_pct, attempts)`
- `training_completions(id, assignment_id, completed_at, final_score_pct, completion_status)`

### 2.5 Certifications and retraining
- `certification_types(id, facility_id, code, name, validity_days, renewal_window_days, grace_days, auto_suspend_roles bool)`
- `employee_certifications(id, employee_id, certification_type_id, earned_at, expires_at, status, evidence_file_id nullable)`
- `retraining_policies(id, facility_id, trigger_type, trigger_config_jsonb, retraining_course_id, recurrence_rule, active)`
  - trigger_type: fixed_interval, incident, sop_revision, failed_quiz.
- `certification_events(id, employee_certification_id, event_type, event_at, payload_jsonb)`

### 2.6 SOP library
- `sop_documents(id, facility_id, sop_code, title, category, status, owner_department_id)`
- `sop_versions(id, sop_id, version_no, effective_at, file_id, change_summary, published_by)`
- `sop_audience_rules(id, sop_id, audience_type, audience_ref_id, required_ack bool, ack_due_days)`
- `sop_attestations(id, sop_version_id, employee_id, assigned_at, viewed_at, acknowledged_at, status)`

### 2.7 Notification engine + workflow
- `notification_jobs(id, facility_id, event_type, payload_jsonb, scheduled_for, status, attempts)`
- `notification_deliveries(id, job_id, employee_id, channel, status, sent_at, provider_message_id)`
- `employee_notification_preferences(employee_id, push_enabled, sms_enabled, email_enabled, quiet_hours_jsonb, emergency_override bool)`
- `workflow_tasks(id, facility_id, workflow_type, target_entity, target_id, due_at, owner_employee_id, status)`

### 2.8 Key indexing
- `messages(facility_id, created_at desc)`
- `message_receipts(message_id, employee_id)` unique
- `training_assignments(employee_id, due_at, completion_state)`
- `employee_certifications(employee_id, expires_at, status)`
- `sop_attestations(employee_id, status, assigned_at)`

---

## 3) Messaging Workflows

### 3.1 Shift-based communication
1. Supervisor composes message and selects “Current shift” or “Next shift”.
2. Audience resolver reads scheduling integration and expands recipients.
3. Message persisted with snapshot of resolved audience.
4. Delivery fan-out: in-app push + optional SMS/email.
5. Read receipts and required acknowledgements tracked in near realtime.

### 3.2 Department communication
- Channel-per-department model with optional cross-post to multi-department operations channels.
- Department leads can pin SOP reminders, assignments, and safety bulletins.

### 3.3 Required acknowledgements
- Message flag `is_required_ack=true` enforces explicit user action.
- Escalation path:
  - T+X hours: reminder.
  - T+Y hours: supervisor alert.
  - T+Z hours: manager escalation and optional scheduling restriction.

### 3.4 Emergency messaging
- “Emergency mode” bypasses quiet hours and non-critical notification preferences.
- Multi-channel burst (push → SMS → voice optional).
- Geo/department/shift targeting + “all-hands” fallback.
- Confirmation workflow requires “I am safe / need assistance” responses.

---

## 4) Realtime Strategy

- WebSocket channels partitioned by facility + department + shift.
- Event types:
  - `message.created`, `message.updated`, `receipt.read`, `ack.submitted`
  - `assignment.created`, `quiz.submitted`, `cert.expiring`
  - `emergency.alert.raised`, `emergency.response.received`
- Presence indicators for on-duty staff and supervisors.
- Offline strategy:
  - Local queue for acknowledgements/quiz answers.
  - Conflict policy: server timestamp + idempotency key.
- Backpressure controls:
  - Batch receipt updates.
  - Coalesced counters for unread/read states.

---

## 5) Notification Engine

### 5.1 Orchestration logic
- Inputs: domain events from comms/training/certification/sop modules.
- Rules evaluate:
  - urgency,
  - user preferences,
  - role/shift context,
  - legal/compliance overrides.
- Channel policy examples:
  - Emergency: push+SMS immediately.
  - Required ack: push now, email digest fallback.
  - Training due soon: in-app + daily digest.

### 5.2 Delivery channels
- In-app inbox (authoritative record).
- Push notifications (APNS/FCM).
- SMS for urgent and backup.
- Email for long-form and summaries.

### 5.3 Reliability
- Outbox + retry with exponential backoff.
- Dead-letter queue for failed provider sends.
- Provider health checks and channel failover.

---

## 6) Certification Tracking

- Certification catalog defines validity, renewal window, grace rules.
- Employee certification lifecycle states:
  - `active` → `renewal_due` → `expired` → `suspended`/`reinstated`.
- Evidence artifacts (cards, PDFs, instructor sign-off) stored in file service.
- Compliance dashboards:
  - expiring in 30/14/7 days,
  - overdue by department/role,
  - staffing impact projections.

---

## 7) Expiration Workflows

### 7.1 Scheduled evaluators (daily/hourly)
- Job scans certifications and required training items.
- Emits `cert.expiring_soon`, `cert.expired`, `retraining.required` events.

### 7.2 Automated actions
- Auto-create retraining assignment tied to role/cert policy.
- Notify employee + supervisor + training coordinator.
- Optional rule: mark employee ineligible for specific shifts/positions until completion.

### 7.3 Escalation ladders
- Day -30: soft reminder.
- Day -14: manager copy.
- Day -7: high-priority reminder.
- Day 0: expiration event + schedule restriction.
- Day +N grace end: suspension workflow.

---

## 8) Admin Management UI

### 8.1 Core areas
- **Comms Console**: channel management, templates, emergency launch panel.
- **Audience Builder**: target by role, department, shift, site zone, certification status.
- **Training Studio**: course builder (video/PDF/quiz), assignment rules, due date policies.
- **Certification Admin**: cert types, renewal logic, evidence review.
- **SOP Library**: version control, publish workflow, required attestation rules.
- **Analytics**: read/ack rates, completion rates, compliance gaps.

### 8.2 Guardrails
- Approval workflow for emergency templates and policy changes.
- Immutable audit log for compliance-sensitive actions.

---

## 9) Employee Training UI

- Personalized “My Queue”:
  - required acknowledgements,
  - assigned training,
  - expiring certifications,
  - pending SOP attestations.
- Course player:
  - resume where left off,
  - chapter markers,
  - quiz attempt feedback.
- Certification wallet:
  - status badges,
  - expiration dates,
  - evidence uploads.
- Supervisor view for team compliance and nudging.

---

## 10) Mobile UX

- Thumb-first navigation with bottom tabs: Inbox, Training, SOPs, Certifications, Alerts.
- Offline-first for on-deck operations (sync when connected).
- One-tap actions:
  - “Acknowledge”,
  - “Mark read”,
  - “Start training”,
  - “Respond to emergency”.
- Low-friction media:
  - stream-adaptive video,
  - downloadable PDFs,
  - attachment previews.
- Accessibility:
  - large touch targets,
  - captions/transcripts,
  - multilingual content support.

---

## 11) Integration with Scheduling

### 11.1 Data sync
- Inbound from scheduling:
  - shifts, assignments, call-outs, swaps, no-shows.
- Identity mapping:
  - employee IDs normalized across systems.

### 11.2 Operational use cases
- Shift-targeted messages auto-resolve recipients from live schedule.
- Training/certification gates:
  - scheduler receives warning/block if employee lacks active certification.
- Pre-shift briefing automation:
  - send SOP updates + safety notices to next shift at configurable lead time.

---

## 12) Integration with Incidents

### 12.1 Triggered training
- Incident type/severity rules can auto-assign micro-training or full retraining.
- Example: chemical exposure incident → immediate SOP refresher + quiz.

### 12.2 Communications coupling
- Incident command channel auto-created for major events.
- Emergency alerts can embed incident updates and tasking.

### 12.3 Compliance loop closure
- Post-incident corrective actions linked to:
  - SOP revisions,
  - mandatory attestations,
  - department-level retraining campaigns.
- Reporting ties incident outcomes to training effectiveness metrics.

---

## Recommended Implementation Phases
1. **Phase 1 (MVP)**: comms channels, receipts/acks, SOP library, basic assignments, cert tracking.
2. **Phase 2**: quizzes/video, retraining automation, scheduling integration, emergency messaging.
3. **Phase 3**: incident-driven adaptive training, predictive compliance risk scoring, advanced analytics.
