import test from "node:test";
import assert from "node:assert/strict";
import {
  validateComposeInput,
  buildComposePayload,
  validateAudienceRows,
  buildAudiencePayload,
  deriveAckState
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
