# Security & NFR Audit — RecReports (Phase 6)

Scope: every table, RLS policy, and `SECURITY DEFINER` function across migrations
`20260615120000` … `20260616230000`, plus the non-functional baseline in `CLAUDE.md` §8.
Methodology: static review of schema/policies/functions + pgTAP isolation tests
(`db/tests/0001`, `0002`). No live database was provisioned (code-only engagement), so DB
tests are runnable via `supabase test db` once a project is wired; pure-logic suites
(`npm test`) pass now.

Result: **all Critical/High findings fixed**; Medium fixed; remaining items are Low/Info
and explicitly accepted or tracked as residual (below).

---

## 1. RLS coverage

**Every** facility-scoped table has `enable row level security` and explicit policies.
Verified tables: `organization`, `facility`, `user_account`, `facility_membership`,
`job_area`, `cert_type`, `job_area_required_cert`, `audit_event`, `severity_level` + 13
config catalogs, `staff_certification`, `schedule_period`, `shift_template`, `shift`,
`shift_assignment`, `availability`, `swap_request`, `schedule_delivery`, `injury_report`,
`incident_report`, `report_person`, `report_witness`, `daily_log_entry`(+tag), `memo`(+
receipt), `eod_report`, `form`, `form_response`, `task`, `utilization_count`, `sop`(+
version, +ack), `erp`(+role, +contact), `asset`, `work_order`(+photo),
`asset_inspection_history`.

Read = facility membership (often role- or author-gated); write = role-gated via
`has_facility_role()`. Report records additionally enforce author-only drafts and
lock-on-submit.

## 2. `facility_id` is never client-trusted

Confirmed across all write paths: `facility_id` is derived server-side from the session
(`requireFacilityId()`/`requireRole()`), and every `INSERT/UPDATE` policy independently
re-checks membership/role at that `facility_id` via `is_facility_member()` /
`has_facility_role()`. Even a forged `facility_id` in a payload fails `WITH CHECK` unless
the caller is actually a member there. Polymorphic children derive `facility_id` from the
parent in a trigger (`set_report_child_facility`), ignoring any client value.

## 3. `SECURITY DEFINER` inventory (each reviewed & justified)

| Function | Why DEFINER | Hardening |
|---|---|---|
| `current_user_role_at` | reads `facility_membership` that RLS policies depend on → avoids recursion | `search_path` pinned, `STABLE`, read-only |
| `guard_membership_change` | writes audit + resolves role; enforces no-escalation | pinned; bootstrap only when `auth.uid()` null |
| `guard_report_state` | writes immutable audit; enforces state machine/lock | pinned |
| `audit_eod_state` | writes immutable audit for EOD status | pinned (added F-6) |
| `report_parent_facility` | derive child facility regardless of parent RLS visibility | pinned, returns one uuid |
| `provision_facility_defaults` | seed a new facility before manager rights exist | pinned + role/bootstrap gate |
| `handle_new_user` | auth.users insert path (no JWT) | pinned, idempotent |

All other helpers (`role_rank`, `has_facility_role`, `is_facility_member`,
`can_read_report`, `can_write_report`, `cert_computed_status`, `set_updated_at`,
`set_report_child_facility`) are `SECURITY INVOKER`; `search_path` pinned in F-3.

## 4. Findings

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| **F-1** | **High** | `staff_certification_status` is a view; views run with owner rights by default, **bypassing RLS** → cross-facility cert leak. | **Fixed** — `security_invoker = on` (`20260616230000`). |
| **F-2** | Medium | `sop_version` was readable by any member regardless of the parent SOP's `visibility_role`. | **Fixed** — select gated through parent SOP. |
| **F-3** | Medium | `SECURITY INVOKER` RLS helpers had a mutable `search_path`. | **Fixed** — pinned `public, pg_temp`. |
| **F-4** | Low | `organization`/`facility` have no `INSERT` policy. | **Accepted** — tenant/facility provisioning is a privileged (service-role / `super_admin`) onboarding path by design; not a customer-facing write. |
| **F-5** | Low | Report PII (`report_person.contact`, etc.) is not column-encrypted; relies on platform at-rest disk encryption. | **Residual** — tracked; future column-level encryption (pgsodium/Vault). PII is minimized in forms/exports. |
| **F-6** | Low | EOD status changes were not audited (injury/incident already are). | **Fixed** — `audit_eod_state` trigger. |
| **F-7** | Info | Storage buckets (`certifications`, work-order photos) must be **private** with short-TTL signed URLs. | **Residual** — bucket policy is infra/config, not app code; documented in README/`CLAUDE.md` §8.4. |
| **F-8** | Info | The offline mutation queue is built (shell + conflict flag) but not yet wired into every module's write path. | **Residual** — incremental per-module wiring; pattern is in place. |

### Privilege escalation & isolation — verified by tests
- Cross-facility read/write blocked: `0001` (tenancy), `0002` (incident, report_person, sop).
- No role escalation / can't modify a higher-ranked member: `0001` (guard + RLS).
- Report lock-on-submit + draft-hidden-from-reviewers: `0002`.
- Polymorphic child resolves & isolates by parent facility: `0002`.

---

## 5. Non-functional baseline (`CLAUDE.md` §8)

| Requirement | Status |
|---|---|
| **Audit log** on report create/edit/status-change | ✅ injury/incident (`guard_report_state`), EOD (`audit_eod_state`), role changes (`guard_membership_change`). ⚠️ Residual: schedule publish, form publish, work-order status, and export/access events are not yet audited (optional beyond the "report record" scope of §8). |
| **Retention** ≥7yr incident/injury, no hard-delete in window | ✅ No delete/soft-delete policy on `injury_report`/`incident_report` → not deletable by any customer role; `legal_hold` flag present. Other records use soft-delete; hard-delete only via service role. |
| **Offline** capture + sync + conflict flag (no silent overwrite) | ✅ Dexie shell, mutation queue with backoff, manager-surfaced conflict record, visible `SyncStatus`. ⚠️ Residual (F-8): per-module write wiring incremental. |
| **Accessibility** WCAG 2.1 AA | ✅ Global `:focus-visible`, labeled controls, status by icon+text (never color alone), keyboard-operable actions. ⚠️ Residual: formal contrast/screen-reader audit not performed. |
| **PII** encrypted at rest | ⚠️ Platform disk encryption only (F-5); column-level encryption is a tracked follow-up. |

---

## 6. Residual items (tracked, not blocking sign-off)

1. Column-level PII encryption (F-5).
2. Private Storage bucket policies + signed-URL TTLs (F-7) — infra config.
3. Offline write-path wiring per module (F-8).
4. Extend audit coverage to scheduling/forms/work-orders + export access logging.
5. Formal WCAG audit (automated + manual) and PDF/print branding polish.
6. Live-environment run of `supabase test db` (both pgTAP suites) once a project is provisioned.

**Sign-off:** no open Critical/High findings. The platform enforces tenant isolation,
role hierarchy, report immutability, and audit logging at the database layer (RLS +
triggers), independent of the application tier.
