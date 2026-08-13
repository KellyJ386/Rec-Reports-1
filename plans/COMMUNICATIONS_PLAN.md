# Communications Module — Development Plan

## 1. Current state

- **Schema** (`supabase/migrations/0006_communications.sql`): `communication_channels`, `messages`, `message_audiences`, `message_receipts`, `message_acknowledgements`, `notification_jobs`, `notification_deliveries`. RLS enabled on all seven tables, but **only `communication_channels` and `messages` have both read and write (`for all`) policies** — `message_audiences` likewise has read+write for publishers, while `message_receipts` and `message_acknowledgements` have **only a SELECT policy**; there is no INSERT/UPDATE policy allowing an employee to write their own receipt or acknowledgement row.
- **Notification routing admin surface** (`supabase/migrations/0016_notifications.sql`, `src/lib/admin/notifications.mjs`, `src/lib/http/notification-routes.mjs`): `notification_events` (seeded, includes `message.ack_overdue` targeting `in_app,email,sms`), `distribution_lists`, `distribution_list_members`, `notification_routes`, plus pure helpers `resolveRoute`, `expandDistributionList`, `isWithinQuietHours`, `buildNotificationJob`. The `/notification-routes/:id/test` route inserts a row into `notification_jobs` — this is the only code path in the repo that writes to `notification_jobs`.
- **Domain lib** (`src/lib/communications.mjs`): three pure functions — `resolveMessageAudience`, `acknowledgementState`, `shouldBypassQuietHours` — unit tested in `test/communications.test.mjs`, but none of them is called from any route.
- **End-user routes** (`src/lib/http/communications-routes.mjs`, mounted in `scripts/server.mjs` under `/api/v1`): `GET /facilities/:facilityId/messages`, `GET /messages/:id`, `POST /facilities/:facilityId/messages`, `POST /messages/:id/acknowledge`. No routes exist for channels, audiences, or receipts.
- **Route tests** (`test/communications-routes.test.mjs`): cover the four routes above against a stubbed PostgREST fetch; they do not exercise real RLS, so they cannot catch the missing receipt/acknowledgement write policies.
- **UI** (`src/public/index.html` `#communications-heading` panel, `src/public/js/app.js` `loadMessages`/`acknowledgeMessage`): lists the 5 most recent messages with an "Acknowledge" button when `is_required_ack`; no compose form, channel picker, audience builder, read-receipt marking, or admin console tie-in.
- **Auth/RLS model** (`scripts/server.mjs` `buildClient`/`authenticate`): PostgREST calls use the service-role `apikey` but the **user's own JWT as `Authorization: Bearer`**, so RLS is enforced per-request-user, not bypassed — meaning the missing receipt/ack write policies are a real production bug, not just a test gap.
- **No delivery worker exists anywhere in the repo** (`grep` for `notification_jobs`/`notification_deliveries` outside migrations/tests/admin-routing turns up nothing) — jobs are inserted but never processed into `notification_deliveries` or an actual push/SMS/email send.

## 2. Gap analysis

| Design-doc capability | Design doc ref | Implemented today | Gap |
|---|---|---|---|
| Audiences (role/department/shift/employee targeting) | §2.2 `message_audiences`, §3.1 | Table + RLS exist; `resolveMessageAudience` is unit-tested pure logic | No route to create/list `message_audiences`; `resolveMessageAudience` never called by any route; no persistence of resolved recipient snapshot |
| Read receipts | §2.2 `message_receipts`, §4 | Table exists | No route to mark delivered/read; **no INSERT/UPDATE RLS policy** — even if a route existed, employee self-writes would be denied |
| Required acknowledgement | §3.3, §2.2 `message_acknowledgements` | `POST /messages/:id/acknowledge` inserts a row; `acknowledgementState` pure fn exists | **No INSERT policy on `message_acknowledgements`** — route is broken under real RLS; no escalation ladder (reminder/supervisor/manager); no `GET` to read ack rollup per message |
| Channels (department/facility/shift/emergency) | §2.2 `communication_channels`, §3.2 | Table + full RLS (read/publish) | No CRUD routes at all; UI has no channel picker; messages can only reference a channel id the caller already knows |
| Priority / emergency messaging | §3.4, `shouldBypassQuietHours` | Priority enum on `messages`, `emergency_enabled` on channels, `shouldBypassQuietHours` pure fn | Not wired to any delivery path; no emergency composer, no "I am safe / need assistance" confirmation workflow, no multi-channel burst |
| Delivery via notification worker | §5 | `notification_jobs`/`notification_deliveries` tables + RLS; `buildNotificationJob` builds a row shape; test-sandbox route inserts one job | **No worker/cron consumes `notification_jobs`**; nothing ever writes `notification_deliveries`; no actual push/SMS/email provider integration; message publish never enqueues a job |
| Ack compliance reporting | §6 (adapted), §8.1 Analytics | `message_acknowledgements_state_idx` exists | No aggregate/rollup endpoint (per-message or per-facility ack/read rates); no admin analytics view |
| Shift-targeted messaging (Phase 2) | §11.2 | `shift` audience type defined in schema/domain lib | No live scheduling integration; audience resolution not connected to `shift_assignments` at request time |
| Emergency mode (Phase 2) | §3.4 | Schema flags only | No bypass-quiet-hours enforcement in a delivery path, no confirmation/response tracking table or route |

## 3. Phased task list

### Phase M1 — MVP-complete (channels, audiences, receipts, working acks, basic delivery, push/in-app per roadmap "Communication (MVP)")

**CM-01 — Fix RLS: allow self-service INSERT/UPDATE on `message_receipts` and `message_acknowledgements`**
- Files: new `supabase/migrations/00XX_communications_self_service_rls.sql`; `supabase/tests/communications_self_service.sql`
- Acceptance: an authenticated employee (any membership with `communications.read` on the message's facility) can `insert`/`update` their **own** (`employee_id = auth.uid()`-mapped) `message_receipts` row and their own `message_acknowledgements` row; cannot write another employee's row; cannot write across facility (`fn_assert_same_facility`-style check against `messages`); publishers retain full manage via `communications.publish` (e.g. `manager_override` ack, waive).
- Tests: RLS SQL file mirroring `supabase/tests/forms_and_notifications.sql` style — allowed self-insert, denied cross-employee insert, denied cross-facility insert, denied read-only-permission escalation.
- Size: M

**CM-02 — `message_audiences` CRUD routes**
- Files: `src/lib/http/communications-routes.mjs`, `test/communications-routes.test.mjs`
- Acceptance: `GET /messages/:id/audiences`, `POST /messages/:id/audiences` (bulk array of `{audienceType, audienceRefId}`, validated against the four allowed types), guarded by `communications.publish` on the message's facility; inserted rows carry `facility_id` from the parent message.
- Tests: unit route tests (happy path shape, 400 on invalid `audienceType`, 403 for non-publisher, facility mismatch).
- Size: S

**CM-03 — Wire `resolveMessageAudience` into publish flow**
- Files: `src/lib/communications.mjs` (extend to accept live rows shape), `src/lib/http/communications-routes.mjs`
- Acceptance: `POST /facilities/:facilityId/messages/:id/publish` (new endpoint, separate from create) loads `message_audiences`, resolves recipients via department/shift/employee lookups, sets `published_at`, and returns resolved recipient count.
- Tests: unit tests on the resolver against realistic row shapes (snake_case from PostgREST) in addition to existing camelCase pure-fn tests; route test for publish happy path + 403.
- Size: M

**CM-04 — `communication_channels` CRUD routes**
- Files: `src/lib/http/communications-routes.mjs`, `test/communications-routes.test.mjs`
- Acceptance: `GET /facilities/:facilityId/channels`, `POST /facilities/:facilityId/channels` (name, type, department_id, shift_scoped, emergency_enabled), guarded read/publish exactly as migration 0006 policies; unique `(facility_id, name)` violation surfaces as 409/400.
- Tests: route tests for list/create, permission denial, duplicate-name error mapping.
- Size: S

**CM-05 — Receipts routes (delivered/read marking)**
- Files: `src/lib/http/communications-routes.mjs`, `test/communications-routes.test.mjs`
- Acceptance: `POST /messages/:id/receipt` upserts (`onConflict: "message_id,employee_id"`, `merge: true`, mirroring the `organization_module_settings` upsert pattern in `scripts/server.mjs`) `delivered_at`/`read_at` for `auth.claims.sub`; guarded by `communications.read`.
- Tests: upsert shape assertion, 403 for non-member, idempotent double-call.
- Size: S

**CM-06 — Notification delivery worker (v1: in-app only)**
- Files: new `scripts/notification-worker.mjs` (cron-invoked, mirrors script conventions), new `src/lib/notifications/deliver.mjs`
- Acceptance: polls `notification_jobs` where `status='pending'`, for each job expands `payload_jsonb.recipients` (falling back to `expandDistributionList`/`resolveMessageAudience` when only a route/list is given), inserts one `notification_deliveries` row per recipient per channel with `channel='in_app'` marked `sent`, updates job `status='sent'`/`attempts+=1`, and enqueues a job automatically whenever a message is published (hook into CM-03's publish route) using `buildNotificationJob`.
- Tests: unit tests for the pure expansion/shaping helpers in `src/lib/notifications/deliver.mjs`; an integration-style test using the same stub-fetch harness as `test/communications-routes.test.mjs` to assert `notification_deliveries` rows are written with correct shape.
- Size: L

**CM-07 — Push notification channel (device token registration + send)**
- Files: new migration for `employee_notification_preferences`/device tokens (design §2.7, currently absent from 0006), `src/lib/notifications/deliver.mjs`, `src/lib/http/communications-routes.mjs` or new `notification-preferences-routes.mjs`
- Acceptance: employee can register a push token; worker (CM-06) marks `channel='push'` deliveries `sent` via a provider adapter interface (stubbed/no-op adapter acceptable for MVP, real APNS/FCM deferred); quiet-hours check via `isWithinQuietHours` + `shouldBypassQuietHours` gates non-urgent push.
- Tests: RLS test for preference table (self-write only), unit tests for quiet-hours gating.
- Size: M

**CM-08 — UI: compose message + channel/audience picker**
- Files: `src/public/index.html`, `src/public/js/app.js`
- Acceptance: publisher-role users see a compose form (channel select populated from CM-04, subject/body/priority/required-ack toggle, audience picker calling CM-02) that POSTs via CM-03's publish flow; non-publishers do not see the form (mirrors existing progressive-disclosure pattern used for the Acknowledge button).
- Tests: manual QA (no JS unit test harness for `app.js` currently exists in `test/`).
- Size: M

**CM-09 — UI: read-receipt auto-marking + ack state display**
- Files: `src/public/js/app.js`
- Acceptance: `loadMessages` calls the CM-05 receipt endpoint on render (delivered) and on visible/click (read); message card shows ack state (`pending`/`overdue`/`complete`) using `acknowledgementState`-equivalent server-provided field.
- Size: S

### Phase M2 — Design-complete (priority/emergency messaging, escalation, shift targeting, ack compliance reporting)

**CM-10 — Required-acknowledgement escalation ladder**
- Files: `scripts/notification-worker.mjs` (extend), `src/lib/communications.mjs` (add escalation-tier pure fn), new migration column(s) if `message_acknowledgements` needs an `escalation_tier` marker
- Acceptance: scheduled job scans messages with `is_required_ack=true` past `ack_due_at`, transitions `message_acknowledgements.ack_state` pending→overdue, and emits `notification_jobs` rows against the seeded `message.ack_overdue` event (T+X reminder → T+Y supervisor alert → T+Z manager escalation, per design §3.3).
- Tests: unit tests for the tier-selection pure function against fixed clocks; worker integration test asserting the right event/recipients at each tier.
- Size: L

**CM-11 — Ack/read compliance reporting endpoint**
- Files: `src/lib/http/communications-routes.mjs`, `src/lib/communications.mjs` (rollup helper)
- Acceptance: `GET /facilities/:facilityId/messages/:id/compliance` returns `{delivered, read, acknowledged, pending, overdue, total}` counts, guarded by `communications.read`; `GET /facilities/:facilityId/communications/compliance-summary` gives a facility-wide rollup for the admin analytics area referenced in design §8.1.
- Tests: unit tests for the rollup pure function; route tests for both endpoints.
- Size: M

**CM-12 — Shift-targeted messaging (scheduling integration)**
- Files: `src/lib/communications.mjs` (extend `resolveMessageAudience` to accept live `shift_assignments` query), `src/lib/http/communications-routes.mjs`
- Acceptance: audience type `shift` resolves against `shift_assignments` filtered to a caller-specified date/shift window ("current shift" / "next shift" per design §3.1) rather than the entire historical table; publish flow snapshots the resolved list at publish time (design §3.1 step 3).
- Tests: unit tests covering "current shift" vs "next shift" window edge cases (midnight rollover, multi-shift overlap).
- Size: M

**CM-13 — Emergency mode**
- Files: new migration for `emergency_alert_responses` (design "confirmation workflow" — not in 0006), `src/lib/http/communications-routes.mjs`, `src/lib/communications.mjs`
- Acceptance: `POST /facilities/:facilityId/messages/:id/emergency-broadcast` (requires `channel.emergency_enabled` and `communications.publish`) forces `priority='emergency'`, bypasses quiet hours via `shouldBypassQuietHours`, fans out push+SMS immediately via CM-06/07 worker, and exposes `POST /messages/:id/emergency-response` for employees to submit "I am safe"/"need assistance".
- Tests: RLS test for the new response table (self-write only, facility-scoped read for supervisors); route tests for broadcast gating and response submission.
- Size: L

**CM-14 — SMS/email delivery channels**
- Files: `src/lib/notifications/deliver.mjs`, provider adapter interface
- Acceptance: worker sends `channel='sms'`/`'email'` deliveries through a pluggable provider adapter (stub adapter for tests, real provider deferred to ops decision); dead-letter handling on repeated provider failure marks `notification_deliveries.status='bounced'`.
- Tests: unit tests against a fake adapter (success, failure, retry/backoff).
- Size: M

### Phase M3 — Polish / automation

**CM-15 — Outbox retry + dead-letter queue for `notification_jobs`**
- Files: `scripts/notification-worker.mjs`
- Acceptance: failed jobs retry with exponential backoff up to a configured max `attempts`, then flip to `status='failed'` and are surfaced in an admin "failed notifications" view; matches design §5.3.
- Size: M

**CM-16 — WebSocket/live unread + receipt counters**
- Files: new realtime layer (out of current zero-runtime-dependency Node stack — needs a design decision on Supabase Realtime vs custom SSE)
- Acceptance: unread counts and ack rollups update without full page reload; explicitly flagged as needing an architecture decision before sizing further.
- Size: L (spike first)

**CM-17 — Admin Comms Console (templates, emergency launch panel, audience builder UI)**
- Files: admin surface pages (mirroring `notification-routes.mjs`-backed admin UI)
- Acceptance: mirrors design §8 — template library, emergency launch button gated behind an approval step, visual audience builder over CM-02/CM-12.
- Size: L

**CM-18 — Immutable audit log coverage for comms admin actions**
- Files: migration adding `fn_audit_admin_change()` triggers to `communication_channels`, `messages` (publish/edit), `message_audiences`, mirroring the pattern already applied to `distribution_lists`/`notification_routes` in 0016.
- Acceptance: every publish/edit/emergency-broadcast/channel-change is captured in the existing audit table exactly like 0016's triggers.
- Tests: RLS/audit SQL test mirroring `supabase/tests/audit_chain.sql` or `audit_append_only.sql`.
- Size: S

## 4. Dependencies

- **Notification delivery worker (CM-06) does not exist yet** — it is the hard dependency for CM-07 (push), CM-10 (escalation), CM-13 (emergency fan-out), and CM-14 (SMS/email). Every M2 task that "sends" something is blocked on CM-06 landing first. `buildNotificationJob`/`resolveRoute`/`expandDistributionList` in `src/lib/admin/notifications.mjs` are already the correct building blocks — CM-06 is primarily wiring, not new domain logic.
- **Admin distribution lists** (`distribution_lists`/`distribution_list_members`, 0016) are already fully built and RLS-gated; CM-06/CM-10 should reuse `expandDistributionList` rather than re-deriving recipient expansion, so a distribution list can double as a comms audience (role/employee) alongside `message_audiences`.
- **Scheduling / shift data** (`shift_assignments`) is a hard dependency for CM-12 (shift-targeted messaging) and for the `shift` audience type in CM-03's publish flow; without a live "current/next shift" query, `resolveMessageAudience`'s `shift` branch can only operate on whatever is passed in, not resolve automatically.
- **CM-01 (RLS fix) blocks everything downstream that touches `message_receipts`/`message_acknowledgements` in a real (non-stubbed) environment** — it should land first in M1 regardless of task numbering, since the existing `/messages/:id/acknowledge` route is currently non-functional against real RLS.
- **CM-13 (emergency mode)** depends on CM-06/CM-07 for actual multi-channel burst delivery, and on a new `emergency_alert_responses` table that doesn't exist in 0006.
- **CM-16 (realtime)** depends on an architecture decision (Supabase Realtime channels vs. polling vs. custom SSE) not currently represented anywhere in the codebase — flagged as a spike, not estimated at task size until that decision is made.

## 5. Suggested agent/model assignment per task

| Task | Assignment | Rationale |
|---|---|---|
| CM-01 (RLS self-service fix) | **Sonnet** | Security-sensitive RLS policy design (own-row vs cross-employee/cross-facility) — needs judgment, not pattern-copy |
| CM-02 (audience CRUD routes) | **Haiku**, reviewed by Sonnet | Directly mirrors existing `distribution_list_members` route pattern in `notification-routes.mjs` |
| CM-03 (wire resolver into publish) | **Sonnet** | Cross-cuts domain lib + route + RLS assumptions; judgment call on snapshot semantics |
| CM-04 (channel CRUD routes) | **Haiku**, reviewed by Sonnet | Pure pattern-copy of existing list/create route shape |
| CM-05 (receipts upsert route) | **Haiku**, reviewed by Sonnet | Copies the `onConflict`/`merge` upsert pattern already used in `scripts/server.mjs` |
| CM-06 (delivery worker) | **Sonnet**, integration-reviewed by Opus/orchestrator | New cross-module component (jobs→deliveries→recipient expansion); needs correctness judgment and touches every downstream feature |
| CM-07 (push channel) | **Sonnet** | Auth-adjacent (device token ownership) + quiet-hours gating logic |
| CM-08/CM-09 (UI compose/receipts) | **Haiku**, reviewed by Sonnet | Follows existing `app.js` panel conventions (`loadMessages`/`loadWorkOrders` style) |
| CM-10 (escalation ladder) | **Sonnet** | Time-based tier logic with compliance implications, needs careful edge-case testing |
| CM-11 (compliance reporting) | **Haiku** for rollup route, **Sonnet** for the pure aggregation function | Route is boilerplate; correctness of the counts needs review |
| CM-12 (shift targeting) | **Sonnet** | Time-window/midnight-rollover logic, integrates with scheduling module |
| CM-13 (emergency mode) | **Sonnet**, security-reviewed by **Opus/orchestrator** | New RLS table + bypass-of-normal-controls semantics needs a dedicated security pass |
| CM-14 (SMS/email adapters) | **Sonnet** | External provider integration, error/retry semantics |
| CM-15 (retry/DLQ) | **Sonnet** | Reliability logic with production failure-mode implications |
| CM-16 (realtime spike) | **Opus/orchestrator** | Architecture decision spanning the whole stack, not a single-module task |
| CM-17 (admin console UI) | **Haiku** for scaffolding, **Sonnet** for approval-workflow gating | Bulk of the work is UI plumbing; the emergency-approval gate needs judgment |
| CM-18 (audit triggers) | **Haiku**, reviewed by Sonnet | Direct copy of the `fn_audit_admin_change()` trigger pattern from 0016 |
| Cross-phase integration review (end of M1, end of M2) | **Opus/orchestrator** | Final security/consistency pass across RLS, worker, and UI before phase sign-off |

### Critical files
- `supabase/migrations/0006_communications.sql`, `src/lib/http/communications-routes.mjs`, `src/lib/communications.mjs`, `src/lib/admin/notifications.mjs`, `scripts/server.mjs`
