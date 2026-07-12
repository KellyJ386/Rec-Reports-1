# Rec Reports — Complete Platform Audit

**Date:** 2026-07-12
**Scope:** Full repository — architecture, database/RLS, security & permissions, admin control-center gap analysis, testing/CI, frontend.
**Method:** Six parallel audit agents (one per dimension) ran on a mix of models, each reading the actual repository files. Every raw finding was then independently re-verified by a second adversarial agent instructed to refute it against the code; only findings that survived verification are listed here. 54 raw findings were produced; **48 were confirmed** and 6 were rejected or downgraded during verification.

---

## 1. Executive summary

The repository is a well-documented **early foundation, not yet a product**. The design documentation is extensive and coherent (nine design docs covering architecture, schema, every module, and a Master Admin Control Center), and the database layer is the strongest real asset: all 50+ tenant tables have RLS enabled, tenant isolation flows through `SECURITY DEFINER` helpers with pinned `search_path`, and the unit-tested domain helpers in `src/lib/` are small and clean. There is no obvious cross-tenant *read* leak on the permission-gated tables.

However, the audit confirmed serious problems in three bands:

1. **The release gates are broken and partly illusory.** `scripts/verify-migrations.mjs` has a hard JavaScript syntax error (botched merge in commit `fa36588`, now on `main` via PR #8), so `npm run db:verify` — the RLS-coverage release gate — has never successfully run, and **CI on `main` is currently red** because of it. `supabase/seed.sql` has the same class of defect (missing comma + duplicated tuples) and cannot load into Postgres at all. The `lint`/`typecheck`/`format:check` scripts are custom string-scanners that never parse JavaScript, which is exactly why a bare syntax error slipped through every earlier gate.

2. **The data plane has correctness gaps behind the solid RLS façade.** The `organizations` table has RLS enabled with *zero* policies (unreadable by every authenticated user, including admins); soft-deleted rows remain fully readable everywhere despite the documented soft-delete strategy; the `report_submissions` UPDATE policy structurally forbids the draft→submitted transition; write policies validate only `facility_id` and not that referenced foreign keys belong to the same tenant (cross-tenant reference injection); and no `CREATE POLICY` is idempotent, so migrations cannot be re-run.

3. **The admin area — the thing that is supposed to "control everything" — essentially does not exist.** Versus the ten admin domains in `MASTER_ADMIN_CONTROL_CENTER_DESIGN.md`, what exists is: one migration (7 tables), a 31-line pure-helper module, a flat 13-permission array, and a static HTML panel with a no-op button. There is **no admin UI, no admin API, and no write path** for the flagship module-toggle matrix (`organization_module_settings` is SELECT-only in RLS). Even tables that do exist for org/identity management (roles, memberships, role_permissions, report_templates, facilities, departments) are read-only to every authenticated role — all administration currently requires service-role/direct DB access. Every module's business rules (escalation thresholds, SLAs, publish cadence, certification enforcement) are hardcoded constants rather than tenant-configurable settings.

**Bottom line:** the foundation (schema + RLS + tested domain helpers) is worth building on, but "production-grade SaaS" is currently aspirational. The companion document `ADMIN_CONTROL_CENTER_IMPLEMENTATION_PLAN.md` sequences the path from here to a working admin control center in 8 phases (~11–14 weeks), with the broken gates fixed in Phase 0 and a demoable "admin controls everything at a basic level" milestone at ~4–5 weeks.

---

## 2. Baseline verification (run during this audit)

| Check | Result |
|---|---|
| `npm run format:check` | ✅ passes |
| `npm run lint` | ✅ passes (but does not parse JS — see finding on tooling) |
| `npm run typecheck` | ✅ passes (single string assertion, not a typechecker) |
| `npm test` | ✅ 25/25 tests pass |
| `npm run build` | ✅ builds `dist/` |
| `npm run db:verify` | ❌ **crashes with `SyntaxError: Unexpected string`** at `scripts/verify-migrations.mjs:65` |
| `seed.sql` loads into Postgres | ❌ **fails** — malformed `VALUES` list at `supabase/seed.sql:17-21` |
| CI (`.github/workflows/ci.yml`) on `main` | ❌ **red** — `db:verify` is step 6 of 6 with no `continue-on-error` |

---

## 3. Dimension summaries

### Architecture & code quality
An early foundation dressed up as a finished product. Two literal syntax errors sit in load-bearing paths (`verify-migrations.mjs`, `seed.sql`), and the custom lint/typecheck/format gates are too weak to catch them. The "production-grade SaaS" claim is overstated: the frontend is a static, script-free HTML mockup with no-op buttons, `package.json` has zero dependencies, and the `src/lib/*.mjs` domain helpers are never imported by any runtime code — only by tests. The lib functions themselves are small, clean, consistent, and well unit-tested, but the permission vocabulary drifts across `permissions.mjs`, `seed.sql`, and `PLATFORM_ARCHITECTURE.md`, and the architecture doc promises an entire platform (PWA, offline sync, Edge Functions, realtime, notifications, PDF export) that does not exist.

### Database, RLS & tenant isolation
The migrations implement a consistent facility-scoped RLS model — every tenant table has RLS enabled, helpers are `SECURITY DEFINER` with pinned `search_path`, and the permission-gated `for all` policies correctly pair `USING` with `WITH CHECK`, so there is no obvious cross-tenant read leak on those tables. Real problems remain: `seed.sql` won't load; `organizations` is fully unreadable (RLS on, zero policies); no policy excludes soft-deleted rows; the `report_submissions` UPDATE policy forbids the submit transition; write policies don't validate that referenced FKs belong to the same tenant; `CREATE POLICY` statements are not idempotent; and `POSTGRES_SUPABASE_SCHEMA.md` describes a fundamentally different schema than what was built.

### Security, permissions & auth
The RLS foundation is structurally sound and client-side write paths are fail-closed for privilege escalation (users cannot self-grant permissions); client/server secret separation is correct. But admin config mutations and permission grants are not audited at the DB layer; the audit tables are neither writable by any authenticated path nor append-only/tamper-evident as designed; role/permission/membership management has no RLS write policy (relies entirely on service-role code with no DB backstop); and the permission model is a flat facility-scoped list that omits the designed hierarchical scopes, deny rules, and entitlement gating — a single broad `admin.manage` covers everything.

### Admin control-center gap analysis
The design doc specifies a full governance plane: 10-section admin UI shell, typed `/api/admin/v1/*` BFF, 6 domain services, a rules engine, and ~35 tables spanning RBAC, forms, notifications, certifications, branding, subscriptions, and a signed audit trail. What exists: migration `0008` (7 tables: module toggles, facility/department settings, branding, change requests), 31 lines of pure helpers in `admin-config.mjs`, no server layer, and one static HTML card. The per-module "Admin Controls" sections promised in the scheduling/reports/incidents/communications/training design docs have no tables, no policies, and no code — every module hardcodes its thresholds as constants. Full inventory in the findings below.

### Testing, CI & tooling
The `db:verify` crash is precisely diagnosed (duplicated, comma-broken tail of `requiredRlsTables`, introduced by a bad merge in `fa36588`). CI does run `db:verify` last with no `continue-on-error`, so CI on `main` is red — and no earlier step could catch the bug because none of the custom lint/format/typecheck scripts parse `.mjs` files as JavaScript. Unit tests are generally good (25 passing, real edge cases, cross-facility isolation), with gaps: `readServerEnv` untested, several `report-schema.mjs` validation branches untested, and `supabase/tests/tenant_isolation.sql` is never executed by any script or CI job.

### Frontend & UX
The actual frontend is one static HTML landing page with placeholder cards: zero JavaScript, no routing, no state, no API calls, no wiring to `src/lib` or Supabase. Semantic structure and basic ARIA labels are present, but there is no interactivity, focus management, or security-header story (`dev-server.mjs` doubles as the production `start` target with none). Substantial frontend implementation is required to deliver even the MVP described in the roadmap.

---

## 4. Confirmed findings (48)

All findings below were independently re-verified against the repository by a second agent before inclusion.

### Critical (7)

#### 1. No admin UI, no admin API layer — the Admin Experience Layer and Admin API/BFF Layer (design doc secs 1.2.1-1.2.2, 2) do not exist

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `src/public/index.html:154-171; scripts/dev-server.mjs:1-19`
- **Detail:** MASTER_ADMIN_CONTROL_CENTER_DESIGN.md sec 2 specifies a global admin shell with a 10-item left nav (Dashboard, Modules & Features, Identity & Permissions, Forms & Fields, Notifications, Facilities & Departments, Certifications, Branding & Documents, Audit & Compliance, Billing & Subscription) and typed `/api/admin/v1/*` endpoints (sec 1.2.2). src/public/index.html:154-171 contains exactly one static, non-interactive 'Admin control center' panel with a single `<button type="button">Review admin changes</button>` that has no click handler — the file has no `<script>` tag at all (confirmed by full read of the 172-line file). scripts/dev-server.mjs:1-19 is a bare static-file server (fs.createReadStream keyed off request path) with no route table, no `/api/` handling, and no auth/RLS-aware request logic. There is no server-side code anywhere in the repo that reads or writes any admin_config table.
- **Recommendation:** Build the admin BFF/API layer and at least a functional (even minimal) admin UI that can read/write the config tables that do exist, before claiming any 'admin controls everything' capability.

#### 2. Module toggle matrix — the platform's flagship admin capability — has no write path; org-level toggles are read-only and facility-level toggles have no supporting UI/API

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `supabase/migrations/0008_admin_config.sql:102-114; src/lib/admin-config.mjs:17-20`
- **Detail:** supabase/migrations/0008_admin_config.sql:102-114 defines only a SELECT policy for organization_module_settings ('admin readers can read org module settings', lines 103-109) — there is no INSERT/UPDATE/DELETE/ALL policy for that table anywhere in the migrations directory (verified via full grep of 'for insert|for update|for delete|for all' across supabase/migrations/*.sql). Org admins can never toggle a module on/off at the tenant level through any authenticated role; only service-role/direct DB access can write it. facility_module_overrides does have a 'for all' policy (0008_admin_config.sql:110) but there is no application code (no src/lib module, no API route) that calls it — isModuleEnabled() in src/lib/admin-config.mjs:17-20 is a pure function that takes settings as arguments; nothing in the repo fetches or persists module settings.
- **Recommendation:** Add write RLS policies for organization_module_settings scoped to admin.manage, and build the persistence/API code path that lets an admin actually flip a module toggle.

#### 3. seed.sql has a fatal SQL syntax error (missing comma) — the entire seed fails to load

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/seed.sql:17-21`
- **Detail:** In the permissions INSERT, line 17 `('communications.publish', 'Publish communications')` is NOT followed by a comma before the next value tuple on line 18 `('incidents.read', 'Read incidents'),`. Two VALUES tuples with no separating comma is a syntax error (`syntax error at or near "("`), so the whole statement — and thus the whole seed run, which is one file — aborts. Nothing gets seeded. Secondarily, lines 18-21 duplicate rows already inserted on lines 10, 11, 13, 15 (`incidents.read`, `incidents.manage`, `admin.manage`, `reports.template.manage`), which is dead/confused content even after the comma is fixed.
- **Recommendation:** Add the missing comma after line 17 and delete the duplicate tuples on lines 18-21. Verify the file parses by running it against a fresh DB in CI.

#### 4. No frontend implementation - only static HTML skeleton

- **Dimension:** Frontend & UX
- **Location:** `src/public/index.html (lines 1-172), scripts/dev-server.mjs, PLATFORM_ARCHITECTURE.md section 1.2`
- **Detail:** Design docs (PLATFORM_ARCHITECTURE.md, MASTER_PRODUCTION_READINESS_PLAN.md) describe a comprehensive Next.js PWA with authentication, role-based dashboards, offline sync, form handling, and tenant-scoped workflows. Actual implementation is purely static HTML with zero JavaScript. No client libraries, no event handlers, no API calls, no form submission logic. Buttons have type='button' with no onclick handlers (lines 65-66, 87, 103, 119, 135, 151, 167). Form inputs capture nothing. Facility switcher select has no change listener (lines 24-30). Text placeholder states 'Tenant-aware workflow space ready for authenticated Supabase data integration' (lines 33-38) but page is completely inert.

#### 5. No admin UI implementation - design specifies comprehensive control center

- **Dimension:** Frontend & UX
- **Location:** `src/public/index.html lines 154-169, MASTER_ADMIN_CONTROL_CENTER_DESIGN.md sections 2.1-2.2`
- **Detail:** The core factual claims check out precisely. src/public/index.html lines 154-169 (verified exactly) contain a single `<section class="admin-heading">` panel: an eyebrow label "Admin control center", a static heading/paragraph, and an "admin-card" div with two hardcoded `<span>` lines and one inert `<button type="button">Review admin changes</button>` — no `onclick`, no `<script>` tag anywhere in the file (grep confirms zero `<script` tags), no forms, no nav, no sidebar. dev-server.mjs is a bare static file server with no `/api/admin/*` routes. The only "admin" logic in the repo is src/lib/admin-config.mjs (31 lines: mergeSettings/isModuleEnabled/buildConfigAuditEvent helpers) — pure functions with unit tests, not wired to any UI or API surface. MASTER_ADMIN_CONTROL_CENTER_DESIGN.md sections 2.1-2.2 do specify exactly the top bar + 10-item left nav (Dashboard, Modules & Features, Identity & Permissions, Forms & Fields, Notifications, Facilities & Departments, Certifications, Branding & Documents, Audit & Compliance, Billing & Subscription) the auditor lists, and section 1.2 (not 2.1-2.2, a minor citation looseness) specifies policy-driven visibility, draft/publish UX, and mutation-pipeline/audit-emission — none of which exist in code. So the gap is real and the location/quote details are accurate. One caveat on severity framing: this same "static card, zero JS, inert buttons" pattern is true of every other module panel on the page (daily reports, scheduling, incidents, work orders, communications, training) — the whole file is an explicitly labeled "Sprint 1" foundation scaffold with no `<script>` at all, so admin is not uniquely regressed relative to the rest of the app. Calling it out as critical is defensible given the design doc's breadth, but the framing "No admin UI implementation" slightly overstates it as an admin-specific failure when it's actually the current state of the entire frontend.

#### 6. No API layer - backend logic disconnected from frontend

- **Dimension:** Frontend & UX
- **Location:** `src/lib/ (all modules), PLATFORM_ARCHITECTURE.md section 1.2, MASTER_ADMIN_CONTROL_CENTER_DESIGN.md section 1.2`
- **Detail:** Business logic exists in src/lib/*.mjs (permissions.mjs, scheduling.mjs, incidents.mjs, work-orders.mjs, communications.mjs, training.mjs) but no HTTP API route handlers exist to expose this to clients. Design calls for 'Next.js Route Handlers (BFF) for web clients' (PLATFORM_ARCHITECTURE.md 1.2) and '/api/admin/v1/*' endpoints (MASTER_ADMIN_CONTROL_CENTER_DESIGN.md 1.2). No handlers found in codebase. Frontend cannot call backend.

#### 7. scripts/verify-migrations.mjs has invalid JS syntax — botched merge left duplicate array entries with missing commas, crashing `npm run db:verify`

- **Dimension:** Testing, CI & Tooling
- **Location:** `scripts/verify-migrations.mjs:64-68 (defect introduced in commit fa36588, now on main via febc99c)`
- **Detail:** In the `requiredRlsTables` array, line 64 `"admin_change_requests"` has no trailing comma, and lines 65-67 append three more bare string literals with no commas at all:
```
64  "admin_change_requests"
65  "certification_events"
66  "incident_amendments"
67  "schedule_publications"
68  ];
```
JS parses two adjacent string-literal expression statements with nothing between them as a syntax error. Running `node scripts/verify-migrations.mjs` reproduces exactly the reported crash:
```
file:///home/user/Rec-Reports-1/scripts/verify-migrations.mjs:65
  "certification_events"
  ^^^^^^^^^^^^^^^^^^^^^^
SyntaxError: Unexpected string
```
All three of the appended names (certification_events, incident_amendments, schedule_publications) are also pure duplicates of entries already present earlier in the same array (lines 57, 40, and 33 respectively), confirming this is dead weight from a bad merge, not new required content.

Root cause via git history: commit f6c4da3 ("Add admin configuration slice") introduced a syntactically valid array ending in `"admin_change_requests"\n];`. The very next commit, fa36588 (a 2-parent merge, "Merge branch 'main' into codex/follow-production-readiness-plan-fxhfdz"), added 3 lines to the file, turning the valid closing tail into the broken 4-line tail above — i.e. a merge conflict was resolved by concatenating both sides' additions without commas. This merge commit is already on main via merge commit febc99c (PR #8), so main's CI is currently red at the npm run db:verify step.
- **Recommendation:** Fix the array to end `..., "branding_profiles", "admin_change_requests"];` and drop the three duplicate lines (65-67) since those tables are already covered earlier in the list. Add a fast `node --check scripts/*.mjs` syntax-validation step so a bare syntax error fails immediately instead of only surfacing at db:verify runtime.


### High (17)

#### 8. 'organizations' table has RLS enabled with zero policies — completely inaccessible to every authenticated role, including admins

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `supabase/migrations/0001_foundation.sql:3-7,85`
- **Detail:** The core claim holds: supabase/migrations/0001_foundation.sql:3-7 creates `organizations`, line 85 runs `alter table organizations enable row level security;`, and a grep of all 8 migration files for `create policy.*organizations` (or any policy targeting the organizations table) returns zero matches. Cross-checking every migration file confirms every other RLS-enabled table (35+ tables across all 8 files) has at least one corresponding `create policy`, and 0001_foundation.sql itself enables RLS on 7 tables but only defines 6 policies — organizations is the sole omission, indicating an oversight rather than a deliberate access model. supabase/tests/tenant_isolation.sql and scripts/verify-migrations.mjs's requiredRlsTables list also never reference `organizations`, so no test or CI check would catch this. There is no application code in the repo (src/lib/*.mjs has no organizations-table client, no service-role bypass path) that would route around this restriction, so the practical effect described (Postgres denies all row access to the `authenticated`/any non-bypassrls role, since RLS-enabled tables with zero policies default-deny) is accurate. One minor inaccuracy in the audit's stated methodology: grepping for the literal string 'on organizations' actually returns zero matches in this repo (not "only the index-creation line and RLS-enable line" as claimed — neither of those lines contains that substring), but this doesn't change the underlying, independently-verified fact that no CREATE POLICY targets organizations anywhere.
- **Recommendation:** Add at least a SELECT policy scoped to organization membership, and a write policy scoped to a tenant-owner/admin permission, for the organizations table.

#### 9. Facilities & Departments admin page (design doc sec 2.2-F) has no write path — facilities, departments, employees, and certification_types are read-only in RLS

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `supabase/migrations/0001_foundation.sql:93-95; supabase/migrations/0002_daily_reports.sql:113; supabase/migrations/0003_scheduling.sql:134-135`
- **Detail:** facilities (0001_foundation.sql:93-95), departments (0002_daily_reports.sql:113), employees (0003_scheduling.sql:134), and certification_types (0003_scheduling.sql:135) each have exactly one SELECT policy and no write policy anywhere in the migrations. Admins cannot create a new facility, rename/re-timezone an existing one, add a department, onboard an employee record, or define a certification type through any RLS-governed client. This blocks the entire 'Onboarding Workflow' sec 9.3 ('Import facilities/departments... and set local defaults') and the Facilities & Departments admin page (sec 2.2-F) at the data-access layer, independent of the missing UI/API.
- **Recommendation:** Add admin.manage-scoped write policies for facilities, departments, employees, and certification_types, mirroring the pattern already used for facility_module_overrides in 0008_admin_config.sql:110.

#### 10. Identity & Permissions admin page (design doc sec 2.2-C) is entirely unimplemented — no RBAC service, no role/permission write policies, and the permission catalog itself is a hardcoded 13-item array, not a managed catalog

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `src/lib/permissions.mjs:1-15; supabase/migrations/0001_foundation.sql:24-51,96-115`
- **Detail:** Design doc sec 3.3 specifies roles, permissions, role_permissions, user_role_assignments, and permission_constraints as admin-manageable tables with a 'role catalog', 'permission graph explorer', and 'effective access simulator' (sec 2.2-C). The actual roles/permissions/role_permissions/memberships tables (0001_foundation.sql:24-51) have SELECT-only RLS policies (0001_foundation.sql:96-115) with no write policy at all — admins cannot create a custom role, grant a permission, or assign a membership through the app. There is no src/lib module for identity/RBAC management (grep for 'memberships|roles|invite|role_permissions' across src/ only matches src/lib/permissions.mjs). permissions.mjs:1-15 hardcodes a flat 13-entry permission array with no module/resource/action structure, no custom-permission support, and it is itself out of sync with what the schema actually enforces: migrations reference 'communications.read' and 'training.read' (confirmed via grep of has_permission() calls across all migrations) but neither code exists in the permissions.mjs catalog, and 'reports.export' exists in the catalog but is never checked by any RLS policy.
- **Recommendation:** Build role/permission CRUD with admin-scoped write RLS policies, and reconcile the permissions.mjs catalog with every has_permission() code actually used across migrations (add communications.read, training.read; remove or wire up reports.export).

#### 11. Forms & Fields / template builder (design doc sec 2.2-D, 3.4) is unimplemented — report_templates/report_template_versions are read-only and no custom_fields/form_definitions tables exist

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `supabase/migrations/0002_daily_reports.sql:13-40,114-115; src/lib/report-schema.mjs:1-65`
- **Detail:** DAILY_REPORTS_MODULE_DESIGN.md sec 10.1-10.2 promises a template catalog, field definitions with conditional visibility, workflow rules, and permissions 'reports.templates.manage', 'reports.workflow.manage', 'reports.distribution.manage' — none of these permission codes appear in src/lib/permissions.mjs:1-15. report_templates and report_template_versions (0002_daily_reports.sql:13-40) have only SELECT RLS policies (0002_daily_reports.sql:114-115), no write policy, so no admin can create or publish a template through the app. src/lib/report-schema.mjs:1-65 is only a pure client-side/schema validator (validateReportTemplateSchema, validateReportSubmission) with no persistence, no versioning workflow, no draft/publish state machine, and no sandbox test mode as promised in sec 10.3. The design doc's custom_fields, form_definitions, form_field_bindings, form_publications tables (sec 3.4) do not exist in any migration.
- **Recommendation:** Add write RLS policies for report_templates/report_template_versions gated on a new reports.templates.manage permission, and build the persistence/versioning/publish workflow around the existing validator.

#### 12. Notifications admin page and per-module 'Notification policy' controls (design doc sec 2.2-E, 3.5) are entirely absent — no distribution lists, routing tables, or code

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `src/lib/communications.mjs:23-25; supabase/seed.sql:164 (unused facility_settings.notifications.quietHoursStart/End)`
- **Detail:** Design doc sec 3.5 specifies notification_events, distribution_lists, distribution_list_members, notification_routes, notification_route_overrides. None of these tables exist in any migration (grep of 'create table' across 0001-0008 confirms only notification_jobs/notification_deliveries exist, in 0006_communications.sql, which model a single facility's outgoing jobs — not admin-configurable routing/escalation policy). SCHEDULING_SYSTEM_DESIGN.md:242-243 and COMMUNICATION_TRAINING_SYSTEM_DESIGN.md sec 8.1 both promise admin-configurable notification routing/escalation chains and a distribution-list/audience builder; none of this is backed by schema or code. src/lib/communications.mjs:23-25 hardcodes `shouldBypassQuietHours` as `priority === 'emergency' || priority === 'urgent'` — quiet-hours bypass and channel routing are not read from any tenant/facility configuration despite facility_settings seed data already containing `notifications.quietHoursStart/End` (supabase/seed.sql:164) that nothing in src/lib actually consumes.
- **Recommendation:** Add distribution_lists/notification_routes tables and wire shouldBypassQuietHours (and channel selection generally) to read facility_settings/department_settings instead of hardcoded constants.

#### 13. db:verify release gate is a hard SyntaxError and has never run

- **Dimension:** Architecture & Code Quality
- **Location:** `scripts/verify-migrations.mjs:64-67 (also duplicates of :33,:46,:57); README.md:19-30`
- **Detail:** scripts/verify-migrations.mjs fails to even parse. The requiredRlsTables array (lines 15-68) ends with four adjacent string literals missing comma separators: `"admin_change_requests"` (line 64) then `"certification_events"` (65), `"incident_amendments"` (66), `"schedule_publications"` (67). Adjacent string literals with no comma inside an array literal is invalid JS, so `node scripts/verify-migrations.mjs` throws `SyntaxError: Unexpected string` before any check runs (confirmed by execution). The last three of those entries are also duplicates of items already present earlier in the same array (lines 33, 46, 57). README.md lines 19-30 explicitly lists `npm run db:verify` as a mandatory 'production readiness check' to run 'before opening a release candidate' — a gate that cannot ever have passed. Even if it parsed, its RLS 'verification' is a naive `combinedSql.includes(...)` substring match (line 71), not real SQL parsing.
- **Recommendation:** Add the missing commas, delete the three duplicate table names, and add a smoke test that actually executes db:verify in CI so a non-parsing gate cannot ship again.

#### 14. seed.sql is malformed and will fail to load into Postgres

- **Dimension:** Architecture & Code Quality
- **Location:** `supabase/seed.sql:17-21; README.md:34`
- **Detail:** supabase/seed.sql line 17 ends the permissions VALUES row `('communications.publish', 'Publish communications')` with NO trailing comma, then lines 18-21 append four more value tuples (`('incidents.read', ...)`, `('incidents.manage', ...)`, `('admin.manage', ...)`, `('reports.template.manage', ...)`) before the `on conflict` clause on line 22. Two adjacent row constructors without a comma in a VALUES list is a Postgres syntax error, so the entire seed insert aborts. Those four trailing tuples are also duplicates of rows already inserted earlier in the same statement (e.g. incidents.read at line 10). README.md line 34 instructs operators to 'load supabase/seed.sql for demo organization, two facilities, and baseline permissions' — this step is broken out of the box. Same bad-merge/paste bug class as the verify-migrations.mjs finding.
- **Recommendation:** Add the missing comma or (better) delete the duplicated trailing rows; validate seed.sql against a real Postgres instance in CI.

#### 15. "Production-grade SaaS" is a static HTML mockup with zero runtime code

- **Dimension:** Architecture & Code Quality
- **Location:** `src/public/index.html:1-172; package.json:1-21; src/lib/*.mjs (imported only by scripts/typecheck.mjs and test/*); PLATFORM_ARCHITECTURE.md:14-27,200-247`
- **Detail:** README.md:1-3 and package.json:5 claim a 'production-grade recreation operations SaaS platform', and PLATFORM_ARCHITECTURE.md promises a Next.js PWA, offline IndexedDB queue/sync, Supabase Edge Functions, Realtime channels, notification dispatcher, PDF export, and Zod boundary validation. None of that exists. The served frontend (src/public/index.html, 172 lines) is entirely static: no <script> tag anywhere (grep for script/onclick/fetch/supabase finds nothing), every button is `type="button"` with no handler (e.g. lines 65-66, 87, 103), the facility <select> (lines 26-29) drives nothing, and all data (INC-2026-0001, employee names, counts) is hardcoded. package.json has zero dependencies — no Supabase client, no auth, no Next.js. The src/lib/*.mjs modules are pure helper functions that are never imported by any runtime code: the only non-test importer in the whole repo is scripts/typecheck.mjs (permissions.mjs). There is no application layer, API, or DB wiring connecting the frontend, the lib functions, and the SQL schema.
- **Recommendation:** Recalibrate README/package.json/PLATFORM_ARCHITECTURE language to reflect that this is an early foundation (schema + isolated domain helpers + a static shell), or begin wiring auth/data/API so the claim becomes true.

#### 16. `organizations` has RLS enabled but no policy at all — table is completely unreadable to any client

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0001_foundation.sql:85 (no matching create policy)`
- **Detail:** 0001 enables RLS on organizations (`alter table organizations enable row level security;`, line 85) but never creates any policy for it, unlike every other table in the migration. RLS default-deny means authenticated users get zero rows from organizations. Any UI that resolves an org name (the top of the tenant hierarchy) via the Supabase auth/anon client will silently see nothing. Either a SELECT policy is missing, or the table is intended to be service-role-only and that intent is undocumented.
- **Recommendation:** Add a SELECT policy scoped to the caller's org (e.g. org id in the set of orgs owning `current_facility_ids()`), or document that organizations is service-role-only.

#### 17. No RLS USING clause excludes soft-deleted rows — deleted_at rows remain fully readable

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0002_daily_reports.sql:113-121; 0003:134-146; 0004:123-134; 0005:73-80; 0006:109-118; 0007:99-108`
- **Detail:** Nearly every tenant table carries a `deleted_at timestamptz` soft-delete column (departments, report_submissions, employees, incident_reports, work_orders, messages, courses, etc.), and POSTGRES_SUPABASE_SCHEMA.md section 3.1 explicitly states the strategy is to 'Exclude soft-deleted rows by default in USING clauses.' However, not one policy in 0002-0008 includes `deleted_at is null`. E.g. `report readers can read submissions ... using (has_permission(auth.uid(), facility_id, 'reports.read'))` (0002:116) returns soft-deleted submissions. Soft-deleted incident reports, messages, employees, etc. all stay visible through the API. This is both a stated-vs-actual gap and a data-governance/leak concern (e.g. a 'deleted' incident with legal_hold still readable).
- **Recommendation:** Add `and deleted_at is null` to the USING clause of every SELECT/ALL policy on soft-deletable tables (and gate un-delete via a separate WITH CHECK), matching the documented strategy.

#### 18. report_submissions UPDATE policy makes the draft→submitted transition impossible via RLS

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0002_daily_reports.sql:114-119`
- **Detail:** The only write path for report_submissions after insert is `report submitters can update drafts ... for update using (has_permission(auth.uid(), facility_id, 'reports.submit') and status = 'draft')` (0002:118). There is no WITH CHECK, so Postgres reuses the USING expression as the WITH CHECK for the post-update row. That forces the NEW row to also satisfy `status = 'draft'` — meaning a submitter can never change status to 'submitted'/'locked'/'revised'. The core report workflow (submit a draft) cannot be performed through RLS at all; it silently requires the service role. There is also no INSERT/UPDATE policy at all for report_templates or report_template_versions even though a `reports.template.manage` permission is defined (seed.sql:15) and template authoring is a feature — templates can only be written via service role.
- **Recommendation:** Add an explicit WITH CHECK that permits status transitions (e.g. `with check (has_permission(auth.uid(), facility_id, 'reports.submit') and status in ('draft','submitted','revised'))`), and add manage policies for report_templates/report_template_versions gated on `reports.template.manage`, or document that these tables are service-role-only.

#### 19. Missing security headers in dev-server

- **Dimension:** Frontend & UX
- **Location:** `scripts/dev-server.mjs lines 9-18, specifically line 17 response.writeHead()`
- **Detail:** Dev server (scripts/dev-server.mjs) sets only 'content-type' header (line 17) when serving resources. No security headers present: no Content-Security-Policy, no X-Frame-Options, no X-Content-Type-Options, no Strict-Transport-Security, no Referrer-Policy, or cache control headers. While this is a development server, production deployment would be vulnerable to clickjacking, MIME-sniffing, and lack CSP protections.

#### 20. UI shows 6 modules plus admin but no routing or module state

- **Dimension:** Frontend & UX
- **Location:** `src/public/index.html lines 32-169, PHASED_MVP_ROADMAP.md section 6 (UI Priorities)`
- **Detail:** Index.html displays cards for Daily reports, Scheduling, Incidents, Work orders, Communications, Training, and Admin (lines 32-169). Each suggests it is a separate module/workflow. No mechanism exists to navigate between them, show/hide module-specific content, or manage module-enabled state. Design calls for module toggles and feature flags (MASTER_ADMIN_CONTROL_CENTER_DESIGN.md 2.2B) and modular bounded contexts (PLATFORM_ARCHITECTURE.md 1.1) but UI is a single flat page.

#### 21. Facility context selection has no state management

- **Dimension:** Frontend & UX
- **Location:** `src/public/index.html lines 24-30, MASTER_PRODUCTION_READINESS_PLAN.md section 3.3`
- **Detail:** The core factual claims are accurate: src/public/index.html lines 24-30 contain a facility `<select>` with two hardcoded options, no `id`/`name`, no `<script>` tag anywhere on the page, and no JS file exists in src/public at all (only index.html and styles.css). A repo-wide search confirms zero client-side JS references to the facility switcher, and package.json/README explicitly describe the frontend as a "Static Node-served web foundation with zero runtime dependencies." MASTER_PRODUCTION_READINESS_PLAN.md section 3.3 does list "Implement active facility context selection" as a task, and PHASED_MVP_ROADMAP.md section 6.1 lists "Login + facility context switch" as step 1 of the MVP UI sequence — so the design-doc citations are accurate and the gap is genuine, not a misreading. However, severity 'high' framing as if the facility switcher is a uniquely broken/overlooked feature is misleading: literally every interactive element on this page (all buttons, the report form, schedule/incident/work-order action buttons) is equally non-functional with zero JS anywhere in the entire repo (confirmed via file listing — no client-side .js files exist at all). The page itself is labeled "Production readiness sprint 1" in its own markup, indicating this is an intentional early-stage static scaffold/wireframe rather than a regression or isolated defect. A more accurate framing would be 'the entire frontend is a static non-interactive mockup with no client-side logic,' of which the facility switcher is one unremarkable instance — likely medium severity as a tracked gap rather than a standalone high-severity finding.

#### 22. Admin config mutations are not audited and audit tables are not writable/append-only as designed

- **Dimension:** Security, Permissions & Auth
- **Location:** `supabase/migrations/0008_admin_config.sql:110-114; supabase/migrations/0002_daily_reports.sql:74-83,110,120; supabase/migrations/0004_incidents.sql:84,120,133; src/lib/admin-config.mjs:22-31; MASTER_ADMIN_CONTROL_CENTER_DESIGN.md:274-293`
- **Detail:** Technical claims are accurate as cited (no triggers, no insert policies on audit_events/incident_audit_events, no audit_signatures table, no hash-chain enforcement, no UPDATE/DELETE restrictions). The one overreach: the claim that this 'requires the service-role key' which 'bypasses RLS' describes a hypothetical consequence, not an observed code path — the repo has no actual supabase client wiring or API/edge-function code anywhere that inserts audit rows at all yet (src/lib/admin-config.mjs's buildConfigAuditEvent is currently only exercised by a unit test). So this is best framed as 'the audit trail mandated by the design doc is entirely unimplemented at the DB layer, and the current RLS policies would block the obvious client-side insert path if one were built' rather than as an active bypass in a live system.
- **Recommendation:** Add DB triggers (or explicit INSERT policies + server writes) that record audit_events on every admin config mutation; make audit tables append-only (deny UPDATE/DELETE even for service role via triggers/revokes); implement audit_signatures / hash-chaining as specified; ensure the app's non-service client can insert its own audit rows under a scoped insert policy.

#### 23. No server-side RLS write policies for roles, role_permissions, or memberships — privilege grants rely entirely on service-role code with no DB backstop or audit

- **Dimension:** Security, Permissions & Auth
- **Location:** `supabase/migrations/0001_foundation.sql:85-115 (RLS enabled, SELECT-only policies for roles/role_permissions/memberships); MASTER_ADMIN_CONTROL_CENTER_DESIGN.md:200-210,220-221`
- **Detail:** All cited facts are accurate: 0001_foundation.sql has RLS-enabled, SELECT-only policies for roles/role_permissions/memberships with no INSERT/UPDATE/DELETE policy in this or any later migration, and no audit trigger. This is a real, verifiable inconsistency given that 0008_admin_config.sql demonstrates the same team applying has_permission()-gated 'for all' write policies to other admin tables (facility_settings, department_settings, branding_profiles, admin_change_requests) but never to the core RBAC tables. However, the report's phrase 'un-reviewed server code' overstates current risk: no service-role code implementing role/permission/membership grant workflows exists anywhere in the repo yet (grep across src/lib and tests finds nothing) -- this is presently an architectural/latent gap for a feature that hasn't been built, not an actively exploitable path in shipped code today. Severity 'high' is defensible for the RBAC-table gap itself but is somewhat aggressive given there is no current exploitable implementation to point to.
- **Recommendation:** Add explicit RLS write policies scoping membership/role/role_permission mutations to admin.manage within the same facility/organization, plus a WITH CHECK preventing granting permissions the actor doesn't hold; emit audit events on grants; avoid using the service-role key for routine admin role management.

#### 24. CI does run db:verify and would catch this exact bug — meaning CI on main is currently failing

- **Dimension:** Testing, CI & Tooling
- **Location:** `.github/workflows/ci.yml:17-23; package.json:15; scripts/verify-migrations.mjs:65`
- **Detail:** .github/workflows/ci.yml runs `npm run db:verify` as the final step (line 23), after format:check, lint, typecheck, test, and build (lines 18-22), with no continue-on-error. Since db:verify maps to `node scripts/verify-migrations.mjs` (package.json:15) and that file has a hard SyntaxError at module-load time, the step throws and exits non-zero, and GitHub Actions fails the job by default. So CI would catch this specific bug — but that also means CI on main has been broken since the merge (fa36588 / PR #8 / febc99c) that introduced it, and it is still broken at HEAD.
- **Recommendation:** Fix the syntax bug and re-run CI to confirm green; add branch protection requiring the checks job to pass before merge so a broken db:verify script cannot land on main again.


### Medium (15)

#### 25. Certifications admin page and certification policy engine (design doc sec 2.2-G, 3.7) are unimplemented — no certification_role_requirements/certification_policies tables, no hard-block-vs-warning toggle

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `src/lib/scheduling.mjs:21-28; src/lib/training.mjs:19-21; supabase/migrations/0003_scheduling.sql:16-26,135; supabase/migrations/0007_training.sql:1-3`
- **Detail:** Design doc sec 3.7 specifies certification_role_requirements and certification_policies tables for role-to-cert mapping and retraining/enforcement cadence; neither exists in any migration. SCHEDULING_SYSTEM_DESIGN.md:236-237 promises an admin toggle for 'hard-block vs warning for expired certs', but src/lib/scheduling.mjs:21-28 (findMissingCertifications) and src/lib/training.mjs:19-21 (certificationBlocksSchedule, hardcoded to `['expired','revoked'].includes(...)`) always hard-block with no facility-configurable warning mode. certification_types (0003_scheduling.sql:16-26) has validity_days/grace_days/auto_suspend_roles columns added in 0007_training.sql:1-3, but the table has only a SELECT RLS policy (0003_scheduling.sql:135), so admins cannot edit these policy fields through the app at all.
- **Recommendation:** Add write RLS for certification_types scoped to admin.manage/training.manage, add certification_role_requirements, and make findMissingCertifications/certificationBlocksSchedule consult a facility-level enforcement-mode setting instead of always hard-blocking.

#### 26. Billing & Subscription controls (design doc sec 2.2-J, 3.9, 10) are 100% absent — no plan/entitlement/usage-counter tables, no enforcement code

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `supabase/migrations/0001_foundation.sql:3-7 (organizations has no plan_id); no billing tables in any migration`
- **Detail:** Design doc sec 3.9 lists subscription_plans, tenant_subscriptions, subscription_addons, tenant_addons, usage_counters as the schema for the Billing & Subscription admin page, and sec 10 describes entitlement-gated feature access with soft/hard limit enforcement. None of these tables exist in any of the 8 migrations (confirmed via grep for 'create table' across all files). There is no entitlement-guard code anywhere in src/lib. The 'organizations' table (0001_foundation.sql:3-7) has no plan_id column at all, contradicting even the minimal tenants(...,plan_id,...) shape the design doc specifies in sec 3.1.
- **Recommendation:** Either scope billing out of the near-term plan explicitly, or add the minimal subscription_plans/tenant_subscriptions tables plus an entitlement-check helper before advertising per-tier module gating.

#### 27. Per-module 'Admin Controls' sections promised in module design docs are all hardcoded business rules, not tenant/facility-configurable settings

- **Dimension:** Admin Control Center Gap Analysis
- **Location:** `src/lib/scheduling.mjs:1-38; src/lib/incidents.mjs:1-2; src/lib/work-orders.mjs:1-2`
- **Detail:** SCHEDULING_SYSTEM_DESIGN.md:230-243 (Admin Controls: publish cadence, approval requirements, max hours warnings, conflict thresholds, open-shift claim window, cert enforcement mode, visibility controls, notification policy) has zero corresponding fields consumed by src/lib/scheduling.mjs (38 lines total, no config parameter in any exported function). src/lib/incidents.mjs:1-2 hardcodes `escalationSeverities = new Set(['high','critical'])` and `oshaReviewTriggers` as module-level constants rather than reading from a facility/tenant escalation-policy config, even though facility_settings.settings_jsonb (0008_admin_config.sql:32-42) exists and could hold exactly this. src/lib/work-orders.mjs:1 hardcodes `priorityRank` and `openStatuses`. None of the six workflow modules (scheduling, incidents, work orders, communications, training, daily reports) expose a single admin-configurable setting today; every threshold, priority order, escalation trigger, and enforcement rule is a literal constant in source.
- **Recommendation:** Introduce a facility-config parameter (sourced from facility_settings.settings_jsonb via mergeSettings) into these pure functions so 'admin controls everything' is at least structurally possible, then build the admin surfaces to edit it.

#### 28. lint/typecheck/format-check gates are near-meaningless despite being branded 'production readiness checks'

- **Dimension:** Architecture & Code Quality
- **Location:** `scripts/typecheck.mjs:1-3; scripts/lint.mjs:10-14; scripts/format-check.mjs:11; README.md:19-30`
- **Detail:** The three quality scripts the README (lines 19-30) presents as release gates do almost nothing. scripts/typecheck.mjs (3 lines) asserts only that the permissions array contains the string 'admin.manage' — there is no TypeScript anywhere in the repo, so 'typecheck' is a misnomer for one membership assertion. scripts/lint.mjs (lines 10-14) only flags tab characters and a hyper-specific string `try {\n    await import` — it performs no actual static analysis. scripts/format-check.mjs (line 11) only checks that each file ends in a trailing newline. These gates give false confidence: the verify-migrations.mjs SyntaxError and seed.sql syntax error both sailed past lint/typecheck/format-check untouched.
- **Recommendation:** Either adopt real tools (eslint/prettier/tsc) or rename these to honest 'smoke check' scripts and stop marketing them as production readiness gates.

#### 29. Permission model drift across permissions.mjs, seed.sql, and PLATFORM_ARCHITECTURE.md

- **Dimension:** Architecture & Code Quality
- **Location:** `src/lib/permissions.mjs:1-15; supabase/seed.sql:2-21; PLATFORM_ARCHITECTURE.md:108,133`
- **Detail:** Three sources define incompatible permission vocabularies. (1) src/lib/permissions.mjs:1-15 is a frozen 13-entry array treated as the canonical contract (typecheck.mjs guards it). (2) supabase/seed.sql:1-21 inserts permission codes that the lib array does NOT contain: `reports.template.manage`, `training.read`, and `communications.read` — so the app's permission enum and the DB seed disagree on what permissions exist. (3) PLATFORM_ARCHITECTURE.md prescribes a different scheme entirely: a `module.resource.action` format with examples `incidents.report.create`, `work_orders.assign`, `sop.publish` (line 133) and an RLS helper call `has_permission(auth.uid(), facility_id, 'incidents.write')` (line 108) — none of `incidents.write`, `incidents.report.create`, or `work_orders.assign` exist in either the lib array or the seed. Any code relying on permissions.mjs as the source of truth will diverge from what the database actually grants.
- **Recommendation:** Pick one canonical permission list, generate the seed from it (or test that seed codes are a subset of the lib enum), and reconcile the architecture doc's format with the implemented `module.action` codes.

#### 30. Insert/update policies validate only facility_id, not that referenced FKs belong to the same facility — cross-tenant reference injection

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0002_daily_reports.sql:117; 0003:96-97; 0005:15-33; 0007:33-48`
- **Detail:** Write policies gate solely on `has_permission(auth.uid(), facility_id, ...)`. They never verify that FK columns point to rows in the same facility. For example a user with `reports.create` on facility A can insert a report_submission with `facility_id = A` but `template_id`/`template_version_id`/`department_id` referencing facility B's rows (0002:117 checks only facility_id). Same pattern for schedule_shifts.schedule_period_id, shift_assignments.employee_id, work_orders.asset_id/assigned_to_employee_id, incident_* child tables, training_assignments.course_id, etc. The FK constraints are cross-facility-agnostic (they reference the base table by id only), so nothing at the DB layer stops a row in tenant A from pointing at tenant B's object. This corrupts tenant isolation of relationships and can leak the existence/id of another tenant's objects.
- **Recommendation:** Either add same-facility checks to WITH CHECK clauses (e.g. `exists (select 1 from report_templates t where t.id = template_id and t.facility_id = report_submissions.facility_id)`) or use composite FKs `(facility_id, id)` so the FK itself enforces same-tenant references.

#### 31. Policies are not idempotent — re-running any migration fails on CREATE POLICY

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0001_foundation.sql:93-115 (and all create policy statements in 0002-0008)`
- **Detail:** The migrations lean on `create table if not exists`, `create index if not exists`, and `create or replace function` for idempotent re-runs, but every `create policy` statement (0001:93-115, 0002:113-121, 0003:134-146, 0004:123-134, 0005:73-80, 0006:109-118, 0007:99-108, 0008:102-114) has no idempotency guard. Postgres CREATE POLICY has no IF NOT EXISTS, so re-applying a migration (a common recovery/CI pattern given the `if not exists` used everywhere else) errors with `policy "..." already exists`. The mixed use of `if not exists` on tables but bare CREATE POLICY makes the file only partially idempotent, which is a trap.
- **Recommendation:** Precede each policy with `drop policy if exists "<name>" on <table>;`, or wrap creation in a DO block that checks pg_policies, so the migrations are fully re-runnable.

#### 32. POSTGRES_SUPABASE_SCHEMA.md describes a fundamentally different schema than the migrations (pervasive drift)

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `POSTGRES_SUPABASE_SCHEMA.md:6-11, 60-109, 190-227 vs supabase/migrations/0001_foundation.sql:3-83`
- **Detail:** The design doc does not match the implemented schema on nearly every core point: (1) it has NO `organizations` table and calls `facilities` the tenant boundary, but migrations add a two-level `organizations -> facilities` hierarchy (0001:3-15); (2) doc uses `users`, migrations use `app_users` (0001:17); (3) doc authorizes via `user_role_assignments` + `is_facility_member()` + a 2-arg `has_permission(p_facility_id, p_permission)` reading `permissions.id uuid` (md:94-109), but migrations use `memberships` + `current_facility_ids()` + a 3-arg `has_permission(check_user_id, check_facility_id, permission_code)` where `permissions` PK is `code text` (0001:32-35, 43-51, 67-83) and `is_facility_member` does not exist; (4) doc defines Postgres ENUM types (`create type app_status`, `shift_status`, etc., md:60-69) but migrations use `text ... check (...)` throughout and never create a single enum; (5) role_permissions references `permission_id uuid` in the doc vs `permission_code text` in migrations (0001:37-41); (6) table names differ (shifts vs schedule_shifts, daily_report_submissions vs report_submissions, notifications vs notification_jobs/deliveries, audit_log vs audit_events/incident_audit_events); (7) doc claims `created_by/updated_by/deleted_by` on every table but migrations largely omit updated_by/deleted_by and often created_by; (8) doc's btree_gin extension and JSONB gin indexes (md:58,417-423) are absent. A reader using this doc to reason about RLS or write queries will be systematically wrong.
- **Recommendation:** Rewrite POSTGRES_SUPABASE_SCHEMA.md to reflect the actual implemented schema (organizations hierarchy, app_users, memberships, text+check enums, code-based permissions, 3-arg has_permission), or clearly mark it as an aspirational design not yet built.

#### 33. Message read-receipts and acknowledgements cannot be written by employees via RLS

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0006_communications.sql:115-116; 0001_foundation.sql:102-103`
- **Detail:** Core claim confirmed exactly as stated: 0006_communications.sql:115-116 defines only SELECT policies for message_receipts and message_acknowledgements ("communication readers can read receipts"/"...acknowledgements", gated on communications.read), with no INSERT/UPDATE/ALL policy anywhere in the migrations for either table (verified via repo-wide grep). The only other policies touching these tables' siblings (messages, communication_channels, message_audiences, notification_jobs) are gated on communications.publish (grep of seed.sql/src/lib/permissions.mjs shows communications.publish is the sole write-granting permission for the whole comms module, listed alongside admin.manage/training.manage as elevated). There is no self-row pattern anywhere in the schema (no `employee_id in (select ... where user_id = auth.uid())` style policy exists in any migration) that would let an employee write their own receipt/ack row, so the finding that the required-ack/read-receipt workflow (is_required_ack/ack_due_at) is inoperable for regular staff under RLS and must go through the service role is accurate. The design doc (COMMUNICATION_TRAINING_SYSTEM_DESIGN.md) explicitly promises employee-driven "Acknowledge" actions and an `ack.submitted` event, confirming this is a genuine gap vs. the intended design, not a deliberate service-role-only design choice. One secondary/tangential point in the DETAIL is slightly overstated: app_users:102-103 ("users can read themselves") does mean managers can't resolve co-workers' *emails* (email only lives on app_users, which has no broader read policy) — but employee *names* are actually resolvable, since the separate `employees` table (0003_scheduling.sql) has first_name/last_name and a facility-wide read policy ("members can read employees" — any active member of the facility can select all employees rows). So "cannot resolve co-workers' names ... from app_users" is misleading (roster names come from employees, not app_users); "cannot resolve ... emails" is accurate. This is a minor blemish on an ancillary "similarly" remark, not the core finding, and doesn't affect the well-evidenced primary claim about message_receipts/message_acknowledgements. Severity of "medium" is reasonable, not inflated — it's a real compliance-workflow gap requiring service-role bypass for basic user actions (read receipts, acks), but it's not a data-exposure/privilege-escalation issue.
- **Recommendation:** Add employee-scoped INSERT/UPDATE policies for message_receipts/message_acknowledgements (e.g. `employee_id` maps to the caller's own employee row), and either broaden the app_users SELECT policy to same-facility members or document that these writes/reads are service-role mediated.

#### 34. report_submissions UPDATE policy omits WITH CHECK, blocking the submit transition and leaving row transitions unenforced

- **Dimension:** Security, Permissions & Auth
- **Location:** `supabase/migrations/0002_daily_reports.sql:117-118`
- **Detail:** The update policy `report submitters can update drafts` (0002_daily_reports.sql:118) specifies only USING (`has_permission(...,'reports.submit') and status = 'draft'`) with no WITH CHECK. In Postgres, when WITH CHECK is omitted the USING expression is applied to the NEW row as well, so the updated row must still satisfy `status = 'draft'` — a submitter can never move a report from draft to submitted/locked/revised through this policy, breaking the core submit workflow. There is also no policy at all governing submitted→locked→revised transitions, so all lifecycle state changes must go through the service role (RLS bypass), again with no DB-level enforcement of who may lock/revise a report. The intended constraints (which columns/status a submitter may set) are therefore neither expressed nor enforced.
- **Recommendation:** Add an explicit WITH CHECK that permits the intended status transition (e.g. new status in ('draft','submitted')) while pinning facility_id, and add dedicated policies (or a security-definer RPC) for lock/revise transitions gated by the appropriate permission.

#### 35. Permission model is flat/facility-only and diverges materially from the designed hierarchy

- **Dimension:** Security, Permissions & Auth
- **Location:** `src/lib/permissions.mjs:1-26; supabase/migrations/0001_foundation.sql:67-83; supabase/migrations/0008_admin_config.sql:103-114; MASTER_ADMIN_CONTROL_CENTER_DESIGN.md:190-210`
- **Detail:** All cited facts check out exactly against the repo:
- src/lib/permissions.mjs:1-15 is indeed a flat array of exactly 13 facility-scoped permission strings (Object.freeze), with no scope/hierarchy encoding, ending with the single `admin.manage` catch-all (confirmed lines 1-26 total).
- 0001_foundation.sql:67-83 `has_permission(user_id, facility_id, permission_code)` joins only memberships + role_permissions filtered by facility_id and active status — no tenant/department/self scope parameter or evaluation exists anywhere in the migrations.
- 0008_admin_config.sql: `organization_module_settings` (lines 103-109) has only a SELECT policy gated by facility-level `admin.manage`; there is no INSERT/UPDATE/DELETE/ALL policy for org-level config, so no org-scope admin write path exists via RLS. Lines 110-114 are exactly five `for all` policies (facility_module_overrides, facility_settings, department_settings, branding_profiles, admin_change_requests) all gated by the same single `admin.manage` facility permission — including department_settings, so there is no department- or self-scoped check despite the department_settings table existing.
- MASTER_ADMIN_CONTROL_CENTER_DESIGN.md:190-210 (section 4, "Permission Hierarchy") does specify 5 hierarchical scopes, system roles, `module.resource.action` encoding, and a 6-step evaluation order including entitlement checks and deny rules — none of which appear in permissions.mjs or the migrations.
However, severity is likely overstated as a standalone "medium security" finding: MASTER_PRODUCTION_READINESS_PLAN.md explicitly specifies (and the code matches almost verbatim) a simpler facility_id-scoped RBAC model with `has_permission(user_id, facility_id, permission_code)` as the actual near-term build target, and PHASED_MVP_ROADMAP.md explicitly places "Advanced permissions and delegated administration" in Phase 3 (months 7-12), i.e. deliberately deferred, not an unmet promise for the current build. MASTER_ADMIN_CONTROL_CENTER_DESIGN.md reads as a separate, more ambitious target-state design for a later "Master Admin Control Center" surface rather than the governing spec for what exists today. So the individual factual claims (flat permission set, single admin.manage blast radius, no dept/tenant/self scoping, no deny/entitlement logic) are all accurate and verifiable, but this is better characterized as a documented, roadmap-acknowledged phasing gap / architecture-doc drift than an active, unaddressed security hole in the currently shipped feature set — I'd downgrade to low/informational rather than medium.
- **Recommendation:** Either narrow the design to match the flat model or split admin.manage into granular permissions (module.toggle, branding.publish, settings.publish, change_request.approve, membership.manage) and introduce tenant/department scope predicates; separating request/approve permissions also prevents self-approval of change requests.

#### 36. Earlier CI steps (lint/format/typecheck/test) cannot catch the syntax error — they never parse or execute scripts/*.mjs as code

- **Dimension:** Testing, CI & Tooling
- **Location:** `scripts/lint.mjs:1-19; scripts/format-check.mjs:1-17; scripts/typecheck.mjs:1-3`
- **Detail:** All specific technical claims are verified by direct execution and file inspection: lint.mjs (19 lines, confirmed by wc -l) only does readFileSync + string/regex checks (tab chars, one try/catch-import string pattern) across src/scripts/test and never parses JS; format-check.mjs (17 lines) only checks trailing-newline; typecheck.mjs (3 lines) only imports src/lib/permissions.mjs and checks one string in an array, never touching scripts/verify-migrations.mjs or the other 8 lib modules (admin-config, communications, work-orders, scheduling, report-schema, incidents, training, env). Running `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` all exit 0 despite scripts/verify-migrations.mjs containing an actual SyntaxError (missing commas between array string literals at lines 65-67); only `node scripts/verify-migrations.mjs` (i.e. `npm run db:verify`) throws it. `node --test` ran 25 tests, all from test/*.test.mjs, none touching scripts/verify-migrations.mjs. CI (.github/workflows/ci.yml) runs exactly the 6 named commands (format:check, lint, typecheck, test, build, db:verify) in that order. One numeric detail is off: the script survives 5 of these 6 commands (format:check, lint, typecheck, test, build all pass) before being caught by the 6th (db:verify) — not "4 of the 6" as stated. This is a minor miscount, not a substantive error; the core mechanism and conclusion ("only db:verify catches it") are fully correct. Severity of medium is reasonable given this is a genuine test-coverage gap for the scripts/ directory, not inflated.
- **Recommendation:** Have lint.mjs (or a new step) run `node --check <file>` over every .mjs file under scripts/ and src/ to catch syntax errors cheaply and early, rather than relying on db:verify's full readdir+readFile+string-scan to be the only thing that loads the module.

#### 37. 'typecheck' and 'lint' scripts are not real tooling — no ESLint/TSC/Prettier anywhere, contradicting the script names

- **Dimension:** Testing, CI & Tooling
- **Location:** `package.json:7-16 (no dependencies/devDependencies block); scripts/lint.mjs; scripts/typecheck.mjs; scripts/format-check.mjs`
- **Detail:** package.json declares no dependencies or devDependencies at all. `npm run typecheck` (scripts/typecheck.mjs, 3 lines) does not run TypeScript or any type checker — it imports one lib module and asserts one string is present in an array. `npm run lint` (scripts/lint.mjs) does not run ESLint or any AST-based linter — it's a tab-character/string-pattern grep. `npm run format:check` (scripts/format-check.mjs) only checks trailing newlines, not real formatting. There is no static analysis of variable use, unreachable code, unused imports, type mismatches, or even basic syntax validity across most of the codebase — as directly demonstrated by the verify-migrations.mjs bug slipping past all three.
- **Recommendation:** Either rename these scripts to reflect what they actually do (e.g. style:tabs-check, contract-smoke) to stop misleading contributors/CI readers, or invest in real tooling (ESLint flat config, Prettier, and/or tsc --checkJs with JSDoc) — devDependencies can be added without violating the 'zero runtime deps' goal since that only concerns the shipped app.

#### 38. src/lib/env.mjs's readServerEnv is exported but completely untested

- **Dimension:** Testing, CI & Tooling
- **Location:** `src/lib/env.mjs:34-45; test/env.test.mjs:1-24 (readServerEnv never imported)`
- **Detail:** src/lib/env.mjs exports both readClientEnv (lines 13-32) and readServerEnv (lines 34-45), the latter adding handling for optional server-only fields (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, OBSERVABILITY_DSN) including URL validation via assertUrl for OBSERVABILITY_DSN (lines 39-41). test/env.test.mjs (24 lines) imports and tests only readClientEnv — readServerEnv has zero coverage, including its OBSERVABILITY_DSN URL-validation branch, which governs how server secrets get read into the returned env object.
- **Recommendation:** Add test cases for readServerEnv: no optional fields set, SUPABASE_SERVICE_ROLE_KEY/DATABASE_URL set, and an invalid OBSERVABILITY_DSN to confirm it throws via assertUrl.

#### 39. supabase/tests/tenant_isolation.sql (RLS check) exists but is never run by any npm script or CI job

- **Dimension:** Testing, CI & Tooling
- **Location:** `supabase/tests/tenant_isolation.sql:1-3; package.json:7-16 (no script references it); .github/workflows/ci.yml:8-23 (no step runs it)`
- **Detail:** supabase/tests/tenant_isolation.sql contains SQL intended to verify RLS is actually enforced (has_table_privilege / pg_class.relrowsecurity checks), but no npm script references supabase/tests and .github/workflows/ci.yml never runs a SQL test runner (no `supabase test db`, no `pg_prove`) against it. The only thing db:verify actually checks is that the migration files contain the literal substring `alter table X enable row level security` (scripts/verify-migrations.mjs:71) — pure text matching, not real RLS behavior against a running Postgres instance. It would pass even if the RLS policies were logically wrong.
- **Recommendation:** Wire supabase/tests/tenant_isolation.sql into CI via the Supabase CLI's local test runner against a spun-up Postgres/RLS instance, or remove the file if it is aspirational — as-is it gives false confidence that tenant isolation is verified.


### Low (9)

#### 40. Report submission validation ignores half of its own supported field types

- **Dimension:** Architecture & Code Quality
- **Location:** `src/lib/report-schema.mjs:1-12,46-64`
- **Detail:** src/lib/report-schema.mjs declares 10 allowed field types (lines 1-12) including multiselect, checkbox, date, time, photo, and signature, but validateReportSubmission (lines 46-64) only enforces: required-presence for all types, numeric parseability for `number`, and option membership for `select`. A `multiselect` value is never checked against its options; `date`/`time` values are never format-validated; there is no numeric min/max or text length enforcement. For a platform whose selling point (index.html:44-47, PLATFORM_ARCHITECTURE.md:10) is 'metadata-driven configurable forms', the runtime validator is materially thinner than the schema it accepts, so invalid multiselect/date submissions pass validation.
- **Recommendation:** Extend validateReportSubmission to cover multiselect (array + option membership), date/time parsing, and optional numeric/length constraints, or shrink allowedFieldTypes to only what is validated.

#### 41. dev-server.mjs is also the production 'start' server with no hardening

- **Dimension:** Architecture & Code Quality
- **Location:** `scripts/dev-server.mjs:1-19; package.json:10`
- **Detail:** package.json:10 defines `start` as `node scripts/dev-server.mjs dist`, i.e. the same 19-line dev server is the production server. It sets no security headers, no cache-control, no compression, is single-threaded with no error handling on the stream pipe (scripts/dev-server.mjs:18), and only understands three content types (line 7). Path traversal via `../` is mitigated (WHATWG URL normalization collapses the segments and requests return 404 — verified), so that specific risk is low, but shipping a dev server as the prod entrypoint contradicts the deployment architecture in PLATFORM_ARCHITECTURE.md:249-256 (Vercel + Supabase).
- **Recommendation:** Separate dev and production serving; if a static host (Vercel) is the target per the architecture doc, drop the custom prod server or add headers/caching/error handling before calling it production.

#### 42. Missing value/range constraints allow logically invalid rows

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0003_scheduling.sql:43-56, 28-41, 58-72; 0002_daily_reports.sql:42-60`
- **Detail:** schedule_shifts has `check (starts_at < ends_at)` (0003:90) but schedule_periods has no `check (week_start_date <= week_end_date)` (0003:43-56), and employee_certifications has no `check (issued_at <= expires_at)` (0003:28-41). report_submissions has no uniqueness on `(facility_id, template_id, report_date, shift_ref)` (0002:42-60), so duplicate daily reports for the same date/shift are allowed. shift_templates likewise has no `start_time_local < end_time_local` check (0003:65). These are data-integrity gaps rather than isolation issues.
- **Recommendation:** Add the range/ordering checks and any intended per-period/per-day uniqueness constraints.

#### 43. Some cascade-parent FK columns lack a covering index

- **Dimension:** Database, RLS & Tenant Isolation
- **Location:** `supabase/migrations/0006_communications.sql:18,94; 0007_training.sql:54,62`
- **Detail:** Most FKs are covered by composite or unique indexes, but a few cascade-delete parents are not indexed on the child's FK column, so deleting a parent forces a sequential scan of the child: messages.channel_id (communication_channels cascade; messages_facility_created_idx does not lead with channel_id, 0006:15-18,94), and training_progress.module_id (course_modules cascade; unique(assignment_id, module_id) leads with assignment_id, so module_id alone is unindexed, 0007:50-63). Low impact at current scale but relevant for the 2,000+ facility target the schema doc cites (md:425).
- **Recommendation:** Add indexes on messages(facility_id, channel_id) and training_progress(module_id) (or reorder existing composites) to keep cascade deletes and lookups index-backed.

#### 44. Client-side hasPermission ignores membership status, mirroring server RLS incorrectly

- **Dimension:** Security, Permissions & Auth
- **Location:** `src/lib/permissions.mjs:17-26 vs supabase/migrations/0001_foundation.sql:64,80`
- **Detail:** hasPermission and canAccessFacility (src/lib/permissions.mjs:17-26) match on facilityId and permissions membership but never check membership status. The authoritative server function requires `status = 'active'` (0001_foundation.sql:80; current_facility_ids at line 64 also filters status='active'). A membership in state 'invited' or 'disabled' (schema allows these, 0001:48) therefore passes all client-side checks and the UI will present actions the server will reject. Impact is limited to UI correctness because RLS is authoritative, but the client/server mirror is inconsistent and a disabled user's UI still appears fully authorized.
- **Recommendation:** Have the client helpers require an active status (e.g. `membership.status === 'active'`) so client gating matches server RLS, and cover the disabled/invited case in test/permissions.test.mjs (which currently only tests active-style memberships).

#### 45. Secret separation is correct but service-role/DATABASE_URL handling is unvalidated and shipped with an embedded password placeholder

- **Dimension:** Security, Permissions & Auth
- **Location:** `src/lib/env.mjs:1-45; .env.example:4-5`
- **Detail:** Positive: readClientEnv (src/lib/env.mjs:13-32) returns only NEXT_PUBLIC_* fields, and SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL are read only in readServerEnv (lines 3, 34-45), so the service-role secret is not exposed to the client bundle, and no src/ code references SERVICE_ROLE. Gaps: (1) service-role key and DATABASE_URL are treated as fully optional with no validation that they are absent from any NEXT_PUBLIC_-prefixed variable, so an accidental `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` would not be caught. (2) .env.example:5 ships DATABASE_URL with an embedded credential (`postgres:postgres`) and line 4 a service-role placeholder — acceptable as local defaults, but there is no guardrail/comment marking service-role as server-only and no assertion preventing it from leaking into client env.
- **Recommendation:** Add an explicit assertion in readClientEnv that rejects any NEXT_PUBLIC_ key whose name contains SERVICE_ROLE/DATABASE_URL/secret, annotate .env.example service-role line as server-only, and validate DATABASE_URL as a URL when present.

#### 46. admin-config.mjs's deepMerge array-vs-object branch is untested

- **Dimension:** Testing, CI & Tooling
- **Location:** `src/lib/admin-config.mjs:8; test/admin-config.test.mjs:5-14`
- **Detail:** deepMerge (src/lib/admin-config.mjs:5-15) explicitly special-cases arrays (`!Array.isArray(value)` on line 8) so array-valued settings are replaced wholesale rather than recursively merged — a deliberate behavioral choice for config layering. test/admin-config.test.mjs only exercises deep-merging of plain nested objects (lines 5-14); no test passes an array value through mergeSettings/deepMerge, so this branch is unverified.
- **Recommendation:** Add a case like mergeSettings({tags:['a','b']}, {tags:['c']}) and assert the override array wins outright rather than being merged.

#### 47. report-schema.mjs's validateReportTemplateSchema has several error branches never exercised by tests

- **Dimension:** Testing, CI & Tooling
- **Location:** `src/lib/report-schema.mjs:26,33,34,36,37,38; test/report-schema.test.mjs:17-20`
- **Detail:** validateReportTemplateSchema (src/lib/report-schema.mjs:14-44) has multiple independent validation branches: missing section.title (line 26), missing/empty section.fields (line 27), missing field.key (line 33), duplicate field.key (line 34), missing field.label (line 36), unsupported field.type (line 37), and select field missing options at template-validation time (line 38). test/report-schema.test.mjs only exercises the top-level 'sections must contain at least one section' case (line 19) plus submission-time errors from validateReportSubmission. The template-level branches for missing title/label, duplicate keys, unsupported type, and select-without-options are never triggered by any test.
- **Recommendation:** Add a template with a duplicate field key, one with an unsupported type, and one with a select field lacking options, and assert validateReportTemplateSchema returns the expected error messages for each.

#### 48. README's readiness-check list matches CI step order/content exactly — correctly wired (informational, not a gap)

- **Dimension:** Testing, CI & Tooling
- **Location:** `README.md:19-30; .github/workflows/ci.yml:17-23`
- **Detail:** README.md:23-30 lists exactly the six commands npm run format:check, npm run lint, npm run typecheck, npm run test, npm run build, npm run db:verify as the pre-release readiness checks. .github/workflows/ci.yml:18-23 runs exactly these six commands in the same order. Included for completeness since the task asked whether CI runs all README-listed checks — it does, modulo db:verify itself currently crashing due to the syntax bug above.
- **Recommendation:** No action needed beyond fixing the underlying db:verify crash; keep README and ci.yml in sync if new checks are added later.

---

## 5. Findings rejected during adversarial verification (6)

For transparency, these raw findings did not survive independent re-verification as stated (typically: factually anchored but severity-inflated, already covered by another finding, or judged out of scope for the current stage):

1. **Prototype pollution in `admin-config.mjs` `deepMerge`** (security) — the code matches the citation, but exploitation requires attacker-controlled config JSON reaching a server-side merge path that does not exist yet; retained as a hardening note for the Phase 2 API layer (use `Object.create(null)` / key filtering when the merge runs server-side).
2. **Audit & Compliance page lacks diff view / hash chain / retention** (admin-gap) — accurate observations, but folded into the broader confirmed findings on the audit backbone rather than standing alone.
3. **`admin-config.test.mjs` only covers trivial helpers** (admin-gap) — true but duplicative of the module-coverage findings.
4. **No keyboard focus indicators** (frontend) — factually verified, but judged low-impact while the page has no interactive elements; addressed by the Phase 3 UI acceptance criteria.
5. **Button color contrast may fail WCAG AA** (frontend) — computed contrast actually passes; refuted.
6. **No skip links** (frontend) — verified but judged premature for a single-section static page; addressed by the Phase 3 UI acceptance criteria.

---

## 6. What happens next

The remediation and build-out sequence for every confirmed finding is laid out in **`ADMIN_CONTROL_CENTER_IMPLEMENTATION_PLAN.md`**:

- **Phase 0** fixes the two syntax errors, reconciles the permission vocabulary, and upgrades the gates so a syntax error can never pass again.
- **Phase 1** hardens RLS (organizations policies, soft-delete filtering, submit transition, FK-injection guard, idempotent policies, org-scope primitive).
- **Phases 2–7** build the admin control center itself — API/BFF spine, append-only audit backbone, admin shell UI, module-toggle matrix, RBAC management, setting registry, branding/export/draft-publish, and the remaining design domains — with every audit finding converted into a permanent mechanical regression check in `verify-migrations.mjs`.
