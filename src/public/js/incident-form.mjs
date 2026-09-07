// Pure, DOM-free helpers behind the incident capture form and detail view
// (IN-10). Mirrors src/lib/incidents.mjs's vocabularies/allow-lists so the
// UI never diverges from the server's own check-constraint enums, but is
// deliberately NOT an import of that file: browser code cannot reach
// src/lib (it never ships to dist/), so the handful of constants used here
// are copied, not shared.
//
// Everything here operates on plain data -- no `document`, no fetch -- so it
// is importable and testable under node:test without a browser, matching
// report-form.mjs's convention for this codebase's schema-driven UIs.

// report_type / severity check constraints, verbatim from
// supabase/migrations/0004_incidents.sql.
export const INCIDENT_REPORT_TYPES = ["incident", "accident", "near_miss"];
export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"];

// Follow-up action_type vocabulary, verbatim from incident_followup_actions'
// check constraint (0004_incidents.sql), used by the follow-up create form.
export const FOLLOWUP_ACTION_TYPES = ["corrective_action", "investigation", "documentation", "equipment_fix", "training"];

// The fields buildAmendment (src/lib/incidents.mjs) allows amending, copied
// here so the amendment form only ever offers exactly what the server will
// accept -- an out-of-list key would 400 with "cannot amend field(s): ...".
export const AMENDABLE_INCIDENT_FIELDS = ["summary", "immediate_actions", "location_text", "severity", "requires_osha_review"];

const GATING_SEVERITIES = new Set(["high", "critical"]);

// Whether `severity` triggers the capture form's stricter, UI-only
// mandatory-field gate. The server itself does not require
// immediate_actions for any severity (it's a nullable column) -- this is a
// deliberate client-side tightening so a high/critical incident is never
// created without at least a note on what was done immediately, without
// waiting on a round trip to find that out.
export function severityRequiresGating(severity) {
  return GATING_SEVERITIES.has(severity);
}

// Validates the capture form's in-memory field state before
// POST /facilities/:facilityId/incidents is called. Base-required fields
// mirror that route's own shape check (reportType, severity, occurredAt,
// locationText, summary) so a client-side rejection and the server's 400
// never disagree about what's required; severityRequiresGating adds
// immediateActions on top for high/critical severity.
export function validateIncidentCapture(fields = {}) {
  const errors = {};
  const reportType = fields.reportType;
  const severity = fields.severity;

  if (!reportType || !INCIDENT_REPORT_TYPES.includes(reportType)) {
    errors.reportType = "Select an incident type.";
  }
  if (!severity || !INCIDENT_SEVERITIES.includes(severity)) {
    errors.severity = "Select a severity.";
  }
  if (!fields.occurredAt) errors.occurredAt = "Occurred date/time is required.";
  if (!fields.locationText || !fields.locationText.trim()) errors.locationText = "Location is required.";
  if (!fields.summary || !fields.summary.trim()) errors.summary = "Summary is required.";
  if (severityRequiresGating(severity) && !(fields.immediateActions || "").trim()) {
    errors.immediateActions = "Immediate actions are required for high/critical severity incidents.";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Shapes validated capture-form field state into the JSON body
// POST /facilities/:facilityId/incidents expects. Optional strings are only
// included when non-empty (an empty string is never sent in their place),
// and boolean flags are only included when true -- matching the route's own
// `?? false`/`?? null` defaults so omitting a field and sending its default
// value explicitly behave identically server-side.
export function buildIncidentCreatePayload(fields = {}) {
  const payload = {
    reportType: fields.reportType,
    severity: fields.severity,
    occurredAt: fields.occurredAt,
    locationText: (fields.locationText || "").trim(),
    summary: (fields.summary || "").trim()
  };
  const immediateActions = (fields.immediateActions || "").trim();
  if (immediateActions) payload.immediateActions = immediateActions;
  if (fields.requiresOshaReview) payload.requiresOshaReview = true;
  if (fields.legalHold) payload.legalHold = true;
  if (fields.departmentId) payload.departmentId = fields.departmentId;
  return payload;
}

// Validates a follow-up action create form's field state before
// POST /incidents/:id/followups, mirroring that route's own shape check.
export function validateFollowupInput(fields = {}) {
  const errors = {};
  if (!fields.actionType || !FOLLOWUP_ACTION_TYPES.includes(fields.actionType)) {
    errors.actionType = `Select one of: ${FOLLOWUP_ACTION_TYPES.join(", ")}.`;
  }
  if (!fields.description || !fields.description.trim()) errors.description = "Description is required.";
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildFollowupPayload(fields = {}) {
  const payload = { actionType: fields.actionType, description: (fields.description || "").trim() };
  if (fields.dueAt) payload.dueAt = fields.dueAt;
  if (fields.ownerUserId) payload.ownerUserId = fields.ownerUserId;
  return payload;
}

// Validates the amendment form: a non-empty reason plus a patch touching at
// least one AMENDABLE_INCIDENT_FIELDS key, mirroring buildAmendment's own
// (server-side) checks so a client-side rejection never disagrees with the
// eventual 400.
export function validateAmendmentInput(fields = {}) {
  const errors = {};
  if (!fields.reason || !fields.reason.trim()) errors.reason = "A reason is required to amend an incident.";
  const patch = fields.patch && typeof fields.patch === "object" ? fields.patch : {};
  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0) {
    errors.patch = "Change at least one field.";
  } else {
    const invalidKeys = patchKeys.filter((key) => !AMENDABLE_INCIDENT_FIELDS.includes(key));
    if (invalidKeys.length > 0) {
      errors.patch = `Cannot amend field(s): ${invalidKeys.join(", ")}.`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildAmendmentPayload(fields = {}) {
  return { reason: (fields.reason || "").trim(), patch: fields.patch || {} };
}

// Escalation status vocabulary, verbatim from incident_escalations' check
// constraint (0004_incidents.sql), used to label escalation-history rows and
// decide which of the acknowledge/resolve actions applies to a given row.
export const ESCALATION_STATUSES = ["pending", "acknowledged", "resolved", "expired"];

// --- People / witness statements (IN-12) ------------------------------------
// person_role vocabulary, verbatim from incident_people's check constraint
// (0004_incidents.sql), used by the "add person" form.
export const INCIDENT_PERSON_ROLES = ["injured_party", "witness", "staff", "contractor", "visitor"];

// Validates the "add person" form's field state before
// POST /facilities/:facilityId/incidents/:incidentId/people, mirroring that
// route's own shape check: personRole must be one of the check-constraint
// values, fullName is a required non-blank string. contact/injury are
// optional free-form objects (contact_json/injury_json columns default to
// {} server-side, so the form never needs to send an empty object either).
export function validatePersonInput(fields = {}) {
  const errors = {};
  if (!fields.personRole || !INCIDENT_PERSON_ROLES.includes(fields.personRole)) {
    errors.personRole = `Select one of: ${INCIDENT_PERSON_ROLES.join(", ")}.`;
  }
  if (!fields.fullName || !fields.fullName.trim()) {
    errors.fullName = "Full name is required.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Shapes validated "add person" field state into the JSON body
// POST .../people expects. contact/injury are only included when they carry
// at least one key, matching buildIncidentCreatePayload's "omit rather than
// send an empty default" convention above.
export function buildPersonPayload(fields = {}) {
  const payload = {
    personRole: fields.personRole,
    fullName: (fields.fullName || "").trim()
  };
  const contact = fields.contact && typeof fields.contact === "object" ? fields.contact : {};
  if (Object.keys(contact).length > 0) payload.contact = contact;
  const injury = fields.injury && typeof fields.injury === "object" ? fields.injury : {};
  if (Object.keys(injury).length > 0) payload.injury = injury;
  return payload;
}

// Validates the "add statement" form's field state before
// POST .../people/:personId/statements, mirroring that route's own shape
// check: statementText is a required non-blank string.
export function validateStatementInput(fields = {}) {
  const errors = {};
  if (!fields.statementText || !fields.statementText.trim()) {
    errors.statementText = "Statement text is required.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildStatementPayload(fields = {}) {
  return { statementText: (fields.statementText || "").trim() };
}

// Which single action (if any) is legal next for an escalation row, per the
// incidents-routes.mjs guarded transitions (pending -> acknowledged ->
// resolved only). Returns null when neither action applies (resolved/
// expired terminal states), so the detail view can skip rendering an action
// button entirely rather than rendering one that would always 409.
export function nextEscalationAction(status) {
  if (status === "pending") return "acknowledge";
  if (status === "acknowledged") return "resolve";
  return null;
}
