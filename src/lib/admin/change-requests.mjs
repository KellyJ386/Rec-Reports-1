// Pure helpers for the admin_change_requests draft -> review -> publish
// workflow (0008:70, state machine enforced in 0014's
// fn_enforce_change_request_transition). These mirror the DB trigger's rules
// exactly so the API can reject an illegal transition with a clean 409 before
// ever reaching Postgres, and so the two layers can never disagree about what
// counts as a legal move.

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CHANGE_REQUEST_STATUSES = Object.freeze([
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "published"
]);

// action -> { from, to } legal transition. Mirrors
// fn_enforce_change_request_transition() in 0014_change_requests.sql, action
// for action.
export const TRANSITIONS = Object.freeze({
  submit: Object.freeze({ from: "draft", to: "pending_review" }),
  approve: Object.freeze({ from: "pending_review", to: "approved" }),
  reject: Object.freeze({ from: "pending_review", to: "rejected" }),
  publish: Object.freeze({ from: "approved", to: "published" })
});

// Shapes the insert row for a new change request. Always starts in 'draft' --
// the caller advances it through submit/approve/reject/publish (via
// advanceChangeRequest and the /change-requests/:id/:action endpoints) from
// there.
export function createChangeRequest({
  facilityId,
  entityTable,
  entityId,
  changeSummary,
  before,
  after,
  requestedBy
}) {
  return {
    facility_id: facilityId,
    entity_table: entityTable,
    entity_id: entityId ?? null,
    change_summary: changeSummary,
    before_jsonb: before ?? {},
    after_jsonb: after ?? {},
    status: "draft",
    requested_by: requestedBy ?? null
  };
}

// Boundary validator for the POST .../change-requests body. { valid, errors[] }
// in the report-schema.mjs style so the route layer can map failures to 400.
export function validateChangeRequestInput(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (!isNonEmptyString(payload.entityTable)) {
    errors.push("entityTable is required");
  }
  if (!isNonEmptyString(payload.changeSummary)) {
    errors.push("changeSummary is required");
  }
  if (payload.before !== undefined && payload.before !== null && !isPlainObject(payload.before)) {
    errors.push("before must be an object");
  }
  if (payload.after !== undefined && payload.after !== null && !isPlainObject(payload.after)) {
    errors.push("after must be an object");
  }
  return { valid: errors.length === 0, errors };
}

// Whether `action` is legal from `currentStatus`, matching the DB trigger's
// transition table exactly (draft->pending_review->approved|rejected->published).
export function canTransition(currentStatus, action) {
  const transition = TRANSITIONS[action];
  if (!transition) {
    return { allowed: false, nextStatus: null, reason: `unknown action: ${action}` };
  }
  if (currentStatus !== transition.from) {
    return {
      allowed: false,
      nextStatus: null,
      reason: `cannot ${action} a change request in status "${currentStatus}" (expected "${transition.from}")`
    };
  }
  return { allowed: true, nextStatus: transition.to, reason: null };
}

// Computes the UPDATE patch for advancing a change request by one action,
// mirroring fn_enforce_change_request_transition() in the DB bit for bit:
//   * illegal transitions            -> { error }
//   * approve/reject require an actor and stamp reviewed_by/reviewed_at
//   * approve additionally blocks self-approval (reviewer === requester)
//   * publish stamps published_at
// Returns a plain patch object ({ status, reviewed_by?, reviewed_at?,
// published_at? }) on success, or { error } on failure -- never both.
export function advanceChangeRequest(cr, action, actorUserId) {
  if (!cr || !isNonEmptyString(cr.status)) {
    return { error: "a change request with a status is required" };
  }

  const { allowed, nextStatus, reason } = canTransition(cr.status, action);
  if (!allowed) {
    return { error: reason };
  }

  if ((action === "approve" || action === "reject") && !isNonEmptyString(actorUserId)) {
    return { error: `${action} requires an actor` };
  }

  if (action === "approve" && cr.requested_by && actorUserId === cr.requested_by) {
    return { error: "a change request cannot be self-approved (reviewer must differ from requester)" };
  }

  const patch = { status: nextStatus };
  if (action === "approve" || action === "reject") {
    patch.reviewed_by = actorUserId;
    patch.reviewed_at = new Date().toISOString();
  }
  if (action === "publish") {
    patch.published_at = new Date().toISOString();
  }
  return patch;
}
