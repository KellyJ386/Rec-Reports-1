import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeIncidentTimeline,
  evaluateClosureGatePreview,
  SIGNATURE_ROLES,
  validateSignatureInput,
  buildSignaturePayload,
  COMPLIANCE_CHECK_KEYS,
  COMPLIANCE_CHECK_STATUSES,
  validateComplianceCheckInput,
  complianceCheckStatusOptions,
  buildCompliancePayload,
  nextOshaQuestion,
  buildOshaEvaluationPayload
} from "../src/public/js/incident-review.mjs";

// --- mergeIncidentTimeline ----------------------------------------------------

test("mergeIncidentTimeline merges audit events and amendments into one chronological array", () => {
  const auditEvents = [
    { id: 1, created_at: "2026-07-01T00:00:00Z", event_type: "incident.created", actor_user_id: "u1", event_payload: {} },
    { id: 3, created_at: "2026-07-03T00:00:00Z", event_type: "incident.submitted", actor_user_id: "u1", event_payload: {} }
  ];
  const amendments = [
    { id: "a1", amended_at: "2026-07-02T00:00:00Z", amendment_reason: "correction", amended_by: "u2" }
  ];
  const merged = mergeIncidentTimeline(auditEvents, amendments);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((e) => e.at),
    ["2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", "2026-07-03T00:00:00Z"]
  );
  assert.deepEqual(
    merged.map((e) => e.kind),
    ["audit", "amendment", "audit"]
  );
  assert.ok(merged.every((e) => e.immutable === true));
});

test("mergeIncidentTimeline handles empty/missing inputs", () => {
  assert.deepEqual(mergeIncidentTimeline(), []);
  assert.deepEqual(mergeIncidentTimeline([], []), []);
  assert.deepEqual(mergeIncidentTimeline(undefined, undefined), []);
});

test("mergeIncidentTimeline preserves audit-before-amendment ordering for entries at the exact same instant", () => {
  const auditEvents = [{ id: 1, created_at: "2026-07-01T00:00:00Z", event_type: "incident.status_changed" }];
  const amendments = [{ id: "a1", amended_at: "2026-07-01T00:00:00Z", amendment_reason: "same instant" }];
  const merged = mergeIncidentTimeline(auditEvents, amendments);
  assert.deepEqual(
    merged.map((e) => e.kind),
    ["audit", "amendment"]
  );
});

test("mergeIncidentTimeline surfaces eventType/actorUserId/payload uniformly across both kinds", () => {
  const merged = mergeIncidentTimeline(
    [{ id: 1, created_at: "2026-07-01T00:00:00Z", event_type: "incident.escalated", actor_user_id: "u1", event_payload: { level: 1 } }],
    [{ id: "a1", amended_at: "2026-07-02T00:00:00Z", amendment_reason: "why", amended_by: "u2" }]
  );
  assert.equal(merged[0].eventType, "incident.escalated");
  assert.equal(merged[0].actorUserId, "u1");
  assert.deepEqual(merged[0].payload, { level: 1 });
  assert.equal(merged[1].eventType, "incident.amended");
  assert.equal(merged[1].actorUserId, "u2");
  assert.deepEqual(merged[1].payload, { reason: "why" });
});

// --- evaluateClosureGatePreview ------------------------------------------------

test("evaluateClosureGatePreview allows a low/medium-severity, non-OSHA incident unconditionally", () => {
  assert.deepEqual(evaluateClosureGatePreview({ severity: "medium", requires_osha_review: false }, []), {
    allowed: true,
    blockingCheck: null,
    reason: null
  });
});

test("evaluateClosureGatePreview blocks a high/critical incident with no evidence_complete check, names the check", () => {
  for (const severity of ["high", "critical"]) {
    const gate = evaluateClosureGatePreview({ severity, requires_osha_review: false }, []);
    assert.equal(gate.allowed, false);
    assert.equal(gate.blockingCheck, "evidence_complete");
  }
});

test("evaluateClosureGatePreview allows once evidence_complete passes or is waived", () => {
  assert.equal(
    evaluateClosureGatePreview({ severity: "high", requires_osha_review: false }, [
      { check_key: "evidence_complete", status: "pass" }
    ]).allowed,
    true
  );
  assert.equal(
    evaluateClosureGatePreview({ severity: "critical", requires_osha_review: false }, [
      { check_key: "evidence_complete", status: "waived" }
    ]).allowed,
    true
  );
});

test("evaluateClosureGatePreview additionally requires supervisor_signoff when requires_osha_review, independent of severity", () => {
  const gate = evaluateClosureGatePreview({ severity: "low", requires_osha_review: true }, []);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockingCheck, "supervisor_signoff");
});

// --- Signatures (IN-13) -------------------------------------------------------

test("SIGNATURE_ROLES matches the design doc's fixed vocabulary", () => {
  assert.deepEqual(SIGNATURE_ROLES, ["reporter", "witness", "supervisor", "manager"]);
});

test("validateSignatureInput rejects a missing/unknown role, blank attestation, blank signedName", () => {
  const missing = validateSignatureInput({});
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.role);
  assert.ok(missing.errors.attestationText);
  assert.ok(missing.errors.signedName);

  const badRole = validateSignatureInput({ role: "ceo", attestationText: "I attest", signedName: "A" });
  assert.equal(badRole.valid, false);
  assert.ok(badRole.errors.role);
});

test("validateSignatureInput rejects an attestation over 2000 characters", () => {
  const result = validateSignatureInput({ role: "witness", attestationText: "a".repeat(2001), signedName: "A" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.attestationText);
});

test("validateSignatureInput accepts a well-formed signature", () => {
  const result = validateSignatureInput({ role: "supervisor", attestationText: "I attest this is accurate.", signedName: "Jamie Rivera" });
  assert.equal(result.valid, true);
});

test("buildSignaturePayload trims text fields and omits signatureImagePath when absent", () => {
  const payload = buildSignaturePayload({ role: "witness", attestationText: "  I saw it.  ", signedName: "  Jamie  " });
  assert.deepEqual(payload, { role: "witness", attestationText: "I saw it.", signedName: "Jamie" });
});

test("buildSignaturePayload includes signatureImagePath when present", () => {
  const payload = buildSignaturePayload({
    role: "witness",
    attestationText: "I saw it.",
    signedName: "Jamie",
    signatureImagePath: "facilities/fac-1/incidents/inc-1/x.png"
  });
  assert.equal(payload.signatureImagePath, "facilities/fac-1/incidents/inc-1/x.png");
});

// --- Compliance checks (IN-15) -------------------------------------------------

test("COMPLIANCE_CHECK_KEYS/STATUSES match the design doc's fixed vocabularies", () => {
  assert.deepEqual(COMPLIANCE_CHECK_KEYS, ["evidence_complete", "supervisor_signoff", "osha_recordability", "legal_review"]);
  assert.deepEqual(COMPLIANCE_CHECK_STATUSES, ["pass", "fail", "waived"]);
});

test("validateComplianceCheckInput rejects an unknown checkKey/status", () => {
  const result = validateComplianceCheckInput({ checkKey: "not_real", status: "maybe" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.checkKey);
  assert.ok(result.errors.status);
});

test("validateComplianceCheckInput accepts a valid combination", () => {
  assert.equal(validateComplianceCheckInput({ checkKey: "evidence_complete", status: "pass" }).valid, true);
});

test("complianceCheckStatusOptions excludes 'waived' unless canWaive is true", () => {
  assert.deepEqual(complianceCheckStatusOptions(false), ["pass", "fail"]);
  assert.deepEqual(complianceCheckStatusOptions(true), ["pass", "fail", "waived"]);
  assert.deepEqual(complianceCheckStatusOptions(), ["pass", "fail"]);
});

test("buildCompliancePayload omits notes when blank, includes when present", () => {
  assert.deepEqual(buildCompliancePayload({ checkKey: "evidence_complete", status: "pass" }), {
    checkKey: "evidence_complete",
    status: "pass"
  });
  assert.deepEqual(buildCompliancePayload({ checkKey: "evidence_complete", status: "pass", notes: "  looks good  " }), {
    checkKey: "evidence_complete",
    status: "pass",
    notes: "looks good"
  });
});

// --- OSHA questionnaire walker (IN-14) -----------------------------------------

const TEST_TREE = {
  start: "fatality",
  nodes: {
    fatality: { question: "Fatality?", yes: { outcome: "recordable" }, no: "hospitalization" },
    hospitalization: { question: "Hospitalization?", yes: { outcome: "recordable" }, no: { outcome: "not_work_related" } }
  }
};

test("nextOshaQuestion returns the start question with no answers yet", () => {
  const result = nextOshaQuestion(TEST_TREE, {});
  assert.equal(result.done, false);
  assert.equal(result.nodeId, "fatality");
  assert.equal(result.question, "Fatality?");
});

test("nextOshaQuestion advances to the next question as answers accumulate", () => {
  const result = nextOshaQuestion(TEST_TREE, { fatality: "no" });
  assert.equal(result.done, false);
  assert.equal(result.nodeId, "hospitalization");
});

test("nextOshaQuestion reports done + outcome once a terminal leaf is reached", () => {
  const result = nextOshaQuestion(TEST_TREE, { fatality: "no", hospitalization: "no" });
  assert.equal(result.done, true);
  assert.equal(result.outcome, "not_work_related");
  assert.equal(result.path.length, 2);
});

test("nextOshaQuestion falls back safely on a malformed/missing tree", () => {
  for (const badTree of [null, undefined, {}, "nope"]) {
    const result = nextOshaQuestion(badTree, {});
    assert.equal(result.done, true);
    assert.equal(result.outcome, "needs_more_info");
    assert.equal(result.malformed, true);
  }
});

test("nextOshaQuestion is deterministic for the same tree/answers", () => {
  const answers = { fatality: "no" };
  assert.deepEqual(nextOshaQuestion(TEST_TREE, answers), nextOshaQuestion(TEST_TREE, answers));
});

test("buildOshaEvaluationPayload wraps answers as-is under { answers }", () => {
  assert.deepEqual(buildOshaEvaluationPayload({ fatality: "yes" }), { answers: { fatality: "yes" } });
  assert.deepEqual(buildOshaEvaluationPayload(), { answers: {} });
});
