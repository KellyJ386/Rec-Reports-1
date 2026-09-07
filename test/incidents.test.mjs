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
  incidentRetentionClass,
  retentionEligibleAt,
  INCIDENT_STATUSES,
  SIGNATURE_ROLES,
  validateAttestationText,
  COMPLIANCE_CHECK_KEYS,
  COMPLIANCE_CHECK_STATUSES,
  evaluateClosureGate,
  evaluateOshaDecisionTree,
  OSHA_OUTCOMES
} from "../src/lib/incidents.mjs";
import { settingsRegistry } from "../src/lib/settings-registry.mjs";

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

// IN-14: the tree-outcome expansion is additive -- every existing 2-arg call
// above is unaffected (treeOutcome defaults to null), and a "recordable"
// tree outcome flags OSHA review on its own, independent of report_type.
test("classifyOshaReview also flags a 'recordable' OSHA decision-tree outcome, independent of report_type/outcomes", () => {
  assert.equal(classifyOshaReview("incident", [], "recordable"), true);
  assert.equal(classifyOshaReview("near_miss", [], "recordable"), true);
  assert.equal(classifyOshaReview("incident", [], "first_aid_only"), false);
  assert.equal(classifyOshaReview("incident", [], "not_work_related"), false);
  assert.equal(classifyOshaReview("incident", [], "needs_more_info"), false);
  assert.equal(classifyOshaReview("incident", [], null), false);
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

// --- Signatures (IN-13) ------------------------------------------------------

test("validateAttestationText rejects blank/whitespace-only text", () => {
  assert.equal(validateAttestationText("").valid, false);
  assert.equal(validateAttestationText("   ").valid, false);
  assert.equal(validateAttestationText(undefined).valid, false);
  assert.equal(validateAttestationText(null).valid, false);
});

test("validateAttestationText accepts trimmed non-blank text up to 2000 chars, rejects longer", () => {
  assert.equal(validateAttestationText("I attest this is accurate.").valid, true);
  assert.equal(validateAttestationText("a".repeat(2000)).valid, true);
  const tooLong = validateAttestationText("a".repeat(2001));
  assert.equal(tooLong.valid, false);
  assert.match(tooLong.error, /2000/);
});

test("SIGNATURE_ROLES matches the design doc's fixed vocabulary, supervisor included", () => {
  assert.deepEqual(SIGNATURE_ROLES, ["reporter", "witness", "supervisor", "manager"]);
});

// --- Compliance checks + closure gate (IN-15) --------------------------------

test("COMPLIANCE_CHECK_KEYS/STATUSES match the design doc's fixed vocabularies", () => {
  assert.deepEqual(COMPLIANCE_CHECK_KEYS, ["evidence_complete", "supervisor_signoff", "osha_recordability", "legal_review"]);
  assert.deepEqual(COMPLIANCE_CHECK_STATUSES, ["pass", "fail", "waived"]);
});

test("evaluateClosureGate allows a low/medium-severity, non-OSHA incident with no compliance checks at all", () => {
  assert.deepEqual(evaluateClosureGate({ severity: "low", requiresOshaReview: false }, []), {
    allowed: true,
    reason: null,
    reasonCode: null,
    blockingCheck: null
  });
  assert.equal(evaluateClosureGate({ severity: "medium", requiresOshaReview: false }, []).allowed, true);
});

test("evaluateClosureGate blocks a high/critical incident with no evidence_complete check", () => {
  for (const severity of ["high", "critical"]) {
    const gate = evaluateClosureGate({ severity, requiresOshaReview: false }, []);
    assert.equal(gate.allowed, false);
    assert.equal(gate.reasonCode, "compliance_check_failed");
    assert.equal(gate.blockingCheck, "evidence_complete");
    assert.match(gate.reason, /evidence_complete/);
  }
});

test("evaluateClosureGate blocks a high-severity incident whose evidence_complete check failed", () => {
  const gate = evaluateClosureGate(
    { severity: "high", requiresOshaReview: false },
    [{ check_key: "evidence_complete", status: "fail" }]
  );
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /failed/);
  assert.equal(gate.blockingCheck, "evidence_complete");
});

test("evaluateClosureGate allows a high-severity incident whose evidence_complete check passed or was waived", () => {
  assert.equal(
    evaluateClosureGate({ severity: "high", requiresOshaReview: false }, [{ check_key: "evidence_complete", status: "pass" }])
      .allowed,
    true
  );
  assert.equal(
    evaluateClosureGate({ severity: "critical", requiresOshaReview: false }, [
      { check_key: "evidence_complete", status: "waived" }
    ]).allowed,
    true
  );
});

test("evaluateClosureGate additionally requires supervisor_signoff when requiresOshaReview is true, independent of severity", () => {
  const lowSeverityOsha = evaluateClosureGate({ severity: "low", requiresOshaReview: true }, []);
  assert.equal(lowSeverityOsha.allowed, false);
  assert.equal(lowSeverityOsha.blockingCheck, "supervisor_signoff");

  assert.equal(
    evaluateClosureGate({ severity: "low", requiresOshaReview: true }, [
      { check_key: "supervisor_signoff", status: "pass" }
    ]).allowed,
    true
  );
});

test("evaluateClosureGate on a high-severity, requires_osha_review incident: evidence_complete is checked before supervisor_signoff", () => {
  // Only evidence_complete recorded -- supervisor_signoff still blocks.
  const gate = evaluateClosureGate({ severity: "high", requiresOshaReview: true }, [
    { check_key: "evidence_complete", status: "pass" }
  ]);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockingCheck, "supervisor_signoff");

  // Both recorded -- passes.
  assert.equal(
    evaluateClosureGate({ severity: "high", requiresOshaReview: true }, [
      { check_key: "evidence_complete", status: "pass" },
      { check_key: "supervisor_signoff", status: "waived" }
    ]).allowed,
    true
  );
});

// --- OSHA recordability decision tree (IN-14) --------------------------------

const TEST_TREE = {
  start: "fatality",
  nodes: {
    fatality: { question: "Fatality?", yes: { outcome: "recordable", timer: "fatality" }, no: "hospitalization" },
    hospitalization: {
      question: "Hospitalization?",
      yes: { outcome: "recordable", timer: "hospitalization" },
      no: "work_related"
    },
    work_related: { question: "Work-related?", yes: "recordable_criteria", no: { outcome: "not_work_related" } },
    recordable_criteria: {
      question: "Meets recordable criteria?",
      yes: { outcome: "recordable", timer: "recordable" },
      no: "first_aid"
    },
    first_aid: { question: "First aid only?", yes: { outcome: "first_aid_only" }, no: { outcome: "needs_more_info" } }
  },
  timers: {
    fatality: { hours: 8 },
    hospitalization: { hours: 24 },
    recordable: { days: 7 }
  }
};

test("evaluateOshaDecisionTree is the shipped default in settings-registry.mjs (incidents.oshaDecisionTree)", () => {
  const definition = settingsRegistry.find((d) => d.key === "incidents.oshaDecisionTree");
  assert.ok(definition, "expected an incidents.oshaDecisionTree setting definition");
  assert.equal(definition.dataType, "json");
  assert.equal(definition.module, "incidents");
  const now = new Date("2026-07-01T00:00:00Z");
  const result = evaluateOshaDecisionTree(definition.default, { fatality: "yes" }, now);
  assert.equal(result.outcome, "recordable");
  assert.equal(result.dueAt, "2026-07-01T08:00:00.000Z");
});

test("evaluateOshaDecisionTree: fatality path is recordable with an 8-hour timer", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const result = evaluateOshaDecisionTree(TEST_TREE, { fatality: "yes" }, now);
  assert.equal(result.outcome, "recordable");
  assert.equal(result.recordable, true);
  assert.equal(result.dueAt, "2026-07-01T08:00:00.000Z");
  assert.deepEqual(result.path, [{ nodeId: "fatality", question: "Fatality?", answer: "yes" }]);
});

test("evaluateOshaDecisionTree: hospitalization path is recordable with a 24-hour timer", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const result = evaluateOshaDecisionTree(TEST_TREE, { fatality: "no", hospitalization: "yes" }, now);
  assert.equal(result.outcome, "recordable");
  assert.equal(result.dueAt, "2026-07-02T00:00:00.000Z");
  assert.equal(result.path.length, 2);
});

test("evaluateOshaDecisionTree: ordinary recordable-criteria path gets a 7-day timer", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const result = evaluateOshaDecisionTree(
    TEST_TREE,
    { fatality: "no", hospitalization: "no", work_related: "yes", recordable_criteria: "yes" },
    now
  );
  assert.equal(result.outcome, "recordable");
  assert.equal(result.dueAt, "2026-07-08T00:00:00.000Z");
});

test("evaluateOshaDecisionTree: not-work-related and first-aid-only paths carry no timer", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const notWorkRelated = evaluateOshaDecisionTree(TEST_TREE, { fatality: "no", hospitalization: "no", work_related: "no" }, now);
  assert.equal(notWorkRelated.outcome, "not_work_related");
  assert.equal(notWorkRelated.recordable, false);
  assert.equal(notWorkRelated.dueAt, null);

  const firstAid = evaluateOshaDecisionTree(
    TEST_TREE,
    { fatality: "no", hospitalization: "no", work_related: "yes", recordable_criteria: "no", first_aid: "yes" },
    now
  );
  assert.equal(firstAid.outcome, "first_aid_only");
  assert.equal(firstAid.dueAt, null);
});

test("evaluateOshaDecisionTree: determinism -- identical tree/answers/now always produce identical output", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const answers = { fatality: "no", hospitalization: "no", work_related: "yes", recordable_criteria: "yes" };
  const first = evaluateOshaDecisionTree(TEST_TREE, answers, now);
  const second = evaluateOshaDecisionTree(TEST_TREE, answers, now);
  assert.deepEqual(first, second);
});

test("evaluateOshaDecisionTree: malformed-config fallback -- null/undefined/shapeless tree", () => {
  for (const badTree of [null, undefined, {}, { start: "fatality" }, "not an object", 42]) {
    const result = evaluateOshaDecisionTree(badTree, { fatality: "yes" });
    assert.equal(result.outcome, "needs_more_info");
    assert.equal(result.recordable, false);
    assert.equal(result.dueAt, null);
    assert.equal(result.malformed, true);
  }
});

test("evaluateOshaDecisionTree: malformed-config fallback -- missing/invalid answer for the current node", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const missingAnswer = evaluateOshaDecisionTree(TEST_TREE, {}, now);
  assert.equal(missingAnswer.outcome, "needs_more_info");
  assert.equal(missingAnswer.malformed, true);
  assert.deepEqual(missingAnswer.path, []);

  const invalidAnswer = evaluateOshaDecisionTree(TEST_TREE, { fatality: "maybe" }, now);
  assert.equal(invalidAnswer.outcome, "needs_more_info");
  assert.equal(invalidAnswer.malformed, true);

  // Insufficient answers partway through the tree: path holds what WAS
  // legally walked before the missing answer.
  const partial = evaluateOshaDecisionTree(TEST_TREE, { fatality: "no", hospitalization: "no" });
  assert.equal(partial.outcome, "needs_more_info");
  assert.equal(partial.malformed, true);
  assert.equal(partial.path.length, 2);
});

test("evaluateOshaDecisionTree: malformed-config fallback -- a node names a continuation absent from tree.nodes", () => {
  const brokenTree = {
    start: "fatality",
    nodes: { fatality: { question: "Fatality?", yes: { outcome: "recordable" }, no: "nowhere" } }
  };
  const result = evaluateOshaDecisionTree(brokenTree, { fatality: "no" });
  assert.equal(result.outcome, "needs_more_info");
  assert.equal(result.malformed, true);
});

test("evaluateOshaDecisionTree: malformed-config fallback -- a cyclic tree does not hang, falls back after bounded depth", () => {
  const cyclicTree = {
    start: "a",
    nodes: {
      a: { question: "A?", yes: { outcome: "recordable" }, no: "b" },
      b: { question: "B?", yes: { outcome: "recordable" }, no: "a" }
    }
  };
  const result = evaluateOshaDecisionTree(cyclicTree, { a: "no", b: "no" });
  assert.equal(result.outcome, "needs_more_info");
  assert.equal(result.malformed, true);
});

test("evaluateOshaDecisionTree: a terminal leaf naming an outcome outside OSHA_OUTCOMES falls back safely", () => {
  const badOutcomeTree = {
    start: "a",
    nodes: { a: { question: "A?", yes: { outcome: "totally_made_up" }, no: { outcome: "not_work_related" } } }
  };
  const result = evaluateOshaDecisionTree(badOutcomeTree, { a: "yes" });
  assert.equal(result.outcome, "needs_more_info");
  assert.equal(result.malformed, true);
  assert.ok(OSHA_OUTCOMES.includes("not_work_related")); // sanity: the OTHER leaf's outcome is legal
});

test("evaluateOshaDecisionTree: a recordable leaf with no `timer` key (or an unknown timer name) carries dueAt: null", () => {
  const treeWithoutTimer = {
    start: "a",
    nodes: { a: { question: "A?", yes: { outcome: "recordable" }, no: { outcome: "not_work_related" } } }
  };
  assert.equal(evaluateOshaDecisionTree(treeWithoutTimer, { a: "yes" }).dueAt, null);

  const treeWithUnknownTimer = {
    start: "a",
    nodes: { a: { question: "A?", yes: { outcome: "recordable", timer: "does_not_exist" }, no: { outcome: "not_work_related" } } },
    timers: { fatality: { hours: 8 } }
  };
  assert.equal(evaluateOshaDecisionTree(treeWithUnknownTimer, { a: "yes" }).dueAt, null);
});

// --- Retention (IN-16) -------------------------------------------------------

test("incidentRetentionClass: OSHA-recordable incidents take priority over everything else", () => {
  assert.equal(incidentRetentionClass({ requiresOshaReview: true, severity: "low", reportType: "near_miss" }), "osha");
  assert.equal(incidentRetentionClass({ requiresOshaReview: true, severity: "critical" }), "osha");
});

test("incidentRetentionClass: near_miss or low severity (no OSHA review) is minor", () => {
  assert.equal(incidentRetentionClass({ requiresOshaReview: false, reportType: "near_miss", severity: "medium" }), "minor");
  assert.equal(incidentRetentionClass({ requiresOshaReview: false, reportType: "incident", severity: "low" }), "minor");
});

test("incidentRetentionClass: everything else falls back to standard", () => {
  assert.equal(incidentRetentionClass({ requiresOshaReview: false, reportType: "accident", severity: "high" }), "standard");
  assert.equal(incidentRetentionClass({}), "standard");
});

test("retentionEligibleAt uses occurredAt as the anchor and the registry defaults when unconfigured", () => {
  const standard = retentionEligibleAt({ occurredAt: "2026-01-01T00:00:00Z", severity: "high" });
  assert.equal(standard.toISOString(), new Date(Date.UTC(2026, 0, 1) + 2555 * 86400000).toISOString());

  const osha = retentionEligibleAt({ occurredAt: "2026-01-01T00:00:00Z", requiresOshaReview: true });
  assert.equal(osha.toISOString(), new Date(Date.UTC(2026, 0, 1) + 1825 * 86400000).toISOString());

  const minor = retentionEligibleAt({ occurredAt: "2026-01-01T00:00:00Z", reportType: "near_miss" });
  assert.equal(minor.toISOString(), new Date(Date.UTC(2026, 0, 1) + 1095 * 86400000).toISOString());
});

test("retentionEligibleAt honors facility-configured retention days", () => {
  const eligible = retentionEligibleAt(
    { occurredAt: "2026-01-01T00:00:00Z", severity: "high" },
    { "incidents.retentionDaysStandard": 10 }
  );
  assert.equal(eligible.toISOString(), new Date(Date.UTC(2026, 0, 11)).toISOString());
});

test("retentionEligibleAt falls back to createdAt then reportedAt when occurredAt is absent", () => {
  const fromCreated = retentionEligibleAt({ createdAt: "2026-01-01T00:00:00Z", severity: "high" });
  assert.equal(fromCreated.toISOString(), new Date(Date.UTC(2026, 0, 1) + 2555 * 86400000).toISOString());

  const fromReported = retentionEligibleAt({ reportedAt: "2026-01-01T00:00:00Z", severity: "high" });
  assert.equal(fromReported.toISOString(), new Date(Date.UTC(2026, 0, 1) + 2555 * 86400000).toISOString());
});

test("retentionEligibleAt returns null when no anchor timestamp is available", () => {
  assert.equal(retentionEligibleAt({ severity: "high" }), null);
  assert.equal(retentionEligibleAt(null), null);
});

test("retentionEligibleAt is pure -- never reads the clock, deterministic for the same inputs", () => {
  const incident = { occurredAt: "2026-01-01T00:00:00Z", requiresOshaReview: true };
  const a = retentionEligibleAt(incident);
  const b = retentionEligibleAt(incident);
  assert.equal(a.toISOString(), b.toISOString());
});
