import { configValue } from "./settings-registry.mjs";
import { computeRowHash } from "./audit.mjs";
import { buildNotificationJob } from "./admin/notifications.mjs";

const escalationSeverities = new Set(["high", "critical"]);
// IN-20: severities whose notification jobs bypass quiet-hours suppression
// (src/lib/notifications/worker.mjs honors payload_jsonb.quietHoursBypass ===
// true on both the job-processing and outbox-translation paths already --
// this is the incident module's own policy for which severities set it).
const QUIET_HOURS_BYPASS_SEVERITIES = new Set(["high", "critical"]);
const oshaReviewTriggers = new Set(["employee_injury", "hospitalization", "lost_time", "fatality"]);

// `config` is optional. incidents.severityAutoEscalate=false stops severity
// alone from escalating (legal hold and OSHA review still force escalation);
// the shipped default is true, preserving the original behavior.
export function shouldEscalateIncident(incident, config = {}) {
  const severityAutoEscalate = configValue(config, "incidents.severityAutoEscalate");
  const bySeverity = severityAutoEscalate && escalationSeverities.has(incident.severity);
  return bySeverity || incident.legalHold === true || incident.requiresOshaReview === true;
}

// The moment by which an escalation acknowledgement is due, driven by
// incidents.escalationSlaHours. Returns null when the incident carries no
// reported timestamp to anchor the SLA to.
export function escalationDueAt(incident, config = {}) {
  const slaHours = configValue(config, "incidents.escalationSlaHours");
  const anchor = incident.reportedAt ?? incident.createdAt ?? incident.occurredAt;
  if (!anchor) return null;
  return new Date(new Date(anchor).getTime() + slaHours * 60 * 60 * 1000);
}

// `incident.dueAt`, when present, is used verbatim instead of recomputing an
// SLA-derived due date from escalationDueAt. This is what lets IN-06's
// escalations list route reuse this same function against an
// incident_escalations row (which already carries its own server-stamped
// due_at from creation time) without reshaping it into an incident-like
// object with reportedAt/createdAt/occurredAt -- callers just pass
// { dueAt: escalation.due_at }. Existing callers that pass an incident
// (no dueAt) are unaffected: the fallback to escalationDueAt(incident,
// config) is exactly the prior behavior.
export function isEscalationOverdue(incident, now = new Date(), config = {}) {
  const dueAt = incident?.dueAt ? new Date(incident.dueAt) : escalationDueAt(incident, config);
  if (!dueAt) return false;
  return now > dueAt;
}

// IN-21: the level a new auto-escalation row should carry when the current
// one (`currentLevel`, an incident_escalations.escalation_level value) has
// gone overdue unacknowledged. Always currentLevel + 1 -- the cap against
// incidents.maxEscalationLevel is a SEPARATE decision (decideEscalationSweep
// in incident-sla-sweep.mjs), not folded in here, so this stays a one-line
// arithmetic fact callers can rely on independent of whether the cap allows
// creating that next level at all. Guards against a non-positive/non-finite
// input (a malformed or missing escalation_level) by treating it as level 0,
// so the result is always a positive integer >= 1.
export function nextEscalationLevel(currentLevel) {
  const level = Number.isFinite(currentLevel) && currentLevel > 0 ? Math.floor(currentLevel) : 0;
  return level + 1;
}

// IN-20: shapes one notification_jobs row PER recipient for an incident
// lifecycle event (incident.submitted / incident.escalated /
// incident.sla_breached). Pure -- `route` is whatever the caller already
// resolved (admin/notifications.mjs's resolveRoute against a facility's
// active notification_routes for the event code) and `recipients` is
// whatever employee-id list the caller already expanded (e.g.
// notifications/worker.mjs's expandRouteRecipients, or a directly-targeted
// escalation.target_user_id folded in); this function does no I/O of its
// own, matching every other pure decision function in this file.
//
// One row per recipient (rather than admin/notifications.mjs's usual single
// job carrying an array of recipients) is deliberate: it is what lets each
// row carry its OWN dedupe_key. `dedupe_key` is `${incidentId}:${eventCode}:
// ${recipientId}` -- the exact per-(incident, event, recipient) shape IN-20
// specifies -- and is inserted via pgInsert's ignoreDuplicates option
// against notification_jobs' new unique partial index on dedupe_key
// (0058_incident_cross_module.sql), so a retried or re-run call site (e.g.
// the SLA sweep re-processing the same escalation, or a route handler retried
// after a network blip) can never enqueue the same recipient twice for the
// same incident event.
//
// quietHoursBypass is stamped true whenever `incident.severity` is high or
// critical (QUIET_HOURS_BYPASS_SEVERITIES) -- worker.mjs's processJob/
// translateOutboxEvent both already honor payload_jsonb.quietHoursBypass ===
// true (see its own quiet-hours check), so a severe incident's notification
// still fires immediately instead of waiting out a facility's quiet-hours
// window, exactly like communications-routes.mjs's shouldBypassQuietHours
// does for urgent messages.
//
// `incident` needs only `{ id, severity }` -- callers pass the minimal shape
// rather than a full incident_reports row, keeping this function's input
// surface as small as its output.
export function buildIncidentNotificationJobs(eventCode, route, recipients, incident) {
  const incidentId = incident?.id ?? null;
  const bypass = QUIET_HOURS_BYPASS_SEVERITIES.has(incident?.severity);
  return (recipients ?? [])
    .filter((recipientId) => recipientId)
    .map((recipientId) => {
      const job = buildNotificationJob(eventCode, route, [recipientId]);
      job.dedupe_key = `${incidentId}:${eventCode}:${recipientId}`;
      job.payload_jsonb = { ...job.payload_jsonb, incidentId, quietHoursBypass: bypass };
      return job;
    });
}

export function classifyOshaReview(reportType, outcomes = []) {
  if (reportType !== "accident") return false;
  return outcomes.some((outcome) => oshaReviewTriggers.has(outcome));
}

export function requiredIncidentFollowUps(incident, config = {}) {
  const followUps = [];
  if (shouldEscalateIncident(incident, config)) {
    followUps.push("manager_review", "safety_lead_acknowledgement");
  }
  if (incident.requiresOshaReview) {
    followUps.push("osha_recordability_check", "evidence_completeness_check");
  }
  if (incident.severity === "critical") {
    followUps.push("executive_notification", "legal_review");
  }
  return [...new Set(followUps)];
}

// --- Status transition machine (IN-02) --------------------------------------
// Mirrors the check constraint on incident_reports.status verbatim
// (0004_incidents.sql:6): draft, submitted, under_review, escalated,
// action_pending, closed. No DB trigger enforces the graph the way
// fn_enforce_change_request_transition does for admin_change_requests
// (0014) -- this is the sole guard, called by the routes in
// incidents-routes.mjs before every UPDATE of incident_reports.status.
export const INCIDENT_STATUSES = Object.freeze([
  "draft",
  "submitted",
  "under_review",
  "escalated",
  "action_pending",
  "closed"
]);

// from -> legal `to` statuses, encoding the design's
// draft -> submitted -> under_review -> (escalated | action_pending) -> closed
// narrative:
//   * under_review cannot jump straight to closed -- every incident must pass
//     through either an escalation or a follow-up action before it can be
//     closed, so the ledger always shows *something* happened to a reviewed
//     incident before it was closed out (legal-defensibility is this
//     module's core promise per the plan).
//   * escalated and action_pending move laterally into each other (an
//     escalated incident can still pick up follow-up actions; an incident
//     with only follow-ups can still escalate later) and either can close
//     directly once its own closure gates are satisfied.
//   * closed is terminal -- no transition leaves it.
const INCIDENT_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["submitted"]),
  submitted: Object.freeze(["under_review"]),
  under_review: Object.freeze(["escalated", "action_pending"]),
  escalated: Object.freeze(["action_pending", "closed"]),
  action_pending: Object.freeze(["escalated", "closed"]),
  closed: Object.freeze([])
});

// Pure transition guard. `context`:
//   * actorPermissions: string[] of permission codes the actor holds at the
//     incident's facility (e.g. ["incidents.manage", "incidents.review"]).
//   * isCreator: whether the actor authored the draft. incident_reports
//     carries no created_by column (0004_incidents.sql), and the only route
//     that can create a draft already requires incidents.manage
//     (POST /facilities/:facilityId/incidents), so there is nothing in
//     storage today to check "is this actor the creator" against. isCreator
//     is accepted here for forward compatibility -- when a created_by column
//     lands, routes can pass isCreator: actor === incident.created_by
//     without changing this function. Until then routes pass isCreator:
//     false (or omit it) and incidents.manage alone gates submission, which
//     is the documented choice for "submit needs incidents.manage OR being
//     the creator."
//   * openFollowUps: array (or array-like with .length) of currently open
//     required follow-up actions; a non-empty list blocks closing.
//   * legalHold: incident.legal_hold -- when true, closing additionally
//     requires incidents.legal_hold.manage.
//
// Returns { allowed, reason, reasonCode }. reasonCode is a superset of the
// plan's { allowed, reason } shape, added so callers (the HTTP routes) can
// map a rejection to the right status code without parsing the human-
// readable `reason` string:
//   * "unknown_status"     -> from/to isn't one of INCIDENT_STATUSES (400)
//   * "invalid_transition" -> from/to isn't a legal edge in the graph (409)
//   * "forbidden"          -> actor lacks the required permission (403)
//   * "followups_open"     -> closing blocked by open required follow-ups (409)
//   * "legal_hold"         -> closing blocked by an unmanaged legal hold (409)
export function canTransitionIncident(from, to, context = {}) {
  const { actorPermissions = [], isCreator = false, openFollowUps = [], legalHold = false } = context;

  if (!INCIDENT_STATUSES.includes(from)) {
    return { allowed: false, reason: `unknown status "${from}"`, reasonCode: "unknown_status" };
  }
  if (!INCIDENT_STATUSES.includes(to)) {
    return { allowed: false, reason: `unknown status "${to}"`, reasonCode: "unknown_status" };
  }

  const legalMoves = INCIDENT_TRANSITIONS[from] ?? [];
  if (!legalMoves.includes(to)) {
    return {
      allowed: false,
      reason: `cannot transition from "${from}" to "${to}"`,
      reasonCode: "invalid_transition"
    };
  }

  const permissions = new Set(actorPermissions ?? []);
  const isSubmit = from === "draft" && to === "submitted";

  if (isSubmit) {
    if (!permissions.has("incidents.manage") && !isCreator) {
      return {
        allowed: false,
        reason: "submit requires incidents.manage or being the incident's creator",
        reasonCode: "forbidden"
      };
    }
  } else if (!permissions.has("incidents.review")) {
    return { allowed: false, reason: "missing permission: incidents.review", reasonCode: "forbidden" };
  }

  if (to === "closed") {
    const openCount = openFollowUps?.length ?? 0;
    if (openCount > 0) {
      return {
        allowed: false,
        reason: `cannot close while ${openCount} required follow-up action(s) remain open`,
        reasonCode: "followups_open"
      };
    }
    if (legalHold && !permissions.has("incidents.legal_hold.manage")) {
      return {
        allowed: false,
        reason: "incidents under legal hold require incidents.legal_hold.manage to close",
        reasonCode: "legal_hold"
      };
    }
  }

  return { allowed: true, reason: null, reasonCode: null };
}

// Shapes an incident_audit_events insert row (IN-03). The DB's
// fn_audit_chain_link trigger (0013_audit_chain.sql) fills prev_hash/row_hash
// automatically on insert -- callers must NOT set those columns themselves.
//
// event_hash (0004_incidents.sql) is a separate, NOT NULL legacy column that
// predates the 0013 hash-chain columns and is not touched by any trigger, so
// it still must be populated on every insert or the row is rejected. It is
// filled with a self-contained hash of this event's own content
// (computeRowHash with no prevHash, from audit.mjs) so no extra SELECT is
// needed before the insert -- the real chain-of-custody guarantee comes from
// prev_hash/row_hash, which the DB computes.
export function buildIncidentAuditEvent({ facilityId, incidentId, actorUserId, eventType, payload }) {
  const event = {
    facility_id: facilityId,
    incident_id: incidentId,
    actor_user_id: actorUserId ?? null,
    event_type: eventType,
    event_payload: payload ?? {}
  };
  return { ...event, event_hash: computeRowHash(null, event) };
}

// --- Amendments (IN-04) ------------------------------------------------------
// Amendments are the module's legal-defensibility core: once an incident has
// left draft, its material fields are frozen against plain UPDATEs (routes.js
// enforces the 409-on-draft rule) and can only change through this append-
// only record of what changed, why, and by whom -- before/after snapshots of
// the *entire* row, hashed so a later reader can detect tampering with the
// snapshot content independent of the incident_amendments table's own RLS
// posture.
//
// Allow-list rationale (read against incident_reports' columns,
// 0004_incidents.sql:1-22): only narrative/descriptive and classification
// fields are amendable --
//   * summary, immediate_actions, location_text -- narrative/descriptive
//     fields that are routinely corrected or expanded as an investigation
//     proceeds (e.g. a fuller account of what happened, a corrected room
//     number).
//   * severity, requires_osha_review -- classification fields that
//     legitimately change on reclassification (e.g. an initial "medium"
//     severity is revised to "high" after review; OSHA recordability is
//     determined only after the fact).
// Deliberately EXCLUDED:
//   * status -- has its own guarded transition machine (canTransitionIncident
//     / POST /incidents/:id/status); amending it would bypass every gate
//     that machine enforces (closure follow-up/legal-hold checks, etc).
//   * facility_id, incident_no, id, department_id -- identity/routing
//     columns. Changing these would mean *re-pointing* the record at a
//     different tenant/case/department rather than correcting its content --
//     exactly what amendments must never be able to do.
//   * occurred_at -- the fixed factual anchor the escalation SLA and audit
//     timeline are computed from; correcting a mis-recorded occurrence time
//     is a materially different (and more sensitive -- it can shift whether
//     an SLA was breached) operation than correcting a description, so it is
//     intentionally left out of this allow-list rather than folded in.
//   * submitted_by, submitted_at, created_at, updated_at, deleted_at,
//     legal_hold -- system-stamped or independently-guarded (legal_hold has
//     its own incidents.legal_hold.manage-gated surface per IN-02).
export const AMENDABLE_INCIDENT_FIELDS = Object.freeze([
  "summary",
  "immediate_actions",
  "location_text",
  "severity",
  "requires_osha_review"
]);

// Pure. `before` is the current incident_reports row exactly as loaded from
// storage (snake_case columns) -- the before/after snapshots stored in
// incident_amendments are literal row dumps, so `patch` is keyed by the same
// snake_case column names rather than the HTTP layer's camelCase, keeping
// the snapshot shape, the allow-list, and the wire patch identical (one
// fewer translation layer to get wrong in the module's legal core).
//
// Returns { error } for:
//   * a missing/blank `reason` (checked first: an amendment with no stated
//     reason is not a valid amendment regardless of what it changes)
//   * an empty patch (nothing to amend)
//   * any patch key outside AMENDABLE_INCIDENT_FIELDS (lists every offending
//     key, not just the first, so a caller can fix its request in one pass)
//
// On success, returns the full built amendment: before/after snapshots (the
// after snapshot is `before` with only the patch's fields applied), their
// sha-256 hashes (via audit.mjs's computeRowHash with a null prevHash --
// the same "self-contained content hash" shape buildIncidentAuditEvent uses
// for event_hash), the patch to apply to incident_reports, the trimmed
// reason, and the actor. Hashing is over the *entire* snapshot (not just the
// changed fields) so the hash can later re-verify the full before/after
// state, not merely the diff.
export function buildAmendment(before, patch, { reason, actor } = {}) {
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (!trimmedReason) {
    return { error: "reason is required" };
  }

  const patchEntries = Object.entries(patch ?? {});
  if (patchEntries.length === 0) {
    return { error: "patch must include at least one amendable field" };
  }

  const invalidKeys = patchEntries.map(([key]) => key).filter((key) => !AMENDABLE_INCIDENT_FIELDS.includes(key));
  if (invalidKeys.length > 0) {
    return {
      error: `cannot amend field(s): ${invalidKeys.join(", ")} (allowed: ${AMENDABLE_INCIDENT_FIELDS.join(", ")})`
    };
  }

  const appliedPatch = Object.fromEntries(patchEntries);
  const beforeSnapshot = { ...before };
  const afterSnapshot = { ...before, ...appliedPatch };

  return {
    beforeSnapshot,
    afterSnapshot,
    beforeHash: computeRowHash(null, beforeSnapshot),
    afterHash: computeRowHash(null, afterSnapshot),
    patch: appliedPatch,
    changedFields: Object.keys(appliedPatch),
    reason: trimmedReason,
    actor: actor ?? null
  };
}

// --- Incident number generation (IN-09) --------------------------------------
// Server-generated incident_no, format INC-YYYY-NNNN, sequenced per facility
// per calendar year (the calling route already scopes `existingIncidentNos`
// to one facility; the year match below is what additionally partitions the
// sequence by year within that facility's history).
const INCIDENT_NO_PATTERN = /^INC-(\d{4})-(\d{4,})$/;

export function formatIncidentNo(sequence, year) {
  return `INC-${year}-${String(sequence).padStart(4, "0")}`;
}

// Pure. `existingIncidentNos` is a flat string[] of incident_no values already
// used (any shape -- the route fetches them unfiltered per facility). Values
// that don't match INC-YYYY-NNNN, or whose YYYY isn't `year`, are ignored
// rather than throwing -- legacy/malformed numbers must never block new
// numbering. Returns max-matching-sequence + 1 for `year`, or NNNN=0001 when
// none exist yet.
export function nextIncidentNo(existingIncidentNos = [], year = new Date().getUTCFullYear()) {
  let maxSequence = 0;
  for (const incidentNo of existingIncidentNos ?? []) {
    const match = typeof incidentNo === "string" ? incidentNo.match(INCIDENT_NO_PATTERN) : null;
    if (!match) continue;
    if (Number(match[1]) !== year) continue;
    const sequence = Number(match[2]);
    if (sequence > maxSequence) maxSequence = sequence;
  }
  return formatIncidentNo(maxSequence + 1, year);
}
