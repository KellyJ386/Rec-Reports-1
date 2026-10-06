// Pure, DOM-free helpers behind the home dashboard's polled inbox summary
// (CM-16's zero-dependency default: GET /api/v1/me/inbox-summary every 30
// seconds, no websocket / SSE / Supabase Realtime). The scheduling decision
// (how long to wait before the next poll) and the "what changed" / "what to
// say" shaping live here so they can be unit tested; app.js owns the timers,
// the fetch and the DOM.

export const INBOX_POLL_BASE_MS = 30_000;
// A hidden tab polls four times less often -- unread counts nobody can see are
// not worth the requests, and the visibilitychange handler polls immediately
// when the tab comes back, so the user never waits on the slow cadence.
export const INBOX_POLL_HIDDEN_MS = 120_000;
export const INBOX_POLL_MAX_MS = 300_000;
const MAX_BACKOFF_DOUBLINGS = 6;

// Milliseconds to wait before the next poll.
//   visible, healthy  -> 30 s
//   hidden, healthy   -> 120 s
//   consecutive failures double the wait each time (30, 60, 120, ...), capped
//   at 5 minutes, so a struggling server is not hammered; one success resets.
export function nextPollDelayMs({ hidden = false, consecutiveFailures = 0 } = {}) {
  const base = hidden ? INBOX_POLL_HIDDEN_MS : INBOX_POLL_BASE_MS;
  const failures = Number.isFinite(consecutiveFailures) ? Math.max(0, Math.floor(consecutiveFailures)) : 0;
  if (failures === 0) return base;
  return Math.min(base * 2 ** Math.min(failures, MAX_BACKOFF_DOUBLINGS), INBOX_POLL_MAX_MS);
}

// When a hidden tab becomes visible again: poll right away if the last
// successful poll is older than the visible cadence, else let the already
// scheduled timer run.
export function shouldPollOnVisible({ lastPolledAt = null, now = Date.now() } = {}) {
  if (lastPolledAt === null || lastPolledAt === undefined) return true;
  return now - lastPolledAt >= INBOX_POLL_BASE_MS;
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm;
}

// The one-line status text for the polled counters (an aria-live="polite"
// region): "3 unread messages · 2 awaiting your acknowledgement (1 overdue)".
export function describeInboxSummary(summary) {
  if (!summary) return "";
  const unread = Number(summary.unreadCount) || 0;
  const pending = Number(summary.pendingAcks?.count) || 0;
  const overdue = Number(summary.pendingAcks?.overdueCount) || 0;
  const parts = [`${unread} unread ${plural(unread, "message", "messages")}`];
  if (pending > 0) {
    let ack = `${pending} awaiting your acknowledgement`;
    if (overdue > 0) ack += ` (${overdue} overdue)`;
    parts.push(ack);
  }
  return parts.join(" · ");
}

// True when the emergency banner should be on screen at all: there is a recent
// emergency alert (the server already applies the 72 h window).
export function hasEmergencyAlert(summary) {
  return !!summary?.latestEmergency?.messageId;
}

// True while the viewer still owes an answer to the latest emergency alert.
export function needsEmergencyResponse(summary) {
  return hasEmergencyAlert(summary) && !summary.latestEmergency.myResponse;
}

// True when a poll brought news worth announcing: a different latest alert
// than the one already shown, or the viewer's own response changing (e.g. from
// another device).
export function emergencyAlertChanged(previous, next) {
  const before = previous?.latestEmergency ?? null;
  const after = next?.latestEmergency ?? null;
  if (!before && !after) return false;
  if (!before || !after) return true;
  return before.messageId !== after.messageId || (before.myResponse ?? null) !== (after.myResponse ?? null);
}

// The sentence the banner shows after the viewer has answered.
export function describeEmergencyResponse(response) {
  if (response === "safe") return "You reported that you are safe.";
  if (response === "need_help") return "You reported that you need help. A supervisor has been told.";
  return "";
}
