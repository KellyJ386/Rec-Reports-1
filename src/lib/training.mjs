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

// TR-06: decides whether a training assignment is ready to be marked
// 'passed', based on real per-module progress rather than caller assertion.
// An assignment is ready only when every REQUIRED module has a
// training_progress row in state 'completed' for that assignment.
//
// A module counts as required unless it is explicitly marked
// `required: false` (matches the course_modules default of required=true) --
// non-required modules are never checked. A course with zero required
// modules (all-optional content, or no modules at all) is vacuously ready:
// there is nothing left to gate completion on.
//
//   modules: [{ id, required, title? }] -- a course's course_modules rows
//   progressRows: [{ moduleId, state }] -- an assignment's training_progress
//     rows; a required module absent from this list has never been started
//     and is treated the same as any other non-'completed' state
//
// Returns { ready, outstandingModules } rather than a bare boolean so the
// caller (the /complete route) can explain the refusal by naming exactly
// which required modules are still outstanding.
export function assignmentReadyToComplete(modules, progressRows) {
  const stateByModuleId = new Map((progressRows ?? []).map((row) => [row.moduleId, row.state]));
  const outstandingModules = (modules ?? [])
    .filter((module) => module.required !== false)
    .filter((module) => stateByModuleId.get(module.id) !== "completed")
    .map((module) => ({ id: module.id, title: module.title ?? null }));
  return { ready: outstandingModules.length === 0, outstandingModules };
}
