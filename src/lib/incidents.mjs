import { configValue } from "./settings-registry.mjs";

const escalationSeverities = new Set(["high", "critical"]);
const oshaReviewTriggers = new Set(["employee_injury", "hospitalization", "lost_time", "fatality"]);

// `config` is optional. incidents.severityAutoEscalate=false stops severity
// alone from escalating (legal hold and OSHA review still force escalation);
// the shipped default is true, preserving the original behavior.
export function shouldEscalateIncident(incident, config = {}) {
  const severityAutoEscalate = configValue(config, "incidents.severityAutoEscalate");
  const bySeverity = severityAutoEscalate && escalationSeverities.has(incident.severity);
  return bySeverity || incident.legalHold === true || incident.requiresOshaReview === true;
}

// The moment by which an escalation acknowledgement is due, driven by
// incidents.escalationSlaHours. Returns null when the incident carries no
// reported timestamp to anchor the SLA to.
export function escalationDueAt(incident, config = {}) {
  const slaHours = configValue(config, "incidents.escalationSlaHours");
  const anchor = incident.reportedAt ?? incident.createdAt ?? incident.occurredAt;
  if (!anchor) return null;
  return new Date(new Date(anchor).getTime() + slaHours * 60 * 60 * 1000);
}

export function isEscalationOverdue(incident, now = new Date(), config = {}) {
  const dueAt = escalationDueAt(incident, config);
  if (!dueAt) return false;
  return now > dueAt;
}

export function classifyOshaReview(reportType, outcomes = []) {
  if (reportType !== "accident") return false;
  return outcomes.some((outcome) => oshaReviewTriggers.has(outcome));
}

export function requiredIncidentFollowUps(incident, config = {}) {
  const followUps = [];
  if (shouldEscalateIncident(incident, config)) {
    followUps.push("manager_review", "safety_lead_acknowledgement");
  }
  if (incident.requiresOshaReview) {
    followUps.push("osha_recordability_check", "evidence_completeness_check");
  }
  if (incident.severity === "critical") {
    followUps.push("executive_notification", "legal_review");
  }
  return [...new Set(followUps)];
}
