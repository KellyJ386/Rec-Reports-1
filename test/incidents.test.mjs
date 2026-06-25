import test from "node:test";
import assert from "node:assert/strict";
import { classifyOshaReview, requiredIncidentFollowUps, shouldEscalateIncident } from "../src/lib/incidents.mjs";

test("shouldEscalateIncident escalates high severity, legal hold, or OSHA review", () => {
  assert.equal(shouldEscalateIncident({ severity: "high" }), true);
  assert.equal(shouldEscalateIncident({ severity: "low", legalHold: true }), true);
  assert.equal(shouldEscalateIncident({ severity: "medium", requiresOshaReview: true }), true);
  assert.equal(shouldEscalateIncident({ severity: "medium" }), false);
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
