import test from "node:test";
import assert from "node:assert/strict";
import {
  validateComposeInput,
  buildComposePayload,
  validateAudienceRows,
  buildAudiencePayload,
  deriveAckState,
  ackedMessageIdsFromRows,
  shouldFetchCompliance,
  formatComplianceSummary
} from "../src/public/js/comms-compose.mjs";

test("validateComposeInput requires channel, subject, body", () => {
  const bad = validateComposeInput({});
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.channelId);
  assert.ok(bad.errors.subject);
  assert.ok(bad.errors.bodyText);

  const good = validateComposeInput({ channelId: "chan-1", subject: "Heads up", bodyText: "Pool closed" });
  assert.equal(good.valid, true);
});

test("validateComposeInput rejects an unknown priority", () => {
  const result = validateComposeInput({
    channelId: "chan-1",
    subject: "s",
    bodyText: "b",
    priority: "critical"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.priority);
});

test("validateComposeInput rejects an invalid ackDueAt only when ack is required", () => {
  const ignored = validateComposeInput({
    channelId: "chan-1",
    subject: "s",
    bodyText: "b",
    isRequiredAck: false,
    ackDueAt: "not-a-date"
  });
  assert.equal(ignored.valid, true);

  const flagged = validateComposeInput({
    channelId: "chan-1",
    subject: "s",
    bodyText: "b",
    isRequiredAck: true,
    ackDueAt: "not-a-date"
  });
  assert.equal(flagged.valid, false);
  assert.ok(flagged.errors.ackDueAt);
});

test("buildComposePayload trims text, defaults priority, and omits ackDueAt when ack isn't required", () => {
  const payload = buildComposePayload({
    channelId: "chan-1",
    subject: "  Heads up  ",
    bodyText: "  Pool closed  ",
    isRequiredAck: false,
    ackDueAt: "2026-08-20T00:00:00Z"
  });
  assert.deepEqual(payload, {
    channelId: "chan-1",
    subject: "Heads up",
    bodyText: "Pool closed",
    priority: "normal",
    isRequiredAck: false
  });
});

test("buildComposePayload includes ackDueAt only when isRequiredAck and set", () => {
  const payload = buildComposePayload({
    channelId: "chan-1",
    subject: "s",
    bodyText: "b",
    priority: "urgent",
    isRequiredAck: true,
    ackDueAt: "2026-08-20T00:00:00Z"
  });
  assert.equal(payload.ackDueAt, "2026-08-20T00:00:00Z");
  assert.equal(payload.priority, "urgent");
  assert.equal(payload.isRequiredAck, true);
});

test("validateAudienceRows rejects an empty list and a half-filled row", () => {
  assert.equal(validateAudienceRows([]).valid, false);
  assert.equal(validateAudienceRows([{ audienceType: "department", audienceRefId: "" }]).valid, false);
  assert.equal(validateAudienceRows([{ audienceType: "", audienceRefId: "dept-1" }]).valid, false);
});

test("validateAudienceRows accepts at least one complete row, ignoring untouched blank rows", () => {
  const result = validateAudienceRows([
    { audienceType: "", audienceRefId: "" },
    { audienceType: "department", audienceRefId: "dept-1" }
  ]);
  assert.equal(result.valid, true);
});

test("buildAudiencePayload drops incomplete rows and unknown types", () => {
  const rows = [
    { audienceType: "department", audienceRefId: "dept-1" },
    { audienceType: "", audienceRefId: "" },
    { audienceType: "role", audienceRefId: "" },
    { audienceType: "not_a_type", audienceRefId: "x" },
    { audienceType: "employee", audienceRefId: "emp-1" }
  ];
  assert.deepEqual(buildAudiencePayload(rows), [
    { audienceType: "department", audienceRefId: "dept-1" },
    { audienceType: "employee", audienceRefId: "emp-1" }
  ]);
});

test("deriveAckState returns not_required when the message doesn't require ack", () => {
  assert.equal(deriveAckState({ isRequiredAck: false }), "not_required");
});

test("deriveAckState returns complete when the current viewer already acknowledged", () => {
  assert.equal(deriveAckState({ isRequiredAck: true, ackedByMe: true }), "complete");
  // complete wins even if ackDueAt has already passed.
  assert.equal(
    deriveAckState(
      { isRequiredAck: true, ackedByMe: true, ackDueAt: "2020-01-01T00:00:00Z" },
      new Date("2026-01-01T00:00:00Z")
    ),
    "complete"
  );
});

test("deriveAckState returns overdue when ackDueAt has passed and not yet acknowledged", () => {
  const state = deriveAckState(
    { isRequiredAck: true, ackedByMe: false, ackDueAt: "2020-01-01T00:00:00Z" },
    new Date("2026-01-01T00:00:00Z")
  );
  assert.equal(state, "overdue");
});

test("deriveAckState returns pending when required, unacknowledged, and not yet due", () => {
  const state = deriveAckState(
    { isRequiredAck: true, ackedByMe: false, ackDueAt: "2030-01-01T00:00:00Z" },
    new Date("2026-01-01T00:00:00Z")
  );
  assert.equal(state, "pending");
});

test("deriveAckState returns pending when required with no ackDueAt at all", () => {
  assert.equal(deriveAckState({ isRequiredAck: true, ackedByMe: false }), "pending");
});

// --- ackedMessageIdsFromRows (P-1) -------------------------------------------

test("ackedMessageIdsFromRows builds a Set of message ids from live snake_case rows", () => {
  const rows = [{ id: "ack-1", message_id: "msg-1" }, { id: "ack-2", message_id: "msg-2" }];
  assert.deepEqual(ackedMessageIdsFromRows(rows), new Set(["msg-1", "msg-2"]));
});

test("ackedMessageIdsFromRows also accepts camelCase rows", () => {
  assert.deepEqual(ackedMessageIdsFromRows([{ messageId: "msg-1" }]), new Set(["msg-1"]));
});

test("ackedMessageIdsFromRows returns an empty Set for an empty/undefined response", () => {
  assert.deepEqual(ackedMessageIdsFromRows([]), new Set());
  assert.deepEqual(ackedMessageIdsFromRows(undefined), new Set());
});

// --- shouldFetchCompliance (P-1) ---------------------------------------------

test("shouldFetchCompliance is true for any message when the viewer holds communications.publish", () => {
  assert.equal(
    shouldFetchCompliance({ id: "msg-1", author_employee_id: "emp-other" }, { canPublish: true, myEmployeeId: "emp-me" }),
    true
  );
});

test("shouldFetchCompliance is true when the viewer is the message's own author, even without publish", () => {
  assert.equal(
    shouldFetchCompliance(
      { id: "msg-1", author_employee_id: "emp-me" },
      { canPublish: false, myEmployeeId: "emp-me" }
    ),
    true
  );
});

test("shouldFetchCompliance is false for someone else's message when the viewer can't publish", () => {
  assert.equal(
    shouldFetchCompliance(
      { id: "msg-1", author_employee_id: "emp-other" },
      { canPublish: false, myEmployeeId: "emp-me" }
    ),
    false
  );
});

test("shouldFetchCompliance is false with no resolved employee id and no publish permission", () => {
  assert.equal(
    shouldFetchCompliance({ id: "msg-1", author_employee_id: "emp-other" }, { canPublish: false, myEmployeeId: null }),
    false
  );
});

test("shouldFetchCompliance accepts the camelCase authorEmployeeId shape too", () => {
  assert.equal(
    shouldFetchCompliance({ id: "msg-1", authorEmployeeId: "emp-me" }, { canPublish: false, myEmployeeId: "emp-me" }),
    true
  );
});

test("shouldFetchCompliance is false for a missing message", () => {
  assert.equal(shouldFetchCompliance(null, { canPublish: true }), false);
});

// --- formatComplianceSummary (P-1) -------------------------------------------

test("formatComplianceSummary reports acknowledged/total with no overdue clause when overdue is zero", () => {
  assert.equal(
    formatComplianceSummary({ delivered: 3, read: 3, acknowledged: 2, pending: 1, overdue: 0, total: 3 }),
    "2/3 acknowledged"
  );
});

test("formatComplianceSummary appends the overdue count when nonzero", () => {
  assert.equal(
    formatComplianceSummary({ delivered: 3, read: 3, acknowledged: 1, pending: 2, overdue: 1, total: 3 }),
    "1/3 acknowledged, 1 overdue"
  );
});

test("formatComplianceSummary returns an empty string for a missing or malformed rollup", () => {
  assert.equal(formatComplianceSummary(null), "");
  assert.equal(formatComplianceSummary(undefined), "");
  assert.equal(formatComplianceSummary({}), "");
});
