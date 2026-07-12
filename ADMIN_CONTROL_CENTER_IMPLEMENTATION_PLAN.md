# Admin Control Center — Implementation Plan
## Rec Reports: making the admin area control everything

**Date:** 2026-07-12
**Status (2026-07-12):** Implemented. Phases 0-7 are complete on branch `claude/admin-area-audit-plan-3klmax` — migrations 0009-0018, the `/api/admin/v1` BFF, and all ten admin UI sections. Each phase landed with the full gate suite green; migrations were additionally applied end-to-end against a live Postgres 16 with the SQL test suites passing.

**Basis:** `ADMIN_AREA_AUDIT_REPORT.md` (48 adversarially-verified findings) and `MASTER_ADMIN_CONTROL_CENTER_DESIGN.md`.
**How this plan was produced:** three independent plan proposals were drafted from different angles — **risk-first** (fix foundations before features), **MVP-first** (fastest demoable admin area), and **domain-first** (settings/permission data model as the spine) — by separate agents on different models, then scored and synthesized by a judge agent. The scorecard and rationale are kept below; the synthesized plan follows.

---

## Scorecard (1–5)

| Dimension | Risk-first | MVP-first | Domain-first |
|---|---|---|---|
| Fit to this codebase | 5 | 5 | 4 |
| Correct sequencing (foundations→features) | 5 | 4 | 3 |
| "Admin controls everything" coverage | 5 | 4.5 | 5 |
| Realism / time-to-value | 3 | 5 | 2.5 |
| **Weighted total** | **4.5** | **4.6** | **3.6** |

**Winner (structure): MVP-first.** It is the only plan that reaches a real "admin controls everything at a basic level" milestone quickly (flagship module-toggle matrix demoable ~2 weeks in), keeps every phase independently shippable, and gets the codebase facts exactly right (correct duplicate line numbers, the native-`fetch` `supabase-rest.mjs` BFF primitive, reusing `admin-config.mjs` verbatim, the `organization_admins` + `is_organization_admin()` minimum org-scope primitive that correctly diagnoses that facility-only `has_permission` structurally blocks org-level actions).

**Risk-first** is the strongest on rigor and the most trustworthy on the data plane: it is the only one that treats the **audit backbone as a first-class phase before features**, insists on **idempotent policies**, catches **cross-tenant FK injection** (write policies validate only `facility_id`, not that referenced `template_id`/`asset_id`/`department_id` share it), and — most valuably — turns every audit finding into a **permanent regression gate inside `verify-migrations.mjs`** rather than a one-time fix. Its weakness is time-to-value: 10 weeks to the first admin feature.

**Domain-first** has the best single idea — generalizing the *already-canonical* `permissions.mjs` frozen array and the `admin-config.mjs` resolver (`mergeSettings`/`isModuleEnabled`) into a **Setting Registry + Permission Catalog** mirrored to Postgres and generation-tested. But it sequences a 2.5-week pure-abstraction "spine" and a generic `setting_values` EAV store ahead of any user-visible output, with UI dead last — maximal big-design-up-front risk on an unvalidated abstraction. Its coverage and its entitlement-aware `resolveEffectiveSettings` resolver are excellent ideas to graft in *later*, not to bet the foundation on.

**Synthesis strategy:** take MVP-first's incremental, demo-early phase spine; graft in risk-first's mechanical cross-cutting gates, FK-injection validation, idempotency, and audit-as-backbone discipline (with append-only enforced early, hash-chain verification landing with the audit UI); and introduce domain-first's Setting Registry + Permission Catalog *pragmatically* — catalog reconciliation in Phase 0, a lightweight registry when per-module config actually arrives.

---

# Synthesized Final Plan — Rec Reports Admin Control Center

**Global constraints honored in every phase:** zero runtime dependencies (`package.json` has none); pure `.mjs` under `src/lib`; `node:test` under `test/*.test.mjs`; Supabase migrations with RLS gated on `has_permission(auth.uid(), facility_id, code)` / `current_facility_ids()`; home-grown string-based gates in `scripts/`. Any new dependency is an explicit, reviewed PR decision.

**Cross-cutting gates (enforced from Phase 0 onward, extended each phase):**
- CI order `format:check → lint → typecheck → test → build → db:verify → db:verify:seed → db:test:rls`.
- `verify-migrations.mjs` grows with each phase so findings become permanent regression checks: every RLS-enabled table has ≥1 policy per needed verb; no tenant SELECT policy omits `deleted_at is null`; every `create policy` is preceded by `drop policy if exists`; audit tables have a block-mutation trigger.
- Every new tenant table ships with: RLS + policies for all verbs + `deleted_at` filtering + append-only audit trigger + covering indexes on cascade-parent FKs — checked mechanically.
- Every new mutation: boundary-validated → permission-gated via the canonical catalog → RLS-backstopped → emits an audit row. No exceptions.

**Migration convention:** the platform has never deployed (`src/public/index.html` is a static mockup, zero runtime code). Foundational RLS *fixes* to shipped policies are applied via **new forward migrations `0009+`** (not in-place edits to `0001`–`0008`) so the migration history stays append-only and re-runnable, adopting risk-first/domain-first's approach over MVP-first's in-place edits — the small cost of one hardening migration buys a clean, idempotent, re-runnable history.

---

## Phase 0 — Unbreak the gates, seed, and lock the permission vocabulary
**(0.5–1 day; blocks everything)**

### Goals
Restore a working, honest toolchain and establish a single permission vocabulary before any policy is written against it. Zero product behavior change.

### DB migrations
None (repairs to existing non-migration files only).
- `scripts/verify-migrations.mjs:64-67` — add the missing comma after `"admin_change_requests"` and delete the three duplicate bare literals (`"certification_events"`, `"incident_amendments"`, `"schedule_publications"` already present at lines 33/40/57). Confirm `node --check` passes.
- `supabase/seed.sql:16-21` — add the missing comma after `('communications.publish', 'Publish communications')` and delete the four duplicate tuples on lines 18-21 (`incidents.read`, `incidents.manage`, `admin.manage`, `reports.template.manage` already present at lines 10-15).

### Lib modules/functions
- `src/lib/permissions.mjs` — reconcile the flat array to the seed's superset by adding `training.read`, `communications.read`, `reports.template.manage`; keep `Object.freeze`. **Fix the confirmed status bug:** `hasPermission`/`canAccessFacility` must filter on `membership.status === "active"` to match the server `has_permission` predicate (0001:80).
- New `scripts/verify-seed.mjs` — parse `seed.sql`, assert each top-level `insert … values … ;` block is comma-balanced and `permissions` codes are unique. Wire as `db:verify:seed`.
- `scripts/verify-migrations.mjs` — extend beyond "RLS enabled" to also assert (a) every `requiredRlsTables` entry has ≥1 `create policy … for insert|for all`, and (b) every `create policy` is preceded by a matching `drop policy if exists` (enforced once Phase 1 lands).
- `scripts/lint.mjs` — add a `node --check` pass over every `scripts/*.mjs` and `src/lib/*.mjs` so a syntax error can never again pass the gate.
- `scripts/typecheck.mjs` — replace the single `admin.manage` assertion with a cross-source check: the `permissions.mjs` array, the `seed.sql` codes, and every `has_permission(…, 'x')` literal in migrations must be one identical, duplicate-free set.

### UI
None.

### Tests
- `test/verify-migrations.test.mjs` — subprocess `node scripts/verify-migrations.mjs` exits 0 and prints "Verified"; `requiredRlsTables` has no duplicates.
- `test/permissions.test.mjs` — extend: `hasPermission` returns `false` for `invited`/`disabled` membership; array ↔ seed code sets are identical (parse both, diff).
- `test/seed-integrity.test.mjs` — no duplicate permission codes; VALUES blocks balanced.

### Acceptance criteria
- `npm run db:verify` and `db:verify:seed` exit 0.
- `psql -v ON_ERROR_STOP=1 -f supabase/seed.sql` loads a fresh Postgres end-to-end.
- Full CI is green on a branch for the first time.
- `permissions.mjs`, `seed.sql`, and all migration `has_permission()` literals reference one identical set; client and server agree on active-status semantics (test mirrors the SQL predicate).

---

## Phase 1 — RLS & tenant-isolation hardening + org-scope primitive
**(3–5 days; foundations, blocks all write features)**

### Goals
Make the data plane correct and safe: the org selector works, soft-deletes stop leaking, draft→submitted is legal, cross-tenant FK injection is impossible, org-level admin becomes structurally expressible, and every policy is idempotent. This is the risk-first data-plane phase, tightened to a few days.

### DB migrations — `0009_rls_hardening.sql` (idempotent throughout)
1. **`organizations` unreadable** (0001:85, zero policies): add SELECT scoping to the caller's org via `organization_id in (select organization_id from facilities where id in (select current_facility_ids()))`. Unblocks the top-of-shell tenant name.
2. **Soft-delete leakage**: recreate every tenant SELECT policy across `0002`–`0007` that omits `deleted_at is null` to exclude soft-deleted rows.
3. **`report_submissions` draft→submitted impossible** (0002:118): add `with check (has_permission(auth.uid(), facility_id, 'reports.submit') and status in ('draft','submitted'))` permitting only the legal transition.
4. **Cross-tenant FK injection** (0002:117, 0003, 0005, 0007): introduce reusable `security definer` validator `fn_assert_same_facility(child_facility_id uuid, parent_table text, parent_id uuid)`; apply first to the highest-risk case (`report_submissions.template_id`/`template_version_id` must share the row's `facility_id`) via `with check`, and leave the helper for later phases to reuse.
5. **Org-scope primitive**: add `organization_admins(organization_id, user_id, unique)` and
   `is_organization_admin(check_user_id, check_organization_id)` = member of `organization_admins` **OR** holds `admin.manage` on any facility in that org. Org provisioning stays service-role-only (no user-facing INSERT on `organizations`), making that intentional rather than accidental.
6. **`organizations` UPDATE** gated on `is_organization_admin`.
7. **`organization_module_settings` write path** (the flagship gap, 0008:103 SELECT-only): add `for all` gated on `is_organization_admin(auth.uid(), organization_id)`, mirroring the existing `facility_module_overrides` policy at 0008:110.
8. **`facilities` INSERT/UPDATE** gated on `is_organization_admin(auth.uid(), organization_id)`.
9. **Message receipts/acks unwritable** (0006:115): add INSERT/UPDATE letting an employee write their own receipt/ack (gated on `communications.read` + self).
10. **Policy idempotency**: every policy `0009` touches uses `drop policy if exists … ; create policy …`; adopt going forward.
11. **Batched low-severity fixes**: `check (week_start_date <= week_end_date)` on `schedule_periods`; `check (issued_at <= expires_at)` on `employee_certifications`; covering index on `messages.channel_id`.

### Lib modules/functions
- New `src/lib/env.mjs` reuse + `src/lib/tenant.mjs` — pure `sameFacility(refs, facilityId)` guard mirroring the FK rule so it is `node:test`-covered without a DB and reusable by the future API layer.

### UI
None.

### Tests
- Wire the orphaned `supabase/tests/tenant_isolation.sql` into `db:test:rls` (no-op skip with a clear message when no local Postgres). Add negative cases: user in facility A reads/inserts/updates zero rows in B; cannot inject a B-owned `template_id`; cannot read a soft-deleted row; org-admin can write `organization_module_settings` for own org, denied for foreign org.
- `test/tenant.test.mjs` — `sameFacility` guard.
- Idempotency: CI re-runs each migration twice.

### Acceptance criteria
- Authenticated user reads their own org name and zero foreign-org rows.
- Draft report transitions to `submitted` under RLS by a `reports.submit` holder; a `reports.create`-only user cannot.
- No row referencing a facility-B FK can be inserted from facility A (proven by `tenant_isolation.sql`).
- Every migration re-runs cleanly twice; `verify-migrations` fails a future tenant table shipped without policies or `deleted_at`.

---

## Phase 2 — Admin API/BFF spine + hardened server + append-only audit backbone
**(1–1.5 weeks; foundations for all UI)**

### Goals
Stand up a typed, permission-gated, audited mutation pipeline and a hardened server before any UI, and make audit trustworthy *by construction* (append-only enforced, config mutations trigger-audited) so no later feature ships unlogged. Hash-chain verification is deferred to the Audit UI phase (Phase 5) but the append-only guarantee lands now.

### DB migrations — `0010_audit_backbone.sql` (idempotent)
- **Append-only enforcement** on `audit_events` (0002:74) and `incident_audit_events`: `before update or delete` trigger that raises; INSERT policy so authorized server paths can write.
- **Restrict audit reads** to `admin.manage` holders (0002:120 currently allows any member).
- **Config-change triggers**: `fn_audit_admin_change()` (`after insert/update/delete`) on `organizations`, `facilities`, `organization_module_settings`, `facility_module_overrides`, `facility_settings`, `department_settings`, `branding_profiles` — writes a `config.changed` row with `jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))`, org-scoped rows using `facility_id = null`. Audit no longer depends on app discipline.
- Widen `audit_events` to accept org-level rows: add nullable `organization_id`; keep `facility_id` nullable-compatible for org-scope mutations.

### Lib modules/functions
- New `src/lib/supabase-rest.mjs` — zero-dep PostgREST client on native `fetch`: `pgSelect/pgInsert/pgUpdate/pgDelete`, reading `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` via `env.mjs`. The missing data-access primitive without adopting `@supabase/supabase-js`.
- New `src/lib/http/router.mjs` (~30-line path/method router), `auth.mjs` (Supabase JWT verify + membership load), `guard.mjs` (`requirePermission(facilityId, code)` reusing `permissions.mjs`), `validate.mjs` (hand-rolled schema helpers in the `report-schema.mjs` error-array style).
- New `src/lib/audit.mjs` — `canonicalize(obj)` (stable key order), `computeRowHash(prevHash, row)`, `verifyChain(rows)` using `node:crypto`; reuses `admin-config.mjs.buildConfigAuditEvent` as the payload shaper. (Hash-chain columns/trigger added in Phase 5 with the verification UI; the pure functions land now and are unit-tested.)
- New `scripts/server.mjs` (hardened `start` target) — security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS), cache-control, stream-pipe error handling; delegates `/api/admin/v1/*` to the router, static otherwise. `scripts/dev-server.mjs` stays dev-only. `package.json` `start` repointed to `server.mjs`.
- First endpoints (read + safest write, to prove the pipeline): `GET /modules`, `GET /org/:id/module-settings`, `PUT /org/:id/module-settings`.

### UI
None (server + API only).

### Tests
- `test/http-guard.test.mjs` — `requirePermission` denies without code, denies inactive membership, allows holder.
- `test/audit.test.mjs` — `computeRowHash` determinism; `verifyChain` detects a mutated middle row and a reorder; `canonicalize` order-independent.
- `test/server-headers.test.mjs` — every response carries required headers; unknown routes 404 cleanly; broken stream doesn't crash the process.
- `supabase/tests/audit_append_only.sql` — `update`/`delete` on `audit_events` raises; a config mutation produces exactly one audit row with correct before/after.

### Acceptance criteria
- A module toggle round-trips through the API: authorized admin succeeds and produces an audit row; non-admin rejected by both the API guard and RLS; write survives re-read.
- Any `update`/`delete` on `audit_events`/`incident_audit_events` raises at the DB.
- `start` server sets all listed headers and is not the raw dev server; boundary validation rejects malformed payloads before any DB call.

---

## Phase 3 — Admin shell UI + Modules & Features matrix + Facilities/Departments
**(1.5–2 weeks; the flagship "controls everything at a basic level" demo)**

### Goals
Deliver the visible admin control center on the hardened, audited base: a real shell, the module-toggle matrix (org + facility scope), and facility/department CRUD — the two lowest-risk pages whose RLS and audit are already done.

### DB migrations — `0011_org_tree_writes.sql`
- `departments`, `employees`, `certification_types` (all SELECT-only today): add `insert/update/delete` gated on `has_permission(auth.uid(), facility_id, 'admin.manage')`.
- Attach `fn_audit_admin_change()` triggers to these tables.

### Lib modules/functions
- New `src/lib/admin/module-settings.mjs` — `resolveEffectiveModuleState(orgSetting, facilityOverride)` reusing `isModuleEnabled`/`mergeSettings`; `impactSummary(module, disabling)` ("disables scheduling for 3 departments", design 2.2-B); `applyModuleToggle(...)` shaping write + audit event; `validateModuleTogglePayload({enabled, configPatch})`.
- New `src/lib/admin/facilities.mjs` — `validateFacilityInput`, `validateDepartmentInput`, `buildFacilityInsert`, `buildDepartmentInsert`, `validateFacilitySettingsPatch` (shape-checks `locale`, `reporting.dailyReportDueHour`, `notifications.quietHours*` — the fields seed.sql:164 populates but nothing reads); audit-event shapers.
- API endpoints: `GET /org/:id/modules`, `PUT /org/:id/modules/:moduleId`, `GET/PUT /facilities/:id/modules/:moduleId`, `GET/POST /org/:id/facilities`, `GET/POST /facilities/:id/departments`, `GET/PATCH /facilities/:id/settings`.

### UI — `src/public/admin/` (vanilla JS + `fetch`, dependency-free)
- Global shell (design 2.1): top-bar tenant/facility/department switcher wired to real state (replaces the inert `<select>` at index.html:24-30 and the two static `<span>`s at 154-169); left-nav with the 10 groups, unbuilt pages rendered as "coming in Phase N" stubs so the full shell is visible day one; policy-driven nav visibility via the catalog.
- **Modules & Features**: module × (org default / facility override) matrix, checkbox writes through the API, impact text, per-row audit link.
- **Facilities & Departments**: facility/department list + create/rename, timezone/locale editor via `facility_settings`; textual inheritance preview (tenant default → facility override).

### Tests
- `test/module-settings.test.mjs` — precedence (facility override wins → org → default), covering `admin-config.mjs` `deepMerge`'s untested array-vs-object branch.
- `test/facilities.test.mjs` — rejects cross-org parenting, missing timezone.
- `test/supabase-rest.test.mjs` — monkeypatch `globalThis.fetch`; assert PostgREST query construction and that the service-role key never leaks into a client-context call.
- Smoke harness skeleton: "toggle a module", "create a department" against a local server + seeded tenant.

### Acceptance criteria
- An org-admin flips "Incidents" off for a facility through the UI; change persists in `facility_module_overrides` with a corresponding `audit_events` row, zero code changes required.
- Admin creates a department and renames a facility; a non-admin sees neither the nav entry nor a working endpoint (proven by API guard + RLS).
- No horizontal page scroll; light/dark themable; responsive.

---

## Phase 4 — Identity & Permissions (RBAC write path) + effective-access simulator
**(1.5–2 weeks; high value, high blast radius — after audit + API are proven)**

### Goals
Turn Identity & Permissions from SELECT-only (0001:96-115) into a working, audited management surface with an effective-access simulator, gated behind the now-trustworthy audit backbone.

### DB migrations — `0012_rbac_admin.sql`
- Write RLS (`for all`, matching `with check`) on `roles`, `memberships` gated on `has_permission(auth.uid(), facility_id, 'admin.manage')`; on `role_permissions` via join to `roles.facility_id`.
- Add `roles.is_system_role bool`, `roles.active bool`; seed system roles (Tenant Owner, Compliance Admin, Ops Admin, Read-Only Auditor, design 4.2); `before delete` trigger protects system roles.
- Attach `fn_audit_admin_change()` triggers to `roles`, `role_permissions`, `memberships` — closes "privilege grants have no DB backstop or audit".

### Lib modules/functions
- New `src/lib/admin/rbac.mjs` — `computeEffectivePermissions(memberships, facilityId)` (respects `status='active'`); `validateRoleGrant(role, permissions)` rejecting out-of-catalog codes; `diffRolePermissions(before, after)` → grants/revokes for audit payloads; `simulateAccess(user, facilityId, code)` → `{allowed, reason}` matching `has_permission` semantics.
- API: `GET/POST /facilities/:id/roles`, `PUT /roles/:id/permissions` (bulk set), `POST/PATCH /facilities/:id/memberships`, `GET /facilities/:id/access-simulator?userId=`.

### UI
- **Identity & Permissions** page goes live: role list (system vs custom), permission-grid editor (permission codes as columns), membership management, and a "simulate access" panel returning the full `{permission, granted}[]` matrix.

### Tests
- `test/rbac.test.mjs` — effective-permission resolution across multiple memberships and active-status; grant validation rejects unknown codes; simulator output equals `hasPermission` for every catalog code.
- `supabase/tests/rbac_writes.sql` — facility admin creates a role and assigns permissions within their facility, denied cross-facility.

### Acceptance criteria
- Creating a role, attaching permissions, and assigning a membership all produce audit rows and are gated by `admin.manage`; a non-admin write is RLS-denied.
- Simulator output equals what server `has_permission` returns for the same triples, including active-status.

---

## Phase 5 — Setting Registry + per-module configuration surfaces + Audit & Compliance UI
**(2.5–3 weeks; makes hardcoded business rules admin-controllable, and closes tamper-evidence)**

### Goals
Graft in domain-first's best idea — but pragmatically, now that the surface exists and its shape is validated. Introduce a **lightweight Setting Registry** as the canonical source for tenant-controllable settings, wire each module lib to consume it instead of constants, and ship the Audit & Compliance page with hash-chain verification.

### DB migrations — `0013_settings_and_audit_chain.sql`
- **Hash chain**: add `prev_hash`/`row_hash` to `audit_events` (and `incident_audit_events`); insert trigger computes `row_hash = sha256(prev_hash || canonical(row))` per facility partition using `pgcrypto` (already enabled, 0001:1). Delivers design 8.3 tamper evidence, zero new deps.
- **Cross-tenant FK validators**: extend `fn_assert_same_facility` to `work_orders.asset_id`, `schedule_shifts.schedule_period_id`, and other high-risk parents.
- (Settings values continue to live in the existing `facility_settings`/`department_settings`/`facility_module_overrides.config_patch_jsonb` — no generic EAV table; the registry is a code-side catalog, avoiding domain-first's unvalidated `setting_values` bet.)

### Lib modules/functions
- New `src/lib/settings-registry.mjs` (domain-first's flagship, scoped down) — one frozen array of `{key, module, label, dataType, scopes, default, validation, permission}` for the settings the module docs promise but that are hardcoded today: scheduling publish cadence / approval flag / conflict threshold / open-shift claim window / **cert enforcement mode (hard-block vs warning)**; incident escalation SLA; work-order SLA/priority defaults; report due-hour & quiet hours; comms require-ack default. Functions: `getDefinition`, `settingsForModule`, `validateSettingValue(key, value)`, and `resolveEffectiveSettings({registry, orgLayer, facilityLayer, departmentLayer})` generalizing `mergeSettings` and returning `{value, source}` per key for inheritance visualization.
- New `scripts/gen-settings-check.mjs` — assert `settings-registry.mjs` and a checked-in seed/doc stay in sync (generation test, the same guard style as the permission diff).
- **Wire module libs to config** (backward-compatible `config` param, defaulted): `scheduling.mjs` conflict/cert checks; `incidents.mjs` escalation; `work-orders.mjs` SLA; `report-schema.mjs` — **complete `validateReportSubmission` for the ignored types** (`multiselect`/`checkbox`/`date`/`time`/`photo`/`signature`), which today only enforces `number`/`select`.
- New `src/lib/admin/audit-export.mjs` — `queryAuditTimeline(...)`, `verifyChain` (reuses Phase 2 `audit.mjs`), `exportAuditPackage(events, 'csv'|'json')` (PDF deferred — no PDF lib in a zero-dep repo).
- API: generic `GET/PATCH /facilities/:id/modules/:code/config` (validated against the registry before write to `config_patch_jsonb`); `GET /facilities/:id/audit`, `GET /facilities/:id/audit/export`.

### UI
- Each module admin page gains a **"Module settings" tab** rendered generically from the registry (label + input per key — one schema-to-form renderer, not six bespoke forms).
- **Audit & Compliance** page: searchable timeline, before/after diff, **"Verify chain integrity"** badge (PASS on untouched chain, FAIL on a corrupted row), CSV/JSON export — restricted to `admin.manage`.

### Tests
- `test/settings-registry.test.mjs` — default resolution, scope precedence, `validateSettingValue` per `dataType`, `resolveEffectiveSettings` reports correct `source`.
- Per-module: extend `scheduling.test.mjs`, `incidents.test.mjs`, etc. to prove behavior changes when config changes (e.g. `certEnforcementMode: "warning"` downgrades a conflict from hard error to flagged warning — fails before wiring, passes after).
- `test/report-schema.test.mjs` — new type-enforcement branches.
- `test/audit-export.test.mjs` — CSV/JSON round-trip, nested JSONB escaping, chain-verification result included.
- `supabase/tests/audit_chain.sql` — direct service-role tamper is detectable.

### Acceptance criteria
- For at least scheduling and daily reports, changing a config value in the UI measurably changes runtime behavior (test-proven).
- Every mutation from Phases 3–4 appears in the Audit timeline with a working before/after diff; tampering with one `audit_events` row is caught by "Verify chain integrity".
- No module's design-doc "Admin Controls" section is 100% unimplemented; each has its top 3 controls wired.

---

## Phase 6 — Branding, Data Export, and Draft/Publish workflow depth
**(1–1.5 weeks)**

### Goals
Complete the branding/export trio and turn the orphaned `admin_change_requests` table (0008:70, no producer today) into the real draft → review → publish workflow the design calls for (5.1/5.6), reused across config domains.

### DB migrations — `0014_change_requests.sql`
- Wire `admin_change_requests` lifecycle: state machine on the existing `status` check constraint; `after insert/update` audit triggers; `facility_settings`/`department_settings` writes create a new version row rather than mutating in place (respecting the existing `version` column).
- Add `pdf_templates`, `pdf_template_bindings` (design 3.8) with admin write RLS (branding already writable at 0008:113).

### Lib modules/functions
- New `src/lib/admin/change-requests.mjs` — `createChangeRequest(...)`, `advanceChangeRequest(cr, action, actor)` matching the status constraint, `publishChangeRequest`.
- New `src/lib/admin/branding.mjs` — `validateThemePatch({primary, accent, logoPath})`, reusing change-requests for draft/publish.
- New `src/lib/admin/export.mjs` — generic `exportTable(rows, 'csv'|'json')` reused by audit export and a general facility-scoped data-export page (gated on `X.export`/`admin.manage`).
- API: `POST /change-requests`, `POST /change-requests/:id/publish`, `GET/PATCH /facilities/:id/branding`, `GET /facilities/:id/export/:table`.

### UI
- **Branding & Documents** page: color/logo form with live preview swatch, draft/publish banner.
- Reusable **draft/publish banner** ("3 unpublished changes") with before/after diff from `admin_change_requests`.
- **Data Export** utility panel (table picker + format + download).

### Tests
- `test/change-requests.test.mjs` — legal/illegal transitions; `test/branding.test.mjs`; `test/export.test.mjs` — CSV/JSON escaping, nested JSONB.
- Acceptance: editing facility timezone lands as a draft `admin_change_requests` row that must be explicitly published before `facility_settings.published_at` updates.

### Acceptance criteria
- Admin edits are stageable as change requests and require explicit publish; an admin exports a facility's incident reports to CSV without touching SQL.

---

## Phase 7 — Forms & Fields, Notifications routing, Certification policy, Feature flags & Entitlements
**(2.5–3.5 weeks; sequenced by value/blast-radius; each sub-item independently shippable)**

### Goals
Deliver the remaining design domains on the fully hardened, audited, API-gated base. Each new table set ships with idempotent RLS + append-only audit triggers + `verify-migrations` extension + `node:test` coverage landing with the feature.

### Sub-items (recommended order)
1. **Forms & Fields (lite)** — `0015_forms.sql`: `custom_fields`, `form_definitions`, `form_field_bindings` (design 3.4; status enum instead of full versioning UI). `src/lib/admin/forms.mjs` reuses `validateReportTemplateSchema` as the shared validator so builder and runtime submission agree. UI: structured field-list editor (add/remove/reorder), not a drag/drop canvas. Add `reports.templates.manage`, `reports.workflow.manage` to the catalog.
2. **Notifications routing** — `0016_notifications.sql`: `notification_events`, `distribution_lists`, `distribution_list_members`, `notification_routes`, `notification_route_overrides` (design 3.5). `src/lib/admin/notifications.mjs` — `resolveRoute(event, overrides)`, `expandDistributionList`; consumes registry quiet-hours; wires into existing `notification_jobs`/`notification_deliveries` (0006).
3. **Certification policy** — `0017_cert_policy.sql`: `certification_role_requirements`, `certification_policies` with `enforcement_mode`; gives the Phase 5 `certEnforcementMode` registry key a real backing table; `scheduling.mjs`/`training.mjs` consume it.
4. **Feature flags & Entitlements/Billing** — `0018_flags_entitlements.sql`: `feature_flags`, `feature_flag_rules` (design 3.2); minimal `subscription_plans`, `tenant_subscriptions`, `subscription_addons`, `tenant_addons`, `usage_counters` (design 3.9). `src/lib/admin/entitlements.mjs` — `entitlementsFor(plan, addons)`, `isEntitled`, `usageStatus` (80/90/100 soft limits, design 10.3); `resolveEffectiveSettings` gains an `entitlements` argument that filters gated keys. A runtime entitlement guard invoked before privileged actions. **Last** because it gates everything else and is safest added once the surfaces it gates exist.

### Deferred (explicit, not silently dropped) — since delivered in a follow-up
All four items landed after Phases 0–7 shipped, each resolved without taking on a runtime dependency:
- ~~Full drag/drop form-builder canvas~~ — delivered: native HTML5 drag-and-drop palette + multi-section canvas in `src/public/admin/js/pages/forms.js`, with in-place draft editing via `PATCH /forms/:id` (`buildFormDraftUpdate`); no dependency needed.
- ~~PDF rendering engine~~ — delivered: `src/lib/admin/pdf.mjs`, a zero-dependency PDF 1.4 renderer wired into `buildExportPackage` as a third export format (`csv|json|pdf`, base64 envelope); the "dependency decision" resolved as hand-rolled, consistent with the repo's zero-dep constraint.
- ~~Platform-level cross-organization super-admin scope~~ — delivered in `0022_platform_admin.sql`: `platform_admins` roster + `is_platform_admin`, folded into `current_facility_ids` and `has_permission` in place (signatures unchanged, so all dependent policies inherit it), plus auth-level JS guards.
- ~~Department-level scope in `has_permission`/`memberships`~~ — delivered in `0023_department_scope.sql`: nullable `memberships.department_id` (null = facility-wide, so no existing row changes behavior), a 4-arg `has_permission` overload for department-carrying rows, and `department_settings` switched to it; JS mirror kept in lockstep.

### Tests & acceptance (per sub-item)
- One `test/admin/*.test.mjs` per new lib module + a `supabase/tests/*.sql` RLS proof per new table set, following the Phase 2–5 pattern.
- Acceptance: build a 3-field custom form that renders/validates in the daily-reports flow; define a route for `incident.escalated` to a distribution list and have a test notification reach the sandbox log; toggle a cert requirement warning→hard-block and observe `scheduling.mjs` behavior change; a setting whose entitlement is not in the plan is filtered out of `resolveEffectiveSettings`.

---

## Sequencing summary

| Phase | Duration | Milestone |
|---|---|---|
| 0 | 0.5–1 day | CI green; one permission vocabulary; gates parse JS |
| 1 | 3–5 days | Data plane correct: org readable, no soft-delete/FK leakage, idempotent policies, org-scope primitive |
| 2 | 1–1.5 wk | Hardened server + API/BFF spine + append-only audit backbone (config mutations auto-audited) |
| 3 | 1.5–2 wk | **Flagship demo:** admin shell + module matrix + facilities/departments, every write audited |
| 4 | 1.5–2 wk | RBAC management + effective-access simulator |
| 5 | 2.5–3 wk | Setting Registry; hardcoded module rules become admin-controllable; Audit & Compliance UI + hash-chain verification |
| 6 | 1–1.5 wk | Branding, data export, draft/publish workflow |
| 7 | 2.5–3.5 wk | Forms, notifications routing, cert policy, feature flags & entitlements |

**Total ≈ 11–14 weeks**, with a demoable "controls everything at a basic level" milestone at the end of Phase 3 (~4–5 weeks) and every subsequent phase independently shippable. Foundations (parse/seed/vocab → RLS/tenant isolation → API+audit backbone) all complete before any net-new admin feature reaches users, satisfying the risk-first invariant while preserving MVP-first's incremental delivery and grafting in domain-first's registry as a validated mid-plan asset rather than an upfront bet.