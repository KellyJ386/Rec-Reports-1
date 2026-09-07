import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOshaReview,
  requiredIncidentFollowUps,
  shouldEscalateIncident,
  escalationDueAt,
  isEscalationOverdue,
  nextEscalationLevel,
  canTransitionIncident,
  buildIncidentAuditEvent,
  buildAmendment,
  buildIncidentNotificationJobs,
  AMENDABLE_INCIDENT_FIELDS,
  formatIncidentNo,
  nextIncidentNo,
  INCIDENT_STATUSES
} from "../src/lib/incidents.mjs";

// --- nextEscalationLevel (IN-21) ---------------------------------------------

test("nextEscalationLevel returns currentLevel + 1", () => {
  assert.equal(nextEscalationLevel(1), 2);
  assert.equal(nextEscalationLevel(4), 5);
});

test("nextEscalationLevel treats a missing/non-positive level as 0, returning 1", () => {
  assert.equal(nextEscalationLevel(0), 1);
  assert.equal(nextEscalationLevel(-3), 1);
  assert.equal(nextEscalationLevel(undefined), 1);
  assert.equal(nextEscalationLevel(null), 1);
});

// --- buildIncidentNotificationJobs (IN-20) -----------------------------------

const NOTIFY_ROUTE = {
  id: "route-1",
  facility_id: "fac-1",
  priority: 5,
  route_jsonb: { channels: ["in_app", "email"] }
};

test("buildIncidentNotificationJobs shapes one row per recipient with a per-recipient dedupe_key", () => {
  const jobs = buildIncidentNotificationJobs("incident.escalated", NOTIFY_ROUTE, ["emp-1", "emp-2"], {
    id: "inc-1",
    severity: "medium"
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].dedupe_key, "inc-1:incident.escalated:emp-1");
  assert.equal(jobs[1].dedupe_key, "inc-1:incident.escalated:emp-2");
  assert.equal(jobs[0].facility_id, "fac-1");
  assert.equal(jobs[0].event_type, "incident.escalated");
  assert.deepEqual(jobs[0].payload_jsonb.recipients, ["emp-1"]);
  assert.deepEqual(jobs[0].payload_jsonb.channels, ["in_app", "email"]);
  assert.equal(jobs[0].payload_jsonb.incidentId, "inc-1");
});

test("buildIncidentNotificationJobs sets quietHoursBypass true for high/critical severity, false otherwise", () => {
  const high = buildIncidentNotificationJobs("incident.escalated", NOTIFY_ROUTE, ["emp-1"], {
    id: "inc-1",
    severity: "high"
  });
  assert.equal(high[0].payload_jsonb.quietHoursBypass, true);

  const critical = buildIncidentNotificationJobs("incident.sla_breached", NOTIFY_ROUTE, ["emp-1"], {
    id: "inc-1",
    severity: "critical"
  });
  assert.equal(critical[0].payload_jsonb.quietHoursBypass, true);

  const low = buildIncidentNotificationJobs("incident.submitted", NOTIFY_ROUTE, ["emp-1"], {
    id: "inc-1",
    severity: "low"
  });
  assert.equal(low[0].payload_jsonb.quietHoursBypass, false);

  const medium = buildIncidentNotificationJobs("incident.submitted", NOTIFY_ROUTE, ["emp-1"], {
    id: "inc-1",
    severity: "medium"
  });
  assert.equal(medium[0].payload_jsonb.quietHoursBypass, false);
});

test("buildIncidentNotificationJobs drops falsy recipient ids and returns [] for an empty recipient list", () => {
  assert.deepEqual(buildIncidentNotificationJobs("incident.submitted", NOTIFY_ROUTE, [], { id: "inc-1" }), []);
  const jobs = buildIncidentNotificationJobs("incident.submitted", NOTIFY_ROUTE, ["emp-1", null, undefined, ""], {
    id: "inc-1"
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].dedupe_key, "inc-1:incident.submitted:emp-1");
});

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

test("isEscalationOverdue uses incident.dueAt verbatim when present, bypassing the SLA calculation (IN-06)", () => {
  const now = new Date("2026-07-08T02:00:00Z");
  // dueAt already passed -- overdue, even though this "incident" carries no
  // reportedAt/createdAt/occurredAt at all (escalationDueAt would return
  // null for it, i.e. never overdue, if dueAt weren't honored first).
  assert.equal(isEscalationOverdue({ dueAt: "2026-07-08T01:00:00Z" }, now), true);
  // dueAt not yet reached -- not overdue.
  assert.equal(isEscalationOverdue({ dueAt: "2026-07-08T03:00:00Z" }, now), false);
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

// --- buildAmendment (IN-04) --------------------------------------------------

const BEFORE_INCIDENT = {
  id: "inc-1",
  facility_id: "fac-1",
  department_id: null,
  incident_no: "INC-2026-0001",
  report_type: "incident",
  status: "submitted",
  severity: "medium",
  occurred_at: "2026-07-18T10:00:00Z",
  reported_at: "2026-07-18T11:00:00Z",
  location_text: "Building A",
  summary: "Original summary",
  immediate_actions: null,
  requires_osha_review: false,
  legal_hold: false,
  submitted_by: "user-1",
  submitted_at: "2026-07-18T11:00:00Z",
  created_at: "2026-07-18T11:00:00Z",
  updated_at: "2026-07-18T11:00:00Z"
};

test("AMENDABLE_INCIDENT_FIELDS excludes status/facility_id/incident_no/ids", () => {
  for (const excluded of ["status", "facility_id", "incident_no", "id", "department_id", "occurred_at"]) {
    assert.ok(!AMENDABLE_INCIDENT_FIELDS.includes(excluded), `${excluded} must not be amendable`);
  }
  assert.deepEqual(
    [...AMENDABLE_INCIDENT_FIELDS].sort(),
    ["immediate_actions", "location_text", "requires_osha_review", "severity", "summary"].sort()
  );
});

test("buildAmendment applies the patch on top of before to produce afterSnapshot, leaving before untouched", () => {
  const built = buildAmendment(BEFORE_INCIDENT, { summary: "Revised after investigation" }, { reason: "found more detail" });
  assert.equal(built.error, undefined);
  assert.equal(built.beforeSnapshot.summary, "Original summary");
  assert.equal(built.afterSnapshot.summary, "Revised after investigation");
  // Every other field is carried through unchanged.
  assert.equal(built.afterSnapshot.severity, BEFORE_INCIDENT.severity);
  assert.equal(built.afterSnapshot.status, BEFORE_INCIDENT.status);
  assert.deepEqual(built.patch, { summary: "Revised after investigation" });
  assert.deepEqual(built.changedFields, ["summary"]);
  assert.equal(built.reason, "found more detail");
});

test("buildAmendment is deterministic: identical inputs produce identical hashes", () => {
  const args = [BEFORE_INCIDENT, { severity: "high" }, { reason: "reclassified", actor: "user-9" }];
  const first = buildAmendment(...args);
  const second = buildAmendment(...args);
  assert.equal(first.beforeHash, second.beforeHash);
  assert.equal(first.afterHash, second.afterHash);
  assert.equal(first.beforeHash.length, 64); // sha256 hex
  assert.equal(first.afterHash.length, 64);
});

test("buildAmendment hashes are content-sensitive: a different patch changes afterHash but not beforeHash", () => {
  const a = buildAmendment(BEFORE_INCIDENT, { severity: "high" }, { reason: "r" });
  const b = buildAmendment(BEFORE_INCIDENT, { severity: "critical" }, { reason: "r" });
  assert.equal(a.beforeHash, b.beforeHash); // same before-state
  assert.notEqual(a.afterHash, b.afterHash); // different after-state
});

test("buildAmendment rejects an empty patch", () => {
  const result = buildAmendment(BEFORE_INCIDENT, {}, { reason: "no-op" });
  assert.equal(result.error, "patch must include at least one amendable field");
  assert.equal(result.beforeSnapshot, undefined);
});

test("buildAmendment rejects non-amendable keys, listing every offending key", () => {
  const result = buildAmendment(
    BEFORE_INCIDENT,
    { status: "closed", facility_id: "fac-2", summary: "ok field mixed in" },
    { reason: "attempted bypass" }
  );
  assert.match(result.error, /status/);
  assert.match(result.error, /facility_id/);
  assert.equal(result.beforeSnapshot, undefined);
});

test("buildAmendment rejects a missing or blank reason", () => {
  assert.equal(buildAmendment(BEFORE_INCIDENT, { summary: "x" }, {}).error, "reason is required");
  assert.equal(buildAmendment(BEFORE_INCIDENT, { summary: "x" }, { reason: "" }).error, "reason is required");
  assert.equal(buildAmendment(BEFORE_INCIDENT, { summary: "x" }, { reason: "   " }).error, "reason is required");
});

test("buildAmendment trims the reason and defaults actor to null", () => {
  const withActor = buildAmendment(BEFORE_INCIDENT, { summary: "x" }, { reason: "  spaced reason  ", actor: "user-1" });
  assert.equal(withActor.reason, "spaced reason");
  assert.equal(withActor.actor, "user-1");

  const withoutActor = buildAmendment(BEFORE_INCIDENT, { summary: "x" }, { reason: "reason" });
  assert.equal(withoutActor.actor, null);
});

// --- Incident number generation (IN-09) --------------------------------------

test("formatIncidentNo pads the sequence to 4 digits", () => {
  assert.equal(formatIncidentNo(1, 2026), "INC-2026-0001");
  assert.equal(formatIncidentNo(42, 2026), "INC-2026-0042");
  assert.equal(formatIncidentNo(10000, 2026), "INC-2026-10000"); // never truncates a 5+ digit sequence
});

test("nextIncidentNo starts at 0001 when no existing incidents match the year", () => {
  assert.equal(nextIncidentNo([], 2026), "INC-2026-0001");
  assert.equal(nextIncidentNo(["INC-2025-0099"], 2026), "INC-2026-0001"); // different year, ignored
});

test("nextIncidentNo returns max + 1 for the given year", () => {
  assert.equal(nextIncidentNo(["INC-2026-0001", "INC-2026-0007", "INC-2026-0003"], 2026), "INC-2026-0008");
});

test("nextIncidentNo ignores malformed / non-matching values instead of throwing", () => {
  assert.equal(
    nextIncidentNo(["not-a-number", "", null, undefined, 42, "INC-2026-0002"], 2026),
    "INC-2026-0003"
  );
});

test("nextIncidentNo defaults year to the current UTC year when omitted", () => {
  const year = new Date().getUTCFullYear();
  assert.equal(nextIncidentNo([]), `INC-${year}-0001`);
});
