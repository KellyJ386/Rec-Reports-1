export function certificationStatus(certification, now = new Date()) {
  if (certification.status === "revoked") return "revoked";
  if (!certification.expiresAt) return certification.status ?? "active";
  const expiresAt = new Date(certification.expiresAt);
  if (expiresAt < now) return "expired";
  const renewalWindowDays = certification.renewalWindowDays ?? 30;
  const renewalStartsAt = new Date(expiresAt);
  renewalStartsAt.setUTCDate(renewalStartsAt.getUTCDate() - renewalWindowDays);
  return renewalStartsAt <= now ? "expiring" : "active";
}

export function trainingAssignmentState(assignment, now = new Date()) {
  if (assignment.completedAt) return "complete";
  if (assignment.dueAt && new Date(assignment.dueAt) < now) return "overdue";
  if (assignment.startedAt) return "in_progress";
  return "not_started";
}

export function certificationBlocksSchedule(certification, now = new Date()) {
  return ["expired", "revoked"].includes(certificationStatus(certification, now));
}
