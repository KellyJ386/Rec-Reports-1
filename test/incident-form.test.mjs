import test from "node:test";
import assert from "node:assert/strict";
import {
  severityRequiresGating,
  validateIncidentCapture,
  buildIncidentCreatePayload,
  validateFollowupInput,
  buildFollowupPayload,
  validateAmendmentInput,
  buildAmendmentPayload,
  nextEscalationAction
} from "../src/public/js/incident-form.mjs";

test("severityRequiresGating is true only for high/critical", () => {
  assert.equal(severityRequiresGating("low"), false);
  assert.equal(severityRequiresGating("medium"), false);
  assert.equal(severityRequiresGating("high"), true);
  assert.equal(severityRequiresGating("critical"), true);
  assert.equal(severityRequiresGating(undefined), false);
});

test("validateIncidentCapture rejects missing base fields", () => {
  const result = validateIncidentCapture({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.reportType);
  assert.ok(result.errors.severity);
  assert.ok(result.errors.occurredAt);
  assert.ok(result.errors.locationText);
  assert.ok(result.errors.summary);
  assert.equal(result.errors.immediateActions, undefined);
});

test("validateIncidentCapture accepts a complete low-severity draft with no immediateActions", () => {
  const result = validateIncidentCapture({
    reportType: "incident",
    severity: "low",
    occurredAt: "2026-08-16T10:00:00Z",
    locationText: "Pool deck",
    summary: "Slip near the diving board"
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
});

test("validateIncidentCapture gates immediateActions for high/critical severity", () => {
  const base = {
    reportType: "accident",
    severity: "high",
    occurredAt: "2026-08-16T10:00:00Z",
    locationText: "Pool deck",
    summary: "Fall from ladder"
  };
  const missing = validateIncidentCapture(base);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.immediateActions);

  const whitespaceOnly = validateIncidentCapture({ ...base, immediateActions: "   " });
  assert.equal(whitespaceOnly.valid, false);
  assert.ok(whitespaceOnly.errors.immediateActions);

  const complete = validateIncidentCapture({ ...base, immediateActions: "Called EMS, cordoned area" });
  assert.equal(complete.valid, true);
});

test("validateIncidentCapture rejects unknown reportType/severity enum values", () => {
  const result = validateIncidentCapture({
    reportType: "unknown_type",
    severity: "extreme",
    occurredAt: "2026-08-16T10:00:00Z",
    locationText: "x",
    summary: "y"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.reportType);
  assert.ok(result.errors.severity);
});

test("buildIncidentCreatePayload trims strings and omits empty optional fields", () => {
  const payload = buildIncidentCreatePayload({
    reportType: "near_miss",
    severity: "low",
    occurredAt: "2026-08-16T10:00:00Z",
    locationText: "  Lobby  ",
    summary: "  Wet floor  ",
    immediateActions: "   "
  });
  assert.deepEqual(payload, {
    reportType: "near_miss",
    severity: "low",
    occurredAt: "2026-08-16T10:00:00Z",
    locationText: "Lobby",
    summary: "Wet floor"
  });
  assert.equal("immediateActions" in payload, false);
  assert.equal("requiresOshaReview" in payload, false);
});

test("buildIncidentCreatePayload includes optional flags only when true/set", () => {
  const payload = buildIncidentCreatePayload({
    reportType: "accident",
    severity: "critical",
    occurredAt: "2026-08-16T10:00:00Z",
    locationText: "Gym",
    summary: "Injury",
    immediateActions: "First aid administered",
    requiresOshaReview: true,
    legalHold: true,
    departmentId: "dept-1"
  });
  assert.equal(payload.requiresOshaReview, true);
  assert.equal(payload.legalHold, true);
  assert.equal(payload.departmentId, "dept-1");
  assert.equal(payload.immediateActions, "First aid administered");
});

test("validateFollowupInput requires a known actionType and a description", () => {
  const bad = validateFollowupInput({ actionType: "not_a_type", description: "" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.actionType);
  assert.ok(bad.errors.description);

  const good = validateFollowupInput({ actionType: "corrective_action", description: "Fix the rail" });
  assert.equal(good.valid, true);
});

test("buildFollowupPayload trims description and omits unset optional fields", () => {
  const payload = buildFollowupPayload({ actionType: "training", description: "  Retrain staff  " });
  assert.deepEqual(payload, { actionType: "training", description: "Retrain staff" });
});

test("validateAmendmentInput requires a reason and at least one amendable field", () => {
  assert.equal(validateAmendmentInput({}).valid, false);
  assert.equal(validateAmendmentInput({ reason: "x", patch: {} }).valid, false);
  assert.equal(
    validateAmendmentInput({ reason: "correcting", patch: { summary: "new summary" } }).valid,
    true
  );
});

test("validateAmendmentInput rejects patch keys outside the amendable allow-list", () => {
  const result = validateAmendmentInput({ reason: "x", patch: { status: "closed" } });
  assert.equal(result.valid, false);
  assert.match(result.errors.patch, /status/);
});

test("buildAmendmentPayload trims the reason and passes the patch through", () => {
  const payload = buildAmendmentPayload({ reason: "  clarifying  ", patch: { severity: "high" } });
  assert.deepEqual(payload, { reason: "clarifying", patch: { severity: "high" } });
});

test("nextEscalationAction maps pending->acknowledge, acknowledged->resolve, else null", () => {
  assert.equal(nextEscalationAction("pending"), "acknowledge");
  assert.equal(nextEscalationAction("acknowledged"), "resolve");
  assert.equal(nextEscalationAction("resolved"), null);
  assert.equal(nextEscalationAction("expired"), null);
});
