import { configValue } from "./settings-registry.mjs";

// `config` optional. The renewal/recert window falls back to
// training.recertWindowDays (shipped default 30) when the certification itself
// does not carry a renewalWindowDays, preserving the original ?? 30 behavior.
export function certificationStatus(certification, now = new Date(), config = {}) {
  if (certification.status === "revoked") return "revoked";
  if (!certification.expiresAt) return certification.status ?? "active";
  const expiresAt = new Date(certification.expiresAt);
  if (expiresAt < now) return "expired";
  const renewalWindowDays = certification.renewalWindowDays ?? configValue(config, "training.recertWindowDays");
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

export function certificationBlocksSchedule(certification, now = new Date(), config = {}) {
  return ["expired", "revoked"].includes(certificationStatus(certification, now, config));
}
