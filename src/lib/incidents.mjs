const escalationSeverities = new Set(["high", "critical"]);
const oshaReviewTriggers = new Set(["employee_injury", "hospitalization", "lost_time", "fatality"]);

export function shouldEscalateIncident(incident) {
  return escalationSeverities.has(incident.severity) || incident.legalHold === true || incident.requiresOshaReview === true;
}

export function classifyOshaReview(reportType, outcomes = []) {
  if (reportType !== "accident") return false;
  return outcomes.some((outcome) => oshaReviewTriggers.has(outcome));
}

export function requiredIncidentFollowUps(incident) {
  const followUps = [];
  if (shouldEscalateIncident(incident)) {
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
