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

// `treeOutcome` (IN-14) is the terminal outcome of evaluateOshaDecisionTree
// below, e.g. from a POST .../osha-evaluation call. Optional and defaulted
// to null so every existing 2-arg caller (report-workflow.mjs's
// evaluateWorkflow) is unaffected; when given, a "recordable" tree outcome
// flags OSHA review on its own, independent of (and in addition to) the
// report_type/outcomes check above.
export function classifyOshaReview(reportType, outcomes = [], treeOutcome = null) {
  if (reportType === "accident" && outcomes.some((outcome) => oshaReviewTriggers.has(outcome))) {
    return true;
  }
  return treeOutcome === "recordable";
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

// --- Signatures (IN-13) ------------------------------------------------------
// Verbatim from INCIDENT_ACCIDENT_REPORTING_SYSTEM.md 2.1's
// `signature_role enum('reporter','witness','supervisor','manager')`.
export const SIGNATURE_ROLES = Object.freeze(["reporter", "witness", "supervisor", "manager"]);

const ATTESTATION_MAX_LENGTH = 2000;

// Pure. Mirrors the incident_signatures.attestation_text NOT NULL column: a
// blank attestation is never valid regardless of length, and the DB-facing
// route caps it at ATTESTATION_MAX_LENGTH so a signature's legal-attestation
// text can never silently grow unbounded. Returns { valid, error }, the same
// shape convention as validateIncidentCapture (incident-form.mjs) uses.
export function validateAttestationText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return { valid: false, error: "attestationText is required" };
  if (trimmed.length > ATTESTATION_MAX_LENGTH) {
    return { valid: false, error: `attestationText must be at most ${ATTESTATION_MAX_LENGTH} characters` };
  }
  return { valid: true, error: null };
}

// --- Compliance checks (IN-15) ------------------------------------------------
// Verbatim from INCIDENT_ACCIDENT_REPORTING_SYSTEM.md 2.2's
// `check_type enum('osha_recordability','supervisor_signoff','evidence_complete','legal_review')`.
export const COMPLIANCE_CHECK_KEYS = Object.freeze([
  "evidence_complete",
  "supervisor_signoff",
  "osha_recordability",
  "legal_review"
]);
export const COMPLIANCE_CHECK_STATUSES = Object.freeze(["pass", "fail", "waived"]);

// The severities design §9.4 ("require evidence checklist completion for
// high/critical cases") and this module's own closure gate (IN-02's
// canTransitionIncident) apply the evidence_complete requirement to.
const CLOSURE_GATE_SEVERITIES = new Set(["high", "critical"]);

function latestCheckStatus(complianceChecks, checkKey) {
  const row = (complianceChecks ?? []).find((check) => check?.check_key === checkKey);
  return row ? row.status : null;
}

// Pure. Decides whether an incident may close given its own severity/OSHA-
// review flag and the compliance-check rows recorded against it (raw
// snake_case rows as loaded from incident_compliance_checks -- {check_key,
// status, ...} -- matching openFollowUps' own "pass the DB rows straight
// through" convention elsewhere in this module). Mirrors the DB-side guard
// migration 0056 adds to fn_incident_report_transition_guard (0043/0048) --
// this function is what a route calls FIRST, for a specific, friendly
// rejection naming which check blocked the close; the trigger is what
// actually enforces the rule at the database layer, independent of write
// path.
//
// Required checks:
//   * "evidence_complete" -- any high/critical severity incident (design
//     §9.4).
//   * "supervisor_signoff" -- any incident with requiresOshaReview true
//     (IN-13's acceptance criterion: "closure gate extended to require
//     supervisor signoff when requires_osha_review").
// A required check with no recorded row, or one recorded "fail", blocks the
// close; "pass" or "waived" (waiving is itself gated to incidents.review at
// the route/RLS layer, not re-checked here) both satisfy it.
export function evaluateClosureGate(incident = {}, complianceChecks = []) {
  const required = [];
  if (CLOSURE_GATE_SEVERITIES.has(incident.severity)) required.push("evidence_complete");
  if (incident.requiresOshaReview) required.push("supervisor_signoff");

  for (const checkKey of required) {
    const status = latestCheckStatus(complianceChecks, checkKey);
    if (status === "pass" || status === "waived") continue;
    return {
      allowed: false,
      reason:
        status === "fail"
          ? `cannot close: compliance check "${checkKey}" failed`
          : `cannot close: compliance check "${checkKey}" has not passed`,
      reasonCode: "compliance_check_failed",
      blockingCheck: checkKey
    };
  }
  return { allowed: true, reason: null, reasonCode: null, blockingCheck: null };
}

// --- OSHA recordability decision tree (IN-14) ---------------------------------
// Every outcome the shipped default tree (settings-registry.mjs's
// incidents.oshaDecisionTree default) and a tenant-authored replacement may
// produce. "needs_more_info" is both a legitimate terminal leaf a tree can
// name AND this evaluator's own fallback for a malformed tree/incomplete
// answer set -- see evaluateOshaDecisionTree's header.
export const OSHA_OUTCOMES = Object.freeze(["recordable", "first_aid_only", "not_work_related", "needs_more_info"]);
const OSHA_RECORDABLE_OUTCOME = "recordable";
const OSHA_FALLBACK_OUTCOME = "needs_more_info";
const OSHA_MAX_TREE_DEPTH = 64; // guards a cyclic/malformed tenant-authored tree against an infinite walk

function oshaFallback(path) {
  return { outcome: OSHA_FALLBACK_OUTCOME, recordable: false, dueAt: null, path, malformed: true };
}

// Pure (except reading `now`, threaded in rather than read from the clock so
// callers/tests get a deterministic dueAt). Walks `tree` (settings-registry's
// incidents.oshaDecisionTree shape: { start, nodes: { [id]: { question, yes,
// no } }, timers }) from `tree.start`, following `answers[nodeId]` ("yes" or
// "no") at each node until a terminal leaf ({ outcome, timer? }) is reached.
// `answers` is a flat { [nodeId]: "yes" | "no" } map, e.g. from
// POST .../osha-evaluation's body.
//
// Returns { outcome, recordable, dueAt, path }:
//   * outcome    -- one of OSHA_OUTCOMES.
//   * recordable -- outcome === "recordable" (a plain convenience boolean so
//                   callers don't need to compare strings themselves).
//   * dueAt      -- an ISO string regulatory deadline (now + the terminal
//                   leaf's `timer` entry from tree.timers, if any), or null
//                   when the leaf carries no timer (every non-recordable
//                   outcome, and any recordable leaf whose tree omits one).
//   * path       -- [{ nodeId, question, answer }] in traversal order, for a
//                   review UI to render exactly which questions led to the
//                   outcome.
//
// Malformed-config / insufficient-answers fallback: a missing/non-object
// tree, a missing start node, a node absent from tree.nodes, or an
// answers[nodeId] that isn't "yes"/"no" all degrade to
// { outcome: "needs_more_info", recordable: false, dueAt: null, path,
// malformed: true } (path holds whatever nodes WERE legally walked before
// the point of failure) rather than throwing -- an incomplete or
// misconfigured determination must never crash the route, only fall back to
// the one outcome that always means "a human still needs to look at this".
export function evaluateOshaDecisionTree(tree, answers = {}, now = new Date()) {
  if (!tree || typeof tree !== "object" || typeof tree.start !== "string" || !tree.nodes || typeof tree.nodes !== "object") {
    return oshaFallback([]);
  }

  const path = [];
  let currentId = tree.start;
  for (let depth = 0; depth < OSHA_MAX_TREE_DEPTH; depth += 1) {
    const node = tree.nodes[currentId];
    if (!node || typeof node !== "object") return oshaFallback(path);

    const answer = answers?.[currentId];
    if (answer !== "yes" && answer !== "no") return oshaFallback(path);

    const next = node[answer];
    path.push({ nodeId: currentId, question: node.question ?? null, answer });

    if (next && typeof next === "object" && typeof next.outcome === "string") {
      if (!OSHA_OUTCOMES.includes(next.outcome)) return oshaFallback(path);
      let dueAt = null;
      if (next.timer && tree.timers && typeof tree.timers === "object") {
        const timer = tree.timers[next.timer];
        if (timer && typeof timer === "object") {
          const ms =
            (Number.isFinite(timer.hours) ? timer.hours * 60 * 60 * 1000 : 0) +
            (Number.isFinite(timer.days) ? timer.days * 24 * 60 * 60 * 1000 : 0);
          if (ms > 0) dueAt = new Date(now.getTime() + ms).toISOString();
        }
      }
      return { outcome: next.outcome, recordable: next.outcome === OSHA_RECORDABLE_OUTCOME, dueAt, path };
    }

    if (typeof next === "string") {
      currentId = next;
      continue;
    }

    // `next` is undefined/null/some other shape -- the tree names no legal
    // continuation for this answer.
    return oshaFallback(path);
  }

  // Depth exhausted without reaching a terminal leaf -- a cyclic tree.
  return oshaFallback(path);
}

// --- Retention (IN-16) -------------------------------------------------------
// Purely informational: retentionEligibleAt (and its class-selection helper
// below) never purges, deletes, or flags anything -- Wave 4 IN-25 owns the
// actual purge job, and per that plan row's own acceptance line ("skips
// legal_hold=true and closed-within-retention rows") a held incident stays
// under 0057's DB-layer delete guards regardless of what this function
// returns for it. This is just the date past which that future job would be
// PERMITTED to consider a row, exposed today on the incident detail response
// (retention_eligible_at) so a caller can see it coming.
//
// Class selection, in priority order -- three settings-registry keys drive
// the actual day counts (incidents.retentionDaysStandard/Osha/Minor):
//   1. "osha"     -- requires_osha_review is true. OSHA 1904.33 requires
//                    5-year retention of recordable injury/illness logs;
//                    retentionDaysOsha ships 1825 days (5 years) to match.
//   2. "minor"     -- a near_miss report, or a low-severity incident that
//                    never triggered OSHA review -- the lightest-weight
//                    record class this module tracks. retentionDaysMinor
//                    ships 1095 days (3 years).
//   3. "standard"  -- the fallback/default class: every other incident and
//                    accident report (medium/high/critical, or any severity
//                    once OSHA-recordable is excluded above).
//                    retentionDaysStandard ships 2555 days (7 years) -- the
//                    longest default, matching general liability/statute-of-
//                    limitations practice for the baseline legal record this
//                    module keeps when no narrower class applies.
// `incident` accepts the same camelCase shape escalationDueAt/
// shouldEscalateIncident already do (routes remap the raw snake_case DB row
// before calling in, e.g. incidents-routes.mjs's escalationDueAt call site).
export function incidentRetentionClass({ requiresOshaReview, reportType, severity } = {}) {
  if (requiresOshaReview === true) return "osha";
  if (reportType === "near_miss" || severity === "low") return "minor";
  return "standard";
}

const RETENTION_CONFIG_KEY_BY_CLASS = Object.freeze({
  osha: "incidents.retentionDaysOsha",
  minor: "incidents.retentionDaysMinor",
  standard: "incidents.retentionDaysStandard"
});

// Pure -- never reads the clock itself (matches escalationDueAt's own
// contract). Anchor is occurredAt (falling back to createdAt, then
// reportedAt) -- the incident's own factual date, the same anchor OSHA's
// "following the end of the calendar year the records cover" convention
// counts from, and the one timestamp every incident carries regardless of
// status. Returns a Date (matching escalationDueAt's return shape) or null
// when no anchor timestamp is available at all.
export function retentionEligibleAt(incident, config = {}) {
  const { occurredAt, createdAt, reportedAt } = incident ?? {};
  const anchor = occurredAt ?? createdAt ?? reportedAt;
  if (!anchor) return null;
  const anchorDate = new Date(anchor);
  if (Number.isNaN(anchorDate.getTime())) return null;

  const retentionClass = incidentRetentionClass(incident);
  const days = configValue(config, RETENTION_CONFIG_KEY_BY_CLASS[retentionClass]);
  return new Date(anchorDate.getTime() + days * 24 * 60 * 60 * 1000);
}
