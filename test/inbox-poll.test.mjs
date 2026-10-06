import test from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_POLL_BASE_MS,
  INBOX_POLL_HIDDEN_MS,
  INBOX_POLL_MAX_MS,
  nextPollDelayMs,
  shouldPollOnVisible,
  describeInboxSummary,
  hasEmergencyAlert,
  needsEmergencyResponse,
  emergencyAlertChanged,
  describeEmergencyResponse
} from "../src/public/js/inbox-poll.mjs";

test("the polling default is 30 seconds with no realtime dependency", () => {
  assert.equal(INBOX_POLL_BASE_MS, 30_000);
  assert.equal(nextPollDelayMs(), 30_000);
  assert.equal(nextPollDelayMs({ hidden: false, consecutiveFailures: 0 }), 30_000);
});

test("a hidden tab backs off to a slower cadence", () => {
  assert.equal(nextPollDelayMs({ hidden: true }), INBOX_POLL_HIDDEN_MS);
  assert.ok(INBOX_POLL_HIDDEN_MS > INBOX_POLL_BASE_MS);
});

test("consecutive failures double the delay up to the cap, and a success resets", () => {
  assert.equal(nextPollDelayMs({ consecutiveFailures: 1 }), 60_000);
  assert.equal(nextPollDelayMs({ consecutiveFailures: 2 }), 120_000);
  assert.equal(nextPollDelayMs({ consecutiveFailures: 3 }), 240_000);
  assert.equal(nextPollDelayMs({ consecutiveFailures: 4 }), INBOX_POLL_MAX_MS);
  assert.equal(nextPollDelayMs({ consecutiveFailures: 50 }), INBOX_POLL_MAX_MS);
  assert.equal(nextPollDelayMs({ hidden: true, consecutiveFailures: 3 }), INBOX_POLL_MAX_MS);
  assert.equal(nextPollDelayMs({ consecutiveFailures: 0 }), 30_000);
  // Garbage input degrades to the healthy cadence.
  assert.equal(nextPollDelayMs({ consecutiveFailures: Number.NaN }), 30_000);
  assert.equal(nextPollDelayMs({ consecutiveFailures: -3 }), 30_000);
});

test("shouldPollOnVisible polls at once unless a poll just happened", () => {
  assert.equal(shouldPollOnVisible({ lastPolledAt: null, now: 1_000_000 }), true);
  assert.equal(shouldPollOnVisible({ lastPolledAt: 1_000_000, now: 1_010_000 }), false);
  assert.equal(shouldPollOnVisible({ lastPolledAt: 1_000_000, now: 1_030_000 }), true);
});

test("describeInboxSummary reads naturally and mentions overdue acknowledgements", () => {
  assert.equal(describeInboxSummary(null), "");
  assert.equal(describeInboxSummary({ unreadCount: 0, pendingAcks: { count: 0, overdueCount: 0 } }), "0 unread messages");
  assert.equal(describeInboxSummary({ unreadCount: 1, pendingAcks: { count: 0, overdueCount: 0 } }), "1 unread message");
  assert.equal(
    describeInboxSummary({ unreadCount: 3, pendingAcks: { count: 2, overdueCount: 1 } }),
    "3 unread messages · 2 awaiting your acknowledgement (1 overdue)"
  );
  assert.equal(
    describeInboxSummary({ unreadCount: 2, pendingAcks: { count: 1, overdueCount: 0 } }),
    "2 unread messages · 1 awaiting your acknowledgement"
  );
});

test("emergency banner state: shown while an alert exists, prompting until the viewer answers", () => {
  const none = { latestEmergency: null };
  const open = { latestEmergency: { messageId: "m1", myResponse: null } };
  const answered = { latestEmergency: { messageId: "m1", myResponse: "safe" } };
  assert.equal(hasEmergencyAlert(none), false);
  assert.equal(hasEmergencyAlert(open), true);
  assert.equal(needsEmergencyResponse(open), true);
  assert.equal(needsEmergencyResponse(answered), false);
  assert.equal(needsEmergencyResponse(none), false);
});

test("emergencyAlertChanged detects a new alert or a changed response, not an identical poll", () => {
  const open = { latestEmergency: { messageId: "m1", myResponse: null } };
  assert.equal(emergencyAlertChanged(null, null), false);
  assert.equal(emergencyAlertChanged({ latestEmergency: null }, { latestEmergency: null }), false);
  assert.equal(emergencyAlertChanged(open, open), false);
  assert.equal(emergencyAlertChanged({ latestEmergency: null }, open), true);
  assert.equal(emergencyAlertChanged(open, { latestEmergency: null }), true);
  assert.equal(emergencyAlertChanged(open, { latestEmergency: { messageId: "m2", myResponse: null } }), true);
  assert.equal(emergencyAlertChanged(open, { latestEmergency: { messageId: "m1", myResponse: "need_help" } }), true);
});

test("describeEmergencyResponse", () => {
  assert.match(describeEmergencyResponse("safe"), /safe/);
  assert.match(describeEmergencyResponse("need_help"), /need help/);
  assert.equal(describeEmergencyResponse(null), "");
});
