# Rec Reports — Master Prompt and Production Readiness Plan

## 1) Master Implementation Prompt

Use the following prompt to drive implementation work in a new engineering session or with an AI coding agent:

> You are building **Rec Reports**, a production-grade recreation operations SaaS platform for multi-facility recreation, arena, aquatics, parks, and community operations teams. Configure and complete the product so it can be safely sent to production.
>
> Use the existing platform documents as source-of-truth context:
> - `PLATFORM_ARCHITECTURE.md` for architecture, tenancy, database, security, and module boundaries.
> - `POSTGRES_SUPABASE_SCHEMA.md` for Supabase/Postgres schema expectations.
> - `PHASED_MVP_ROADMAP.md` for MVP scope, delivery order, testing, deployment, and pilot goals.
> - Module design documents for daily reports, scheduling, incidents, communications/training, and admin controls.
>
> Your goal is to deliver a production-ready MVP, not a prototype. Prioritize security, tenant isolation, reliability, auditability, and operability. Implement a modular monolith first, with strict `facility_id` scoping, Supabase RLS, role-based permissions, typed API contracts, mobile-first UI, file storage, notifications, audit events, seeded demo data, CI checks, staging deployment, production deployment, and launch runbooks.
>
> Work in small, reviewable increments. For each increment: identify the acceptance criteria, update implementation, add or update tests, run the relevant checks, document configuration steps, and leave the repository in a deployable state.

## 2) Definition of Production Ready

Rec Reports is ready for production only when all of the following are true:

1. **Core workflows are complete**: scheduling, daily reports, incidents, maintenance work orders, communications, training/certification tracking, and admin configuration are usable end-to-end.
2. **Tenant isolation is enforced**: every tenant-scoped table uses `facility_id`, RLS policies are enabled, and tests prove users cannot access another facility's data.
3. **Authentication and authorization are complete**: users can sign in, switch facility context, and only perform actions allowed by role and permission.
4. **Operational data is durable**: forms, attachments, generated exports, audit events, and notifications persist correctly.
5. **The app is deployable**: environments, secrets, migrations, seed data, build scripts, CI, and deployment settings are documented and repeatable.
6. **The app is observable**: errors, logs, audit events, business KPIs, and deployment health can be monitored.
7. **The app has recovery paths**: backups, rollback steps, incident response, and support escalation are documented.
8. **The user experience is pilot-ready**: frontline workflows are mobile-first, fast, clear, and validated through smoke tests.

## 3) Production Configuration Workstreams

### 3.1 Repository and Application Foundation

**Objective:** Establish a clean application structure that supports production delivery.

**Tasks:**
- Confirm the app stack and package manager.
- Create or finalize the web app structure, shared packages, scripts, linting, formatting, and test framework.
- Add typed environment variable validation.
- Add `.env.example` with all required variables and safe placeholder values.
- Add developer setup documentation.
- Add production build and start scripts.

**Acceptance criteria:**
- A fresh developer can clone, configure environment variables, run migrations, seed sample data, start the app, and run tests from documentation alone.
- CI can install dependencies, lint, type-check, test, and build.

### 3.2 Supabase and Database Configuration

**Objective:** Configure the data layer for secure multi-tenant operation.

**Tasks:**
- Implement migrations for organizations, facilities, departments, users, memberships, roles, permissions, reports, scheduling, incidents, work orders, communications, training, attachments, audit events, outbox events, and sync receipts.
- Enable RLS on every tenant-scoped table.
- Add SQL helper functions such as `current_facility_ids()` and `has_permission(user_id, facility_id, permission_code)`.
- Add indexes for facility-scoped lists, open work, report status dashboards, and audit/event lookup.
- Add seed data for a demo organization, facilities, departments, roles, employees, templates, shifts, reports, incidents, work orders, and training items.
- Add migration verification scripts.

**Acceptance criteria:**
- Migrations apply cleanly to an empty database.
- RLS test fixtures prove cross-facility reads and writes fail.
- Seed data supports all MVP smoke-test journeys.

### 3.3 Authentication, Tenancy, and RBAC

**Objective:** Ensure every user action is authenticated, tenant-scoped, and permission-checked.

**Tasks:**
- Configure Supabase Auth providers required for launch.
- Implement invitation/onboarding flow.
- Implement active facility context selection.
- Implement role and permission middleware/helpers.
- Protect all route handlers and pages that require authentication.
- Add admin screens for memberships and role assignment.

**Acceptance criteria:**
- Anonymous users cannot access protected routes or APIs.
- Authenticated users only see facilities where they have active membership.
- Permission tests cover read, create, update, delete, export, publish, and admin actions.

### 3.4 Daily Reports Module

**Objective:** Make daily operational reporting configurable and reliable.

**Tasks:**
- Implement report templates with simple configurable schemas.
- Implement report submission forms with validation, save/submit states, and attachment support.
- Implement dashboard views for submitted, missing, late, and draft reports.
- Implement report export and audit logging.
- Add reminders for missing reports.

**Acceptance criteria:**
- A supervisor can submit a daily report with required fields and attachments.
- A manager can see compliance status by date, department, and facility.
- Report submissions are immutable after final submission unless reopened by an authorized role.

### 3.5 Scheduling Module

**Objective:** Provide baseline schedule visibility and conflict checks.

**Tasks:**
- Implement shift templates, weekly schedule board, shifts, and assignments.
- Add staff assignment and unassignment flows.
- Add conflict checks for double-booking, unfilled critical roles, and basic certification gaps.
- Add schedule dashboard cards for today's coverage.

**Acceptance criteria:**
- A scheduler can create and staff a weekly schedule.
- The system warns on double-booking and missing critical coverage.
- Staff can view their own upcoming shifts.

### 3.6 Incident and Accident Reporting

**Objective:** Capture incidents safely and support follow-up compliance.

**Tasks:**
- Implement incident form, severity/type classification, people involved, evidence attachments, and status workflow.
- Implement follow-up actions with owners and due dates.
- Implement incident summary export.
- Add escalation notifications for high-severity incidents.
- Audit all material changes.

**Acceptance criteria:**
- Staff can file an incident from mobile.
- Safety/compliance users can triage, assign actions, and export summaries.
- High-severity incidents create visible alerts and notification records.

### 3.7 Maintenance Work Orders

**Objective:** Turn operational issues into trackable maintenance work.

**Tasks:**
- Implement work order creation manually and from reports/incidents.
- Implement priority, status, assignment, due date, updates, comments, and attachments.
- Implement work order dashboard filters for open, overdue, assigned, and high priority.
- Add audit events for status changes.

**Acceptance criteria:**
- Authorized users can create, assign, update, and close work orders.
- Linked report/incident context is visible from the work order.

### 3.8 Communications and Notifications

**Objective:** Support critical communication with acknowledgements.

**Tasks:**
- Implement channels, announcements, direct operational messages, read receipts, and required acknowledgement.
- Implement in-app notification center.
- Configure email and push provider abstractions if needed for launch.
- Implement outbox processing for notification delivery.

**Acceptance criteria:**
- Managers can publish priority announcements to targeted audiences.
- Staff can acknowledge required messages.
- Notification delivery failures are visible and retryable.

### 3.9 Training and Certifications

**Objective:** Track required training and operational certifications.

**Tasks:**
- Implement certification types, employee certifications, evidence uploads, expiry tracking, and renewal windows.
- Implement manual training assignment and completion tracking.
- Surface certification conflicts in scheduling.
- Add expiry notifications.

**Acceptance criteria:**
- HR/training users can assign and track required items.
- Managers can view expiring and expired certifications.
- Schedulers see warnings when assigning staff without required certifications.

### 3.10 Master Admin and Facility Configuration

**Objective:** Allow administrators to configure each facility without engineering intervention.

**Tasks:**
- Implement organization/facility settings.
- Implement department management.
- Implement role and permission management.
- Implement report template management.
- Implement notification preference defaults.
- Implement branding and basic tenant settings if required for launch.

**Acceptance criteria:**
- Facility admins can configure departments, memberships, reports, roles, and notification defaults.
- Admin actions are audited.

## 4) Quality, Security, and Compliance Gates

### 4.1 Automated Checks

Required CI checks before production:
- Install dependencies from lockfile.
- Lint.
- Format check.
- Type-check.
- Unit tests.
- API/integration tests.
- RLS/tenant-isolation tests.
- E2E smoke tests.
- Production build.
- Migration dry run against a clean database.

### 4.2 Security Review

Required security checklist:
- No service-role key exposed to client code.
- RLS enabled and tested on all tenant tables.
- Storage buckets have least-privilege policies.
- API handlers validate facility membership and permission.
- File uploads validate type, size, ownership, and access policy.
- Secrets are stored in the deployment provider, not in source control.
- Audit events are written for admin, incident, report finalization, export, work order, and permission changes.

### 4.3 Data Protection

Required data safeguards:
- Daily database backups configured.
- Backup restore procedure tested.
- Attachment storage retention policy documented.
- Audit retention policy documented.
- Production data access policy documented.

## 5) Deployment Plan

### 5.1 Environments

Configure three environments:

1. **Development** for local and branch-level work.
2. **Staging** for production-like validation with seeded demo data.
3. **Production** for live customer data.

Each environment needs:
- Supabase project URL and anon key.
- Server-only service role key.
- Database connection string for migrations.
- Storage buckets.
- Auth redirect URLs.
- Email/push provider secrets if enabled.
- App base URL.
- Observability DSN/API keys.

### 5.2 Release Sequence

1. Freeze scope for MVP production launch.
2. Apply migrations to staging.
3. Seed staging with realistic facility data.
4. Run full CI and E2E smoke suite.
5. Complete manual UAT for the top workflows.
6. Fix launch-blocking defects.
7. Tag a release candidate.
8. Apply migrations to production.
9. Configure production secrets and auth redirects.
10. Deploy production build.
11. Run production smoke tests using a test tenant.
12. Enable pilot tenant access.
13. Monitor logs, errors, notification delivery, and workflow KPIs.

### 5.3 Rollback Plan

Before every production release:
- Capture current deployed version.
- Confirm latest backup completion.
- Identify reversible and irreversible migrations.
- Prepare rollback command for app deployment.
- Prepare database remediation notes for irreversible schema changes.
- Assign release owner and incident owner.

## 6) Production Smoke-Test Journeys

Run these journeys in staging and again in production with a test tenant:

1. Sign in as facility admin.
2. Invite a supervisor and frontline staff member.
3. Create departments and assign roles.
4. Create report template.
5. Submit daily report with attachment.
6. View report dashboard and missing/submitted status.
7. Create weekly schedule and assign staff.
8. Trigger and verify a schedule conflict warning.
9. File incident with evidence.
10. Assign incident follow-up action.
11. Create work order from report or incident.
12. Update and close work order.
13. Publish required-ack announcement.
14. Acknowledge announcement as staff.
15. Assign training and mark complete.
16. Add certification with expiry date.
17. Verify audit events for critical actions.
18. Verify cross-facility data isolation with a second test facility.

## 7) Launch Blocker Checklist

Do not launch if any item below is incomplete:

- Authentication is incomplete or unprotected routes expose tenant data.
- RLS is missing on any tenant-scoped table.
- Any cross-facility access test fails.
- Migrations cannot run cleanly from an empty database.
- Production build fails.
- Core smoke-test journeys fail.
- File upload/download permissions are not enforced.
- Service-role secrets are exposed to client code.
- Backups are not configured.
- Rollback steps are not documented.
- There is no named owner for launch monitoring and incident response.

## 8) Suggested Execution Order

1. Repository/app foundation.
2. Environment validation and CI.
3. Database migrations, RLS, seed data.
4. Authentication, facility context, RBAC.
5. Shared UI shell and dashboard.
6. Daily reports.
7. Incidents.
8. Work orders.
9. Scheduling.
10. Communications and notifications.
11. Training and certifications.
12. Master admin configuration.
13. Audit, exports, attachments, and observability hardening.
14. E2E smoke tests and staging UAT.
15. Production deployment and pilot launch.

## 9) First Sprint Backlog

The first sprint should create the foundation needed for every later module:

- Choose and document app stack and package manager.
- Add environment validation and `.env.example`.
- Add CI workflow for lint, type-check, test, and build.
- Implement initial Supabase migrations for organizations, facilities, users, memberships, roles, and permissions.
- Enable RLS and add first tenant-isolation tests.
- Seed one demo organization with two facilities and baseline roles.
- Implement login, facility switcher, and protected dashboard shell.
- Document local setup and staging setup.

## 10) Final Production Handoff Package

Before handoff, produce:

- Architecture summary.
- Environment variable reference.
- Migration and seed instructions.
- Admin setup guide.
- Pilot onboarding guide.
- Support runbook.
- Backup and restore runbook.
- Release and rollback runbook.
- Known limitations and post-launch backlog.
- Evidence of completed tests and smoke-test results.
