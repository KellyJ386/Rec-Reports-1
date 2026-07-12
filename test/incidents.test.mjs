import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOshaReview,
  requiredIncidentFollowUps,
  shouldEscalateIncident,
  escalationDueAt,
  isEscalationOverdue
} from "../src/lib/incidents.mjs";

test("shouldEscalateIncident escalates high severity, legal hold, or OSHA review", () => {
  assert.equal(shouldEscalateIncident({ severity: "high" }), true);
  assert.equal(shouldEscalateIncident({ severity: "low", legalHold: true }), true);
  assert.equal(shouldEscalateIncident({ severity: "medium", requiresOshaReview: true }), true);
  assert.equal(shouldEscalateIncident({ severity: "medium" }), false);
});

test("severityAutoEscalate=false stops severity alone from escalating", () => {
  assert.equal(shouldEscalateIncident({ severity: "high" }, {}), true);
  assert.equal(shouldEscalateIncident({ severity: "high" }, { "incidents.severityAutoEscalate": false }), false);
  // legal hold and OSHA review still force escalation regardless of the flag
  assert.equal(
    shouldEscalateIncident({ severity: "high", legalHold: true }, { "incidents.severityAutoEscalate": false }),
    true
  );
});

test("escalationDueAt honors incidents.escalationSlaHours", () => {
  const incident = { reportedAt: "2026-07-08T00:00:00Z" };
  assert.equal(escalationDueAt(incident).toISOString(), "2026-07-08T04:00:00.000Z"); // default 4h
  assert.equal(
    escalationDueAt(incident, { "incidents.escalationSlaHours": 1 }).toISOString(),
    "2026-07-08T01:00:00.000Z"
  );
  const now = new Date("2026-07-08T02:00:00Z");
  assert.equal(isEscalationOverdue(incident, now), false); // due at 04:00, not yet overdue
  assert.equal(isEscalationOverdue(incident, now, { "incidents.escalationSlaHours": 1 }), true);
});

test("classifyOshaReview only flags accident outcomes with OSHA-style triggers", () => {
  assert.equal(classifyOshaReview("incident", ["employee_injury"]), false);
  assert.equal(classifyOshaReview("accident", ["first_aid"]), false);
  assert.equal(classifyOshaReview("accident", ["employee_injury", "lost_time"]), true);
});

test("requiredIncidentFollowUps returns deduplicated compliance actions", () => {
  assert.deepEqual(
    requiredIncidentFollowUps({ severity: "critical", requiresOshaReview: true }),
    [
      "manager_review",
      "safety_lead_acknowledgement",
      "osha_recordability_check",
      "evidence_completeness_check",
      "executive_notification",
      "legal_review"
    ]
  );
});
