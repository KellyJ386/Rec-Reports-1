// TR-09 (plans/TRAINING_PLAN.md): the certification-rule / role-rule
// auto-assignment evaluator. Runs from the CRON_SECRET-guarded drain
// (src/lib/http/internal-routes.mjs, response key `trainingAutoAssign`) and
// standalone as scripts/training-auto-assign.mjs, always against a
// service-role client -- RLS is bypassed, so facility scoping is enforced in
// three layers: every query below is filtered by the RULE's facility_id, the
// pure selectRuleTargets drops any employee outside it, and 0066's
// fn_training_assignment_rule_guard rejects a cross-facility row at the
// database for every role.
//
// What one pass does, per active training_assignment_rules row (oldest
// last_evaluated_at first, so a `limit` smaller than the rule count cannot
// starve the tail):
//   1. Skip (counted, not an error) when the facility switched
//      training.autoAssignEnabled off, or the rule's course is gone / not
//      published.
//   2. Resolve the candidate employees:
//        role rule           -> active employees whose user holds an ACTIVE
//                               membership of the rule's role in the facility;
//        certification rule  -> the same, for the rule's role when it has one,
//                               otherwise for every role with an active
//                               certification_role_requirements row for the
//                               certification type.
//      For a certification rule the candidate must additionally have a GAP
//      for the type (missing / expired / expiring -- certGaps, the same
//      function the cert-gaps report and the scheduling gate use) whose
//      status the rule lists in gap_statuses.
//   3. Insert one training_assignments row per target with source_type
//      'role_rule' / 'certification_rule' and source_ref_id = the rule id.
//      The existing (employee_id, course_id, source_type, source_ref_id)
//      unique constraint is the idempotency key: the insert uses
//      ON CONFLICT DO NOTHING (Prefer: resolution=ignore-duplicates), and a
//      pre-read of the rule's existing assignments keeps a re-run from even
//      attempting a duplicate. Re-running produces zero new rows; an employee
//      gets one assignment per rule, ever (a later renewal cycle is a new
//      rule, not a re-assignment -- documented limitation).
//   4. Stamp last_evaluated_at.
// A failure inside one rule is recorded in summary.errors and never aborts
// the remaining rules.
import { pgSelect, pgInsert, pgUpdate } from "./supabase-rest.mjs";
import { configValue } from "./settings-registry.mjs";
import { makeConfigLoader } from "./http/module-config.mjs";
import { selectRuleTargets, dueAtForRule } from "./training-rules.mjs";

const TRAINING_MODULE_CODE = "training";
const DEFAULT_RULE_LIMIT = 25;
const INSERT_CHUNK = 200;

const RULE_COLUMNS =
  "id,facility_id,rule_type,certification_type_id,role_id,course_id,gap_statuses,due_days,active,last_evaluated_at";
const CONFLICT_TARGET = "employee_id,course_id,source_type,source_ref_id";

function chunk(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}

// Active employees (with a login) whose active membership in `facilityId`
// carries one of `roleIds`.
async function employeesWithRoles(client, facilityId, roleIds) {
  if (roleIds.length === 0) return [];
  const memberships = await pgSelect(client, "memberships", {
    filters: { facility_id: facilityId, status: "active", role_id: { in: roleIds } },
    select: "user_id,role_id"
  });
  const userIds = [...new Set((memberships ?? []).map((membership) => membership.user_id))];
  if (userIds.length === 0) return [];
  const employees = await pgSelect(client, "employees", {
    filters: { facility_id: facilityId, status: "active", user_id: { in: userIds } },
    select: "id,facility_id,user_id",
    extra: { deleted_at: "is.null" }
  });
  return employees ?? [];
}

async function certificationRoleIds(client, rule) {
  if (rule.role_id) return [rule.role_id];
  const requirements = await pgSelect(client, "certification_role_requirements", {
    filters: { facility_id: rule.facility_id, certification_type_id: rule.certification_type_id, active: true },
    select: "role_id"
  });
  return [...new Set((requirements ?? []).map((requirement) => requirement.role_id))];
}

async function certsByEmployee(client, rule, employeeIds) {
  if (employeeIds.length === 0) return {};
  const [certs, types] = await Promise.all([
    pgSelect(client, "employee_certifications", {
      filters: {
        facility_id: rule.facility_id,
        certification_type_id: rule.certification_type_id,
        employee_id: { in: employeeIds }
      },
      select: "id,employee_id,certification_type_id,expires_at,status",
      extra: { deleted_at: "is.null" }
    }),
    pgSelect(client, "certification_types", {
      filters: { id: rule.certification_type_id, facility_id: rule.facility_id },
      select: "id,renewal_window_days",
      limit: 1
    })
  ]);
  const renewalWindowDays = (types ?? [])[0]?.renewal_window_days;
  const byEmployee = {};
  for (const cert of certs ?? []) {
    (byEmployee[cert.employee_id] ??= []).push({ ...cert, renewal_window_days: renewalWindowDays });
  }
  return byEmployee;
}

async function evaluateRule(client, rule, { now, config, summary }) {
  if (configValue(config, "training.autoAssignEnabled") === false) {
    summary.skippedDisabled += 1;
    return;
  }

  const courseRows = await pgSelect(client, "courses", {
    filters: { id: rule.course_id, facility_id: rule.facility_id, status: "published" },
    select: "id",
    extra: { deleted_at: "is.null" },
    limit: 1
  });
  if ((courseRows ?? []).length === 0) {
    summary.skippedCourse += 1;
    return;
  }

  const roleIds = rule.rule_type === "role" ? [rule.role_id] : await certificationRoleIds(client, rule);
  const candidates = await employeesWithRoles(client, rule.facility_id, roleIds);
  summary.candidates += candidates.length;

  const certs =
    rule.rule_type === "certification" ? await certsByEmployee(client, rule, candidates.map((employee) => employee.id)) : {};
  const targets = selectRuleTargets(rule, { candidates, certsByEmployee: certs, now, config });
  if (targets.length === 0) return;

  const sourceType = rule.rule_type === "role" ? "role_rule" : "certification_rule";
  const existing = await pgSelect(client, "training_assignments", {
    filters: {
      facility_id: rule.facility_id,
      course_id: rule.course_id,
      source_type: sourceType,
      source_ref_id: rule.id
    },
    select: "employee_id"
  });
  const alreadyAssigned = new Set((existing ?? []).map((row) => row.employee_id));
  const missing = targets.filter((target) => !alreadyAssigned.has(target.employeeId));
  summary.deduped += targets.length - missing.length;
  if (missing.length === 0) return;

  const dueAt = dueAtForRule(rule, configValue(config, "training.autoAssignDueDays"), now);
  const rows = missing.map((target) => ({
    facility_id: rule.facility_id,
    employee_id: target.employeeId,
    course_id: rule.course_id,
    assigned_by: null,
    due_at: dueAt,
    reason_code: `auto_${rule.rule_type}_rule:${target.reason}`,
    source_type: sourceType,
    source_ref_id: rule.id
  }));
  for (const batch of chunk(rows, INSERT_CHUNK)) {
    const inserted = await pgInsert(client, "training_assignments", batch, {
      onConflict: CONFLICT_TARGET,
      ignoreDuplicates: true,
      returning: true
    });
    const createdCount = (inserted ?? []).length;
    summary.created += createdCount;
    // A concurrent pass won the race for the rest: ON CONFLICT DO NOTHING.
    summary.deduped += batch.length - createdCount;
  }
}

// runTrainingAutoAssign(client, { now, limit, loadConfig }) -> summary.
// `loadConfig({ facilityId, moduleCode })` resolves a facility's effective
// training settings (defaults to the shared makeConfigLoader(client), which
// degrades to registry defaults on any lookup failure).
export async function runTrainingAutoAssign(
  client,
  { now = new Date(), limit = DEFAULT_RULE_LIMIT, loadConfig = makeConfigLoader(client) } = {}
) {
  const summary = {
    rulesScanned: 0,
    rulesEvaluated: 0,
    skippedDisabled: 0,
    skippedCourse: 0,
    candidates: 0,
    created: 0,
    deduped: 0,
    errors: []
  };

  const rules =
    (await pgSelect(client, "training_assignment_rules", {
      filters: { active: true },
      select: RULE_COLUMNS,
      order: "last_evaluated_at.asc.nullsfirst",
      limit
    })) ?? [];
  summary.rulesScanned = rules.length;

  for (const rule of rules) {
    try {
      const config = await loadConfig({ facilityId: rule.facility_id, moduleCode: TRAINING_MODULE_CODE });
      await evaluateRule(client, rule, { now, config, summary });
      await pgUpdate(
        client,
        "training_assignment_rules",
        { id: rule.id, facility_id: rule.facility_id },
        { last_evaluated_at: now.toISOString() },
        { returning: false }
      );
      summary.rulesEvaluated += 1;
    } catch (error) {
      summary.errors.push({ ruleId: rule.id, error: error.message });
    }
  }
  return summary;
}
