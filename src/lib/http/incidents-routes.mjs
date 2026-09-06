import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { reportError } from "../observability.mjs";
import { requireAuthPermission } from "./guard.mjs";
import {
  escalationDueAt,
  isEscalationOverdue,
  canTransitionIncident,
  buildIncidentAuditEvent,
  buildAmendment,
  nextIncidentNo,
  requiredIncidentFollowUps,
  INCIDENT_STATUSES
} from "../incidents.mjs";
import { buildIncidentPdfPackage } from "../incident-pdf.mjs";

const READ = "incidents.read";
const MANAGE = "incidents.manage";
const REVIEW = "incidents.review";
const LEGAL_HOLD_MANAGE = "incidents.legal_hold.manage";
const TASKS_CREATE = "incidents.tasks.create";
const EXPORT_PDF = "incidents.export.pdf";

// Follow-up action_type / status vocabularies, verbatim from the check
// constraints on incident_followup_actions (0004_incidents.sql:74-75).
const FOLLOWUP_ACTION_TYPES = ["corrective_action", "investigation", "documentation", "equipment_fix", "training"];
const FOLLOWUP_STATUSES = ["open", "in_progress", "completed", "waived"];
// Escalation status vocabulary, verbatim from incident_escalations'
// check constraint (0004_incidents.sql:61).
const ESCALATION_STATUSES = ["pending", "acknowledged", "resolved", "expired"];

// Permission codes the transition machine (canTransitionIncident) consults.
// Gathered once per request into a plain string[] via requireAuthPermission
// (which already honors auth.platformAdmin) so the pure function never has
// to see auth/membership shapes.
const TRANSITION_PERMISSION_CODES = [MANAGE, REVIEW, LEGAL_HOLD_MANAGE];

// Open (not completed/waived) follow-up actions block closing an incident
// (IN-02's closure gate). Only queried when the target status is "closed".
const OPEN_FOLLOWUP_STATUSES = ["open", "in_progress"];

const INCIDENT_COLUMNS =
  "id,facility_id,department_id,incident_no,report_type,status,severity,occurred_at,reported_at," +
  "location_text,summary,immediate_actions,requires_osha_review,legal_hold,submitted_by,submitted_at," +
  "created_at,updated_at";
const ESCALATION_COLUMNS =
  "id,facility_id,incident_id,escalation_level,reason_code,target_role,target_user_id,status,due_at," +
  "acknowledged_at,created_at,updated_at";
const FOLLOWUP_COLUMNS =
  "id,facility_id,incident_id,owner_user_id,action_type,status,due_at,description,completed_at," +
  "created_at,updated_at";
const AMENDMENT_COLUMNS =
  "id,facility_id,incident_id,amendment_reason,before_snapshot,after_snapshot,amended_by,amended_at";
const PEOPLE_COLUMNS =
  "id,facility_id,incident_id,person_role,full_name,contact_json,injury_json,statement_text," +
  "statement_submitted_at,created_at,updated_at";

// Registers the end-user Incidents API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require incidents.read on the row's facility; creating or escalating
// an incident requires incidents.manage.
export function registerIncidentRoutes(router, { authenticate, sendJson, readBody }) {
  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  function requireRead(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, READ);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function requirePerm(auth, facilityId, code, response) {
    const guard = requireAuthPermission(auth, facilityId, code);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  // Allowed if the actor holds ANY of `codes` at facilityId. Used where a
  // capability is legitimately reachable by more than one role (amendments:
  // documented below at the route registration).
  function requireAnyPerm(auth, facilityId, codes, response) {
    const allowed = codes.some((code) => requireAuthPermission(auth, facilityId, code).allowed);
    if (!allowed) {
      sendJson(response, 403, { error: `missing permission: one of ${codes.join(", ")}` });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  // Inserts one incident_audit_events row, used at every one of this
  // module's domain-write -> audit-write sites (escalate/acknowledge/
  // resolve, submit, transition, amend, follow-up create/complete, PDF
  // export). The domain write and this audit write are two separate REST
  // calls, not one transaction, so a failure here (network blip, RLS
  // hiccup, ...) leaves the domain write already committed with no audit
  // record of it -- a real gap, not just a formality, since these events
  // are the legal-defensibility trail IN-01/IN-04 depend on. The correct
  // fix is a single transactional RPC that writes both rows atomically
  // (tracked as Wave 3 IN-22); until that lands, every call site routes
  // through this one helper so the failure is handled identically
  // everywhere instead of nine slightly different ad hoc try/catches: the
  // caller gets a clear 500 naming the incident whose audit trail is now
  // incomplete, and the failure is reported (fire-and-forget, per
  // observability.mjs's contract -- never awaited, never allowed to slow
  // or fail the response) so it's visible for manual reconciliation
  // instead of silently vanishing.
  //
  // Returns true on success. On failure it has already sent the response
  // itself (matching this module's requireRead/requirePerm convention) --
  // every call site must check the return value and bail out (`return`)
  // without sending anything further.
  async function writeAuditEvent(auth, response, env, event) {
    try {
      await pgInsert(auth.client, "incident_audit_events", [event], { returning: false });
      return true;
    } catch (error) {
      // L-8: reportError is a silent no-op when OBSERVABILITY_DSN is unset
      // (see observability.mjs -- `if (!dsn) return Promise.resolve();`),
      // which is the normal local/dev state. Without a DSN, "the failure is
      // reported ... so it's visible for manual reconciliation" (above) was
      // not actually true -- console.error here is the local-log fallback
      // that makes it true unconditionally, DSN configured or not.
      console.error(
        `incidents.audit_write/${event.event_type} failed for incident ${event.incident_id}:`,
        error
      );
      reportError(error, {
        dsn: env?.OBSERVABILITY_DSN,
        route: `incidents.audit_write/${event.event_type}`,
        status: 500,
        requestId: event.incident_id,
        userId: auth.claims?.sub ?? null
      });
      sendJson(response, 500, { error: "audit write failed", entity_id: event.incident_id });
      return false;
    }
  }

  // Collapses the actor's membership into the plain permission-code list
  // canTransitionIncident expects, reusing requireAuthPermission (and its
  // auth.platformAdmin bypass, 0022) per code rather than reaching into
  // auth.memberships directly.
  function actorPermissionsFor(auth, facilityId) {
    return TRANSITION_PERMISSION_CODES.filter(
      (code) => requireAuthPermission(auth, facilityId, code).allowed
    );
  }

  // Maps a canTransitionIncident rejection to an HTTP status: a forbidden
  // actor is 403; a structurally illegal edge or a closure gate (open
  // follow-ups / unmanaged legal hold) is 409 -- the incident's own state
  // is what's blocking the request, not the caller's identity.
  function transitionStatusCode(reasonCode) {
    return reasonCode === "forbidden" ? 403 : 409;
  }

  async function loadIncident(client, incidentId) {
    const rows = await pgSelect(client, "incident_reports", {
      filters: { id: incidentId },
      select: INCIDENT_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadFollowup(client, followupId) {
    const rows = await pgSelect(client, "incident_followup_actions", {
      filters: { id: followupId },
      select: FOLLOWUP_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadEscalation(client, escalationId) {
    const rows = await pgSelect(client, "incident_escalations", {
      filters: { id: escalationId },
      select: ESCALATION_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Incidents ---------------------------------------------------------
  // Lists incident reports for a facility. Optional ?status= filter.
  // Newest (occurred_at) first.
  router.register(
    "GET",
    "/facilities/:facilityId/incidents",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        if (status) filters.status = status;
        const rows = await pgSelect(auth.client, "incident_reports", {
          filters,
          select: INCIDENT_COLUMNS,
          order: "occurred_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Returns a single incident report.
  router.register(
    "GET",
    "/incidents/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireRead(auth, incident.facility_id, response)) return;
        return sendJson(response, 200, incident);
      })
  );

  // Creates a draft incident report. Validates required shape first (no fetch
  // on validation failure), then inserts the row. incident_no (IN-09) is
  // always server-generated -- any client-supplied incidentNo in the body is
  // ignored outright, never merely overridden, since the numbering is a
  // legal identifier and must be fully server-authoritative.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { reportType, severity, occurredAt, locationText, summary } = body.payload;
        const shape = [];
        if (!reportType) shape.push("reportType is required");
        if (!severity) shape.push("severity is required");
        if (!occurredAt) shape.push("occurredAt is required");
        if (!locationText) shape.push("locationText is required");
        if (!summary) shape.push("summary is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.departmentId ?? null,
          report_type: reportType,
          severity,
          occurred_at: occurredAt,
          reported_at: new Date().toISOString(),
          location_text: locationText,
          summary,
          immediate_actions: body.payload.immediateActions ?? null,
          requires_osha_review: body.payload.requiresOshaReview ?? false,
          legal_hold: body.payload.legalHold ?? false,
          status: "draft"
        };

        // Numbering is generated from this facility's existing incident_no
        // values (max+1 per calendar year, nextIncidentNo -- IN-09) and
        // retried once on a unique-constraint collision (the
        // (facility_id, incident_no) unique index, 0004_incidents.sql:21):
        // a second insert re-reads the facility's incident_no list so the
        // retry's number reflects the row that just won the race.
        const year = new Date().getUTCFullYear();
        let inserted = null;
        for (let attempt = 0; attempt < 2 && inserted === null; attempt += 1) {
          const existing = await pgSelect(auth.client, "incident_reports", {
            filters: { facility_id: params.facilityId },
            select: "incident_no"
          });
          const incidentNo = nextIncidentNo((existing ?? []).map((r) => r.incident_no), year);
          try {
            const rows = await pgInsert(auth.client, "incident_reports", [{ ...row, incident_no: incidentNo }], {
              returning: true
            });
            inserted = (rows ?? [])[0] ?? null;
          } catch (err) {
            const isConflict = err instanceof PostgrestError && err.status === 409;
            if (isConflict && attempt === 0) continue; // one retry with a freshly recomputed number
            if (isConflict) {
              return sendJson(response, 409, {
                error: "unable to generate a unique incident number, please retry"
              });
            }
            throw err;
          }
        }
        return sendJson(response, 201, inserted);
      })
  );

  // Escalates an incident: loads the incident, guards, then inserts an
  // escalation row with due_at computed from escalationDueAt. Body is
  // optional; when present, `level` (positive integer), `targetRole`
  // (non-empty string) and `reasonCode` (non-empty string) are validated
  // before the incident is loaded (shape-only checks that don't need the
  // row), each defaulting to the prior hardcoded values (1 / "manager" /
  // "user_escalation") when omitted so existing callers are unaffected.
  // `targetUserId` is passed through as-is (optional, nullable).
  router.register(
    "POST",
    "/incidents/:id/escalate",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { level, targetRole, reasonCode, targetUserId } = body.payload;
        const shape = [];
        if (level !== undefined && (!Number.isInteger(level) || level < 1)) {
          shape.push("level must be a positive integer");
        }
        if (targetRole !== undefined && (typeof targetRole !== "string" || !targetRole.trim())) {
          shape.push("targetRole must be a non-empty string");
        }
        if (reasonCode !== undefined && (typeof reasonCode !== "string" || !reasonCode.trim())) {
          shape.push("reasonCode must be a non-empty string");
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requirePerm(auth, incident.facility_id, MANAGE, response)) return;

        // escalationDueAt reads camelCase reportedAt/createdAt/occurredAt;
        // loadIncident returns the raw (snake_case) DB row, so it is remapped
        // here rather than passed straight through.
        const dueAt = escalationDueAt({
          reportedAt: incident.reported_at,
          createdAt: incident.created_at,
          occurredAt: incident.occurred_at
        });
        const escalation = {
          facility_id: incident.facility_id,
          incident_id: incident.id,
          escalation_level: level ?? 1,
          reason_code: reasonCode ?? "user_escalation",
          target_role: targetRole ?? "manager",
          target_user_id: targetUserId ?? null,
          status: "pending",
          due_at: dueAt || new Date().toISOString()
        };
        const rows = await pgInsert(auth.client, "incident_escalations", [escalation], {
          returning: true
        });
        const createdEscalation = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.escalated",
            payload: {
              actor: auth.claims.sub,
              escalationId: createdEscalation?.id ?? null,
              level: escalation.escalation_level,
              targetRole: escalation.target_role,
              reasonCode: escalation.reason_code
            }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 201, createdEscalation);
      })
  );

  // Acknowledges a pending escalation: pending -> acknowledged only.
  // acknowledged_at is always server-stamped. Guarded by incidents.manage --
  // matching incident_escalations' RLS write policy ("incident managers can
  // manage escalations", 0004/0026), so an HTTP-layer allow is never granted
  // to an actor whose write would be rejected at the database layer anyway.
  router.register(
    "POST",
    "/escalations/:id/acknowledge",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const escalation = await loadEscalation(auth.client, params.id);
        if (!escalation) return sendJson(response, 404, { error: "escalation not found" });
        if (!requirePerm(auth, escalation.facility_id, MANAGE, response)) return;
        if (escalation.status !== "pending") {
          return sendJson(response, 409, {
            error: `cannot acknowledge an escalation with status "${escalation.status}" (must be pending)`
          });
        }

        const acknowledgedAt = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "incident_escalations",
          { id: escalation.id },
          { status: "acknowledged", acknowledged_at: acknowledgedAt, updated_at: acknowledgedAt },
          { returning: true }
        );

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: escalation.facility_id,
            incidentId: escalation.incident_id,
            actorUserId: auth.claims.sub,
            eventType: "incident.escalation_acknowledged",
            payload: { actor: auth.claims.sub, escalationId: escalation.id, from: "pending", to: "acknowledged" }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Resolves an escalation: acknowledged -> resolved only (an unacknowledged
  // escalation must be acknowledged first; incident_escalations has no
  // resolved_at column, 0004_incidents.sql:53-67, so only status/updated_at
  // are stamped).
  router.register(
    "POST",
    "/escalations/:id/resolve",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const escalation = await loadEscalation(auth.client, params.id);
        if (!escalation) return sendJson(response, 404, { error: "escalation not found" });
        if (!requirePerm(auth, escalation.facility_id, MANAGE, response)) return;
        if (escalation.status !== "acknowledged") {
          return sendJson(response, 409, {
            error: `cannot resolve an escalation with status "${escalation.status}" (must be acknowledged)`
          });
        }

        const rows = await pgUpdate(
          auth.client,
          "incident_escalations",
          { id: escalation.id },
          { status: "resolved", updated_at: new Date().toISOString() },
          { returning: true }
        );

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: escalation.facility_id,
            incidentId: escalation.incident_id,
            actorUserId: auth.claims.sub,
            eventType: "incident.escalation_resolved",
            payload: { actor: auth.claims.sub, escalationId: escalation.id, from: "acknowledged", to: "resolved" }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Lists a facility's incident escalations, optionally filtered by
  // ?status=. Each row gains an `overdue` boolean: true when the escalation
  // is still unresolved (not resolved/expired) and past its stored due_at --
  // isEscalationOverdue(incident.dueAt) reuses the SLA-overdue check
  // against the escalation's own due_at rather than recomputing one, per its
  // dueAt-override doc comment in incidents.mjs.
  router.register(
    "GET",
    "/facilities/:facilityId/incident-escalations",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        if (status) filters.status = status;
        const rows = await pgSelect(auth.client, "incident_escalations", {
          filters,
          select: ESCALATION_COLUMNS,
          order: "due_at.asc"
        });
        const now = new Date();
        const withOverdue = (rows ?? []).map((row) => ({
          ...row,
          overdue:
            row.status !== "resolved" && row.status !== "expired" && isEscalationOverdue({ dueAt: row.due_at }, now)
        }));
        return sendJson(response, 200, withOverdue);
      })
  );

  // Submits a draft incident: loads it, runs the draft->submitted edge
  // through the transition machine (submit needs incidents.manage or being
  // the creator -- see canTransitionIncident's doc comment for why routes
  // currently always pass isCreator: false), stamps submitted_by/
  // submitted_at server-side (never client-supplied), and writes an
  // incident_audit_events row -- the DB trigger from 0013 fills in
  // prev_hash/row_hash on insert. The response also carries
  // `suggestedFollowUps` (IN-05): requiredIncidentFollowUps's output for this
  // incident's severity/legal-hold/OSHA-review state -- SUGGESTIONS only,
  // never auto-inserted as incident_followup_actions rows; a caller decides
  // which (if any) to create via POST /incidents/:id/followups.
  router.register(
    "POST",
    "/incidents/:id/submit",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });

        const actorPermissions = actorPermissionsFor(auth, incident.facility_id);
        const check = canTransitionIncident(incident.status, "submitted", {
          actorPermissions,
          isCreator: false
        });
        if (!check.allowed) {
          return sendJson(response, transitionStatusCode(check.reasonCode), { error: check.reason });
        }

        const submittedAt = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "incident_reports",
          { id: incident.id },
          { status: "submitted", submitted_by: auth.claims.sub, submitted_at: submittedAt },
          { returning: true }
        );

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.submitted",
            payload: { actor: auth.claims.sub, from: incident.status, to: "submitted" }
          })
        );
        if (!auditOk) return;

        const suggestedFollowUps = requiredIncidentFollowUps({
          severity: incident.severity,
          legalHold: incident.legal_hold,
          requiresOshaReview: incident.requires_osha_review
        });

        return sendJson(response, 200, { ...((rows ?? [])[0] ?? null), suggestedFollowUps });
      })
  );

  // Guarded status transition: body { to, reason? }. Shape is validated
  // (to must be one of INCIDENT_STATUSES) before any fetch, matching the
  // file's validate-before-guard pattern. Review/close moves (everything
  // past draft->submitted) require incidents.review, enforced inside
  // canTransitionIncident; closing additionally consults open follow-ups and
  // legal_hold. Every successful transition writes an incident_audit_events
  // row.
  router.register(
    "POST",
    "/incidents/:id/status",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { to, reason } = body.payload;
        if (!to || !INCIDENT_STATUSES.includes(to)) {
          return sendJson(response, 400, { error: `to must be one of: ${INCIDENT_STATUSES.join(", ")}` });
        }

        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });

        const actorPermissions = actorPermissionsFor(auth, incident.facility_id);

        let openFollowUps = [];
        if (to === "closed") {
          openFollowUps = await pgSelect(auth.client, "incident_followup_actions", {
            filters: { incident_id: incident.id, status: { in: OPEN_FOLLOWUP_STATUSES } },
            select: "id"
          });
        }

        const check = canTransitionIncident(incident.status, to, {
          actorPermissions,
          openFollowUps: openFollowUps ?? [],
          legalHold: incident.legal_hold === true
        });
        if (!check.allowed) {
          return sendJson(response, transitionStatusCode(check.reasonCode), { error: check.reason });
        }

        const rows = await pgUpdate(
          auth.client,
          "incident_reports",
          { id: incident.id },
          { status: to },
          { returning: true }
        );

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.status_changed",
            payload: { actor: auth.claims.sub, from: incident.status, to, reason: reason ?? null }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Amendments (IN-04) -----------------------------------------------
  // Lists an incident's amendment history, oldest first (a readable
  // chronological record of what changed over the incident's lifetime).
  router.register(
    "GET",
    "/incidents/:id/amendments",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireRead(auth, incident.facility_id, response)) return;
        const rows = await pgSelect(auth.client, "incident_amendments", {
          filters: { incident_id: incident.id },
          select: AMENDMENT_COLUMNS,
          order: "amended_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Amends a submitted-or-later incident: loads the current row as the
  // before-snapshot, applies the patch via buildAmendment (IN-04 -- the
  // allow-list, hashing, and validation all live there), UPDATEs
  // incident_reports with the patch, and inserts BOTH an incident_amendments
  // row (the durable before/after snapshot pair) AND an incident_audit_events
  // row (the hash-chained ledger entry, carrying the snapshot hashes so a
  // later reader can tie the amendment's content to the tamper-evident
  // chain even independent of incident_amendments' own RLS posture -- see
  // supabase/tests/incident_immutability.sql).
  //
  // Draft incidents are rejected with 409: a draft has no material history to
  // amend yet -- it is still a plain, freely-PATCHable in-progress record (no
  // PATCH /incidents/:id route exists in this API today, but the status
  // machine's own draft->submitted freeze is what this 409 is protecting:
  // amendments only make sense once a report has been submitted and is
  // subject to the append-only/audit regime).
  //
  // Guard: incidents.manage OR incidents.review (requireAnyPerm). Amending is
  // reachable by either a manager correcting/reclassifying their own report
  // or a reviewer doing so during review -- unlike the status machine's
  // review/close moves (incidents.review only), amendments are not
  // inherently a review-stage action, so incidents.manage alone (the same
  // permission that gates submit and incident_reports RLS writes generally)
  // is also sufficient. Both codes are legal under incident_reports' RLS
  // write policy (gated on incidents.manage only, 0004:124) -- a
  // review-only actor's UPDATE would in fact be rejected at the database
  // layer today; this is flagged in the RLS-gap section of the migration
  // note below rather than silently narrowed here, since IN-01 deliberately
  // ships incidents.review as a real code for this module.
  router.register(
    "POST",
    "/incidents/:id/amendments",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireAnyPerm(auth, incident.facility_id, [MANAGE, REVIEW], response)) return;
        if (incident.status === "draft") {
          return sendJson(response, 409, {
            error: "draft incidents cannot be amended; edit the draft directly instead"
          });
        }

        const built = buildAmendment(incident, body.payload.patch, {
          reason: body.payload.reason,
          actor: auth.claims.sub
        });
        if (built.error) return sendJson(response, 400, { error: built.error });

        const incidentRows = await pgUpdate(
          auth.client,
          "incident_reports",
          { id: incident.id },
          built.patch,
          { returning: true }
        );

        const amendmentRows = await pgInsert(
          auth.client,
          "incident_amendments",
          [
            {
              facility_id: incident.facility_id,
              incident_id: incident.id,
              amendment_reason: built.reason,
              before_snapshot: built.beforeSnapshot,
              after_snapshot: built.afterSnapshot,
              amended_by: auth.claims.sub
            }
          ],
          { returning: true }
        );

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.amended",
            payload: {
              actor: auth.claims.sub,
              reason: built.reason,
              fields: built.changedFields,
              beforeHash: built.beforeHash,
              afterHash: built.afterHash
            }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 201, {
          incident: (incidentRows ?? [])[0] ?? null,
          amendment: (amendmentRows ?? [])[0] ?? null
        });
      })
  );

  // --- Follow-up actions (IN-05) ------------------------------------------
  // Lists an incident's follow-up actions, soonest-due first.
  router.register(
    "GET",
    "/incidents/:id/followups",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireRead(auth, incident.facility_id, response)) return;
        const rows = await pgSelect(auth.client, "incident_followup_actions", {
          filters: { incident_id: incident.id },
          select: FOLLOWUP_COLUMNS,
          order: "due_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a follow-up action on an incident. Guarded by
  // incidents.tasks.create (distinct from incidents.manage -- a frontline
  // supervisor can be trusted to open a corrective-action task without
  // holding full incident-management rights, per IN-01's permission
  // design). action_type/status vocabularies are validated against the
  // 0004 check constraints before any fetch; status always starts "open"
  // regardless of what the body sends, matching the table's own default.
  router.register(
    "POST",
    "/incidents/:id/followups",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { actionType, description, dueAt, ownerUserId } = body.payload;
        const shape = [];
        if (!actionType || !FOLLOWUP_ACTION_TYPES.includes(actionType)) {
          shape.push(`actionType must be one of: ${FOLLOWUP_ACTION_TYPES.join(", ")}`);
        }
        if (!description) shape.push("description is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requirePerm(auth, incident.facility_id, TASKS_CREATE, response)) return;

        const row = {
          facility_id: incident.facility_id,
          incident_id: incident.id,
          owner_user_id: ownerUserId ?? null,
          action_type: actionType,
          status: "open",
          due_at: dueAt ?? null,
          description
        };
        const rows = await pgInsert(auth.client, "incident_followup_actions", [row], { returning: true });
        const created = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.followup_created",
            payload: { actor: auth.claims.sub, followupId: created?.id ?? null, actionType, description }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 201, created);
      })
  );

  // Updates a follow-up action: status/owner/due_at/completed_at. Guarded by
  // incidents.manage (a stricter gate than creation -- reassigning owners,
  // rescheduling, or closing out a task is a management action). Only an
  // explicit status of "completed" stamps completed_at server-side (never
  // client-supplied) and writes an incident_audit_events row; other field
  // edits (owner/due date reshuffles, or a status change that isn't a
  // completion) are plain updates with no audit event, per IN-05's "audit
  // events on create/complete" scope.
  router.register(
    "PATCH",
    "/followups/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { status, ownerUserId, dueAt } = body.payload;
        if (status !== undefined && !FOLLOWUP_STATUSES.includes(status)) {
          return sendJson(response, 400, { error: `status must be one of: ${FOLLOWUP_STATUSES.join(", ")}` });
        }

        const followup = await loadFollowup(auth.client, params.id);
        if (!followup) return sendJson(response, 404, { error: "follow-up action not found" });
        if (!requirePerm(auth, followup.facility_id, MANAGE, response)) return;

        const patch = { updated_at: new Date().toISOString() };
        if (status !== undefined) patch.status = status;
        if (ownerUserId !== undefined) patch.owner_user_id = ownerUserId;
        if (dueAt !== undefined) patch.due_at = dueAt;

        const isCompleting = status === "completed" && followup.status !== "completed";
        if (isCompleting) patch.completed_at = new Date().toISOString();

        const rows = await pgUpdate(
          auth.client,
          "incident_followup_actions",
          { id: followup.id },
          patch,
          { returning: true }
        );

        if (isCompleting) {
          const auditOk = await writeAuditEvent(
            auth,
            response,
            env,
            buildIncidentAuditEvent({
              facilityId: followup.facility_id,
              incidentId: followup.incident_id,
              actorUserId: auth.claims.sub,
              eventType: "incident.followup_completed",
              payload: { actor: auth.claims.sub, followupId: followup.id }
            })
          );
          if (!auditOk) return;
        }

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Export (IN-08) -----------------------------------------------------
  // Renders the incident case document as a PDF: case metadata, involved
  // people, follow-up actions, escalation history, amendment history (when
  // present), and an integrity block (a sha-256 content hash + the moment
  // this export was generated). Guarded by incidents.export.pdf -- a
  // dedicated code, distinct from incidents.read, because reading the JSON
  // record and exporting a portable, printable legal document from it are
  // different capabilities: incidents.read is broadly held (any reader can
  // see the case in the app), but who may walk a copy of it out the door as
  // a standalone file is a narrower, explicitly-granted permission (0027).
  //
  // Draft-export decision (IN-08 item 3): drafts ARE exportable. There is a
  // legitimate use for a printable copy of an in-progress report (e.g. a
  // supervisor still gathering facts wants something to hand a witness), and
  // gating export on status != draft would just push people toward
  // screenshotting the UI instead -- worse for provenance, not better. What
  // must never happen is a draft PDF being mistaken for a filed, submitted
  // report, so incident-pdf.mjs watermarks a draft's document both in the
  // bold title line ("[DRAFT - NOT SUBMITTED]") and in an explicit body
  // field; nothing in this route needs to special-case draft beyond passing
  // the incident through as-is -- the watermarking is the renderer's job.
  //
  // Generating an export is itself an access to a legal document and is
  // therefore auditable: every successful export writes an
  // incident_audit_events row (event_type "incident.exported") carrying the
  // exported document's own content hash, so the ledger records not just
  // THAT an export happened but which exact document (by hash) was handed
  // out. The audit write happens after rendering (so a render failure never
  // logs a phantom export) but before the response is sent.
  router.register(
    "GET",
    "/incidents/:id/export.pdf",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requirePerm(auth, incident.facility_id, EXPORT_PDF, response)) return;

        const [facilityRows, departmentRows, people, followups, escalations, amendments] = await Promise.all([
          pgSelect(auth.client, "facilities", { filters: { id: incident.facility_id }, select: "id,name", limit: 1 }),
          incident.department_id
            ? pgSelect(auth.client, "departments", {
                filters: { id: incident.department_id },
                select: "id,name",
                limit: 1
              })
            : Promise.resolve([]),
          pgSelect(auth.client, "incident_people", {
            filters: { incident_id: incident.id },
            select: PEOPLE_COLUMNS,
            order: "created_at.asc"
          }),
          pgSelect(auth.client, "incident_followup_actions", {
            filters: { incident_id: incident.id },
            select: FOLLOWUP_COLUMNS,
            order: "due_at.asc"
          }),
          pgSelect(auth.client, "incident_escalations", {
            filters: { incident_id: incident.id },
            select: ESCALATION_COLUMNS,
            order: "created_at.asc"
          }),
          pgSelect(auth.client, "incident_amendments", {
            filters: { incident_id: incident.id },
            select: AMENDMENT_COLUMNS,
            order: "amended_at.asc"
          })
        ]);

        // Stamped once, here, and threaded through as plain data --
        // incident-pdf.mjs itself never reads the clock, which is what
        // keeps its output reproducible for a fixed fixture (see its module
        // header).
        const generatedAt = new Date().toISOString();
        const pkg = buildIncidentPdfPackage({
          facilityName: (facilityRows ?? [])[0]?.name ?? null,
          departmentName: (departmentRows ?? [])[0]?.name ?? null,
          incident,
          people: people ?? [],
          followups: followups ?? [],
          escalations: escalations ?? [],
          amendments: amendments ?? [],
          generatedAt,
          generatedBy: auth.claims.sub
        });

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.exported",
            payload: {
              actor: auth.claims.sub,
              format: "pdf",
              draft: incident.status === "draft",
              amended: (amendments ?? []).length > 0,
              documentHash: pkg.documentHash
            }
          })
        );
        if (!auditOk) return;

        // documentHash traveled with pkg only so the audit event above could
        // carry it; it is not part of the wire envelope, which matches the
        // {contentType, filename, body, encoding, contentDisposition} shape
        // every other export route (reports-routes.mjs, workflow-routes.mjs,
        // audit-routes.mjs) already returns.
        const { documentHash, ...envelope } = pkg;
        return sendJson(response, 200, {
          ...envelope,
          contentDisposition: `attachment; filename="${pkg.filename}"`
        });
      })
  );

  return router;
}
