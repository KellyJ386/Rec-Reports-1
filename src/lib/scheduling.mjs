import { configValue } from "./settings-registry.mjs";
import { effectiveEnforcementMode } from "./admin/cert-policy.mjs";

export function shiftsOverlap(first, second) {
  return new Date(first.startsAt) < new Date(second.endsAt) && new Date(second.startsAt) < new Date(first.endsAt);
}

export function findDoubleBookings(assignments) {
  const conflicts = [];
  const byEmployee = new Map();
  for (const assignment of assignments) {
    const employeeAssignments = byEmployee.get(assignment.employeeId) ?? [];
    for (const existing of employeeAssignments) {
      if (shiftsOverlap(existing, assignment)) {
        conflicts.push({ employeeId: assignment.employeeId, shiftIds: [existing.shiftId, assignment.shiftId] });
      }
    }
    employeeAssignments.push(assignment);
    byEmployee.set(assignment.employeeId, employeeAssignments);
  }
  return conflicts;
}

export function findMissingCertifications(assignments, certificationsByEmployee) {
  return assignments.flatMap((assignment) => {
    const heldCertifications = new Set(certificationsByEmployee[assignment.employeeId] ?? []);
    return assignment.requiredCertificationCodes
      .filter((code) => !heldCertifications.has(code))
      .map((code) => ({ employeeId: assignment.employeeId, shiftId: assignment.shiftId, certificationCode: code }));
  });
}

// `config` is an optional flat map of registry keys (defaults applied per key),
// so existing callers pass nothing and get the shipped hard-block behavior.
// - scheduling.conflictCheckEnabled=false skips double-booking blocking.
// - scheduling.certEnforcementMode='warning' downgrades missing certifications
//   from a publish-blocking error to a non-blocking warning.
//
// The optional `roleRequirements` (an array of requirement rows carrying a
// certificationCode and an enforcement_mode, i.e. certification_role_requirements
// from 0017) refines enforcement PER missing certification: a missing cert whose
// requirement resolves (via effectiveEnforcementMode -- the requirement override
// winning over the registry mode) to 'warning' is downgraded to a non-blocking
// warning, while 'hard-block' ones still block. With no roleRequirements the
// single registry certEnforcementMode governs every missing cert (Phase 5
// behavior, fully backward compatible).
export function summarizeScheduleReadiness(assignments, certificationsByEmployee, config = {}, { roleRequirements } = {}) {
  const conflictCheckEnabled = configValue(config, "scheduling.conflictCheckEnabled");
  const certEnforcementMode = configValue(config, "scheduling.certEnforcementMode");

  const doubleBookings = conflictCheckEnabled ? findDoubleBookings(assignments) : [];
  const missingCertifications = findMissingCertifications(assignments, certificationsByEmployee);

  const requirementByCode = new Map();
  for (const requirement of roleRequirements ?? []) {
    const code = requirement?.certificationCode ?? requirement?.certification_code;
    if (code) requirementByCode.set(code, requirement);
  }
  const modeForMissing = (missing) => {
    if (requirementByCode.size === 0) return certEnforcementMode;
    const requirement = requirementByCode.get(missing.certificationCode);
    if (!requirement) return certEnforcementMode;
    return effectiveEnforcementMode(requirement, config);
  };

  const blocking = [];
  const warnings = [];
  for (const missing of missingCertifications) {
    if (modeForMissing(missing) === "warning") warnings.push({ ...missing, severity: "warning" });
    else blocking.push(missing);
  }

  return {
    canPublish: doubleBookings.length === 0 && blocking.length === 0,
    doubleBookings,
    missingCertifications,
    warnings,
    certEnforcementMode
  };
}

// --- Schedule period lifecycle (SC-01) --------------------------------------
// schedule_periods.status is constrained by 0003_scheduling.sql to
// 'draft' | 'review' | 'published' | 'archived'. The legal-transition graph
// below mirrors the design doc's linear flow (draft -> review -> published ->
// archived), plus two documented allowances: SCHEDULING_SYSTEM_DESIGN.md
// notes review is "optional for multi-manager environments", so draft can
// jump straight to published; and review -> draft lets a manager send a
// submitted-for-review period back for edits before it goes live. published
// and archived are one-way (an already-published period is only changed
// through the future publish/override flow, SC-07 -- not by this transition
// map), and archived is terminal.
const PERIOD_TRANSITIONS = {
  draft: new Set(["review", "published"]),
  review: new Set(["draft", "published"]),
  published: new Set(["archived"]),
  archived: new Set()
};

export const PERIOD_STATUSES = Object.freeze(Object.keys(PERIOD_TRANSITIONS));

// Pure legal-transition check: true iff `to` is a status schedule_periods may
// move to directly from `from`. Same-status "transitions", unknown statuses,
// and skipped/backward moves not explicitly allowed above all return false so
// the route layer can turn a false result into a 400 without any DB round trip.
export function canTransitionPeriod(from, to) {
  const allowed = PERIOD_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

// --- Shift template validation (SC-02) --------------------------------------
// Pure shape/range check for shift_templates rows, run BEFORE any fetch so an
// invalid payload never reaches PostgREST. `partial` relaxes required-field
// checks for PATCH: a field is only validated if present in `input`, except
// start/end time which are validated together whenever either is present
// (comparing just one against the unfetched current row isn't possible here,
// so PATCH callers must send both together to change either).
export function validateTemplateInput(input, { partial = false } = {}) {
  const errors = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(input ?? {}, key);
  const roleCode = input?.roleCode;
  const startTimeLocal = input?.startTimeLocal;
  const endTimeLocal = input?.endTimeLocal;
  const daysOfWeek = input?.daysOfWeek;
  const requiredCertificationIds = input?.requiredCertificationIds;

  if (!partial || has("roleCode")) {
    if (!roleCode) errors.push("roleCode is required");
  }

  if (!partial || has("startTimeLocal") || has("endTimeLocal")) {
    if (!startTimeLocal) errors.push("startTimeLocal is required");
    if (!endTimeLocal) errors.push("endTimeLocal is required");
    if (startTimeLocal && endTimeLocal && !(startTimeLocal < endTimeLocal)) {
      errors.push("startTimeLocal must be before endTimeLocal");
    }
  }

  if (!partial || has("daysOfWeek")) {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      errors.push("daysOfWeek must be a non-empty array");
    } else if (!daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
      errors.push("daysOfWeek entries must be integers between 0 and 6");
    }
  }

  if (has("requiredCertificationIds")) {
    if (!Array.isArray(requiredCertificationIds)) {
      errors.push("requiredCertificationIds must be an array");
    } else if (!requiredCertificationIds.every((id) => typeof id === "string" && id.length > 0)) {
      errors.push("requiredCertificationIds entries must be non-empty strings");
    }
  }

  return { valid: errors.length === 0, errors };
}
