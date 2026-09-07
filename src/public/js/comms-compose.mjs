// Pure, DOM-free helpers behind the Communications compose form and message
// list (CM-08/CM-09/P-1): compose-form validation/payload shaping,
// audience-row assembly for POST /messages/:id/audiences, a per-viewer
// acknowledgement state derivation for the ack badge shown on each message
// card, and the P-1 ack/compliance-fetch decisions (which messages' server
// acks seed state.ackedMessageIds, and which get a compliance-count fetch).

export const MESSAGE_PRIORITIES = ["low", "normal", "urgent", "emergency"];
export const AUDIENCE_TYPES = ["role", "department", "shift", "employee"];

export function validateComposeInput(fields = {}) {
  const errors = {};
  if (!fields.channelId) errors.channelId = "Select a channel.";
  if (!fields.subject || !fields.subject.trim()) errors.subject = "Subject is required.";
  if (!fields.bodyText || !fields.bodyText.trim()) errors.bodyText = "Message body is required.";
  if (fields.priority && !MESSAGE_PRIORITIES.includes(fields.priority)) errors.priority = "Unknown priority.";
  if (fields.isRequiredAck && fields.ackDueAt && Number.isNaN(new Date(fields.ackDueAt).getTime())) {
    errors.ackDueAt = "Acknowledgement due date is invalid.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
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

// A row needs a type AND a target to be a real targeting rule; an
// all-blank row is just the picker's default empty state, not an error, so
// it's silently excluded rather than flagged.
function isCompleteAudienceRow(row) {
  return !!row && !!row.audienceType && !!row.audienceRefId;
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
// error instead of silently publishing to fewer audiences than intended.
export function buildAudiencePayload(rows = []) {
  return (rows || [])
    .filter((row) => isCompleteAudienceRow(row) && AUDIENCE_TYPES.includes(row.audienceType))
    .map((row) => ({ audienceType: row.audienceType, audienceRefId: row.audienceRefId }));
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
