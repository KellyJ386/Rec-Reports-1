import test from "node:test";
import assert from "node:assert/strict";
import {
  ACK_ESCALATION_TIERS,
  MAX_ACK_ESCALATION_LEVEL,
  buildAckEscalationLadder,
  ackEscalationDueLevel,
  nextAckEscalationStep,
  outstandingAckEmployeeIds,
  summarizeEmergencyResponses,
  isEmergencyResponse,
  summarizeInbox,
  shouldBypassQuietHours,
  shouldBypassQuietHoursForEscalation,
  ackEscalationAnchor,
  ackEscalationNextDueAt,
  serializeShiftWindow,
  normalizeShiftWindow,
  audienceShiftWindow
} from "../src/lib/communications.mjs";
import { getDefinition, validateSettingValue } from "../src/lib/settings-registry.mjs";

const DUE = "2026-08-10T12:00:00Z";
const H = 3_600_000;
const at = (hoursAfterDue) => new Date(new Date(DUE).getTime() + hoursAfterDue * H);

function message(overrides = {}) {
  return {
    id: "m-1",
    is_required_ack: true,
    ack_due_at: DUE,
    published_at: "2026-08-08T12:00:00Z",
    ack_escalation_level: 0,
    ...overrides
  };
}

// --- CM-10: ladder ---------------------------------------------------------------

test("the default ladder is reminder at T+0, supervisor at T+24h, manager at T+48h", () => {
  const ladder = buildAckEscalationLadder();
  assert.deepEqual(
    ladder.map((tier) => [tier.level, tier.tier, tier.eventCode, tier.afterHours]),
    [
      [1, "reminder", "message.ack_overdue", 0],
      [2, "supervisor", "message.ack_escalated_supervisor", 24],
      [3, "manager", "message.ack_escalated_manager", 48]
    ]
  );
  assert.equal(MAX_ACK_ESCALATION_LEVEL, ACK_ESCALATION_TIERS.length);
});

test("ladder offsets come from the facility config and are clamped non-decreasing", () => {
  const config = {
    "communications.ackReminderAfterHours": 6,
    "communications.ackSupervisorAfterHours": 2, // earlier than the reminder: clamped up to 6
    "communications.ackManagerAfterHours": 30
  };
  assert.deepEqual(buildAckEscalationLadder(config).map((tier) => tier.afterHours), [6, 6, 30]);
  // A malformed value falls back to the registry default instead of reordering the ladder.
  const bad = buildAckEscalationLadder({ "communications.ackSupervisorAfterHours": "soon" });
  assert.deepEqual(bad.map((tier) => tier.afterHours), [0, 24, 48]);
  assert.deepEqual(buildAckEscalationLadder({ "communications.ackSupervisorAfterHours": -5 }).map((tier) => tier.afterHours), [0, 24, 48]);
});

test("ackEscalationDueLevel steps through the ladder against a fixed clock", () => {
  const m = message();
  assert.equal(ackEscalationDueLevel(m, at(-1)), 0); // before the deadline
  assert.equal(ackEscalationDueLevel(m, at(0)), 1); // deadline is inclusive
  assert.equal(ackEscalationDueLevel(m, at(23.99)), 1);
  assert.equal(ackEscalationDueLevel(m, at(24)), 2);
  assert.equal(ackEscalationDueLevel(m, at(47)), 2);
  assert.equal(ackEscalationDueLevel(m, at(48)), 3);
  assert.equal(ackEscalationDueLevel(m, at(500)), 3);
});

test("ackEscalationDueLevel is 0 for anything that is not a published required-ack message with a due time", () => {
  assert.equal(ackEscalationDueLevel(message({ is_required_ack: false }), at(100)), 0);
  assert.equal(ackEscalationDueLevel(message({ published_at: null }), at(100)), 0);
  assert.equal(ackEscalationDueLevel(message({ ack_due_at: null }), at(100)), 0);
  assert.equal(ackEscalationDueLevel(message({ ack_due_at: "garbage" }), at(100)), 0);
  // camelCase accessors work too.
  assert.equal(ackEscalationDueLevel({ isRequiredAck: true, ackDueAt: DUE, publishedAt: "2026-08-08T00:00:00Z" }, at(25)), 2);
});

test("nextAckEscalationStep returns exactly the next tier, never skipping a level after an outage", () => {
  assert.equal(nextAckEscalationStep(message(), at(-1)), null);
  assert.equal(nextAckEscalationStep(message(), at(0)).level, 1);
  // 100 hours in, level 0: only level 1 is processed this pass.
  assert.equal(nextAckEscalationStep(message(), at(100)).level, 1);
  assert.equal(nextAckEscalationStep(message({ ack_escalation_level: 1 }), at(100)).level, 2);
  assert.equal(nextAckEscalationStep(message({ ack_escalation_level: 2 }), at(100)).level, 3);
  // Done at the top, and not yet due for the next one.
  assert.equal(nextAckEscalationStep(message({ ack_escalation_level: 3 }), at(500)), null);
  assert.equal(nextAckEscalationStep(message({ ack_escalation_level: 1 }), at(10)), null);
});

test("nextAckEscalationStep honors a custom ladder", () => {
  const ladder = buildAckEscalationLadder({
    "communications.ackReminderAfterHours": 1,
    "communications.ackSupervisorAfterHours": 2,
    "communications.ackManagerAfterHours": 3
  });
  assert.equal(nextAckEscalationStep(message(), at(0.5), ladder), null);
  assert.equal(nextAckEscalationStep(message(), at(1), ladder).level, 1);
  assert.equal(nextAckEscalationStep(message({ ack_escalation_level: 2 }), at(3), ladder).level, 3);
});

test("outstandingAckEmployeeIds drops acknowledged and waived employees, dedupes and sorts", () => {
  const outstanding = outstandingAckEmployeeIds(
    ["e-3", "e-1", "e-2", "e-1", "e-4", null],
    [
      { employee_id: "e-1", acknowledged_at: "2026-08-10T10:00:00Z", ack_state: "acknowledged" },
      { employee_id: "e-2", ack_state: "waived" },
      { employee_id: "e-4", ack_state: "pending", acknowledged_at: null }
    ]
  );
  assert.deepEqual(outstanding, ["e-3", "e-4"]);
  assert.deepEqual(outstandingAckEmployeeIds([], []), []);
});

test("the ladder's quiet-hours bypass follows shouldBypassQuietHours (urgent/emergency only)", () => {
  assert.equal(shouldBypassQuietHours({ priority: "emergency" }), true);
  assert.equal(shouldBypassQuietHours({ priority: "normal" }), false);
  assert.equal(shouldBypassQuietHours({ priority: "low" }), false);
});

test("the five new communications settings are registered with the documented defaults and validate", () => {
  const expected = {
    "communications.ackEscalationEnabled": true,
    "communications.ackReminderAfterHours": 0,
    "communications.ackSupervisorAfterHours": 24,
    "communications.ackManagerAfterHours": 48,
    "communications.emergencyRequiresSecondApprover": true
  };
  for (const [key, value] of Object.entries(expected)) {
    const definition = getDefinition(key);
    assert.ok(definition, `${key} is registered`);
    assert.equal(definition.module, "communications");
    assert.equal(definition.default, value);
    assert.equal(validateSettingValue(key, value).valid, true);
  }
  assert.equal(validateSettingValue("communications.ackManagerAfterHours", -1).valid, false);
  assert.equal(validateSettingValue("communications.ackManagerAfterHours", 721).valid, false);
  assert.equal(validateSettingValue("communications.ackEscalationEnabled", "yes").valid, false);
});

// --- CM-13: emergency roll-up -------------------------------------------------------

test("isEmergencyResponse accepts only safe / need_help", () => {
  assert.equal(isEmergencyResponse("safe"), true);
  assert.equal(isEmergencyResponse("need_help"), true);
  assert.equal(isEmergencyResponse("ok"), false);
  assert.equal(isEmergencyResponse(undefined), false);
});

test("summarizeEmergencyResponses buckets the audience into safe / need help / no response", () => {
  const summary = summarizeEmergencyResponses(
    ["e-1", "e-2", "e-3", "e-4"],
    [
      { employee_id: "e-1", response: "safe" },
      { employee_id: "e-2", response: "need_help" },
      { employee_id: "e-9", response: "safe" }, // outside the audience snapshot
      { employee_id: "e-3", response: "bogus" } // ignored
    ]
  );
  assert.equal(summary.total, 4);
  assert.equal(summary.safe, 1);
  assert.equal(summary.needHelp, 1);
  assert.equal(summary.noResponse, 2);
  assert.equal(summary.outsideAudience, 1);
  assert.deepEqual(summary.needHelpEmployeeIds, ["e-2"]);
  assert.deepEqual(summary.noResponseEmployeeIds, ["e-3", "e-4"]);
});

test("summarizeEmergencyResponses: the last response per employee wins and an empty audience is all zeros", () => {
  const flipped = summarizeEmergencyResponses(["e-1"], [
    { employee_id: "e-1", response: "need_help" },
    { employee_id: "e-1", response: "safe" }
  ]);
  assert.equal(flipped.safe, 1);
  assert.equal(flipped.needHelp, 0);
  const empty = summarizeEmergencyResponses([], []);
  assert.deepEqual([empty.total, empty.safe, empty.needHelp, empty.noResponse], [0, 0, 0, 0]);
});

// --- CM-16: inbox summary ------------------------------------------------------------

const NOW = new Date("2026-08-13T12:00:00Z");

test("summarizeInbox counts unread, pending and overdue acknowledgements and the next due time", () => {
  const summary = summarizeInbox(
    {
      messages: [
        { id: "m1", published_at: "2026-08-13T08:00:00Z", priority: "normal" },
        { id: "m2", published_at: "2026-08-13T09:00:00Z", priority: "normal", is_required_ack: true, ack_due_at: "2026-08-12T00:00:00Z" },
        { id: "m3", published_at: "2026-08-13T10:00:00Z", priority: "normal", is_required_ack: true, ack_due_at: "2026-08-20T00:00:00Z" },
        { id: "m4", published_at: "2026-08-13T11:00:00Z", priority: "normal", is_required_ack: true, ack_due_at: "2026-08-21T00:00:00Z" },
        { id: "draft", published_at: null, priority: "normal", is_required_ack: true }
      ],
      readMessageIds: ["m1"],
      ackedMessageIds: ["m4"]
    },
    NOW
  );
  assert.equal(summary.unreadCount, 3);
  assert.deepEqual(summary.pendingAcks, { count: 2, overdueCount: 1, nextDueAt: "2026-08-12T00:00:00.000Z" });
  assert.equal(summary.latestEmergency, null);
});

test("summarizeInbox surfaces the latest emergency alert inside the 72h window with my response", () => {
  const messages = [
    { id: "e-old", subject: "Old", published_at: "2026-08-01T00:00:00Z", priority: "emergency" },
    { id: "e-1", subject: "Evacuate", body_text: "Go to the field", published_at: "2026-08-13T01:00:00Z", priority: "emergency" },
    { id: "e-2", subject: "Shelter", published_at: "2026-08-13T11:00:00Z", priority: "emergency" }
  ];
  const latest = summarizeInbox({ messages }, NOW).latestEmergency;
  assert.equal(latest.messageId, "e-2");
  assert.equal(latest.myResponse, null);
  const responded = summarizeInbox({ messages, emergencyResponses: [{ message_id: "e-2", response: "safe" }] }, NOW).latestEmergency;
  assert.equal(responded.myResponse, "safe");
  // Nothing inside the window -> no banner.
  assert.equal(summarizeInbox({ messages: [messages[0]] }, NOW).latestEmergency, null);
});

test("summarizeInbox on an empty inbox is all zeros", () => {
  assert.deepEqual(summarizeInbox({}, NOW), {
    unreadCount: 0,
    pendingAcks: { count: 0, overdueCount: 0, nextDueAt: null },
    latestEmergency: null
  });
});

// --- L-1: the ladder is anchored on the later of the due time and the publish time -------------

test("L-1: a due time before the publish time anchors the ladder on the publish time", () => {
  const published = "2026-08-12T12:00:00Z";
  const stale = message({ ack_due_at: "2026-08-01T00:00:00Z", published_at: published });
  assert.equal(ackEscalationAnchor(stale).toISOString(), "2026-08-12T12:00:00.000Z");
  const publishedMs = new Date(published).getTime();
  // Without the anchor all three tiers would be due at once, because the stale due time is eleven days old.
  assert.equal(ackEscalationDueLevel(stale, new Date(publishedMs), buildAckEscalationLadder()), 1);
  assert.equal(ackEscalationDueLevel(stale, new Date(publishedMs + 23 * H), buildAckEscalationLadder()), 1);
  assert.equal(ackEscalationDueLevel(stale, new Date(publishedMs + 24 * H), buildAckEscalationLadder()), 2);
  assert.equal(ackEscalationDueLevel(stale, new Date(publishedMs - 1), buildAckEscalationLadder()), 0, "never before the publish time");
  assert.equal(nextAckEscalationStep(stale, new Date(publishedMs + H)).level, 1);
  // A normal message (due after publish) is unchanged.
  assert.equal(ackEscalationAnchor(message()).toISOString(), "2026-08-10T12:00:00.000Z");
  // Not required / unpublished / no due time: no anchor.
  assert.equal(ackEscalationAnchor(message({ is_required_ack: false })), null);
  assert.equal(ackEscalationAnchor(message({ published_at: null })), null);
  assert.equal(ackEscalationAnchor(message({ ack_due_at: null })), null);
});

test("L-1: only an EMERGENCY message's escalation tiers bypass quiet hours; an urgent publish still does", () => {
  for (const priority of ["low", "normal", "urgent"]) {
    assert.equal(shouldBypassQuietHoursForEscalation({ priority }), false, priority);
  }
  assert.equal(shouldBypassQuietHoursForEscalation({ priority: "emergency" }), true);
  assert.equal(shouldBypassQuietHoursForEscalation(null), false);
  // CM-03's publish-time rule is untouched.
  assert.equal(shouldBypassQuietHours({ priority: "urgent" }), true);
  assert.equal(shouldBypassQuietHours({ priority: "emergency" }), true);
  assert.equal(shouldBypassQuietHours({ priority: "normal" }), false);
});

// --- M-5: when does the sweep next need to look at a message? ------------------------------------

test("M-5: ackEscalationNextDueAt is when the tier AFTER the recorded level comes due", () => {
  const ladder = buildAckEscalationLadder();
  assert.equal(ackEscalationNextDueAt(message(), ladder).toISOString(), at(0).toISOString());
  assert.equal(ackEscalationNextDueAt(message({ ack_escalation_level: 1 }), ladder).toISOString(), at(24).toISOString());
  assert.equal(ackEscalationNextDueAt(message({ ack_escalation_level: 2 }), ladder).toISOString(), at(48).toISOString());
  assert.equal(ackEscalationNextDueAt(message({ ack_escalation_level: 3 }), ladder), null, "a fully escalated message leaves the queue");
  // Right after claiming level N the sweep asks for level N's successor explicitly.
  assert.equal(ackEscalationNextDueAt(message(), ladder, 1).toISOString(), at(24).toISOString());
  assert.equal(ackEscalationNextDueAt(message(), ladder, 3), null);
  // Per-facility offsets move it; the publish-time anchor applies.
  const custom = buildAckEscalationLadder({ "communications.ackReminderAfterHours": 5, "communications.ackSupervisorAfterHours": 10 });
  assert.equal(ackEscalationNextDueAt(message(), custom).toISOString(), at(5).toISOString());
  assert.equal(ackEscalationNextDueAt(message({ is_required_ack: false }), ladder), null);
});

// --- L-4: the publish-time shift window is persisted in a form every reader resolves ---------------

test("L-4: serializeShiftWindow produces the rule.window shape the shared resolver reads back", () => {
  assert.deepEqual(serializeShiftWindow("current"), { kind: "current" });
  assert.deepEqual(serializeShiftWindow(" NEXT "), { kind: "next" });
  assert.deepEqual(serializeShiftWindow({ kind: "next" }), { kind: "next" });
  const range = serializeShiftWindow({ from: "2026-08-10T00:00:00Z", to: "2026-08-12T00:00:00Z" });
  assert.deepEqual(range, { kind: "range", from: "2026-08-10T00:00:00.000Z", to: "2026-08-12T00:00:00.000Z" });
  // JSON round trip: what is stored resolves to the same window.
  const stored = JSON.parse(JSON.stringify({ window: range }));
  assert.deepEqual(normalizeShiftWindow(stored.window), normalizeShiftWindow({ from: "2026-08-10T00:00:00Z", to: "2026-08-12T00:00:00Z" }));
  assert.deepEqual(audienceShiftWindow({ audience_type: "shift", audience_ref_id: null, rule_jsonb: stored }), normalizeShiftWindow(stored.window));
  // Malformed windows are not serialized (null, never "everybody").
  assert.equal(serializeShiftWindow(null), null);
  assert.equal(serializeShiftWindow("sometime"), null);
  assert.equal(serializeShiftWindow({ from: "2026-08-10", to: "2026-01-01" }), null);
  assert.equal(serializeShiftWindow({ from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }), null, "longer than 31 days");
});
