# Daily Reports Module — Development Plan

## 1. Current state

Verified by reading the code, not the docs:

- **Schema exists and is RLS-enabled**: `supabase/migrations/0002_daily_reports.sql` creates `departments`, `report_templates`, `report_template_versions`, `report_submissions`, `report_submission_attachments`, plus the shared `audit_events` and `outbox_events` tables, with the design's `(facility_id, report_date desc)` and `(facility_id, template_id, status)` partial indexes.
- **RLS is read-heavy and write-light**: 0002 + `0009_rls_hardening.sql` + `0021_report_export_read.sql` give SELECT on templates/versions/submissions/attachments (`reports.read`, plus `reports.export` for submissions), INSERT on submissions (`reports.create`, with `fn_assert_same_facility` FK guards), and UPDATE only while `status = 'draft'` with a `WITH CHECK` that permits `draft → submitted`. There is **no INSERT/UPDATE policy anywhere for `report_templates`, `report_template_versions`, or `report_submission_attachments`.**
- **Domain lib is pure and tested**: `src/lib/report-schema.mjs` exports `supportedFieldTypes` (10 types), `validateReportTemplateSchema`, `validateReportSubmission`; covered by `test/report-schema.test.mjs` and reused as the single source of truth by the admin form builder.
- **End-user API is 6 routes**: `src/lib/http/reports-routes.mjs` — list/get templates, list submissions, get submission, create draft, PATCH draft, POST submit (full validation, 422 on errors, stamps `submitted_by`/`submitted_at`). Registered on the `/api/v1` `userRouter` in `scripts/server.mjs:242`.
- **Route tests exist and are behavioral**: `test/reports-routes.test.mjs` (15 tests) stubs `globalThis.fetch` and asserts on the emitted PostgREST query strings and insert/patch bodies, including 403/404/409/422 paths.
- **RLS SQL tests cover reports**: `supabase/tests/tenant_isolation.sql` proves cross-facility template invisibility, soft-delete exclusion, `reports.create` gating, the legal `draft → submitted` transition, and the 0021 `reports.export` read regression.
- **End-user UI is read-only**: `src/public/js/app.js:146-195` (`loadReports`) renders name/description and `status - report_date` strings. No fill form, no draft editing, no submit button, no detail view.
- **The admin form builder targets a different table**: `src/public/admin/js/pages/forms.js` + `src/lib/http/forms-routes.mjs` + `src/lib/admin/forms.mjs` build drag-and-drop schemas into `form_definitions` (0015), gated on `reports.template.manage` **and** the `custom_forms` entitlement (402). Nothing writes `report_templates`/`report_template_versions` — those exist only via `supabase/seed.sql:95-110`.
- **Supporting infra is partially present**: `src/lib/admin/pdf.mjs` (zero-dep PDF renderer) and `src/lib/admin/export.mjs` power the *generic table* export; `src/lib/settings-registry.mjs:124-157` defines three `daily_reports` keys; `supabase/seed.sql:244` seeds a `report.missing` notification event and `:273` a `reports.pdf_export` feature flag.
- **Known dead ends in the current code**: `outbox_events` is written by nothing; `report_submission_attachments` is written by nothing; `pdf_status` never leaves `not_requested`; `validation_json`/`workflow_json` are stored and read by nothing; `authCanAccessFacility` is imported but unused in `reports-routes.mjs:2`; the POST-create comment claims partial payload validation that the handler never performs.

## 2. Gap analysis (design doc vs implemented)

| Design capability (§) | Design target | Implemented today | Gap |
|---|---|---|---|
| Form Definition Service (1.1, 2.1) | Versioned templates, publish/unpublish lifecycle | Tables exist; seed-only data; no API, **no write RLS** | **Full** — templates are unmanageable without service-role |
| Reusable field catalog (2.1) | Facility field presets | `custom_fields` (0015) covers it, but bound to `form_definitions` | **Bridge missing** |
| Form builder UI (3.1, 8.3) | DnD sections/fields, live preview, version compare | DnD builder exists writing `form_definitions`; no preview tabs, no version compare | **Partial + wrong target table** |
| Versioning (3.2) | Draft edits mint versions; published immutable; submissions pin version | Implemented for `form_definitions`; submissions pin `template_version_id` correctly | **Partial** — no equivalent for `report_template_versions` |
| Field types (2.1) | 13 types incl. `datetime`, `counter`, `rating` | 10 types | **Partial** — 3 types missing |
| Field attributes (3.1) | `visibility_rules`, `validation_rules`, `photo_constraints`, `signature_requirements`, `default_value`, `help_text` | `required`, `options` only | **Full** for rules/constraints |
| Validation policy (3.4) | `strict_block` vs `warn_and_submit` + reason | Always hard-blocks (422); `validation_json` unread | **Full** |
| Submission runtime (1.1) | Render from schema, draft/submit, attachments | Draft/submit API done; **no schema-driven renderer**, no attachments | **Partial** |
| Submission lifecycle (2.2) | `draft/submitted/locked/revised` | Only `draft → submitted`; `locked`/`revised` unreachable | **Partial** |
| Attachments (2.2) | Storage path, mime, checksum, metadata | Table only; no upload route, no Storage client, no INSERT policy | **Full** |
| Signatures (2.2) | Dedicated table + signer identity | Table does not exist; `signature` is a bare string field | **Full** |
| PDF workflow (4) | Snapshot render, branding, Storage path, `pdf_status`, tamper hash | Generic tabular PDF only; no per-submission render, `pdf_status` inert | **Mostly full** — renderer reusable |
| Distribution (2.3, 5) | Report distribution lists/deliveries, recipient resolution, retry, digest | Generic `distribution_lists`/`notification_routes` (0016) + `notification_jobs` exist; **no report binding, no sender, no worker** | **Full** for reports |
| Workflow engine (1.1, 2.3, 6) | `report_workflow_events`, incident escalation, task/work-order creation | Table absent; `workflow_json` unread; `outbox_events` unwritten | **Full** |
| Audit trail (7) | Template lifecycle, field diffs, submission lifecycle, PDF access | `audit_events` + hash chain exist; **reports routes write zero audit rows** | **Full** for reports |
| Manager review UI (8.2) | Inbox with filters, quick actions, side-by-side pane | Flat read-only list | **Full** |
| Mobile entry UI (8.1) | Stepper, sticky actions, camera, signature pad, autosave | None | **Full** |
| Offline (9) | IndexedDB caches, media queue, `client_mutation_id`, conflicts | None; no idempotency column | **Full** |
| Governance (10.2) | `reports.publish`, `reports.workflow.manage`, `reports.distribution.manage`, two-step publish | Only `reports.template.manage` in the catalog | **Partial** |
| Department scoping (1.2) | Department-scoped visibility/approvals | Reports policies use the 3-arg `has_permission` → department-scoped members are denied entirely (0023) | **Full** |
| Indexes (2.4) | GIN on `schema_json`/`payload_json`/`workflow_json` | B-tree partials only | **Partial** |

## 3. Phased task list

### Phase M1 — MVP-complete (a facility can configure, fill, submit, review, and export a daily report without service-role access)

| ID | Description | Key files | Acceptance highlights | Size |
|---|---|---|---|---|
| DR-01 | **Extend the PostgREST client** with range filters (`gte`/`lte`/`in`), `offset`, `count` Prefer header, keeping existing plain-value `eq.` shape working | `src/lib/supabase-rest.mjs`, `test/supabase-rest.test.mjs` | Existing callers unchanged; unknown operators throw before the fetch | S |
| DR-02 | **Write-side RLS for report templates/versions** (new migration): INSERT/UPDATE gated on `reports.template.manage`; trigger making a version immutable once `is_published`; `fn_assert_same_facility` guards; archive via `status`, not DELETE | new migration, `supabase/tests/report_templates.sql` | Cross-facility insert 42501; updating a published version raises; `active_version` only points at a published version of the same template | M |
| DR-03 | **Template lifecycle domain lib** (pure, `admin/forms.mjs` style): `nextTemplateVersionNumber`, `buildTemplateDraftUpdate`, `buildTemplatePublish`, `validateTemplateInput` | new `src/lib/report-templates.mjs` + tests | `{valid, errors}` shapes; no I/O; version numbering from 1 | S |
| DR-04 | **Report template management API** (admin router): template CRUD, version CRUD, publish, archive; guard `reports.template.manage` + new `reports.publish` for publish | new `src/lib/http/report-templates-routes.mjs`, `scripts/server.mjs`, tests | 400 before guard/fetch; 409 on publishing a non-draft; publish flips `is_published` + `active_version` safely | L |
| DR-05 | **Governance permission codes**: `reports.publish`, `reports.workflow.manage`, `reports.distribution.manage` in catalog + seeds | `src/lib/permissions.mjs`, `supabase/seed.sql`, migration | Catalog/seed parity; `reports.template.manage` alone cannot publish | S |
| DR-06 | **Bridge the form builder to report templates**: keep `form_definitions` as authoring surface; add `POST /forms/:id/promote` materializing a published `daily_reports` form into `report_templates`/`report_template_versions`; builder gains "Publish to Daily Reports" | routes, `src/public/admin/js/pages/forms.js`, `src/lib/admin/forms.mjs` | Re-promoting mints version n+1; promoting a draft 409; promoted schema byte-identical to `schema_jsonb` | M |
| DR-07 | **Draft/submit hardening**: real partial validation on create/PATCH; reject payload keys absent from pinned schema; verify version/template match on submit; honour `validation_json.submit_policy` (`warn_and_submit` requires reason); drop dead import | `src/lib/http/reports-routes.mjs`, `src/lib/report-schema.mjs`, tests | Unknown keys → 422; `warn_and_submit` without reason → 422, with → 200 + warnings persisted; mismatched version → 409 | M |
| DR-08 | **Submission list filters/pagination + detail-with-schema**: `?from/to/department_id/submitted_by/limit/offset` (cap 200), validated `status`; detail returns submission + pinned `schema_json` + attachments | `src/lib/http/reports-routes.mjs`, tests | Unbounded list impossible; invalid status → 400, not empty list | M |
| DR-09 | **Attachment upload with Supabase Storage brokering**: `SUPABASE_STORAGE_BUCKET` env; zero-dep Storage helper minting signed upload/download URLs; `POST /reports/:id/attachments`; migration adds the INSERT policy (draft-only, same-facility) | new `src/lib/storage.mjs`, `src/lib/env.mjs`, routes, migration, RLS SQL tests | Only draft submissions accept attachments; paths server-derived; signed read URLs expire | L |
| DR-10 | **Submission lifecycle audit events** (`report.draft_created`/`draft_updated`/`submitted`/`attachment_added`), preferably via DB trigger so the 0013 hash chain links them | routes, migration, `supabase/tests/report_audit.sql` | Submit appends exactly one chained audit row; `verifyDbChain` stays valid | M |
| DR-11 | **Department-scoped reports RLS + JS guard parity**: switch submission INSERT/UPDATE and template SELECT policies to the 4-arg `has_permission` overload (0023); routes use `hasDepartmentPermission` | migration, routes, `supabase/tests/department_scope.sql` | Department-A-scoped member can file for A, denied for B; facility-wide unchanged | M |
| DR-12 | **Compliance dashboard endpoint** `GET /facilities/:id/reports/compliance?from=&to=`: per published template per date `{expected, submitted, missing, overdue}` using `reports.dailyReportDueHour` | new `src/lib/reports-compliance.mjs` (pure), routes, tests | Due-hour boundary correct; timezone handling explicit | M |
| DR-13 | **End-user report entry UI (schema-driven renderer)**: template picker → stepper form rendered from `schema_json` (all 10 types), Save draft / Submit bar, per-field 422 errors, timed autosave, photo/signature via DR-09. Renderer extracted to `src/public/js/report-form.mjs` for node:test coverage | `src/public/js/`, `src/public/index.html`, styles | Seeded `opening_checklist` completable from browser; draft survives reload; CSP-safe (no inline handlers) | L |
| DR-14 | **Manager review inbox UI**: filter bar driving DR-08 params, detail pane with labeled answers + attachments + validation results, Export PDF wired to DR-15 | `src/public/js/` + new `report-inbox.mjs` | Detail renders from pinned version's schema, not current | M |
| DR-15 | **Single-submission PDF export** `GET /reports/:id/pdf` gated on `reports.export` + `reports.pdf_export` flag; sectioned Q/A from pinned schema via the zero-dep renderer; standard export envelope | new `src/lib/admin/report-pdf.mjs`, routes, tests | Renders with labels from its own version even after re-publish; draft → 409 | M |

### Phase M2 — Design-complete

| ID | Description | Size |
|---|---|---|
| DR-16 | **Field-type and validation-rule expansion**: `datetime`/`counter`/`rating`; `validation_rules` (min/max/regex — anchored + length-capped against ReDoS), `default_value`, `help_text`, `photo_constraints`, `signature_requirements`, server-evaluated `visibility_rules` (hidden required fields not enforced). Builder type list and runtime validator stay derived from `supportedFieldTypes` | L |
| DR-17 | **Signatures**: `report_submission_signatures` table + `POST /reports/:id/signatures`; submit-time completeness check; signer is the authenticated user; immutable after draft | M |
| DR-18 | **Workflow rule engine (pure)**: `evaluateWorkflow(...)` → ordered action list (`create_incident`/`create_work_order`/`notify`/`queue_pdf`) implementing §6 triggers; reuses `incidents.mjs` and `work-orders.mjs` helpers; supports the seeded `{"on_submit":[...]}` shape; unknown actions ignored with recorded warning | M |
| DR-19 | **Workflow event ledger + outbox integration**: `report_workflow_events` table (RLS: read `reports.read`, write service/route only); on submit persist actions as pending events + enqueue `outbox_events`; submit never blocked by workflow failures (events land `failed`) | M |
| DR-20 | **Workflow execution**: process pending events into `incident_reports`/`work_orders` rows linked to `submission_id`; explicitly-scoped server action with provenance in the audit trail (submitter without `incidents.manage` must not mint incidents directly); idempotent by `submission_id + event_type` | L |
| DR-21 | **Report distribution lists and deliveries**: template-bound `report_distribution_lists`/`_deliveries` composing `expandDistributionList`/`resolveRoute` with template/department/role filters; writes gated on `reports.distribution.manage`; recipients dedupe; no cross-facility resolution | L |
| DR-22 | **Email delivery worker + provider adapter**: provider-agnostic `sendEmail` over `fetch`; queue drainer for `outbox_events`/`notification_jobs` writing deliveries with `provider_message_id`, exponential backoff, digest mode, PDF attach-vs-link policy, quiet hours | L |
| DR-23 | **PDF snapshot pipeline**: on submit queue a PDF job; worker renders the immutable snapshot, uploads to Storage, stores path + content hash, transitions `pdf_status` `queued → generated|failed` with bounded retries; deterministic output (timestamps from `submitted_at`) | L |
| DR-24 | **Lock / revise lifecycle**: `POST /reports/:id/lock` and `/revise` (mints a `revised` successor linked by `revision_of`, original immutable); RLS `WITH CHECK` extended for exactly `submitted → locked` and `submitted|locked → revised` | M |
| DR-25 | **Offline-first submission runtime**: IndexedDB stores (template cache, drafts, media queue, mutation queue); `client_mutation_id` column + unique partial index for replay idempotency; sync order media→remap→submit; retired-version conflicts queued for manager review | L |
| DR-26 | **Template governance**: optional two-step publish via `admin_change_requests` (author cannot self-approve); required `change_summary`; sandbox flag suppressing distribution/workflow side effects | M |
| DR-27 | **Reports settings registry keys**: submit policy default, attachment caps, PDF-on-submit toggle, distribution mode/digest hour, retention days — all read via `configValue` so `{}` reproduces today's behavior | S |
| DR-28 | **PDF/report access audit**: `report.pdf_downloaded`/`report.viewed` events for sensitive templates | S |

### Phase M3 — Polish and automation

| ID | Description | Size |
|---|---|---|
| DR-29 | **Scheduled reminders and digests**: cron-driven `report.missing` notifications using DR-12's compliance computation + `reports.dailyReportDueHour`; digest batching from DR-22; no-duplicate-per-day | M |
| DR-30 | **Notification dedupe + severity routing**: correlation key `submission_id + event_type + recipient` with configurable cooldown; low→in-app, medium→+email, high/critical→+push | M |
| DR-31 | **Retention, purge, legal hold**: retention by report type/severity; `legal_hold` blocks purge; audit trail survives purge | M |
| DR-32 | **Admin builder polish**: version compare (schema diff), live mobile/desktop preview tabs, pre-publish validation checklist | M |
| DR-33 | **Performance and index pass**: GIN on `schema_json`/`payload_json`/`workflow_json`; list-query review; export streaming above the 10k limit | S |
| DR-34 | **Security review and threat model**: signed-URL TTL/path traversal, PDF link sharing, IDOR on `/reports/:id` and `/attachments/:id`, CSP compliance, payload size vs 1 MB `maxBodyBytes`, workflow-triggered privilege escalation | M |

## 4. Dependencies

**Other modules**
- **Incidents** — DR-20 mints `incident_reports` from workflow rules; must satisfy 0004's RLS and reuse `shouldEscalateIncident`/`escalationDueAt` rather than re-deriving severity logic.
- **Work orders** — DR-20's "maintenance defect → task" path reuses `createWorkOrderFromIncident`/`slaHoursForPriority`; coordinate with WO-21 (same feature seen from the work-orders side).
- **Communications/notifications (0006, 0016)** — DR-21/DR-22 must compose the existing pure helpers rather than fork a parallel stack. The design's `report_distribution_*` tables partially duplicate 0016 — DR-21 should justify the split explicitly.
- **Forms & Fields (0015)** — DR-06 is the load-bearing integration; it also inherits the `custom_forms` **entitlement gate (402)**, meaning template authoring is Enterprise-only unless the promote path is deliberately exempted.
- **Admin RBAC (0012, 0022, 0023)** — new permission codes (DR-05) flow through `role_permissions` and seeded roles; the 4-arg `has_permission` overload is a prerequisite for DR-11.

**Platform infrastructure (does not exist yet)**
- **Storage**: no Supabase Storage client anywhere in `src/`. DR-09 must add `SUPABASE_STORAGE_BUCKET` to `src/lib/env.mjs` and build the helper with `fetch` only. DR-23 and DR-25 both block on it. Coordinate with the platform storage task (build once).
- **Notification/email worker**: nothing writes `outbox_events` or drains `notification_jobs`. DR-22/DR-29 need the platform runner story (Vercel cron vs script loop) decided before DR-19 lands, since the ledger design depends on the drain model.

**Build, CI, and verification harness**
- Every new table must be added to `scripts/verify-migrations.mjs` `requiredRlsTables`; new RLS tests are picked up automatically but new tables must be grantable by `rls-bootstrap-post.sql`; migration numbers 0024+ are ordering, not literals — the orchestrator assigns actual numbers across modules.

## 5. Suggested agent/model assignment

| Task | Assignee | Rationale |
|---|---|---|
| DR-01 client filters | Sonnet | A wrong operator encoding is a silent data-exposure bug |
| DR-02 template write RLS | **Sonnet** | New policy shapes + immutability trigger; RLS is never mechanical |
| DR-03 template lifecycle lib | Haiku | Direct pattern-copy of `src/lib/admin/forms.mjs` |
| DR-04 template management API | Sonnet | Auth guards, 402/403/409 ordering, publish atomicity |
| DR-05 permission codes | Haiku | Mechanical catalog + seed edit with a parity test |
| DR-06 builder→template bridge | **Opus/orchestrator** | Cross-module design decision (two competing template stores) |
| DR-07 draft/submit hardening | Sonnet | Validation semantics + security-relevant unknown-key rule |
| DR-08 list filters/pagination | Haiku | Pattern-copy once DR-01 exists |
| DR-09 attachment upload + Storage | **Opus designs, Sonnet implements** | New infra + signed URLs + path derivation = the module's largest security surface |
| DR-10 lifecycle audit | Sonnet | Hash-chain interaction; trigger-vs-route choice |
| DR-11 department-scoped RLS | **Sonnet** | A mistake silently widens access |
| DR-12 compliance endpoint | Haiku | Pure function in the established style |
| DR-13 entry UI | Sonnet | CSP-constrained DOM rendering, XSS discipline, autosave races |
| DR-14 review inbox UI | Haiku | Pattern-copy once DR-13's renderer exists |
| DR-15 single-submission PDF | Haiku | Reuses `pdf.mjs` + the established export envelope |
| DR-16 field types/rules | Sonnet | Regex/ReDoS and visibility-vs-required interactions |
| DR-17 signatures | Sonnet | Identity binding and immutability |
| DR-18 workflow engine (pure) | Haiku | Deterministic transform, table-driven tests |
| DR-19 workflow ledger | Sonnet | New RLS tables + failure isolation from the submit path |
| DR-20 workflow execution | **Opus/orchestrator** | Privilege escalation risk across module boundaries |
| DR-21 distribution | Sonnet | Recipient resolution is a data-leak surface |
| DR-22 email worker | **Opus designs, Sonnet implements** | Secret handling, retry semantics, runner model choice |
| DR-23 PDF pipeline | Sonnet | Determinism + Storage paths |
| DR-24 lock/revise | Sonnet | Transition RLS; illegal-transition coverage |
| DR-25 offline runtime | **Opus/orchestrator** | Idempotency + conflict semantics spanning client and DB |
| DR-26 governance | Sonnet | Self-approval prevention is an authz rule |
| DR-27 settings keys | Haiku | Registry entries with a checked layout invariant |
| DR-28 access audit | Haiku | Mechanical once DR-10 lands |
| DR-29 reminders/digests | Sonnet | Scheduling windows and duplicate suppression |
| DR-30 dedupe/severity routing | Haiku | Pure helpers extending `admin/notifications.mjs` |
| DR-31 retention/legal hold | Sonnet | Destructive operation with compliance implications |
| DR-32 builder polish | Haiku | UI + a pure diff function |
| DR-33 index/perf pass | Haiku | Mechanical migration + verifier assertions |
| DR-34 security review | **Opus/orchestrator** | Whole-module threat model |

Sequencing: DR-01 → DR-02/DR-03 → DR-04 → DR-06 unblocks everything in M1; DR-09 blocks DR-13's media capture, DR-23, and DR-25; DR-18 → DR-19 → DR-20 → DR-21 → DR-22 is a strict chain. Run the RLS suite on every task touching `supabase/migrations/`; security-review DR-02, DR-09, DR-11, DR-20, and DR-25 before merge.

### Critical files
- `src/lib/http/reports-routes.mjs`, `src/lib/report-schema.mjs`, `supabase/migrations/0002_daily_reports.sql`, `src/lib/admin/forms.mjs`, `src/public/js/app.js`
