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

export function summarizeScheduleReadiness(assignments, certificationsByEmployee) {
  const doubleBookings = findDoubleBookings(assignments);
  const missingCertifications = findMissingCertifications(assignments, certificationsByEmployee);
  return {
    canPublish: doubleBookings.length === 0 && missingCertifications.length === 0,
    doubleBookings,
    missingCertifications
  };
}
