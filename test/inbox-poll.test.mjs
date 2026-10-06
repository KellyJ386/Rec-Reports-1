import test from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_POLL_BASE_MS,
  INBOX_POLL_HIDDEN_MS,
  INBOX_POLL_MAX_MS,
  nextPollDelayMs,
  shouldPollOnVisible,
  shouldStopPolling,
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

test("L-7: a tab that becomes visible during a failure backoff does not retry at once", () => {
  // Healthy: unchanged behaviour.
  assert.equal(shouldPollOnVisible({ lastPolledAt: null, now: 1_000_000, consecutiveFailures: 0 }), true);
  // Failing: the backoff wins over "last poll is old" and over "never polled".
  assert.equal(shouldPollOnVisible({ lastPolledAt: 1_000_000, now: 9_000_000, consecutiveFailures: 1 }), false);
  assert.equal(shouldPollOnVisible({ lastPolledAt: null, now: 1_000_000, consecutiveFailures: 3 }), false);
  assert.equal(shouldPollOnVisible({ lastPolledAt: null, now: 1_000_000, consecutiveFailures: Number.NaN }), true);
});

test("L-7: 401, 403 and 404 stop the poller; outages and server errors are retried with backoff", () => {
  for (const status of [401, 403, 404]) assert.equal(shouldStopPolling(Object.assign(new Error("x"), { status })), true, String(status));
  for (const status of [400, 408, 429, 500, 502, 503]) {
    assert.equal(shouldStopPolling(Object.assign(new Error("x"), { status })), false, String(status));
  }
  // A network error has no status: keep trying (with backoff).
  assert.equal(shouldStopPolling(new Error("Network error: fetch failed")), false);
  assert.equal(shouldStopPolling(null), false);
  assert.equal(shouldStopPolling(undefined), false);
});

test("L-7: app.js wires the poller to both rules", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/public/js/app.js", import.meta.url), "utf8");
  const poller = source.slice(source.indexOf("const inboxPoller = (function () {"), source.indexOf("function collapsePanelsOnMobile()"));
  assert.match(poller, /catch \(error\) \{[\s\S]*shouldStopPolling\(error\)[\s\S]*stop\(\);[\s\S]*return;[\s\S]*consecutiveFailures \+= 1/);
  assert.match(poller, /shouldPollOnVisible\(\{ lastPolledAt, now: Date\.now\(\), consecutiveFailures \}\)/);
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
  // L-5: nothing notifies anybody on a need-help answer, so the text must not claim that anyone was told.
  assert.doesNotMatch(describeEmergencyResponse("need_help"), /(supervisor|someone|anyone|they) (has|have|was|were|will be) (been )?(told|notified|alerted)/i);
  assert.doesNotMatch(describeEmergencyResponse("need_help"), /has been told|have been told|been notified/i);
  assert.match(describeEmergencyResponse("need_help"), /recorded/);
  assert.match(describeEmergencyResponse("need_help"), /emergency services|supervisor/);
  assert.equal(describeEmergencyResponse(null), "");
});
