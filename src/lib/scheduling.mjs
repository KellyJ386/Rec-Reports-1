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
