# Recreation Operations SaaS Platform Architecture (Production Blueprint)

## 1) Complete Platform Architecture

### 1.1 Architectural principles
- Multi-tenant first: every domain object scoped to a `facility_id` (or `tenant_id` + `facility_id` where org groups multiple facilities).
- Secure-by-default: Postgres RLS on every tenant table, no bypass from client keys.
- Offline-first UX: form capture works with no network, conflict-safe sync once online.
- Modular bounded contexts: shared core + independent operational modules.
- Metadata-driven configurability: admin-configurable forms, workflows, roles, and notifications.
- Event-oriented integration: append-only event/audit stream for notifications, analytics, and compliance traceability.

### 1.2 Logical layers
1. **Client layer (Next.js + PWA)**
   - Mobile-first app shell.
   - Role-specific dashboard cards and shortcuts.
   - Local offline store (IndexedDB) with queue/sync engine.
2. **Application/API layer**
   - Next.js Route Handlers (BFF) for web clients.
   - Supabase Edge Functions for privileged workflows (PDF generation, scheduled emails, batch exports, rules engine).
3. **Domain services layer**
   - Modular services: scheduling, incidents, maintenance, checklists, certifications, SOPs.
   - Rule evaluators for compliance SLAs, escalation, and notification orchestration.
4. **Data layer**
   - PostgreSQL (Supabase) with strict RLS.
   - Supabase Storage for attachments and generated PDFs.
   - Supabase Realtime channels for live updates.
5. **Observability & governance layer**
   - Audit logging and immutable event history.
   - Metrics, traces, and operational dashboards.
   - Data retention and legal hold policies.

### 1.3 Tenant model
- **Preferred**: one shared database cluster with strict row-level tenant isolation for scale and operations simplicity.
- Tenant hierarchy:
  - `organization` (optional parent for multi-facility operator)
  - `facility` (primary tenant boundary for workflows)
  - `department` (intra-facility grouping)

### 1.4 Service boundaries (modular monolith first)
- Phase 1–2: modular monolith in Next.js + Edge Functions.
- Phase 3+: split high-throughput domains into independent services (notifications, reporting/export, analytics).

---

## 2) Database Structure (PostgreSQL + Supabase)

### 2.1 Core shared tables
- `organizations(id, name, status, plan_tier, created_at)`
- `facilities(id, organization_id, name, timezone, locale, status, settings_jsonb)`
- `departments(id, facility_id, name, type, active)`
- `users(id auth.uid, email, phone, status, last_login_at)`
- `employees(id, facility_id, user_id nullable, employee_no, first_name, last_name, role_title, department_id, active)`
- `facility_user_memberships(id, facility_id, user_id, employee_id nullable, status, invited_by, joined_at)`
- `roles(id, facility_id nullable for system/global roles, code, name, description)`
- `permissions(id, module, action, code)`
- `role_permissions(role_id, permission_id)`
- `user_role_assignments(id, facility_id, user_id, role_id, scope_type, scope_id nullable)`

### 2.2 Operational module tables
- **Scheduling**
  - `shifts(id, facility_id, department_id, starts_at, ends_at, position_code, min_staff, status)`
  - `shift_assignments(id, shift_id, employee_id, assignment_status, checkin_at, checkout_at)`
  - `time_off_requests(id, facility_id, employee_id, starts_at, ends_at, type, status)`
- **Daily reports**
  - `report_templates(id, facility_id, module_code, name, schema_jsonb, active)`
  - `report_submissions(id, facility_id, template_id, submitted_by, submitted_at, payload_jsonb, status)`
- **Incidents/accidents**
  - `incident_reports(id, facility_id, incident_no, occurred_at, location, severity, status, reported_by)`
  - `incident_people(id, incident_id, person_type, name, contact_jsonb, injury_level)`
  - `incident_actions(id, incident_id, action_type, due_at, owner_employee_id, completed_at)`
- **Maintenance/work orders**
  - `assets(id, facility_id, asset_tag, name, category, location, criticality, active)`
  - `work_orders(id, facility_id, asset_id, priority, status, issue_type, description, created_by, assigned_to, due_at)`
  - `work_order_updates(id, work_order_id, updated_by, update_type, notes, created_at)`
- **Training/certifications**
  - `certification_types(id, facility_id, code, name, validity_days, renewal_window_days)`
  - `employee_certifications(id, facility_id, employee_id, certification_type_id, issued_on, expires_on, status, evidence_path)`
  - `training_courses(id, facility_id, title, modality, required_for_role_jsonb)`
  - `training_completions(id, facility_id, course_id, employee_id, completed_on, score, status)`
- **SOP library**
  - `sop_documents(id, facility_id, title, category, version, storage_path, status, effective_date)`
  - `sop_acknowledgements(id, sop_id, employee_id, acknowledged_at, signature_jsonb)`
- **Communications/tasks**
  - `announcements(id, facility_id, title, body, audience_filter_jsonb, published_at, expires_at)`
  - `tasks(id, facility_id, module_code, title, description, owner_employee_id, status, due_at, priority)`
  - `task_comments(id, task_id, author_employee_id, comment, created_at)`
- **Operational specialties**
  - `ice_logs(id, facility_id, sheet_date, resurfacing_count, notes_jsonb)`
  - `refrigeration_readings(id, facility_id, captured_at, compressor_state, suction_pressure, discharge_pressure, temp_jsonb)`
  - `air_quality_readings(id, facility_id, captured_at, co2_ppm, humidity_pct, temp_c, status)`
  - `checklist_templates(id, facility_id, module_code, name, schema_jsonb, active)`
  - `checklist_runs(id, facility_id, template_id, run_date, status, payload_jsonb, completed_by)`

### 2.3 System and cross-cutting tables
- `attachments(id, facility_id, owner_table, owner_id, storage_path, content_type, uploaded_by)`
- `notifications(id, facility_id, channel, recipient_user_id, template_code, payload_jsonb, status, scheduled_for, sent_at)`
- `notification_preferences(id, facility_id, user_id, in_app, email, sms, quiet_hours_jsonb)`
- `audit_events(id bigserial, facility_id, actor_user_id, event_type, entity_type, entity_id, before_jsonb, after_jsonb, ip, user_agent, created_at)`
- `outbox_events(id, facility_id, event_type, aggregate_type, aggregate_id, payload_jsonb, status, available_at)`
- `sync_queue_receipts(id, facility_id, client_mutation_id, status, server_version, processed_at)`

### 2.4 RLS pattern
- Every tenant table includes `facility_id` and optional `organization_id`.
- Policy base:
  - `USING (facility_id IN (SELECT facility_id FROM facility_user_memberships WHERE user_id = auth.uid() AND status='active'))`
- Mutation policies require role permission checks via SQL helper:
  - `has_permission(auth.uid(), facility_id, 'incidents.write')`

### 2.5 Indexing and partitioning
- Composite indexes on `(facility_id, created_at desc)` for feed-like data.
- Partial indexes for open tasks/work orders (`status != 'closed'`).
- Partition large audit/event tables by month.
- GIN indexes for JSONB schemas where search/reporting needed.

---

## 3) Module Relationships
- Shared identity + membership anchors all modules.
- Reports can create downstream tasks/work orders/incidents.
- Incidents trigger compliance workflow and notification escalation.
- Certifications gate scheduling eligibility.
- SOP acknowledgements influence compliance dashboards.
- Work orders linked to assets and optionally to incident root causes.
- Checklists can auto-generate defects -> work orders.

---

## 4) Role Permission Design
- **System roles**: Platform Admin, Org Admin, Facility Admin.
- **Operational roles**: Director, Operations Manager, Scheduler, Supervisor, Frontline Staff, Maintenance Tech, Safety/Compliance Officer, HR/Training Coordinator, Read-only Auditor.
- Permission model:
  - `module.resource.action` (e.g., `incidents.report.create`, `work_orders.assign`, `sop.publish`).
- Scope model:
  - Facility-wide
  - Department-scoped
  - Self-only (own shifts, own tasks)

---

## 5) Recommended Folder Structure

```text
apps/
  web/ (Next.js)
    app/
      (public)/
      (auth)/
      (dashboard)/[facilitySlug]/
        scheduling/
        reports/
        incidents/
        maintenance/
        training/
        sops/
        comms/
        settings/
    components/
      ui/
      forms/
      charts/
      mobile/
    modules/
      scheduling/
      reports/
      incidents/
      maintenance/
      training/
      sops/
      comms/
      checklists/
    lib/
      auth/
      rbac/
      offline/
      api/
      realtime/
      pdf/
      exports/
      validation/
packages/
  db/ (schema, migrations, seeds, SQL helpers)
  types/ (shared TS domain types)
  config/ (feature flags, env schema)
  ui/ (design system wrappers)
  workflow/ (rules/automation engine)
supabase/
  migrations/
  seed/
  functions/
    notify/
    pdf-render/
    csv-export/
    workflow-dispatch/
    nightly-compliance/
```

---

## 6) API Architecture
- Pattern: BFF + domain service classes.
- API surface:
  - Next.js route handlers for client-safe operations.
  - Edge Functions for elevated tasks and cron jobs.
- Use Zod validation at boundary.
- Idempotency keys for form submits, incident creation, work order updates.
- Pagination: cursor-based by `(created_at, id)`.
- API versioning: `/api/v1/...` with additive change policy.

---

## 7) Realtime Architecture
- Supabase Realtime channels per facility and module topic:
  - `facility:{facility_id}:incidents`
  - `facility:{facility_id}:work_orders`
  - `facility:{facility_id}:schedule`
- Presence channels for shift handoff, dispatch board, incident commander mode.
- Throttle and coalesce UI updates to reduce mobile battery/data use.

---

## 8) Notification Architecture
- Event-driven outbox -> notification dispatcher pipeline.
- Channels: in-app, email (transactional provider), optional SMS/push.
- Template engine with liquid-style variables.
- Escalation policies:
  - SLA breach -> supervisor -> manager -> director.
- Quiet hours + digest batching for low-priority alerts.

---

## 9) Offline Architecture
- PWA with service worker caching app shell and reference data.
- IndexedDB stores:
  - `entities_cache`
  - `form_drafts`
  - `mutation_queue`
  - `sync_state`
- Queue item format includes `client_mutation_id`, `base_version`, `retry_count`.
- Sync strategy:
  1. optimistic local write
  2. enqueue mutation
  3. background sync with exponential backoff
  4. server returns canonical row + version
  5. conflict resolution (field-level merge + human review queue for severe conflicts)

---

## 10) Deployment Architecture
- Hosting: Vercel (web) + Supabase project(s) per environment.
- Environments: `dev`, `staging`, `prod`, optional `preview` branches.
- CI/CD:
  - typecheck, lint, tests, migration checks.
  - gated production deploy after staging smoke tests.
- Background jobs:
  - scheduled Edge Functions for daily summaries, compliance checks, certificate expiry reminders.

---

## 11) Security Architecture
- Supabase Auth with MFA options for admins.
- Short-lived JWT access + secure refresh handling.
- RLS enforced for all table access (including selects).
- Signed URLs for sensitive storage objects; strict bucket policies.
- PII minimization in incident reports where possible.
- Immutable audit events and admin action logging.
- Secrets via environment manager; no secrets in client bundle.

---

## 12) Scaling Strategy
- Scale vector assumptions:
  - 2,000 facilities
  - 50–300 users/facility
  - bursty shift/report times
- Tactics:
  - read-heavy caching for reference tables (SOP metadata, templates).
  - async report exports via job queue.
  - partition and archive old audit/log data.
  - isolate noisy tenants with workload governance and query monitoring.
- Future split candidates:
  - notification service
  - export/reporting service
  - analytics warehouse pipeline

---

## 13) MVP Scope (90–120 days)
- Must-have modules:
  1. Facilities/users/employees/roles
  2. Scheduling (basic shift publish + assignment)
  3. Daily operational reports (configurable templates)
  4. Incident reporting
  5. Maintenance work orders
  6. Communications + tasks
  7. Certifications (expiry tracking)
- Must-have platform capabilities:
  - mobile PWA, offline form queue, RBAC, notification basics, PDF export for incident/daily report.

---

## 14) Phased Roadmap
- **Phase 0 (2–4 weeks): Foundations**
  - tenancy model, RLS helpers, auth/membership, design system, offline core.
- **Phase 1 (6–8 weeks): Core Ops MVP**
  - scheduling, daily reports, incidents, work orders, tasks/comms.
- **Phase 2 (4–6 weeks): Compliance & polish**
  - certifications/training, SOP acknowledgements, advanced alerts, CSV/Excel exports.
- **Phase 3 (4–8 weeks): Vertical specialization**
  - ice/refrigeration/air-quality modules, advanced checklist automation.
- **Phase 4 (ongoing): Scale optimization**
  - performance tuning, tenancy analytics, enterprise admin controls, SSO/SCIM.

---

## 15) Implementation Priorities (Execution Order)
1. Tenant-aware auth + facility membership model.
2. Permission engine + RLS policies + policy test harness.
3. Shared design system + app shell + navigation.
4. Offline infrastructure (IndexedDB queue + sync orchestration).
5. Report template builder + submission runtime.
6. Incident + work order lifecycle and linkage.
7. Notification pipeline and SLA/escalation rules.
8. PDF/email export infrastructure.
9. Certification/training compliance logic.
10. Realtime subscriptions per module.
11. Admin configuration panels.
12. Observability (audit explorer, SLO dashboards).

## Non-goals guardrails
- No payroll calculations.
- No POS or transactions ledger.
- No full reservations/membership CRM.
- Integrate with those systems via APIs/webhooks only.
