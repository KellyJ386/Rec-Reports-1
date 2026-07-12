import { configValue } from "./settings-registry.mjs";

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
export function summarizeScheduleReadiness(assignments, certificationsByEmployee, config = {}) {
  const conflictCheckEnabled = configValue(config, "scheduling.conflictCheckEnabled");
  const certEnforcementMode = configValue(config, "scheduling.certEnforcementMode");

  const doubleBookings = conflictCheckEnabled ? findDoubleBookings(assignments) : [];
  const missingCertifications = findMissingCertifications(assignments, certificationsByEmployee);
  const certsBlockPublish = certEnforcementMode !== "warning";
  const warnings = certsBlockPublish
    ? []
    : missingCertifications.map((missing) => ({ ...missing, severity: "warning" }));

  return {
    canPublish: doubleBookings.length === 0 && (!certsBlockPublish || missingCertifications.length === 0),
    doubleBookings,
    missingCertifications,
    warnings,
    certEnforcementMode
  };
}
