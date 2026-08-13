import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOshaReview,
  requiredIncidentFollowUps,
  shouldEscalateIncident,
  escalationDueAt,
  isEscalationOverdue,
  canTransitionIncident,
  buildIncidentAuditEvent,
  INCIDENT_STATUSES
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

// --- canTransitionIncident (IN-02) ------------------------------------------

const LEGAL_EDGES = new Set([
  "draft->submitted",
  "submitted->under_review",
  "under_review->escalated",
  "under_review->action_pending",
  "escalated->action_pending",
  "escalated->closed",
  "action_pending->escalated",
  "action_pending->closed"
]);

const FULLY_PERMITTED = ["incidents.manage", "incidents.review", "incidents.legal_hold.manage"];

test("canTransitionIncident full matrix: only the documented edges are legal, with full permissions and no other gates", () => {
  for (const from of INCIDENT_STATUSES) {
    for (const to of INCIDENT_STATUSES) {
      const result = canTransitionIncident(from, to, { actorPermissions: FULLY_PERMITTED });
      const key = `${from}->${to}`;
      if (LEGAL_EDGES.has(key)) {
        assert.equal(result.allowed, true, `expected ${key} to be allowed: ${result.reason}`);
        assert.equal(result.reasonCode, null);
      } else {
        assert.equal(result.allowed, false, `expected ${key} to be rejected`);
        assert.equal(result.reasonCode, "invalid_transition", key);
      }
    }
  }
});

test("canTransitionIncident rejects unknown statuses before checking the graph", () => {
  assert.deepEqual(canTransitionIncident("bogus", "submitted", { actorPermissions: FULLY_PERMITTED }), {
    allowed: false,
    reason: 'unknown status "bogus"',
    reasonCode: "unknown_status"
  });
  assert.deepEqual(canTransitionIncident("draft", "bogus", { actorPermissions: FULLY_PERMITTED }), {
    allowed: false,
    reason: 'unknown status "bogus"',
    reasonCode: "unknown_status"
  });
});

test("closed is terminal: no transition leaves it even with full permissions", () => {
  for (const to of INCIDENT_STATUSES) {
    const result = canTransitionIncident("closed", to, { actorPermissions: FULLY_PERMITTED });
    assert.equal(result.allowed, false);
  }
});

test("submit (draft->submitted) allows incidents.manage without being the creator", () => {
  const result = canTransitionIncident("draft", "submitted", { actorPermissions: ["incidents.manage"] });
  assert.equal(result.allowed, true);
});

test("submit (draft->submitted) allows the creator without incidents.manage", () => {
  const result = canTransitionIncident("draft", "submitted", { actorPermissions: [], isCreator: true });
  assert.equal(result.allowed, true);
});

test("submit (draft->submitted) rejects an actor with neither incidents.manage nor creator status", () => {
  const result = canTransitionIncident("draft", "submitted", { actorPermissions: ["incidents.read"] });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "forbidden");
});

test("submit does not accept incidents.review as a substitute for incidents.manage/creator", () => {
  const result = canTransitionIncident("draft", "submitted", { actorPermissions: ["incidents.review"] });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "forbidden");
});

test("review/close transitions require incidents.review", () => {
  const withoutReview = canTransitionIncident("submitted", "under_review", {
    actorPermissions: ["incidents.manage"]
  });
  assert.equal(withoutReview.allowed, false);
  assert.equal(withoutReview.reasonCode, "forbidden");

  const withReview = canTransitionIncident("submitted", "under_review", {
    actorPermissions: ["incidents.review"]
  });
  assert.equal(withReview.allowed, true);
});

test("closure is blocked while required follow-ups remain open", () => {
  const result = canTransitionIncident("action_pending", "closed", {
    actorPermissions: ["incidents.review"],
    openFollowUps: [{ id: "f1" }, { id: "f2" }]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "followups_open");
  assert.match(result.reason, /2 required follow-up/);
});

test("closure succeeds once follow-ups are all closed", () => {
  const result = canTransitionIncident("action_pending", "closed", {
    actorPermissions: ["incidents.review"],
    openFollowUps: []
  });
  assert.equal(result.allowed, true);
});

test("legal-hold incidents cannot close without incidents.legal_hold.manage", () => {
  const denied = canTransitionIncident("escalated", "closed", {
    actorPermissions: ["incidents.review"],
    legalHold: true
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasonCode, "legal_hold");

  const allowed = canTransitionIncident("escalated", "closed", {
    actorPermissions: ["incidents.review", "incidents.legal_hold.manage"],
    legalHold: true
  });
  assert.equal(allowed.allowed, true);
});

test("legal hold gate does not apply to non-legal-hold incidents or non-closing transitions", () => {
  const nonClosing = canTransitionIncident("under_review", "escalated", {
    actorPermissions: ["incidents.review"],
    legalHold: true
  });
  assert.equal(nonClosing.allowed, true);

  const notHeld = canTransitionIncident("escalated", "closed", {
    actorPermissions: ["incidents.review"],
    legalHold: false
  });
  assert.equal(notHeld.allowed, true);
});

test("open follow-ups and legal hold gates both apply and are checked in addition to each other", () => {
  const result = canTransitionIncident("action_pending", "closed", {
    actorPermissions: ["incidents.review"],
    openFollowUps: [{ id: "f1" }],
    legalHold: true
  });
  // follow-ups are checked first
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "followups_open");
});

// --- buildIncidentAuditEvent (IN-03 support) --------------------------------

test("buildIncidentAuditEvent shapes an insert row without prev_hash/row_hash (DB trigger owns those)", () => {
  const row = buildIncidentAuditEvent({
    facilityId: "fac-1",
    incidentId: "inc-1",
    actorUserId: "user-1",
    eventType: "incident.submitted",
    payload: { actor: "user-1", from: "draft", to: "submitted" }
  });
  assert.equal(row.facility_id, "fac-1");
  assert.equal(row.incident_id, "inc-1");
  assert.equal(row.actor_user_id, "user-1");
  assert.equal(row.event_type, "incident.submitted");
  assert.deepEqual(row.event_payload, { actor: "user-1", from: "draft", to: "submitted" });
  assert.equal(typeof row.event_hash, "string");
  assert.equal(row.event_hash.length, 64); // sha256 hex
  assert.equal(row.prev_hash, undefined);
  assert.equal(row.row_hash, undefined);
});

test("buildIncidentAuditEvent event_hash is deterministic and payload-sensitive", () => {
  const base = {
    facilityId: "fac-1",
    incidentId: "inc-1",
    actorUserId: "user-1",
    eventType: "incident.status_changed",
    payload: { actor: "user-1", from: "escalated", to: "closed", reason: null }
  };
  const first = buildIncidentAuditEvent(base);
  const second = buildIncidentAuditEvent(base);
  assert.equal(first.event_hash, second.event_hash);

  const different = buildIncidentAuditEvent({ ...base, payload: { ...base.payload, reason: "resolved" } });
  assert.notEqual(different.event_hash, first.event_hash);
});

test("buildIncidentAuditEvent defaults actor_user_id to null and event_payload to {}", () => {
  const row = buildIncidentAuditEvent({ facilityId: "fac-1", incidentId: "inc-1", eventType: "incident.submitted" });
  assert.equal(row.actor_user_id, null);
  assert.deepEqual(row.event_payload, {});
});
