// Pure, DOM-free helpers behind the Communications compose form and message
// list (CM-08/CM-09/P-1): compose-form validation/payload shaping,
// audience-row assembly for POST /messages/:id/audiences, a per-viewer
// acknowledgement state derivation for the ack badge shown on each message
// card, and the P-1 ack/compliance-fetch decisions (which messages' server
// acks seed state.ackedMessageIds, and which get a compliance-count fetch).

export const MESSAGE_PRIORITIES = ["low", "normal", "urgent", "emergency"];
export const AUDIENCE_TYPES = ["role", "department", "shift", "employee"];

export function validateComposeInput(fields = {}, now = new Date()) {
  const errors = {};
  if (!fields.channelId) errors.channelId = "Select a channel.";
  if (!fields.subject || !fields.subject.trim()) errors.subject = "Subject is required.";
  if (!fields.bodyText || !fields.bodyText.trim()) errors.bodyText = "Message body is required.";
  if (fields.priority && !MESSAGE_PRIORITIES.includes(fields.priority)) errors.priority = "Unknown priority.";
  if (fields.isRequiredAck && fields.ackDueAt && Number.isNaN(new Date(fields.ackDueAt).getTime())) {
    errors.ackDueAt = "Acknowledgement due date is invalid.";
  } else if (fields.isRequiredAck && fields.ackDueAt && new Date(fields.ackDueAt).getTime() <= new Date(now).getTime()) {
    // The server refuses to publish a message that is already past its due time (M-5):
    // the escalation ladder would fire three tiers at once.
    errors.ackDueAt = "Acknowledgement due date must be in the future.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// The due value a date input yields (YYYY-MM-DD) as an instant: the END of that
// day in the viewer's time zone, so "due today" is a time that has not passed
// yet (new Date("2026-10-07") is midnight UTC, i.e. already in the past for
// someone choosing today's date). "" for an empty or unparsable input.
export function endOfDayIso(dateValue) {
  if (typeof dateValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return "";
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(year, month - 1, day, 23, 59, 59);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

// Shapes the compose form's field state into the JSON body
// POST /facilities/:facilityId/messages expects (the draft half of the
// draft-then-publish flow -- publishNow is deliberately never set here, see
// app.js's composeAndPublish, which always follows up with
// POST .../messages/:id/publish).
export function buildComposePayload(fields = {}) {
  const payload = {
    channelId: fields.channelId,
    subject: fields.subject.trim(),
    bodyText: fields.bodyText.trim(),
    priority: fields.priority || "normal",
    isRequiredAck: !!fields.isRequiredAck
  };
  if (fields.messageType) payload.messageType = fields.messageType;
  if (fields.isRequiredAck && fields.ackDueAt) payload.ackDueAt = fields.ackDueAt;
  return payload;
}

// CM-12: a `shift` audience row targets either one specific shift (the id the
// row's target field holds, shiftMode "id" -- the default) or a window of
// shifts resolved by the server when the message is published: "current"
// (shifts in progress now) or "next" (the next shift to start). Window rows
// need no target id.
export const SHIFT_AUDIENCE_MODES = ["id", "current", "next"];

function shiftWindowMode(row) {
  return row && row.audienceType === "shift" && (row.shiftMode === "current" || row.shiftMode === "next") ? row.shiftMode : null;
}

// A row needs a type AND a target to be a real targeting rule (a shift-window
// row's "target" is the window itself); an all-blank row is just the picker's
// default empty state, not an error, so it's silently excluded rather than
// flagged.
function isCompleteAudienceRow(row) {
  return !!row && !!row.audienceType && (!!row.audienceRefId || shiftWindowMode(row) !== null);
}

function isTouchedAudienceRow(row) {
  return !!row && (!!row.audienceType || !!row.audienceRefId);
}

// Validates the audience picker's row state before publish: at least one
// complete row, and no half-filled row (a type chosen with no target picked
// yet, or vice versa) sitting in the list.
export function validateAudienceRows(rows = []) {
  const touched = (rows || []).filter(isTouchedAudienceRow);
  if (touched.length === 0) {
    return { valid: false, error: "Add at least one audience." };
  }
  const incomplete = touched.some((row) => !isCompleteAudienceRow(row));
  if (incomplete) {
    return { valid: false, error: "Each audience row needs both a type and a target." };
  }
  return { valid: true, error: null };
}

// Turns the audience picker's row state into the bulk array
// POST /messages/:id/audiences expects. Incomplete rows are dropped rather
// than sent -- call validateAudienceRows first to surface that as a form
// error instead of silently publishing to fewer audiences than intended. A
// shift-window row is sent without a target id and with the window in `rule`.
export function buildAudiencePayload(rows = []) {
  return (rows || [])
    .filter((row) => isCompleteAudienceRow(row) && AUDIENCE_TYPES.includes(row.audienceType))
    .map((row) => {
      const window = shiftWindowMode(row);
      if (window) return { audienceType: "shift", rule: { window } };
      return { audienceType: row.audienceType, audienceRefId: row.audienceRefId };
    });
}

// CM-13: priority "emergency" never goes through the ordinary publish flow --
// the compose form switches to the launch-request flow for it.
export function isEmergencyCompose(fields = {}) {
  return fields.priority === "emergency";
}

// Whether a message card should offer the employee "I am safe" / "I need help":
// a published emergency message the viewer has not answered yet.
export function canRespondToEmergency(message, myResponse = null) {
  return !!message && message.priority === "emergency" && !!message.published_at && !myResponse;
}

// Per-viewer ack-state badge. Answers "has the CURRENT user acknowledged
// this message" -- `ackedByMe` is derived by the caller from
// state.ackedMessageIds, which is now seeded from the server on load (P-1's
// GET .../acknowledgements?employeeId=me) rather than tracked only for the
// current session. Mirrors src/lib/communications.mjs's acknowledgementState's
// not_required/pending/overdue/complete vocabulary for a single-recipient
// view of it.
export function deriveAckState({ isRequiredAck, ackDueAt, ackedByMe } = {}, now = new Date()) {
  if (!isRequiredAck) return "not_required";
  if (ackedByMe) return "complete";
  if (ackDueAt && new Date(ackDueAt) < now) return "overdue";
  return "pending";
}

// --- P-1 (CM-09/CM-11): server-seeded ack state + compliance counts --------

// Turns a GET .../messages/:id/acknowledgements?employeeId=me response into
// the set of message ids it covers (empty when the caller acknowledged
// nothing, or has no employee row in the facility -- the route answers an
// empty list rather than an error either way, so this never needs to branch
// on that). Accepts the live snake_case row shape and, defensively, a
// camelCase one, matching every other accessor in this file/communications.mjs.
export function ackedMessageIdsFromRows(rows = []) {
  const ids = (rows || [])
    .map((row) => row?.messageId ?? row?.message_id)
    .filter((id) => id !== undefined && id !== null);
  return new Set(ids);
}

// Decides whether a message card should fetch and show a compliance rollup
// (delivered/read/acknowledged/pending/overdue counts): the caller either
// holds communications.publish outright (an auditor's view over every
// message, not just their own sends) or is that specific message's own
// author. A message with no `authorEmployeeId` (the caller has no resolved
// employee row, or the API row omits it) never matches the author branch --
// canPublish is the only way in for that viewer.
export function shouldFetchCompliance(message, { canPublish = false, myEmployeeId = null } = {}) {
  if (!message) return false;
  if (canPublish) return true;
  const authorId = message.authorEmployeeId ?? message.author_employee_id ?? null;
  return !!myEmployeeId && authorId === myEmployeeId;
}

// Formats a compliance rollup ({delivered, read, acknowledged, pending,
// overdue, total}) into the compact string a message card shows next to its
// ack badge. Returns "" for a missing/malformed rollup so a caller can
// splice this straight into a conditional `if (text) ...` without a second
// null check.
export function formatComplianceSummary(compliance) {
  if (!compliance || typeof compliance.total !== "number") return "";
  const acknowledged = compliance.acknowledged ?? 0;
  const total = compliance.total;
  const overdue = compliance.overdue ?? 0;
  let text = `${acknowledged}/${total} acknowledged`;
  if (overdue > 0) text += `, ${overdue} overdue`;
  return text;
}

// CM-13 (M-3): what the approver is shown for one pending emergency launch, from
// a row of GET /facilities/:id/emergency-launches. The decision "do I send this
// to everyone, ignoring quiet hours" is made on the message BODY and the number
// of people it reaches, never on the subject alone. `contentChanged` (the
// message or its audience was edited after the request) disables the approval:
// the database refuses it anyway, and the approver should say so up front.
export function describeEmergencyLaunch(launch) {
  const subject = launch?.messages?.subject || "this alert";
  const bodyText = String(launch?.messages?.body_text ?? "");
  const rawCount = launch?.preview?.recipientCount;
  const recipientCount = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;
  const unresolvedAudiences = Number(launch?.preview?.unresolvedAudiences ?? 0) || 0;
  const contentChanged = launch?.contentChanged === true;

  let recipientLine;
  if (recipientCount === null) recipientLine = "The number of recipients is not known yet.";
  else if (recipientCount === 0) recipientLine = "Its audience reaches nobody, so it cannot be sent.";
  else recipientLine = `It will reach ${recipientCount} ${recipientCount === 1 ? "person" : "people"} on every channel and ignores quiet hours.`;
  if (unresolvedAudiences > 0) {
    recipientLine += ` ${unresolvedAudiences} shift ${unresolvedAudiences === 1 ? "audience has" : "audiences have"} no window and reach nobody.`;
  }

  const canApprove = !contentChanged && recipientCount !== 0;
  const confirmText = [
    `Send "${subject}" now?`,
    "",
    bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText,
    "",
    recipientLine
  ].join("\n");
  return {
    subject,
    bodyText,
    recipientCount,
    recipientLine,
    unresolvedAudiences,
    contentChanged,
    canApprove,
    warning: contentChanged
      ? "This message or its audience changed after the launch was requested. Cancel this request and request a new one."
      : null,
    confirmText
  };
}
