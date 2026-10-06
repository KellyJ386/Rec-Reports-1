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
  formatComplianceSummary,
  SHIFT_AUDIENCE_MODES,
  isEmergencyCompose,
  canRespondToEmergency,
  describeEmergencyLaunch,
  endOfDayIso
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

// --- CM-12: shift-window audience rows --------------------------------------------

test("a shift-window row needs no target id; an id-mode shift row still does", () => {
  assert.deepEqual(SHIFT_AUDIENCE_MODES, ["id", "current", "next"]);
  assert.equal(validateAudienceRows([{ audienceType: "shift", audienceRefId: "", shiftMode: "current" }]).valid, true);
  assert.equal(validateAudienceRows([{ audienceType: "shift", audienceRefId: "", shiftMode: "next" }]).valid, true);
  assert.equal(validateAudienceRows([{ audienceType: "shift", audienceRefId: "", shiftMode: "id" }]).valid, false);
  assert.equal(validateAudienceRows([{ audienceType: "shift", audienceRefId: "", shiftMode: undefined }]).valid, false);
  // A window mode on a non-shift row is meaningless and does not complete it.
  assert.equal(validateAudienceRows([{ audienceType: "role", audienceRefId: "", shiftMode: "current" }]).valid, false);
});

test("buildAudiencePayload sends a shift window in rule and omits the target id", () => {
  const payload = buildAudiencePayload([
    { audienceType: "shift", audienceRefId: "", shiftMode: "current" },
    { audienceType: "shift", audienceRefId: "shift-9", shiftMode: "id" },
    { audienceType: "shift", audienceRefId: "ignored-when-window", shiftMode: "next" },
    { audienceType: "department", audienceRefId: "dept-1" }
  ]);
  assert.deepEqual(payload, [
    { audienceType: "shift", rule: { window: "current" } },
    { audienceType: "shift", audienceRefId: "shift-9" },
    { audienceType: "shift", rule: { window: "next" } },
    { audienceType: "department", audienceRefId: "dept-1" }
  ]);
});

// --- CM-13: emergency compose / respond -------------------------------------------------

test("isEmergencyCompose is true only for the emergency priority", () => {
  assert.equal(isEmergencyCompose({ priority: "emergency" }), true);
  assert.equal(isEmergencyCompose({ priority: "urgent" }), false);
  assert.equal(isEmergencyCompose({}), false);
});

test("canRespondToEmergency: a published emergency message the viewer has not answered", () => {
  const published = { priority: "emergency", published_at: "2026-08-13T12:00:00Z" };
  assert.equal(canRespondToEmergency(published, null), true);
  assert.equal(canRespondToEmergency(published, "safe"), false);
  assert.equal(canRespondToEmergency({ ...published, published_at: null }, null), false);
  assert.equal(canRespondToEmergency({ ...published, priority: "urgent" }, null), false);
  assert.equal(canRespondToEmergency(null, null), false);
});

test("M-5: an acknowledgement due date in the past is refused before the server has to", () => {
  const base = { channelId: "c", subject: "s", bodyText: "b", isRequiredAck: true };
  const now = new Date("2026-10-06T12:00:00Z");
  assert.equal(validateComposeInput({ ...base, ackDueAt: "2026-10-05T12:00:00Z" }, now).errors.ackDueAt, "Acknowledgement due date must be in the future.");
  assert.equal(validateComposeInput({ ...base, ackDueAt: "2026-10-06T12:00:00Z" }, now).valid, false, "due exactly now is not in the future");
  assert.equal(validateComposeInput({ ...base, ackDueAt: "2026-10-07T12:00:00Z" }, now).valid, true);
  // Only a REQUIRED acknowledgement has a due date that matters.
  assert.equal(validateComposeInput({ ...base, isRequiredAck: false, ackDueAt: "2026-10-05T12:00:00Z" }, now).valid, true);
  // No due date at all is fine.
  assert.equal(validateComposeInput(base, now).valid, true);
});

test("endOfDayIso turns a date input into the end of that day, so 'due today' is still in the future", () => {
  const iso = endOfDayIso("2026-10-07");
  const parsed = new Date(iso);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 7);
  assert.equal(parsed.getHours(), 23);
  assert.equal(parsed.getMinutes(), 59);
  assert.equal(endOfDayIso(""), "");
  assert.equal(endOfDayIso("not a date"), "");
  assert.equal(endOfDayIso("2026-13-45T00:00"), "");
  assert.equal(endOfDayIso(undefined), "");
});

const QUEUE_ROW = {
  id: "l-1",
  message_id: "m-1",
  messages: { subject: "Severe weather", priority: "emergency", body_text: "Move indoors now" },
  preview: { recipientCount: 42, unresolvedAudiences: 0 },
  contentChanged: false
};

test("M-3: the approver is shown the body and the recipient count, not just the subject", () => {
  const view = describeEmergencyLaunch(QUEUE_ROW);
  assert.equal(view.subject, "Severe weather");
  assert.equal(view.bodyText, "Move indoors now");
  assert.equal(view.recipientCount, 42);
  assert.match(view.recipientLine, /42 people/);
  assert.match(view.recipientLine, /every channel/);
  assert.match(view.recipientLine, /quiet hours/);
  assert.equal(view.canApprove, true);
  assert.equal(view.warning, null);
  // The confirmation dialog carries all three.
  assert.match(view.confirmText, /Severe weather/);
  assert.match(view.confirmText, /Move indoors now/);
  assert.match(view.confirmText, /42 people/);
  assert.equal(describeEmergencyLaunch({ ...QUEUE_ROW, preview: { recipientCount: 1 } }).recipientLine.startsWith("It will reach 1 person "), true);
});

test("M-3: a launch whose content changed, or that reaches nobody, cannot be approved from the UI", () => {
  const changed = describeEmergencyLaunch({ ...QUEUE_ROW, contentChanged: true });
  assert.equal(changed.canApprove, false);
  assert.match(changed.warning, /changed after the launch was requested/);
  const nobody = describeEmergencyLaunch({ ...QUEUE_ROW, preview: { recipientCount: 0, unresolvedAudiences: 2 } });
  assert.equal(nobody.canApprove, false);
  assert.match(nobody.recipientLine, /reaches nobody/);
  assert.match(nobody.recipientLine, /2 shift audiences have no window/);
  // An unknown count is shown as unknown, and does not block (the server decides).
  const unknown = describeEmergencyLaunch({ ...QUEUE_ROW, preview: null });
  assert.equal(unknown.recipientCount, null);
  assert.equal(unknown.canApprove, true);
  assert.match(unknown.recipientLine, /not known/);
});

test("describeEmergencyLaunch tolerates a bare row and truncates a long body in the dialog", () => {
  const bare = describeEmergencyLaunch({ id: "l", message_id: "m" });
  assert.equal(bare.subject, "this alert");
  assert.equal(bare.bodyText, "");
  const long = describeEmergencyLaunch({ ...QUEUE_ROW, messages: { subject: "s", body_text: "x".repeat(900) } });
  assert.equal(long.bodyText.length, 900);
  assert.ok(long.confirmText.includes("x".repeat(500) + "..."));
  assert.ok(!long.confirmText.includes("x".repeat(501)));
});
