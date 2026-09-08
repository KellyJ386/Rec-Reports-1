import { pgSelect, pgInsert, pgUpdate, pgRpc, PostgrestError } from "../supabase-rest.mjs";
import { reportError } from "../observability.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import { verifyIncidentAuditChain } from "../audit.mjs";
import { loadModuleConfig } from "./module-config.mjs";
import { isMissingRelationError } from "./errors.mjs";
import {
  escalationDueAt,
  isEscalationOverdue,
  canTransitionIncident,
  buildIncidentAuditEvent,
  buildAmendment,
  nextIncidentNo,
  requiredIncidentFollowUps,
  evaluateClosureGate,
  retentionEligibleAt,
  buildIncidentNotificationJobs,
  INCIDENT_STATUSES
} from "../incidents.mjs";
import { createWorkOrderFromIncidentFollowup } from "../work-orders.mjs";
import { loadActiveRoute, expandRouteRecipients } from "../notifications/worker.mjs";
import { buildIncidentPdfPackage, buildIncidentPacketPackage } from "../incident-pdf.mjs";

const READ = "incidents.read";
const MANAGE = "incidents.manage";
const REVIEW = "incidents.review";
const LEGAL_HOLD_MANAGE = "incidents.legal_hold.manage";
const TASKS_CREATE = "incidents.tasks.create";
const EXPORT_PDF = "incidents.export.pdf";
const ESCALATE = "incidents.escalate";
// IN-17 cross-module permission codes: work_orders.manage decides which of
// the two POST .../work-order write paths runs (direct insert vs the
// SECURITY DEFINER RPC); training.manage decides whether
// POST .../training-triggers also creates a training_assignments row.
const WORK_ORDERS_MANAGE = "work_orders.manage";
const TRAINING_MANAGE = "training.manage";

// Minimal projection for the IN-17 work-order idempotency check-then-insert
// (POST .../followups/:followupId/work-order's direct-insert path) -- kept
// separate from work-orders-routes.mjs's own WORK_ORDER_COLUMNS on purpose,
// same reasoning as INCIDENT_FOR_WORK_ORDER_COLUMNS there: this module never
// imports from that one.
const WORK_ORDER_MIN_COLUMNS =
  "id,facility_id,source_type,source_id,source_followup_id,title,description,priority,status,created_at";
const AUDIT_VIEW = "incidents.audit.view";
const INCIDENTS_MODULE_CODE = "incidents";

// M1 (security review): the legal packet's facility-wide chain-verification
// fetch is capped at this many rows -- past it, only a PREFIX of the real
// chain was checked (see the packet route's own comment), so the route
// marks the result truncated instead of reporting it as verified.
const CHAIN_VERIFICATION_LIMIT = 10000;

// IN-18: incident_signatures/incident_compliance_checks (design doc §2.2)
// belong to a sibling Wave 3 migration (0056) that may not exist in every
// tree this route runs against. Reads them the same way every other child
// table here is read, but a missing-relation PostgrestError (42P01/PGRST205
// -- the table genuinely doesn't exist in this schema yet) degrades to "no
// rows" instead of failing the whole packet -- the packet is still a
// complete, correct legal document without a section this facility's schema
// doesn't carry yet; renderIncidentPacket already treats an empty array as
// "omit the section" (see that function's own doc comment).
//
// L4 (security review): every OTHER PostgrestError -- a 403 (RLS denied this
// caller these rows), a 500, a malformed query -- is rethrown rather than
// also degrading to []. The original `if (error instanceof PostgrestError)
// return []` swallowed those too, so a legal packet could silently omit its
// Signatures/Compliance Checks sections with no indication anywhere in the
// document that the omission was an authorization/server failure rather
// than "this incident genuinely has none" -- exactly the false-negative
// shape M1 flags for the audit chain, just on a different pair of sections.
async function tryOptionalSelect(client, table, options) {
  try {
    const rows = await pgSelect(client, table, options);
    return rows ?? [];
  } catch (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
}

// Follow-up action_type / status vocabularies, verbatim from the check
// constraints on incident_followup_actions (0004_incidents.sql:74-75).
const FOLLOWUP_ACTION_TYPES = ["corrective_action", "investigation", "documentation", "equipment_fix", "training"];
const FOLLOWUP_STATUSES = ["open", "in_progress", "completed", "waived"];

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
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams } = guards;
  const requireRead = guards.requireRead(READ);

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

  // IN-20: emits notification_jobs for one incident lifecycle event
  // (incident.submitted / incident.escalated / incident.sla_breached).
  // Resolves the facility's live active route for `eventCode` via
  // loadActiveRoute (notifications/worker.mjs -- the same resolveRoute
  // query the drain itself uses), expands its distribution list via
  // expandRouteRecipients, folds in `extraRecipientIds` (e.g. an
  // escalation's own target_user_id, so the specifically-targeted actor is
  // notified even when the route's distribution list doesn't happen to
  // include them), and inserts one buildIncidentNotificationJobs row per
  // recipient with ignoreDuplicates so a retried call can never double-
  // enqueue. When no active route is configured for this facility+event, or
  // it resolves to zero recipients, this is a silent no-op -- exactly
  // matching translateOutboxEvent's "no active route -> skip" contract
  // (worker.mjs), the existing behavior for every other event in this
  // codebase (no facility ships a seeded notification_routes row).
  //
  // Deliberately best-effort: notification emission is not this module's
  // legal-defensibility surface (writeAuditEvent above is, and stays
  // strict/blocking) -- a delivery-pipeline hiccup must never turn a
  // successful incident submit/escalate into a failed request. Errors are
  // caught, logged, and fire-and-forget reported (OP-20's reportError
  // contract), never re-thrown.
  // M3: `escalationId` (the just-created/relevant escalation's own id, when
  // this event carries one -- e.g. the escalate route's own createdEscalation)
  // is threaded through to buildIncidentNotificationJobs so its dedupe_key
  // distinguishes this escalation from any other on the same incident. See
  // that function's own doc comment for the full rationale.
  async function emitIncidentNotifications(auth, env, eventCode, incident, extraRecipientIds = [], escalationId = null) {
    try {
      const route = await loadActiveRoute({ client: auth.client, facilityId: incident.facility_id, eventCode });
      if (!route) return;
      const expanded = await expandRouteRecipients({ client: auth.client, facilityId: incident.facility_id, route });
      const recipients = [...new Set([...(expanded ?? []), ...(extraRecipientIds ?? [])])].filter(Boolean);
      if (recipients.length === 0) return;
      const jobs = buildIncidentNotificationJobs(
        eventCode,
        route,
        recipients,
        { id: incident.id, severity: incident.severity },
        escalationId
      );
      if (jobs.length === 0) return;
      await pgInsert(auth.client, "notification_jobs", jobs, {
        onConflict: "dedupe_key",
        ignoreDuplicates: true,
        returning: false
      });
    } catch (error) {
      console.error(`incidents.notify/${eventCode} failed for incident ${incident?.id}:`, error);
      reportError(error, {
        dsn: env?.OBSERVABILITY_DSN,
        route: `incidents.notify/${eventCode}`,
        status: 500,
        requestId: incident?.id ?? null,
        userId: auth?.claims?.sub ?? null
      });
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

  // Returns a single incident report, plus a computed (never stored)
  // `retention_eligible_at` (IN-16b): the date past which a future purge job
  // (Wave 4 IN-25) would be permitted to consider this row, per its report
  // class and this facility's incidents.retentionDays{Standard,Osha,Minor}
  // config (settings-registry, registry defaults when unconfigured). Pure
  // display -- retentionEligibleAt never purges anything, and a currently
  // legal_hold=true or protected-status incident is still delete-rejected at
  // the DB layer (0057) regardless of what this field says.
  router.register(
    "GET",
    "/incidents/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireRead(auth, incident.facility_id, response)) return;

        const config = await loadModuleConfig({
          client: auth.client,
          facilityId: incident.facility_id,
          moduleCode: INCIDENTS_MODULE_CODE
        });
        const eligibleAt = retentionEligibleAt(
          {
            occurredAt: incident.occurred_at,
            createdAt: incident.created_at,
            reportedAt: incident.reported_at,
            requiresOshaReview: incident.requires_osha_review,
            reportType: incident.report_type,
            severity: incident.severity
          },
          config
        );

        return sendJson(response, 200, {
          ...incident,
          retention_eligible_at: eligibleAt ? eligibleAt.toISOString() : null
        });
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

        // M2 (0048): legalHold is deliberately NOT read from the client body
        // -- creating an incident already on legal hold is a distinct,
        // narrower-gated action (incidents.legal_hold.manage), matching the
        // DB-layer INSERT guard added in 0048. Every draft starts
        // legal_hold=false; PATCH /incidents/:id/legal-hold is the only way
        // to set it, and only for an actor who holds that code.
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
          legal_hold: false,
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
  // `targetUserId` is passed through as-is (optional, nullable). Guarded by
  // incidents.escalate OR incidents.manage (S-5) -- escalation is its own
  // governance surface distinct from full incident management, matching the
  // incident_escalations INSERT RLS policy (0044).
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
        if (!requireAnyPerm(auth, incident.facility_id, [ESCALATE, MANAGE], response)) return;

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

        // IN-20: fire-and-forget (see emitIncidentNotifications) --
        // never awaited-for-failure the way writeAuditEvent above is, so a
        // notification-pipeline hiccup can never turn a successful
        // escalation into a failed response. targetUserId (when the
        // escalation names one) is folded in as an extra recipient
        // alongside whatever the facility's incident.escalated route's
        // distribution list already resolves.
        await emitIncidentNotifications(
          auth,
          env,
          "incident.escalated",
          incident,
          [escalation.target_user_id],
          createdEscalation?.id ?? null
        );

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

        // IN-20: "on submit" -- fire-and-forget, matching the escalate
        // route's call below (see emitIncidentNotifications). This is the
        // ONLY place "incident.submitted" fires: the generic
        // POST /incidents/:id/status route below can also legally drive
        // draft->submitted (the same canTransitionIncident edge), but it
        // always writes its audit event as "incident.status_changed", not
        // "incident.submitted" -- this route is the sole owner of that
        // event, so it is also the sole notification-emission site for it.
        await emitIncidentNotifications(auth, env, "incident.submitted", incident);

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
        let complianceChecks = [];
        if (to === "closed") {
          [openFollowUps, complianceChecks] = await Promise.all([
            pgSelect(auth.client, "incident_followup_actions", {
              filters: { incident_id: incident.id, status: { in: OPEN_FOLLOWUP_STATUSES } },
              select: "id"
            }),
            // L5 (security review): a soft-deleted check must not count
            // toward the gate -- DB guard 2.5 (0056/0057) already filters
            // `and deleted_at is null`; without the matching filter here,
            // a soft-deleted 'pass'/'waived' row let this pre-check allow a
            // close that the trigger would then reject, surfacing as a raw
            // check_violation/409 instead of the friendly {error,
            // blockingCheck} body below.
            pgSelect(auth.client, "incident_compliance_checks", {
              filters: { incident_id: incident.id },
              extra: { deleted_at: "is.null" },
              select: "check_key,status"
            })
          ]);
        }

        const check = canTransitionIncident(incident.status, to, {
          actorPermissions,
          openFollowUps: openFollowUps ?? [],
          legalHold: incident.legal_hold === true
        });
        if (!check.allowed) {
          return sendJson(response, transitionStatusCode(check.reasonCode), { error: check.reason });
        }

        // IN-13/IN-15: the closure gate (evidence_complete for high/
        // critical severity, supervisor_signoff when requires_osha_review)
        // is checked here, AFTER canTransitionIncident's own follow-up/
        // legal-hold gate, so a caller sees the most specific applicable
        // rejection first -- and again, independently, at the database
        // layer by fn_incident_report_transition_guard's guard 2.5
        // (migration 0056), regardless of which check runs first for any
        // given request.
        let waivedChecks = [];
        if (to === "closed") {
          const gate = evaluateClosureGate(
            { severity: incident.severity, requiresOshaReview: incident.requires_osha_review === true },
            complianceChecks ?? []
          );
          if (!gate.allowed) {
            return sendJson(response, 409, { error: gate.reason, blockingCheck: gate.blockingCheck });
          }
          waivedChecks = (complianceChecks ?? [])
            .filter((row) => row.status === "waived")
            .map((row) => row.check_key);
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
            payload: {
              actor: auth.claims.sub,
              from: incident.status,
              to,
              reason: reason ?? null,
              ...(waivedChecks.length > 0 ? { waivedChecks } : {})
            }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Sets or clears an incident's legal hold: body { legalHold: boolean }.
  // Guarded by incidents.legal_hold.manage alone (S-5) -- a narrower gate
  // than incidents.manage by design (see the top-of-file permission-code
  // comment), matching 0043's fn_incident_report_transition_guard, which
  // enforces the same code at the database layer regardless of how the
  // UPDATE reaches incident_reports. Writes an incident_audit_events row
  // (event_type "incident.legal_hold_changed") for every successful change,
  // including a no-op (legalHold already at the requested value) -- the
  // request itself is worth recording for a legal-hold surface.
  router.register(
    "PATCH",
    "/incidents/:id/legal-hold",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { legalHold } = body.payload;
        if (typeof legalHold !== "boolean") {
          return sendJson(response, 400, { error: "legalHold must be a boolean" });
        }

        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requirePerm(auth, incident.facility_id, LEGAL_HOLD_MANAGE, response)) return;

        const rows = await pgUpdate(
          auth.client,
          "incident_reports",
          { id: incident.id },
          { legal_hold: legalHold, updated_at: new Date().toISOString() },
          { returning: true }
        );

        await pgInsert(
          auth.client,
          "incident_audit_events",
          [
            buildIncidentAuditEvent({
              facilityId: incident.facility_id,
              incidentId: incident.id,
              actorUserId: auth.claims.sub,
              eventType: "incident.legal_hold_changed",
              payload: { actor: auth.claims.sub, from: incident.legal_hold, to: legalHold }
            })
          ],
          { returning: false }
        );

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // IN-19: a minimal reader for the review workspace's timeline -- lists an
  // incident's own audit-event ledger, oldest first, so the client can
  // merge it with GET .../amendments into one chronological view. This is
  // deliberately NOT IN-22's full "chain verification endpoint" (that
  // Wave-4 route additionally runs verifyChain and reports tamper status);
  // this one only reads the rows incidents.read already grants access to
  // per-row via incident_audit_events' own SELECT policy (0043(c)).
  router.register(
    "GET",
    "/incidents/:id/audit-events",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireRead(auth, incident.facility_id, response)) return;
        const rows = await pgSelect(auth.client, "incident_audit_events", {
          filters: { incident_id: incident.id },
          select: "id,facility_id,incident_id,event_type,actor_user_id,event_payload,created_at",
          order: "id.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // IN-16c: legal-hold change history -- every incident.legal_hold_changed
  // audit row for this incident, oldest first. 0043/0048's transition guard
  // is what makes this the FULL history: legal_hold can only ever change
  // through the guarded PATCH above (or the equally-guarded INSERT-time
  // path), so there is no toggle this list could be missing. Gated the same
  // as incident_audit_events' own SELECT policy (0044(e):
  // incidents.audit.view OR incidents.manage OR incidents.review) so a
  // caller who can attempt this read never gets a silently RLS-filtered
  // empty array back instead of the 403 their permissions actually warrant.
  router.register(
    "GET",
    "/incidents/:id/legal-hold",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requireAnyPerm(auth, incident.facility_id, [AUDIT_VIEW, MANAGE, REVIEW], response)) return;

        const rows = await pgSelect(auth.client, "incident_audit_events", {
          filters: { incident_id: incident.id, event_type: "incident.legal_hold_changed" },
          select: "id,actor_user_id,event_payload,created_at",
          order: "id.asc"
        });

        return sendJson(response, 200, {
          legalHold: incident.legal_hold === true,
          history: (rows ?? []).map((row) => ({
            id: row.id,
            actorUserId: row.actor_user_id,
            from: row.event_payload?.from ?? null,
            to: row.event_payload?.to ?? null,
            changedAt: row.created_at
          }))
        });
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
  // write policy: "incident managers and reviewers can update reports"
  // (0043, Slice 1C S-4) widened the UPDATE policy to incidents.manage OR
  // incidents.review -- prior to 0043 a review-only actor's UPDATE was in
  // fact rejected at the database layer despite being accepted here.
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

        // M1 (0048): the incident_reports UPDATE and the incident_amendments
        // INSERT now happen atomically inside internal.apply_incident_amendment
        // -- a SECURITY DEFINER RPC that sets the session-local
        // rec.amendment_in_progress flag fn_incident_report_transition_guard's
        // amendable-column check requires, re-checks incidents.manage/review
        // itself (it runs with elevated, RLS-bypassing rights), and computes
        // its own before/after snapshot from the authoritative row rather
        // than trusting a client-supplied one. buildAmendment above still
        // owns validation (empty patch, disallowed fields, blank reason) and
        // the beforeHash/afterHash carried in the incident.amended audit
        // event below, so those stay unchanged; only the actual DB write
        // moved into the RPC. A plain pgUpdate straight to incident_reports
        // for an amendable field on a non-draft incident (the prior two-call
        // shape this replaced) is now rejected by the transition guard.
        let rpcResult;
        try {
          rpcResult = await pgRpc(auth.client, "apply_incident_amendment", {
            incident_id: incident.id,
            changes: built.patch,
            reason: built.reason
          });
        } catch (error) {
          if (error instanceof PostgrestError && (error.status === 403 || error.status === 409 || error.status === 400)) {
            return sendJson(response, error.status, {
              error: error.body?.message ?? "amendment rejected"
            });
          }
          throw error;
        }
        const incidentRows = [rpcResult?.incident ?? null];
        const amendmentRows = [rpcResult?.amendment ?? null];

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

  // --- Cross-module creation (IN-17) --------------------------------------
  // Creates a work_orders row linked to one follow-up action. Guarded by
  // incidents.manage OR incidents.review -- deliberately NOT work_orders.manage
  // (see 0058_incident_cross_module.sql's header for the full elevation-model
  // writeup, which this route implements). Two write paths, chosen purely by
  // whether the caller ALSO holds work_orders.manage:
  //   * holds it -> insert straight into work_orders through the caller's
  //     own RLS-scoped client (createWorkOrderFromIncidentFollowup,
  //     work-orders.mjs) -- ordinary RLS does the gating.
  //   * does not hold it -> call public.create_work_order_from_incident via
  //     pgRpc, the SECURITY DEFINER RPC that re-checks incidents.manage/
  //     review itself and derives every written field server-side.
  // Both paths are idempotent per follow-up (work_orders.source_followup_id's
  // UNIQUE partial index) and return the identical envelope shape
  // { workOrder, created }, so a caller cannot tell which path ran from the
  // response alone -- created:false on a repeat call either way, never a 409.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/followups/:followupId/work-order",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const followup = await loadFollowup(auth.client, params.followupId);
        if (!followup || followup.incident_id !== params.incidentId) {
          return sendJson(response, 404, { error: "follow-up action not found" });
        }
        const incident = await loadIncident(auth.client, params.incidentId);
        if (!incident || incident.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "incident not found" });
        }
        if (!requireAnyPerm(auth, incident.facility_id, [MANAGE, REVIEW], response)) return;

        const hasWorkOrdersManage = requireAuthPermission(auth, incident.facility_id, WORK_ORDERS_MANAGE).allowed;

        if (hasWorkOrdersManage) {
          // Idempotency check-then-insert, mirroring the RPC's own shape
          // (0058) -- a repeat call under this path returns the existing
          // row rather than hitting the unique index and surfacing a raw
          // 409 from PostgREST.
          const existingRows = await pgSelect(auth.client, "work_orders", {
            filters: { source_followup_id: followup.id },
            select: WORK_ORDER_MIN_COLUMNS,
            limit: 1
          });
          const existing = (existingRows ?? [])[0] ?? null;
          if (existing) {
            return sendJson(response, 200, { workOrder: existing, created: false });
          }

          const built = createWorkOrderFromIncidentFollowup(
            {
              id: incident.id,
              facilityId: incident.facility_id,
              incidentNo: incident.incident_no,
              severity: incident.severity,
              summary: incident.summary
            },
            { id: followup.id, actionType: followup.action_type, description: followup.description }
          );
          const row = {
            facility_id: built.facilityId,
            source_type: built.sourceType,
            source_id: built.sourceId,
            source_followup_id: built.sourceFollowupId,
            title: built.title,
            description: built.description,
            priority: built.priority,
            status: built.status,
            created_by: auth.claims.sub
          };
          const rows = await pgInsert(auth.client, "work_orders", [row], { returning: true });
          const workOrder = (rows ?? [])[0] ?? null;

          const auditOk = await writeAuditEvent(
            auth,
            response,
            env,
            buildIncidentAuditEvent({
              facilityId: incident.facility_id,
              incidentId: incident.id,
              actorUserId: auth.claims.sub,
              eventType: "incident.work_order_created",
              payload: {
                source: "incident_followup",
                followup_id: followup.id,
                work_order_id: workOrder?.id ?? null,
                actor: auth.claims.sub
              }
            })
          );
          if (!auditOk) return;

          return sendJson(response, 201, { workOrder, created: true });
        }

        // Elevation path: the caller lacks work_orders.manage. The RPC
        // re-checks incidents.manage/review itself, derives every field
        // from the follow-up + incident it loads, and writes its own
        // incident_audit_events row atomically with the work_orders insert
        // -- no separate writeAuditEvent call here, unlike the direct-insert
        // branch above.
        let rpcResult;
        try {
          rpcResult = await pgRpc(auth.client, "create_work_order_from_incident", {
            followup_id: followup.id
          });
        } catch (error) {
          if (error instanceof PostgrestError && (error.status === 403 || error.status === 404 || error.status === 400)) {
            return sendJson(response, error.status, {
              error: error.body?.message ?? "work order creation rejected"
            });
          }
          throw error;
        }
        const created = rpcResult?.created === true;
        return sendJson(response, created ? 201 : 200, {
          workOrder: rpcResult?.work_order ?? null,
          created
        });
      })
  );

  // Creates an incident_training_triggers row (IN-17), and -- only when the
  // caller ALSO holds training.manage -- a linked training_assignments row.
  // No elevation RPC here: unlike the work-order half above, a caller who
  // lacks training.manage never gets a training_assignments write on their
  // behalf; they get a durable trigger row a training admin can act on
  // instead. Body: { employeeId, certificationTypeId | trainingModuleId,
  // reason } -- exactly one of certificationTypeId/trainingModuleId.
  //
  // trainingModuleId resolves to a training_assignments.course_id via
  // course_modules.course_id (0007); certificationTypeId has NO course
  // linkage anywhere in this schema (certification_types and courses are
  // unrelated tables), so a certificationTypeId target NEVER creates a
  // training_assignments row, regardless of training.manage -- documented
  // in `assignmentSkipped` on the response rather than silently succeeding
  // with a misleading assignment.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/training-triggers",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { employeeId, certificationTypeId, trainingModuleId, reason } = body.payload;
        const shape = [];
        if (!employeeId) shape.push("employeeId is required");
        if (!certificationTypeId && !trainingModuleId) {
          shape.push("exactly one of certificationTypeId or trainingModuleId is required");
        }
        if (certificationTypeId && trainingModuleId) {
          shape.push("only one of certificationTypeId or trainingModuleId may be set");
        }
        if (!reason || typeof reason !== "string" || !reason.trim()) shape.push("reason is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const incident = await loadIncident(auth.client, params.incidentId);
        if (!incident || incident.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "incident not found" });
        }
        if (!requireAnyPerm(auth, incident.facility_id, [MANAGE, REVIEW], response)) return;

        const employeeRows = await pgSelect(auth.client, "employees", {
          filters: { id: employeeId, facility_id: incident.facility_id },
          select: "id",
          limit: 1
        });
        if (!(employeeRows ?? [])[0]) {
          return sendJson(response, 404, { error: "employee not found for this facility" });
        }

        const target = trainingModuleId ? { trainingModuleId } : { certificationTypeId };
        const triggerRow = {
          facility_id: incident.facility_id,
          incident_id: incident.id,
          employee_id: employeeId,
          target,
          reason: reason.trim(),
          created_by: auth.claims.sub
        };
        const triggerRows = await pgInsert(auth.client, "incident_training_triggers", [triggerRow], {
          returning: true
        });
        const trigger = (triggerRows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.training_trigger_created",
            payload: { actor: auth.claims.sub, triggerId: trigger?.id ?? null, employeeId, target, reason: reason.trim() }
          })
        );
        if (!auditOk) return;

        const hasTrainingManage = requireAuthPermission(auth, incident.facility_id, TRAINING_MANAGE).allowed;
        let assignment = null;
        let assignmentSkipped = null;

        if (!hasTrainingManage) {
          assignmentSkipped = "missing permission: training.manage";
        } else if (certificationTypeId) {
          assignmentSkipped = "certificationTypeId has no course linkage; create a training_assignments row manually";
        } else {
          const moduleRows = await pgSelect(auth.client, "course_modules", {
            filters: { id: trainingModuleId, facility_id: incident.facility_id },
            select: "id,course_id,facility_id",
            limit: 1
          });
          const module = (moduleRows ?? [])[0] ?? null;
          if (!module) {
            assignmentSkipped = "trainingModuleId not found for this facility";
          } else {
            const assignmentRows = await pgInsert(
              auth.client,
              "training_assignments",
              [
                {
                  facility_id: incident.facility_id,
                  employee_id: employeeId,
                  course_id: module.course_id,
                  assigned_by: auth.claims.sub,
                  reason_code: "incident_training_trigger",
                  source_type: "incident_rule",
                  source_ref_id: trigger?.id ?? null
                }
              ],
              { returning: true }
            );
            assignment = (assignmentRows ?? [])[0] ?? null;
          }
        }

        return sendJson(response, 201, { trigger, assignment, assignmentSkipped });
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

  // --- Legal packet (IN-18) ------------------------------------------------
  // Renders the full legal packet: everything export.pdf covers, plus every
  // witness statement version, signatures/compliance checks (when those
  // rows exist -- see incident-pdf.mjs's renderIncidentPacket doc comment),
  // an evidence index, and the FULL audit timeline with chain hashes.
  //
  // M1 (security review): unlike export.pdf, this route requires
  // incidents.export.pdf AND one of incidents.audit.view/manage/review --
  // the SAME set incident_audit_events' own SELECT policy requires. Without
  // the second half, an export.pdf-only caller's own audit read is
  // RLS-filtered to zero rows (the packet never sees a 403 -- PostgREST
  // just returns an empty, "successful" result set), and the packet
  // printed "Chain Valid: true" over that emptiness -- an integrity
  // attestation over nothing. Requiring the same permission the read
  // itself needs means a caller who reaches the chain-verification and
  // audit-read code below is always ENTITLED to see what they get back.
  //
  // 409 while the incident is still a draft: unlike export.pdf (which
  // deliberately allows a watermarked draft copy, see that route's own
  // comment), a legal packet is the case-closing bundle -- statements,
  // signatures, and a fixed audit timeline only make sense once there is a
  // submitted case to bundle.
  //
  // Chain verification is run over the incident's FACILITY's full
  // incident_audit_events chain, not just this incident's own rows --
  // 0013_audit_chain.sql links prev_hash/row_hash per-facility, so verifying
  // a per-incident-filtered subset would misreport a broken link at the
  // first row whose true predecessor belongs to a different incident. The
  // Audit Timeline section itself still only lists this incident's own rows
  // (querying incident_audit_events a second time, filtered) -- a packet
  // must never leak another incident's audit content.
  //
  // M1 continued: two more "verified" edge cases, both independent of the
  // permission fix above (a genuinely legitimate caller can still hit
  // either one) --
  //   * the facility-wide chain fetch is capped at CHAIN_VERIFICATION_LIMIT
  //     rows; hitting that cap means only a PREFIX of the real chain was
  //     checked (a prefix of a valid chain trivially re-verifies as
  //     "valid", which would silently under-report), so the route marks
  //     the result `truncated: true` and the rendered "Chain Valid" line
  //     stops reading `true` outright -- see incident-pdf.mjs's own
  //     "Chain Verification Note" handling.
  //   * a submitted-or-later incident must have at least one audit event of
  //     its own (submission itself always writes one) -- if the
  //     incident-scoped audit read comes back empty anyway, that is not a
  //     legitimate "nothing happened yet" case (this route already
  //     rejected drafts above) but a sign the caller's read is silently
  //     filtered or the incident's own audit trail is broken; the packet
  //     is refused (409) rather than rendered with a fabricated-looking
  //     empty timeline and an unearned "valid" chain stamp.
  //
  // Every successful packet export writes an incident_audit_events row
  // (event_type "incident.packet_exported") carrying the packet's own
  // content hash and the chain-verification result, matching export.pdf's
  // own "an export of a legal document is itself auditable" precedent.
  router.register(
    "GET",
    "/incidents/:id/packet.pdf",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requirePerm(auth, incident.facility_id, EXPORT_PDF, response)) return;
        // M1: incident_audit_events' own SELECT policy requires one of
        // incidents.audit.view/manage/review -- require it here too, so a
        // caller who reaches the audit-chain read below is always entitled
        // to see what it returns (see this route's own header comment).
        if (!requireAnyPerm(auth, incident.facility_id, [AUDIT_VIEW, MANAGE, REVIEW], response)) return;
        if (incident.status === "draft") {
          return sendJson(response, 409, {
            error: "a legal packet can only be generated for a submitted-or-later incident"
          });
        }

        const [
          facilityRows,
          departmentRows,
          people,
          statements,
          attachments,
          followups,
          escalations,
          amendments,
          auditEvents,
          chainRows,
          signatures,
          complianceChecks
        ] = await Promise.all([
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
          pgSelect(auth.client, "incident_witness_statements", {
            filters: { incident_id: incident.id },
            select: "id,facility_id,incident_id,person_id,version_no,statement_text,submitted_by,submitted_at,signed_at,deleted_at",
            order: "person_id.asc,version_no.asc"
          }),
          pgSelect(auth.client, "incident_attachments", {
            filters: { incident_id: incident.id },
            select:
              "id,facility_id,incident_id,attachment_type,storage_path,captured_at,captured_by,checksum_sha256,metadata,created_at",
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
          }),
          pgSelect(auth.client, "incident_audit_events", {
            filters: { incident_id: incident.id },
            select: "id,incident_id,event_type,actor_user_id,event_payload,created_at,prev_hash,row_hash",
            order: "id.asc"
          }),
          pgSelect(auth.client, "incident_audit_events", {
            filters: { facility_id: incident.facility_id },
            select: "id,event_type,incident_id,facility_id,event_payload,created_at,prev_hash,row_hash",
            order: "created_at.asc,id.asc",
            limit: CHAIN_VERIFICATION_LIMIT
          }),
          tryOptionalSelect(auth.client, "incident_signatures", {
            filters: { incident_id: incident.id },
            order: "created_at.asc"
          }),
          tryOptionalSelect(auth.client, "incident_compliance_checks", {
            filters: { incident_id: incident.id },
            order: "checked_at.asc"
          })
        ]);

        // M1: a submitted-or-later incident must carry at least its own
        // "incident.submitted" audit event -- an empty incident-scoped read
        // here (distinct from the facility-wide chainRows fetch below) is
        // never a legitimate "nothing happened yet" state for a
        // non-draft incident (the draft check above already excluded the
        // one case where zero events would be expected), so refuse the
        // packet outright rather than render a fabricated-looking empty
        // Audit Timeline under an unearned "valid" chain stamp.
        if ((auditEvents ?? []).length === 0) {
          return sendJson(response, 409, {
            error:
              "no audit events are readable for this incident; a legal packet cannot be generated without a verifiable audit trail"
          });
        }

        const rawChainVerification = verifyIncidentAuditChain(chainRows ?? []);
        // M1: the facility-wide fetch above is capped at
        // CHAIN_VERIFICATION_LIMIT rows -- hitting that cap means only a
        // PREFIX of the real chain was checked, and a prefix of a valid
        // chain trivially re-verifies as "valid" (verifyIncidentAuditChain
        // has no way to know it was handed a partial chain), so that case
        // is downgraded here rather than reported as verified. `noRows`
        // covers the (should-be-impossible now that AUDIT_VIEW/MANAGE/
        // REVIEW is required above, but still checked defensively) case of
        // an empty facility-wide read.
        const chainTruncated = (chainRows ?? []).length >= CHAIN_VERIFICATION_LIMIT;
        const chainNoRows = (chainRows ?? []).length === 0;
        const chainVerification = {
          ...rawChainVerification,
          truncated: chainTruncated,
          noRows: chainNoRows
        };

        // Stamped once, here -- incident-pdf.mjs never reads the clock
        // itself (same contract renderIncidentPdf documents).
        const generatedAt = new Date().toISOString();
        const pkg = buildIncidentPacketPackage({
          facilityName: (facilityRows ?? [])[0]?.name ?? null,
          departmentName: (departmentRows ?? [])[0]?.name ?? null,
          incident,
          people: people ?? [],
          statements: statements ?? [],
          attachments: attachments ?? [],
          amendments: amendments ?? [],
          auditEvents: auditEvents ?? [],
          followups: followups ?? [],
          escalations: escalations ?? [],
          signatures: signatures ?? [],
          complianceChecks: complianceChecks ?? [],
          chainVerification,
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
            eventType: "incident.packet_exported",
            payload: {
              actor: auth.claims.sub,
              format: "pdf",
              documentHash: pkg.documentHash,
              chainValid: !chainVerification.truncated && !chainVerification.noRows && chainVerification.valid,
              chainBrokenAt: chainVerification.brokenAt,
              chainTruncated: chainVerification.truncated,
              chainNoRows: chainVerification.noRows
            }
          })
        );
        if (!auditOk) return;

        const { documentHash, ...envelope } = pkg;
        return sendJson(response, 200, {
          ...envelope,
          contentDisposition: `attachment; filename="${pkg.filename}"`
        });
      })
  );

  return router;
}
