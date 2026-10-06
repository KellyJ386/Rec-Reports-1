// Pure, DOM-free helpers behind the IN-19 supervisor review workspace: the
// timeline merge (audit events + amendments into one chronological view),
// a client-side closure-gate preview, and the form validators for the
// signature / compliance-check / OSHA-questionnaire forms. Mirrors
// src/lib/incidents.mjs's vocabularies/logic so the UI never diverges from
// the server's own check constraints and pure decision functions, but is
// deliberately NOT an import of that file: browser code cannot reach
// src/lib (it never ships to dist/), so the handful of constants/functions
// used here are copied, not shared -- matching incident-form.mjs's own
// stated convention.
//
// Everything here operates on plain data -- no `document`, no fetch -- so it
// is importable and testable under node:test without a browser.

// --- Timeline (audit events + amendments) ------------------------------------

// Merges GET /incidents/:id/audit-events rows and GET /incidents/:id/amendments
// rows into one chronological array, oldest first, each entry tagged with
// `kind` ("audit" | "amendment") and a common `at` (ISO string) field so a
// single render loop can walk the combined history without branching on
// shape first. Every entry also carries `immutable: true` -- both source
// tables are append-only at the database layer (incident_audit_events:
// migration 0013's hash-chain trigger + 0038's block-mutation trigger;
// incident_amendments: RLS-by-omission, no UPDATE/DELETE policy at all) --
// so the review workspace can label the merged timeline as a whole
// immutable record rather than re-deriving that fact per entry from two
// different row shapes.
//
// Ties (identical `at`) are broken by insertion order (Array.prototype.sort
// is stable per the ECMAScript spec since ES2019, which this codebase's
// target runtime satisfies) -- audit events passed first in the input
// arrays sort before amendments at the exact same instant, an arbitrary but
// deterministic choice.
export function mergeIncidentTimeline(auditEvents = [], amendments = []) {
  const auditEntries = (auditEvents ?? []).map((event) => ({
    kind: "audit",
    at: event.created_at,
    immutable: true,
    eventType: event.event_type,
    actorUserId: event.actor_user_id ?? null,
    payload: event.event_payload ?? {},
    raw: event
  }));
  const amendmentEntries = (amendments ?? []).map((amendment) => ({
    kind: "amendment",
    at: amendment.amended_at,
    immutable: true,
    eventType: "incident.amended",
    actorUserId: amendment.amended_by ?? null,
    payload: { reason: amendment.amendment_reason },
    raw: amendment
  }));
  return [...auditEntries, ...amendmentEntries].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

// --- Closure gate preview -----------------------------------------------------

const CLOSURE_GATE_SEVERITIES = new Set(["high", "critical"]);

function latestCheckStatus(complianceChecks, checkKey) {
  const row = (complianceChecks ?? []).find((check) => check?.check_key === checkKey);
  return row ? row.status : null;
}

// Client-side preview of evaluateClosureGate (src/lib/incidents.mjs) -- lets
// the review workspace show a supervisor/reviewer whether "close" would
// currently be accepted, and by which specific check it would be blocked,
// WITHOUT attempting the transition. The server (both the route's own call
// to evaluateClosureGate and the DB trigger's guard 2.5, migration 0056)
// remains the actual authority; this is a preview only, kept in exact sync
// with that function's rules so the UI is never predicting something the
// server will disagree with. `incident` here is GET /incidents/:id's raw
// (snake_case) response shape.
export function evaluateClosureGatePreview(incident = {}, complianceChecks = []) {
  const required = [];
  if (CLOSURE_GATE_SEVERITIES.has(incident.severity)) required.push("evidence_complete");
  if (incident.requires_osha_review) required.push("supervisor_signoff");

  for (const checkKey of required) {
    const status = latestCheckStatus(complianceChecks, checkKey);
    if (status === "pass" || status === "waived") continue;
    return {
      allowed: false,
      blockingCheck: checkKey,
      reason:
        status === "fail"
          ? `Cannot close: "${checkKey}" compliance check failed.`
          : `Cannot close: "${checkKey}" compliance check has not passed.`
    };
  }
  return { allowed: true, blockingCheck: null, reason: null };
}

// --- Signatures (IN-13) -------------------------------------------------------

// Verbatim from incident_signatures' role check constraint (migration 0056)
// / src/lib/incidents.mjs's SIGNATURE_ROLES.
export const SIGNATURE_ROLES = ["reporter", "witness", "supervisor", "manager"];
const ATTESTATION_MAX_LENGTH = 2000;

export function validateSignatureInput(fields = {}) {
  const errors = {};
  if (!fields.role || !SIGNATURE_ROLES.includes(fields.role)) {
    errors.role = `Select one of: ${SIGNATURE_ROLES.join(", ")}.`;
  }
  const attestation = (fields.attestationText || "").trim();
  if (!attestation) {
    errors.attestationText = "An attestation statement is required.";
  } else if (attestation.length > ATTESTATION_MAX_LENGTH) {
    errors.attestationText = `Attestation must be at most ${ATTESTATION_MAX_LENGTH} characters.`;
  }
  if (!fields.signedName || !fields.signedName.trim()) {
    errors.signedName = "Signed name is required.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildSignaturePayload(fields = {}) {
  const payload = {
    role: fields.role,
    attestationText: (fields.attestationText || "").trim(),
    signedName: (fields.signedName || "").trim()
  };
  if (fields.signatureImagePath) payload.signatureImagePath = fields.signatureImagePath;
  return payload;
}

// --- Compliance checks (IN-15) ------------------------------------------------

// Verbatim from incident_compliance_checks' check_key/status check
// constraints (migration 0056) / src/lib/incidents.mjs's
// COMPLIANCE_CHECK_KEYS/COMPLIANCE_CHECK_STATUSES.
export const COMPLIANCE_CHECK_KEYS = ["evidence_complete", "supervisor_signoff", "osha_recordability", "legal_review"];
export const COMPLIANCE_CHECK_STATUSES = ["pass", "fail", "waived"];

export function validateComplianceCheckInput(fields = {}) {
  const errors = {};
  if (!fields.checkKey || !COMPLIANCE_CHECK_KEYS.includes(fields.checkKey)) {
    errors.checkKey = `Select one of: ${COMPLIANCE_CHECK_KEYS.join(", ")}.`;
  }
  if (!fields.status || !COMPLIANCE_CHECK_STATUSES.includes(fields.status)) {
    errors.status = `Select one of: ${COMPLIANCE_CHECK_STATUSES.join(", ")}.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// `canWaive` (default false) mirrors the server's own "waive requires
// incidents.review" rule -- when the caller only holds incidents.manage,
// this rejects a 'waived' status client-side with the same reason the RLS
// policy/route would, before a round trip confirms it.
export function complianceCheckStatusOptions(canWaive = false) {
  return canWaive ? COMPLIANCE_CHECK_STATUSES : COMPLIANCE_CHECK_STATUSES.filter((status) => status !== "waived");
}

export function buildCompliancePayload(fields = {}) {
  const payload = { checkKey: fields.checkKey, status: fields.status };
  const notes = (fields.notes || "").trim();
  if (notes) payload.notes = notes;
  return payload;
}

// --- OSHA decision-tree questionnaire (IN-14) ---------------------------------

// Walks `tree` (the shape GET /facilities/:id/incidents/osha-decision-tree
// returns) from tree.start using the answers already collected in
// `answers` ({ [nodeId]: "yes" | "no" }), and returns EITHER the next
// question to ask ({ done: false, nodeId, question }) or the terminal
// result ({ done: true, outcome, path }) once a leaf is reached. Mirrors
// evaluateOshaDecisionTree's traversal (src/lib/incidents.mjs) but stops at
// the next unanswered node rather than requiring every answer up front --
// exactly what a one-question-at-a-time questionnaire UI needs; the actual
// scored result (including dueAt, which needs a trusted server clock) still
// only ever comes from POST .../osha-evaluation's response. Depth-bounded
// against a cyclic/malformed tenant-authored tree the same way
// evaluateOshaDecisionTree is.
const OSHA_MAX_TREE_DEPTH = 64;

export function nextOshaQuestion(tree, answers = {}) {
  if (!tree || typeof tree !== "object" || typeof tree.start !== "string" || !tree.nodes || typeof tree.nodes !== "object") {
    return { done: true, outcome: "needs_more_info", path: [], malformed: true };
  }

  const path = [];
  let currentId = tree.start;
  for (let depth = 0; depth < OSHA_MAX_TREE_DEPTH; depth += 1) {
    const node = tree.nodes[currentId];
    if (!node || typeof node !== "object") {
      return { done: true, outcome: "needs_more_info", path, malformed: true };
    }

    const answer = answers[currentId];
    if (answer !== "yes" && answer !== "no") {
      return { done: false, nodeId: currentId, question: node.question ?? null, path };
    }

    path.push({ nodeId: currentId, question: node.question ?? null, answer });
    const next = node[answer];

    if (next && typeof next === "object" && typeof next.outcome === "string") {
      return { done: true, outcome: next.outcome, path };
    }
    if (typeof next === "string") {
      currentId = next;
      continue;
    }
    return { done: true, outcome: "needs_more_info", path, malformed: true };
  }
  return { done: true, outcome: "needs_more_info", path, malformed: true };
}

export function buildOshaEvaluationPayload(answers = {}) {
  return { answers: { ...answers } };
}
