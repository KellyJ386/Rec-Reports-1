# Recreation-Focused Scheduling System Design (Simplified, Production-Grade)

## Scope & Constraints
Inspired by SubItUp, WhenToWork, and Deputy, but intentionally simplified for recreation operations.

### Included
- Recurring full-time schedules
- Part-time scheduling
- Open shifts
- Shift swaps
- Manager approvals
- Certification validation
- Department filtering
- Role-based visibility
- Mobile-first schedule UX
- Printable weekly schedules
- Conflict detection
- Time-off requests
- Availability tracking
- Notifications
- Schedule publishing

### Explicitly excluded
- Payroll
- Clock-in/out
- Labor forecasting
- Advanced union rules

---

## 1) Scheduling Architecture

### 1.1 Domain model layers
1. **Template layer**
   - recurring patterns for full-time baseline staffing (e.g., M–F 6a–2p Ice Tech).
2. **Planning layer**
   - schedule drafts generated from templates + part-time/open shift fills.
3. **Approval/publish layer**
   - manager review, certification validation, conflict checks.
4. **Distribution layer**
   - publish to staff feeds, printable weekly output, notifications.
5. **Change-management layer**
   - swaps, pickup requests, time-off impacts, partial re-publish.

### 1.2 Key architecture components
- **Schedule Engine**: creates schedule instances from recurring rules.
- **Rules Engine (simple)**: validates certifications, overlaps, availability, and department/role constraints.
- **Approval Service**: manager decisioning for swaps/open-shift claims/time-off.
- **Publishing Service**: immutable publish versioning + audience targeting.
- **Notification Service**: event-driven notices for actionable changes.
- **Realtime Update Broker**: pushes schedule deltas to active clients.

### 1.3 Multi-tenant boundary
- Tenant boundary = `facility_id`.
- All schedule artifacts are facility-scoped.
- Cross-facility visibility is denied by RLS unless explicit org-admin context exists.

---

## 2) Database Schema (Scheduling Focus)

### 2.1 Core scheduling tables
- `schedule_periods`
  - id, facility_id, department_id nullable, week_start_date, week_end_date, status(`draft|review|published|archived`), publish_version, metadata
- `shift_templates`
  - id, facility_id, department_id, role_code, recurrence_rule, start_time_local, end_time_local, days_of_week int[], required_certification_ids uuid[], active
- `schedule_shifts`
  - id, facility_id, schedule_period_id, department_id, role_code, shift_date, starts_at, ends_at, source(`template|manual`), status(`draft|open|assigned|published|cancelled`), required_certification_ids uuid[], notes
- `shift_assignments`
  - id, facility_id, shift_id, employee_id, assignment_type(`primary|cover`), status(`pending|approved|declined|cancelled`), assigned_by
- `open_shift_claims`
  - id, facility_id, shift_id, claimant_employee_id, claim_status(`pending|approved|denied|withdrawn`), manager_id, decided_at
- `shift_swap_requests`
  - id, facility_id, offered_assignment_id, requested_assignment_id nullable, requester_employee_id, target_employee_id nullable, swap_type(`direct|drop_pickup`), status(`pending|approved|denied|cancelled|expired`), reason
- `time_off_requests`
  - id, facility_id, employee_id, starts_at, ends_at, request_type(`vacation|sick|unpaid|other`), status(`pending|approved|denied|cancelled`), manager_id, decision_notes
- `employee_availability`
  - id, facility_id, employee_id, weekday int, available_start_local, available_end_local, unavailable boolean, effective_from, effective_to nullable
- `schedule_publications`
  - id, facility_id, schedule_period_id, publish_version, published_at, published_by, change_summary jsonb

### 2.2 Supporting shared tables (used by scheduling)
- `employees` (facility scoped)
- `departments`
- `certification_types`
- `employee_certifications`
- `roles`, `permissions`, `user_role_assignments`
- `notifications`

### 2.3 Audit/soft delete fields everywhere
Each table includes:
- `created_at`, `updated_at`, `created_by`, `updated_by`
- `deleted_at`, `deleted_by`

---

## 3) UI Layout Recommendations

### 3.1 Manager schedule workspace (mobile-first + desktop scale)
- **Top bar**: facility selector (if permitted), department filter, week picker, status badge.
- **Primary views**:
  1. **Week Grid** (desktop): days as columns, roles/positions as rows.
  2. **Day Timeline** (mobile): collapsible department sections.
  3. **Open Shift Board**: card list sorted by urgency/start time.
- **Right-side (desktop) / bottom sheet (mobile)**:
  - conflict panel
  - certification warnings
  - pending approvals queue
- **Action bar**:
  - Auto-fill from templates
  - Validate
  - Save Draft
  - Publish
  - Print weekly PDF

### 3.2 Employee self-service UI
- “My Schedule” list/calendar toggle.
- “Pick Up Open Shifts” tab.
- “Request Swap” quick action from assigned shift.
- “Submit Time Off” flow with status tracker.
- “Availability” simple weekly editor.

### 3.3 Printable weekly schedule
- Department-separated pages.
- Optional role grouping.
- Legend for open/changed shifts.
- Signature block for posted hardcopy compliance.

---

## 4) Workflow Diagrams (Text)

### 4.1 Draft-to-publish flow
1. Generate draft from recurring templates.
2. Fill uncovered shifts (manual assignment/open shifts).
3. Run validation (conflicts, certifications, availability, time-off overlaps).
4. Resolve issues or override with manager reason.
5. Submit for review (optional for multi-manager environments).
6. Publish version N.
7. Send notifications + realtime refresh.

### 4.2 Open shift lifecycle
1. Manager marks shift as open.
2. Eligible employees notified.
3. Employees claim.
4. Manager approves one claim.
5. Shift assignment created/updated.
6. Others notified of closure.

### 4.3 Swap lifecycle
1. Employee requests direct or drop/pickup swap.
2. System validates both employees' certifications/availability/conflicts.
3. Manager approves or denies.
4. Approved -> assignment updates atomically.
5. Change logged and stakeholders notified.

---

## 5) Approval Workflows

### 5.1 Approval objects
- `open_shift_claims`
- `shift_swap_requests`
- `time_off_requests`
- Optional `schedule_publication_approval` (if policy requires dual approval)

### 5.2 Approval rules
- Department managers can approve only within their scope.
- Facility admins can approve any department.
- Denial reason required for auditability.
- Expiration window configurable (e.g., swap request auto-expires in 24h).

### 5.3 Escalation
- If pending beyond SLA (e.g., 8h), escalate to next-role manager.

---

## 6) Notification Logic

### Event -> audience mapping
- Schedule published -> all assigned staff in period/department.
- Shift changed after publish -> affected employees + managers.
- Open shift posted -> eligible employees by role/certification/availability.
- Open shift claimed -> manager approval queue.
- Swap requested -> target employee (if direct) + manager.
- Swap approved/denied -> requester + affected parties.
- Time-off submitted -> manager.
- Time-off decision -> requester.

### Notification channels
- In-app realtime (default)
- Email digest for non-urgent events
- Push (optional) for urgent changes within X hours of shift start

### Noise controls
- Deduplicate repeated events in short windows.
- Quiet hours with emergency bypass for near-term coverage gaps.

---

## 7) Realtime Strategy (Supabase)

### 7.1 Channels
- `facility:{facility_id}:schedules`
- `facility:{facility_id}:approvals`
- `facility:{facility_id}:open_shifts`
- `facility:{facility_id}:my_schedule:{employee_id}`

### 7.2 Event payload strategy
- Send minimal deltas (`entity`, `id`, `change_type`, `changed_fields`, `version`).
- Clients re-fetch specific records when needed.

### 7.3 Consistency
- Published schedule reads by `publish_version`.
- Optimistic UI allowed for draft actions; authoritative state returned by server.

---

## 8) Mobile UX Recommendations

1. Prioritize day view over complex week grid on small screens.
2. Use sticky “Next Shift” card at top of employee home.
3. One-thumb actions: claim, swap request, time-off request.
4. Offline draft support for manager edits with sync queue.
5. Badge-based conflict warnings instead of modal overload.
6. Reduce typing with presets/templates and quick-reason chips.

---

## 9) Admin Controls

- Scheduling settings by facility/department:
  - publish cadence (weekly/bi-weekly)
  - approval requirements
  - max hours per day/week warnings
  - conflict thresholds
  - open-shift claim window
- Certification policy:
  - hard-block vs warning for expired certs
- Visibility controls:
  - who can view all schedules vs own department vs own shifts
- Notification policy:
  - required channels by event type

---

## 10) API Endpoints (BFF + Edge)

### Manager endpoints
- `POST /api/v1/schedules/generate`
- `GET /api/v1/schedules?facility_id=&department_id=&week_start=`
- `PATCH /api/v1/schedules/{period_id}/shifts/{shift_id}`
- `POST /api/v1/schedules/{period_id}/validate`
- `POST /api/v1/schedules/{period_id}/publish`
- `POST /api/v1/schedules/{period_id}/print`

### Employee endpoints
- `GET /api/v1/me/schedule?week_start=`
- `GET /api/v1/open-shifts?department_id=`
- `POST /api/v1/open-shift-claims`
- `POST /api/v1/shift-swaps`
- `POST /api/v1/time-off-requests`
- `PUT /api/v1/me/availability`

### Approval endpoints
- `GET /api/v1/approvals?type=&status=`
- `POST /api/v1/approvals/open-shift-claims/{id}/approve`
- `POST /api/v1/approvals/shift-swaps/{id}/approve`
- `POST /api/v1/approvals/time-off/{id}/approve`
- matching `/deny` endpoints

---

## 11) Supabase Table Design Notes

### 11.1 RLS baseline
- All scheduling tables include `facility_id`.
- SELECT policy: facility membership + `deleted_at is null`.
- INSERT/UPDATE/DELETE soft-delete policy: permission checks via `has_permission(facility_id, '<permission_code>')`.

### 11.2 Suggested permission codes
- `scheduling.view.all`
- `scheduling.view.department`
- `scheduling.view.self`
- `scheduling.manage.drafts`
- `scheduling.publish`
- `scheduling.approve.swaps`
- `scheduling.approve.time_off`
- `scheduling.manage.open_shifts`

### 11.3 Critical indexes
- `schedule_shifts(facility_id, shift_date, department_id) where deleted_at is null`
- `shift_assignments(facility_id, employee_id, status) where deleted_at is null`
- `open_shift_claims(facility_id, claim_status, created_at desc) where deleted_at is null`
- `shift_swap_requests(facility_id, status, created_at desc) where deleted_at is null`
- `time_off_requests(facility_id, employee_id, status, starts_at) where deleted_at is null`
- `employee_availability(facility_id, employee_id, weekday) where deleted_at is null`

---

## 12) Edge Cases

1. **Certification expires mid-schedule period**
   - flag impacted future assignments; optionally auto-open shifts.
2. **Employee assigned while time-off pending, then approved**
   - assignment conflict generated; manager forced resolution.
3. **Double-claim race on open shift**
   - transactionally approve first valid claimant, auto-deny rest.
4. **Swap approved but target shift deleted/changed**
   - approval action re-validates current state before commit.
5. **Part-time availability changed after assignment**
   - warning only or forced review based on policy.
6. **Department transfer mid-week**
   - preserve historical assignment department snapshot on shift record.
7. **Publish while unresolved warnings**
   - require override reason and log audit entry.
8. **DST/timezone transition**
   - store shift timestamps in UTC plus facility timezone display.
9. **Manager out-of-office**
   - delegated approver chain for SLA compliance.

---

## 13) Scalability Concerns (2,000+ facilities)

1. **Hot time windows**
   - Publish and Sunday-night edits create spikes; queue non-critical jobs (emails/PDFs).
2. **Partition strategy**
   - Monthly partition large audit/event tables and older schedule history.
3. **Index discipline**
   - Prefer partial indexes on active rows (`deleted_at is null`).
4. **Realtime fan-out**
   - send deltas, not full schedules; segment channels by facility and employee.
5. **Conflict-check performance**
   - precompute employee week windows for overlap checks during publish.
6. **Template expansion cost**
   - run schedule generation in async jobs for large departments.
7. **Reporting/read load**
   - cache rendered weekly schedule snapshots by publish_version.

---

## Minimal MVP for Scheduling Module
- Recurring template generation
- Draft schedule editing
- Open shifts + claims
- Swap requests + manager approval
- Time-off requests + manager approval
- Publish + notifications + printable weekly export
- Role-based visibility + certification conflict checks
