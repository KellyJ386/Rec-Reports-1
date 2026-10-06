// TR-09 / TR-10: pure helpers for training_assignment_rules and incident
// training triggers (0066_training_automation.sql). No I/O: the route layer
// and the evaluator (training-auto-assign.mjs) load rows and pass them in.
import { certGaps } from "./admin/cert-policy.mjs";

export const RULE_TYPES = Object.freeze(["certification", "role"]);
export const GAP_STATUSES = Object.freeze(["missing", "expired", "expiring"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validateGapStatuses(value, errors) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((status) => GAP_STATUSES.includes(status))) {
    errors.push(`gapStatuses must be a non-empty array of: ${GAP_STATUSES.join(", ")}`);
  }
}

// Validates a POST body for a rule.
//   certification rule: { ruleType: "certification", certificationTypeId, courseId, roleId?, gapStatuses?, dueDays? }
//   role rule:          { ruleType: "role", roleId, courseId, dueDays? }
export function validateRuleInput(input = {}) {
  const errors = [];
  if (!RULE_TYPES.includes(input.ruleType)) errors.push(`ruleType must be one of: ${RULE_TYPES.join(", ")}`);
  if (!isUuid(input.courseId)) errors.push("courseId must be a UUID");
  if (input.ruleType === "certification") {
    if (!isUuid(input.certificationTypeId)) errors.push("certificationTypeId must be a UUID");
    if (input.roleId !== undefined && input.roleId !== null && !isUuid(input.roleId)) {
      errors.push("roleId must be a UUID when given");
    }
  }
  if (input.ruleType === "role") {
    if (!isUuid(input.roleId)) errors.push("roleId must be a UUID");
    if (input.certificationTypeId !== undefined && input.certificationTypeId !== null) {
      errors.push("a role rule cannot carry a certificationTypeId");
    }
    if (input.gapStatuses !== undefined) errors.push("gapStatuses only applies to a certification rule");
  }
  if (input.gapStatuses !== undefined && input.ruleType === "certification") validateGapStatuses(input.gapStatuses, errors);
  if (
    input.dueDays !== undefined &&
    input.dueDays !== null &&
    (!Number.isInteger(input.dueDays) || input.dueDays < 1 || input.dueDays > 365)
  ) {
    errors.push("dueDays must be null or an integer between 1 and 365");
  }
  return { valid: errors.length === 0, errors };
}

// Validates a PATCH body: only the mutable fields (active, dueDays, gapStatuses).
export function validateRulePatch(input = {}) {
  const errors = [];
  if (input.active !== undefined && typeof input.active !== "boolean") errors.push("active must be a boolean");
  if (
    input.dueDays !== undefined &&
    input.dueDays !== null &&
    (!Number.isInteger(input.dueDays) || input.dueDays < 1 || input.dueDays > 365)
  ) {
    errors.push("dueDays must be null or an integer between 1 and 365");
  }
  if (input.gapStatuses !== undefined) validateGapStatuses(input.gapStatuses, errors);
  return { valid: errors.length === 0, errors };
}

// The due date an auto-assignment gets: the rule's own due_days, else the
// facility's training.autoAssignDueDays default.
export function dueAtForRule(rule, defaultDueDays, now = new Date()) {
  const days = rule?.due_days ?? defaultDueDays;
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

// Decides which of a rule's candidate employees should receive its course.
//   rule            a training_assignment_rules row
//   candidates      [{ id, facility_id }] -- employees who hold the rule's
//                   role (or, for a certification rule without a role, the
//                   role of any active requirement for the type)
//   certsByEmployee { [employeeId]: [employee_certifications rows] }
//   now / config    threaded into certGaps -> certificationStatus
// Employees outside the rule's facility are NEVER selected, whatever the
// caller passed (the evaluator also scopes every query by facility; this is
// the pure layer's own backstop, and 0066's trigger is the database's).
export function selectRuleTargets(rule, { candidates = [], certsByEmployee = {}, now = new Date(), config = {} } = {}) {
  const inFacility = candidates.filter((employee) => employee.facility_id === rule.facility_id);
  if (rule.rule_type === "role") return inFacility.map((employee) => ({ employeeId: employee.id, reason: "role" }));

  const requirement = [{ certification_type_id: rule.certification_type_id, active: true }];
  const targets = [];
  for (const employee of inFacility) {
    const gaps = certGaps(certsByEmployee[employee.id] ?? [], requirement, now, config);
    const matching = gaps.find((gap) => (rule.gap_statuses ?? GAP_STATUSES).includes(gap.status));
    if (matching) targets.push({ employeeId: employee.id, reason: matching.status });
  }
  return targets;
}

// "pending" until a conversion row OR an incident_rule assignment (the 3B
// route creates one directly when the recording user also held
// training.manage) exists for the trigger.
export function triggerState(trigger, { conversionByTrigger, assignmentByTrigger }) {
  const conversion = conversionByTrigger?.get?.(trigger.id) ?? null;
  const assignment = assignmentByTrigger?.get?.(trigger.id) ?? null;
  return {
    state: conversion || assignment ? "assigned" : "pending",
    assignmentId: conversion?.assignment_id ?? assignment?.id ?? null
  };
}

// Resolves which course a trigger should be assigned, from its `target`
// ({ trainingModuleId } | { certificationTypeId }) and the caller-supplied
// courseId / the facility's active certification rules.
//   moduleCourseId   the course_id of the target module (looked up by the caller)
//   certificationRules  active certification-type rules of the facility
// Returns { courseId } or { error }.
export function resolveTriggerCourse(trigger, { courseId, moduleCourseId, certificationRules = [] } = {}) {
  const target = trigger?.target ?? {};
  if (target.trainingModuleId) {
    if (!moduleCourseId) return { error: "the module this trigger targets no longer exists" };
    return { courseId: moduleCourseId };
  }
  if (target.certificationTypeId) {
    if (courseId) return { courseId };
    const rule = certificationRules.find(
      (candidate) => candidate.rule_type === "certification" && candidate.certification_type_id === target.certificationTypeId
    );
    if (rule) return { courseId: rule.course_id };
    return {
      error:
        "no course is linked to this certification type: supply courseId or create a certification rule for it"
    };
  }
  return { error: "the trigger names neither a module nor a certification type" };
}
