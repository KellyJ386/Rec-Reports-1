import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import { escalationDueAt } from "../incidents.mjs";

const READ = "incidents.read";
const MANAGE = "incidents.manage";

const INCIDENT_COLUMNS =
  "id,facility_id,department_id,incident_no,report_type,status,severity,occurred_at,reported_at," +
  "location_text,summary,immediate_actions,requires_osha_review,legal_hold,submitted_by,submitted_at," +
  "created_at,updated_at";
const ESCALATION_COLUMNS =
  "id,facility_id,incident_id,escalation_level,reason_code,target_role,target_user_id,status,due_at," +
  "acknowledged_at,created_at,updated_at";

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

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  async function loadIncident(client, incidentId) {
    const rows = await pgSelect(client, "incident_reports", {
      filters: { id: incidentId },
      select: INCIDENT_COLUMNS,
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
  // on validation failure), then inserts the row.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { incidentNo, reportType, severity, occurredAt, locationText, summary } = body.payload;
        const shape = [];
        if (!incidentNo) shape.push("incidentNo is required");
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
          incident_no: incidentNo,
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
        const rows = await pgInsert(auth.client, "incident_reports", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Escalates an incident: loads the incident, guards, then inserts an
  // escalation row with due_at computed from escalationDueAt.
  router.register(
    "POST",
    "/incidents/:id/escalate",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const incident = await loadIncident(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });
        if (!requirePerm(auth, incident.facility_id, MANAGE, response)) return;

        const dueAt = escalationDueAt(incident);
        const escalation = {
          facility_id: incident.facility_id,
          incident_id: incident.id,
          escalation_level: 1,
          reason_code: "user_escalation",
          target_role: "manager",
          target_user_id: null,
          status: "pending",
          due_at: dueAt || new Date().toISOString()
        };
        const rows = await pgInsert(auth.client, "incident_escalations", [escalation], {
          returning: true
        });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
