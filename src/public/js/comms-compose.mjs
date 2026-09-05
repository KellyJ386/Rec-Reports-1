// Pure, DOM-free helpers behind the Communications compose form and message
// list (CM-08/CM-09): compose-form validation/payload shaping, audience-row
// assembly for POST /messages/:id/audiences, and a per-viewer acknowledgement
// state derivation for the ack badge shown on each message card.

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

// Per-viewer ack-state badge. Deliberately answers only "has the CURRENT
// user acknowledged this message", not a facility-wide compliance rollup --
// there is no rollup endpoint in this API surface (CM-11 is unbuilt), so
// `ackedByMe` is derived by the caller from whether an acknowledgement
// exists for the signed-in employee. Mirrors
// src/lib/communications.mjs's acknowledgementState's not_required/pending/
// overdue/complete vocabulary for a single-recipient view of it.
export function deriveAckState({ isRequiredAck, ackDueAt, ackedByMe } = {}, now = new Date()) {
  if (!isRequiredAck) return "not_required";
  if (ackedByMe) return "complete";
  if (ackDueAt && new Date(ackDueAt) < now) return "overdue";
  return "pending";
}
