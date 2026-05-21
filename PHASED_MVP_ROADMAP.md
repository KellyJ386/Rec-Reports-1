# Recreation Operations SaaS Platform — Phased MVP Roadmap

## Strategy Lens
This roadmap is optimized for:
1. **Fastest path to usable product**
2. **Fastest path to pilot customers**
3. **Lowest engineering complexity**
4. **Highest operational value**

Guiding principle: ship a tight operational core first (schedule + daily execution + incident/comms basics), then layer workflow depth (maintenance/training automation), then intelligence and scale.

---

## 1) MVP Scope (Phase 1: 10–14 weeks)

### 1.1 Product outcome
A facility can run day-to-day operations in one system for:
- shift scheduling visibility,
- daily reports,
- incident capture,
- critical team communication,
- baseline maintenance ticketing.

### 1.2 In-scope modules and capabilities

#### A) Scheduling (MVP)
- Shift templates and weekly schedule board.
- Assign/unassign staff to shifts.
- Role/position labels per shift.
- Basic conflict checks (double-booking, unassigned critical shifts).

#### B) Reports (MVP)
- Daily operational report submission by department.
- Configurable required fields (simple form config, not full builder yet).
- Photo/file attachment support.
- Daily report dashboard with status (submitted/missing).

#### C) Incidents (MVP)
- Incident report form with severity/type classification.
- Evidence attachment (photos/PDF).
- Basic follow-up tasks with owner + due date.
- Exportable incident summary PDF.

#### D) Maintenance (MVP-light)
- Work order creation from report/incident or manual entry.
- Priority, status, assignee, due date.
- Comment thread + attachments.

#### E) Communication (MVP)
- Department channels + all-ops channel.
- Priority announcements.
- Read receipts + required acknowledgement.
- Push + in-app notifications.

#### F) Training (MVP-light)
- Manual assignment of required training items.
- Completion tracking (complete/incomplete/date).
- Certification record storage (issue/expiry dates, evidence upload).

### 1.3 Explicitly out-of-scope for MVP
- Advanced shift optimization/auto-scheduling.
- Full drag/drop form builder.
- Complex training content authoring and quizzes.
- Advanced preventive maintenance plans.
- Sophisticated automation/rules engine.

### 1.4 Why this MVP works for pilots
- Solves daily operational pain immediately.
- Requires minimal change management for frontline teams.
- Demonstrates measurable value in 30 days (coverage, reporting compliance, incident visibility).

---

## 2) Phase 2 Scope (Weeks 15–26)

### 2.1 Product outcome
From "digitized ops" to "coordinated and compliant ops".

### 2.2 Scope expansion
- **Scheduling**: shift swap requests, time-off requests, qualification gate checks.
- **Reports**: configurable templates by department; scheduled report reminders.
- **Incidents**: escalation workflows, root-cause fields, corrective action tracking.
- **Maintenance**: recurring PM schedules, asset registry, SLA tracking.
- **Communication**: shift-targeted messaging, distribution lists, emergency mode.
- **Training**: video/PDF training modules, quizzes, passing thresholds.

### 2.3 Cross-module automations
- Incident can auto-create corrective training assignment.
- Report defects can auto-create maintenance work orders.
- Expiring certification can flag scheduling conflicts.

---

## 3) Phase 3 Scope (Months 7–12)

### 3.1 Product outcome
Multi-facility optimization and enterprise-grade governance.

### 3.2 Scope expansion
- Multi-facility benchmarking dashboards.
- Advanced permissions and delegated administration.
- Policy-driven workflows and feature flags.
- Predictive alerts (staffing risk, incident hotspots, maintenance backlog risk).
- API ecosystem + deeper HR/payroll/BI integrations.

### 3.3 Enterprise capabilities
- White-label branding controls.
- Full audit export and retention policies.
- Advanced subscription/entitlement controls.

---

## 4) Engineering Priorities

### 4.1 Priority stack (in order)
1. **Authentication, tenancy, RBAC foundation**.
2. **Core data model + API contracts for MVP modules**.
3. **Mobile-first UI shell + offline-tolerant key workflows**.
4. **Notification infrastructure (in-app + push)**.
5. **File/PDF storage and retrieval services**.
6. **Cross-module linking primitives (report↔incident↔work order)**.

### 4.2 Complexity control tactics
- Modular monolith first (single deployable, clear domain modules).
- Shared component library and standardized CRUD patterns.
- Avoid early microservices.
- Use event outbox pattern only where immediate value exists (notifications, audit).

---

## 5) Database Priorities

### 5.1 MVP-first schema order
1. Tenancy + users + memberships + roles.
2. Scheduling tables (shifts, assignments).
3. Reports tables (templates-lite, submissions).
4. Incidents tables (reports, actions, attachments links).
5. Maintenance tables (assets-lite, work orders, updates).
6. Communication tables (channels, messages, receipts, acknowledgements).
7. Training/certification baseline tables.

### 5.2 Technical priorities
- Strict `facility_id` scoping on all operational tables.
- RLS from day one.
- Indexes on `(facility_id, created_at)` and open-status queries.
- Immutable audit/event tables for compliance-critical actions.

---

## 6) UI Priorities

### 6.1 MVP UI sequence
1. Login + facility context switch.
2. Role-based home dashboard (today’s shifts, overdue reports, open incidents/work orders).
3. Fast-entry forms (report, incident, work order).
4. Schedule board.
5. Communication inbox/channel view with ack actions.

### 6.2 UX principles
- Mobile-first field operations design.
- “3-tap completion” for common tasks.
- High visibility badges for urgent/non-compliant items.
- Unified global search for people, shifts, incidents, work orders.

---

## 7) Deployment Strategy

### 7.1 Environments
- Dev → Staging → Production with seeded sample tenant data.

### 7.2 Release model
- Weekly release train during MVP build.
- Feature flags for incomplete modules.
- Blue/green or rolling deploy with fast rollback.

### 7.3 Operational readiness
- Baseline observability: logs, traces, key business metrics.
- Error budget and on-call rotation before first pilot go-live.

---

## 8) Testing Strategy

### 8.1 MVP testing pyramid
- **Unit tests** for domain services and validation.
- **API integration tests** for RBAC + RLS-sensitive operations.
- **E2E smoke tests** for top 8 user journeys:
  - create shift,
  - submit report,
  - log incident,
  - create work order,
  - send required-ack message,
  - acknowledge message,
  - assign training,
  - mark training complete.

### 8.2 Pilot-specific validation
- Synthetic load tests for shift-change traffic peaks.
- Mobile network degradation tests (slow/offline recovery).
- Security tests for tenant data isolation.

---

## 9) Pilot Rollout Strategy

### 9.1 Pilot customer profile
- 1–3 facilities per customer.
- Operationally mature but tooling-fragmented teams.
- Strong onsite champion (ops manager or GM).

### 9.2 Pilot rollout phases
1. **Week 0–1**: discovery + data import (staff, departments, baseline schedules).
2. **Week 2**: admin onboarding + supervisor training.
3. **Week 3–4**: soft launch (reports + comms + incidents).
4. **Week 5–6**: scheduling + maintenance usage ramp.
5. **Week 7–8**: KPI review, gap fixes, expansion decision.

### 9.3 Pilot success KPIs
- Daily report submission compliance > 90%.
- Incident logging latency reduced by 50%.
- Acknowledgement completion > 85% for required announcements.
- Open maintenance backlog aging reduced by 25%.

---

## 10) Scaling Plan

### 10.1 Near-term scale (0–50 facilities)
- Single regional deployment + read replicas.
- Queue-backed notifications and async exports.
- Monthly partitioning for high-volume audit/event tables.

### 10.2 Mid-term scale (50–300 facilities)
- Multi-region read strategy for latency.
- Separate worker tier for notifications/PDF generation.
- Search index for incidents/work orders/SOP content.

### 10.3 Long-term scale (300+ facilities)
- Split high-throughput services (notifications/reporting) from core app.
- Per-tenant performance guardrails and quotas.
- Data lifecycle automation and archival controls.

---

## 11) Monetization Recommendations

### 11.1 Pricing motion
- **Land-and-expand** with facility-based base fee + active employee tiers.

### 11.2 Suggested packaging
- **Core Ops (MVP)**: scheduling, reports, incidents, comms.
- **Ops Plus**: adds maintenance automation + training workflows.
- **Enterprise**: multi-facility analytics, advanced controls, premium compliance/audit exports.

### 11.3 Add-ons
- SMS notification bundles.
- Advanced incident/compliance reporting pack.
- Implementation/onboarding services.
- API/integration pack.

### 11.4 Contract strategy
- Pilot-friendly 3–6 month starter agreements.
- Annual discounts for multi-facility commitments.
- Expansion pricing tied to activated modules and facility count.

---

## 12) Staffing Recommendations

### 12.1 MVP team (lean, high velocity)
- 1 Product Manager (ops-domain strong).
- 1 Tech Lead / Staff Engineer.
- 3 Full-stack Engineers.
- 1 Mobile-lean Frontend Engineer.
- 1 QA/Automation Engineer.
- 1 Product Designer (partially embedded, high leverage).
- 1 Customer Success / Implementation Lead.

### 12.2 Phase 2 additions
- +1 Backend Engineer (workflow automation/integrations).
- +1 Data/Analytics Engineer.
- +1 Support Engineer.

### 12.3 Phase 3 additions
- SRE/Platform Engineer for scale and reliability.
- Security/Compliance specialist (shared or fractional).
- Solutions Architect for enterprise deals and integration design.

### 12.4 Operating cadence
- 2-week sprints with weekly pilot feedback loop.
- Monthly roadmap recalibration based on adoption/KPI evidence.
- Quarterly architecture reviews to decide when to split services.
