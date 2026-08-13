import { configValue } from "./settings-registry.mjs";
import { computeRowHash } from "./audit.mjs";

const escalationSeverities = new Set(["high", "critical"]);
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

export function isEscalationOverdue(incident, now = new Date(), config = {}) {
  const dueAt = escalationDueAt(incident, config);
  if (!dueAt) return false;
  return now > dueAt;
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
