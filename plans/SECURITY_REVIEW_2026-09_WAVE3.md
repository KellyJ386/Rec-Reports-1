# Wave 3 Security Review — Sign-off

**Date:** 2026-09-08
**Scope:** Wave 3 slices 3A, 3B and 3C (`plans/WAVES_1_4_IMPLEMENTATION_PLAN.md`)
**Verdict:** signed off at `cbc52d2` (3A), `f111a52` (3B) and `9f3959c` (3C).

---

## Scope

One independent adversarial review per slice, each followed by one to three rounds of targeted
re-verification on the fixed head, covering:

- **Slice 3A — reports workflow and distribution** (DR-16 to DR-24, DR-26; migrations 0052–0055;
  PR #25). Mandatory focus: the server-side privilege elevation in the workflow engine.
- **Slice 3B — incidents legal core** (IN-13 to IN-21; migrations 0056–0058; PR #26). Mandatory
  focus: legal hold and the cross-module elevation RPC.
- **Slice 3C — work orders assets, SLA and preventive maintenance** (WO-11 to WO-13, WO-15 to
  WO-21; migrations 0059–0061; PR #27). Mandatory focus: work orders minted from report defects
  without the caller holding `work_orders.manage`.

**Method.** As for Wave 1: every review and re-verification ran against a PostgreSQL 16 database
the reviewer built from scratch (bootstrap, every migration in order, post-bootstrap, seed), with
fixtures in a uuid namespace disjoint from the shipped suites. Findings were reproduced before the
fix and re-proved after it. The regex findings were additionally timed on the Node engine the app
runs on, single-process, against 512-character inputs.

## Findings summary

| Slice | Round | Head | High | Medium | Low | Outcome |
|---|---|---|---|---|---|---|
| 3A | 1 | `e491d3f` | 2 | 4 | 10 | fixes required |
| 3A | 2 | `4cf8678` | 1 open | 1 open | 0 | two new notes (N-3, N-4) |
| 3A | 3 | `9ef81fa` | 1 open | 0 | 0 | scanner desync on the empty class forms |
| 3A | 4 | `0700e4d` → `0090079` | 1 new (H-3), then 0 | 0 | 1 new, then 0 | **safe to merge** at `0090079`; `cbc52d2` adds one informational hardening |
| 3B | 1 | `5733b34` | 2 | 3 | 7 | fixes required |
| 3B | 2 | `19bda30` | 0 | 2 new | 2 informational | fixes required |
| 3B | 3 | `f111a52` | 0 | 0 | 2 informational | **safe to merge** |
| 3C | 1 | `328f50e` | 2 | 4 | 3 | fixes required |
| 3C | 2 | `dfa9570` | 1 new (N-1) | 1 new | 2 new | fixes required |
| 3C | 3 | `9f3959c` | 0 | 0 | 0 | **safe to merge** |

## What changed, per High

### 3A H-1 — the workflow RPC accepted a caller-supplied action list
The submit-time RPC now inserts exactly one `evaluate` event per submission. The cron drain derives
the action list from the pinned template version under the service role and executes it; the mint
RPCs for incidents and work orders are executable only by the service role. Proved by the RLS suite
(`report_workflow_events.sql`) and the executor tests; re-checked in every later round of all three
slices, since Slice 3C's first builder had re-created the old RPC signature and the merge removed it.

### 3A H-2 / H-3 — catastrophic backtracking in template validation rules
The pattern check is now an allow-list grammar: anchored, no backreferences (numbered or named), no
lookaround, no nested or repeated groups, alternation only inside a group, a per-pattern backtracking
budget that charges every quantifier its split count and its per-path scan length, and a separate
cap on alternation and optional-group paths; the value tested is capped at 512 characters. The
final sweep timed 7,349 accepted patterns with none above 135 ms. Proved by `test/report-schema.test.mjs`.

### 3B H1 / H2 — a legally held incident could be deleted, and two child tables were unprotected
A held or non-draft incident cannot be hard-deleted by an authenticated actor; while held, its
people, attachments, statements, follow-up actions and escalations can be neither deleted,
soft-deleted nor re-pointed to another incident, and the child guard fails closed when the parent
row is missing. Proved by `supabase/tests/incident_legal_hold.sql` sections 7 to 10.

### 3C H-1 / N-1 — a work order pre-inserted in another facility could suppress the real one
The work_orders manage policy asserts same-facility on `source_submission_id` and carries every
guard of its latest prior definition (seven, including 0058's `source_followup_id`); the mint RPC
lookup and unique index are facility-scoped. A structural test asserts the full guarded-column list
against `pg_policies` so a redefinition cannot drop a guard silently again. Proved by
`supabase/tests/work_order_sla.sql` section 5.

### 3C H-2 — unbounded occurrence preview
The preview window is capped at 400 days, validated as a real calendar date, and the cadence
generators stop at 1000 entries. Proved by `test/pm-plans-routes.test.mjs` and
`test/preventive-maintenance.test.mjs`.

## Accepted risks and follow-ups

- **3A.** Re-pointing `report_templates.active_version` to an already published version needs only
  `reports.template.manage` (a rollback gap, not a bypass). The definer transition guard lets a
  `reports.publish` holder without `reports.read` revise a submission in a department it cannot
  read (a relaxation inside the same facility). The alternation budget's worst measured case is
  135 ms per validation.
- **3B.** A sub-request race between the status commit and the notification insert could in theory
  still be used to pre-seed a `submitted` job; closing it fully would need a server-minted value in
  the key. The pre-existing `communications.publish` policy on notification jobs is broader than the
  new incident-scoped one. Two guard messages could be worded more precisely. Effective module
  config for the OSHA tree and retention is admin-readable only, so routes fall back to defaults.
- **3C.** 0058's follow-up lookup and index are not facility-scoped; with the policy guard restored
  no authenticated write can create a squatting row, so this is recommended hardening in a later
  migration rather than a blocker. The overdue scan dedupes via the job payload and should switch to
  0058's `dedupe_key` column.
- **Harness.** `test/seed-integrity.test.mjs` races the migration fixture when `DATABASE_URL` is
  exported during `npm test`; run the DB proof and the unit tests in separate shells.

## Post-deploy verification

- [ ] Migrations `0052` through `0061` applied to the live project in order, after `0040`–`0051`,
      with `npm run db:verify` green against the deployed tree.
- [ ] RLS suites green against the live project (41 files).
- [ ] `get_advisors(security)` reports no definer-exposure or mutable-search_path findings.
- [ ] Service-role-only RPCs are not executable by an authenticated caller:
      `mint_workflow_incident`, `mint_workflow_work_order`, `set_work_order_sla_fields`.
- [ ] Authenticated RPCs are served: `enqueue_report_workflow`, `apply_incident_amendment`,
      `create_work_order_from_incident`.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set for the API deployment (the work order routes answer 503
      before any write without it).
- [ ] The cron drain reports the `workOrderSla` and `pmGeneration` passes.

## Sign-off

Every finding from the three reviews is closed or accepted with a stated rationale above. Each
closure was re-proved by the reviewer against an independently built database and is bound to a
named test in the tree.

Wave 3 slices 3A, 3B and 3C and migrations 0052–0061 are **signed off at `cbc52d2`, `f111a52` and
`9f3959c`**, subject to the post-deploy verification checklist above.
