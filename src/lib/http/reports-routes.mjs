import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, authCanAccessFacility } from "./guard.mjs";
import { validateReportSubmission } from "../report-schema.mjs";

const READ = "reports.read";
const CREATE = "reports.create";
const SUBMIT = "reports.submit";

const TEMPLATE_COLUMNS =
  "id,facility_id,department_id,code,name,description,status,active_version,created_at,updated_at";
const VERSION_COLUMNS =
  "id,facility_id,template_id,version_number,schema_json,is_published,created_at";
const SUBMISSION_COLUMNS =
  "id,facility_id,department_id,template_id,template_version_id,report_date,shift_ref,status," +
  "submitted_by,submitted_at,payload_json,source,created_at,updated_at";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Registers the end-user Daily Reports API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require reports.read on the row's facility; creating a draft requires
// reports.create; editing or submitting a draft requires reports.submit. Once a
// submission leaves 'draft' it is immutable here (matching the RLS gate in 0002,
// which only permits updates while status = 'draft').
export function registerReportRoutes(router, { authenticate, sendJson, readBody }) {
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

  async function loadTemplate(client, facilityId, templateId) {
    const rows = await pgSelect(client, "report_templates", {
      filters: { id: templateId, facility_id: facilityId },
      select: TEMPLATE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolves the schema to validate a submission against: the template's active
  // published version. Returns { version, schema } or null when unresolved.
  async function loadActiveVersion(client, template) {
    if (!template.active_version) return null;
    const rows = await pgSelect(client, "report_template_versions", {
      filters: { template_id: template.id, version_number: template.active_version },
      select: VERSION_COLUMNS,
      limit: 1
    });
    const version = (rows ?? [])[0] ?? null;
    if (!version) return null;
    return { version, schema: version.schema_json };
  }

  async function loadSubmission(client, submissionId) {
    const rows = await pgSelect(client, "report_submissions", {
      filters: { id: submissionId },
      select: SUBMISSION_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Templates -------------------------------------------------------------
  // Lists templates a member may fill. Defaults to published only; ?status=all
  // returns every status for authors building/reviewing templates.
  router.register(
    "GET",
    "/facilities/:facilityId/report-templates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const wantAll = queryParams(request).get("status") === "all";
        const filters = { facility_id: params.facilityId };
        if (!wantAll) filters.status = "published";
        const rows = await pgSelect(auth.client, "report_templates", {
          filters,
          select: TEMPLATE_COLUMNS,
          order: "name.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Returns a single template together with its active published version schema,
  // so the client can render the fill form.
  router.register(
    "GET",
    "/facilities/:facilityId/report-templates/:templateId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const template = await loadTemplate(auth.client, params.facilityId, params.templateId);
        if (!template) return sendJson(response, 404, { error: "report template not found" });
        const active = await loadActiveVersion(auth.client, template);
        return sendJson(response, 200, {
          ...template,
          active_version_id: active?.version.id ?? null,
          schema_json: active?.schema ?? null
        });
      })
  );

  // --- Submissions -----------------------------------------------------------
  // Lists submissions for a facility. Optional ?status= and ?template_id= narrow
  // the list; newest report_date first.
  router.register(
    "GET",
    "/facilities/:facilityId/reports",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        const templateId = qp.get("template_id");
        if (status) filters.status = status;
        if (templateId) filters.template_id = templateId;
        const rows = await pgSelect(auth.client, "report_submissions", {
          filters,
          select: SUBMISSION_COLUMNS,
          order: "report_date.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "GET",
    "/reports/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const submission = await loadSubmission(auth.client, params.id);
        if (!submission) return sendJson(response, 404, { error: "report not found" });
        if (!requireRead(auth, submission.facility_id, response)) return;
        return sendJson(response, 200, submission);
      })
  );

  // Creates a draft submission. The payload is validated against the template's
  // active published version before insert; a draft may be partial, so only
  // provided fields are validated here — full validation is enforced on submit.
  router.register(
    "POST",
    "/facilities/:facilityId/reports",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { templateId, reportDate } = body.payload;
        const shape = [];
        if (!templateId) shape.push("templateId is required");
        if (!reportDate || !DATE_PATTERN.test(String(reportDate))) {
          shape.push("reportDate is required (YYYY-MM-DD)");
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, CREATE, response)) return;

        const template = await loadTemplate(auth.client, params.facilityId, templateId);
        if (!template) return sendJson(response, 404, { error: "report template not found" });
        if (template.status !== "published") {
          return sendJson(response, 409, { error: "report template is not published" });
        }
        const active = await loadActiveVersion(auth.client, template);
        if (!active) return sendJson(response, 409, { error: "report template has no published version" });

        const payload = body.payload.payload ?? {};
        const row = {
          facility_id: params.facilityId,
          department_id: template.department_id ?? null,
          template_id: template.id,
          template_version_id: active.version.id,
          report_date: reportDate,
          shift_ref: body.payload.shiftRef ?? null,
          status: "draft",
          payload_json: payload,
          source: "web"
        };
        const rows = await pgInsert(auth.client, "report_submissions", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Edits a draft submission's payload/shift in place. Non-drafts are immutable
  // (409); the guard runs on the loaded row's facility.
  router.register("PATCH", "/reports/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission) return sendJson(response, 404, { error: "report not found" });
      if (!requirePerm(auth, submission.facility_id, SUBMIT, response)) return;
      if (submission.status !== "draft") {
        return sendJson(response, 409, { error: "only draft reports can be edited" });
      }
      const patch = {};
      if (body.payload.payload !== undefined) patch.payload_json = body.payload.payload;
      if (body.payload.shiftRef !== undefined) patch.shift_ref = body.payload.shiftRef;
      if (Object.keys(patch).length === 0) {
        return sendJson(response, 400, { error: "nothing to update (send payload and/or shiftRef)" });
      }
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(auth.client, "report_submissions", { id: params.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // Finalizes a draft: validates the full payload against the template version
  // schema, then flips status to 'submitted' and stamps the submitter. Only
  // drafts can be submitted; after this the row is immutable.
  router.register("POST", "/reports/:id/submit", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission) return sendJson(response, 404, { error: "report not found" });
      if (!requirePerm(auth, submission.facility_id, SUBMIT, response)) return;
      if (submission.status !== "draft") {
        return sendJson(response, 409, { error: "only draft reports can be submitted" });
      }
      const versionRows = await pgSelect(auth.client, "report_template_versions", {
        filters: { id: submission.template_version_id },
        select: VERSION_COLUMNS,
        limit: 1
      });
      const version = (versionRows ?? [])[0] ?? null;
      if (!version) return sendJson(response, 409, { error: "template version not found" });
      const errors = validateReportSubmission(version.schema_json, submission.payload_json ?? {});
      if (errors.length > 0) return sendJson(response, 422, { errors });

      const patch = {
        status: "submitted",
        submitted_by: auth.claims.sub,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const rows = await pgUpdate(auth.client, "report_submissions", { id: params.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  return router;
}
