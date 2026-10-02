// DR-21 (plans/DAILY_REPORTS_PLAN.md) -- report distribution bindings API.
//
// GET/POST /facilities/:facilityId/report-distribution-lists
// PATCH/DELETE /facilities/:facilityId/report-distribution-lists/:id (soft delete)
// GET /reports/:id/deliveries (not facility-prefixed, matching every other
//   single-submission route in reports-routes.mjs -- GET /reports/:id,
//   GET /reports/:id/pdf -- the submission's own facility_id is what the
//   guard checks, loaded from the row).
//
// Reads: reports.read. Writes (POST/PATCH/DELETE): reports.distribution.manage
// (0054's RLS policy is the ultimate authority; this file's own
// pre-validation of template_id/distribution_list_id/department_id/role_id
// existence-in-facility exists to return a clean 404 instead of an opaque
// 403-from-RLS for the common "typo'd id" case -- see errors.mjs's own
// comment on when a WITH CHECK denial surfaces as 403 -- RLS's
// fn_assert_same_facility remains the actual enforcement, defense in depth).
import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { makeGuards } from "./guard.mjs";

const READ = "reports.read";
const MANAGE = "reports.distribution.manage";

const VALID_CHANNELS = new Set(["email", "in_app", "push"]);

const BINDING_COLUMNS =
  "id,facility_id,template_id,distribution_list_id,department_id,role_id,channel,attach_pdf,digest,active,created_at,updated_at,deleted_at";
const DELIVERY_COLUMNS =
  "id,facility_id,submission_id,report_distribution_list_id,recipient_employee_id,channel,status,provider_message_id,attempts,last_error,created_at,sent_at";
const SUBMISSION_FACILITY_COLUMNS = "id,facility_id";

export function registerReportDistributionRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams } = guards;
  const requireRead = guards.requireRead(READ);

  async function loadBinding(client, facilityId, id) {
    const rows = await pgSelect(client, "report_distribution_lists", {
      filters: { id, facility_id: facilityId },
      select: BINDING_COLUMNS,
      extra: { deleted_at: "is.null" },
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Validates every foreign reference a binding create/update carries
  // exists AND belongs to this facility, returning the first problem found
  // (null when everything checks out). Mirrors 0054's RLS WITH CHECK
  // (fn_assert_same_facility on template_id/distribution_list_id/
  // department_id/role_id) at the route layer for a clean 404 instead of a
  // 403.
  async function validateReferences(client, facilityId, { templateId, distributionListId, departmentId, roleId }) {
    const [templateRows, listRows, deptRows, roleRows] = await Promise.all([
      pgSelect(client, "report_templates", { filters: { id: templateId, facility_id: facilityId }, select: "id", limit: 1 }),
      pgSelect(client, "distribution_lists", {
        filters: { id: distributionListId, facility_id: facilityId },
        select: "id",
        limit: 1
      }),
      departmentId
        ? pgSelect(client, "departments", { filters: { id: departmentId, facility_id: facilityId }, select: "id", limit: 1 })
        : Promise.resolve(null),
      roleId ? pgSelect(client, "roles", { filters: { id: roleId, facility_id: facilityId }, select: "id", limit: 1 }) : Promise.resolve(null)
    ]);
    if ((templateRows ?? []).length === 0) return "report template not found";
    if ((listRows ?? []).length === 0) return "distribution list not found";
    if (departmentId && (deptRows ?? []).length === 0) return "department not found";
    if (roleId && (roleRows ?? []).length === 0) return "role not found";
    return null;
  }

  // --- GET /facilities/:facilityId/report-distribution-lists -----------------
  // Optional ?template_id= narrows to one template's bindings.
  router.register(
    "GET",
    "/facilities/:facilityId/report-distribution-lists",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const templateId = queryParams(request).get("template_id");
        const filters = { facility_id: params.facilityId };
        if (templateId) filters.template_id = templateId;
        const rows = await pgSelect(auth.client, "report_distribution_lists", {
          filters,
          select: BINDING_COLUMNS,
          extra: { deleted_at: "is.null" },
          order: "created_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // --- POST /facilities/:facilityId/report-distribution-lists ---------------
  router.register(
    "POST",
    "/facilities/:facilityId/report-distribution-lists",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { templateId, distributionListId, channel, departmentId, roleId } = body.payload;
        const errors = [];
        if (typeof templateId !== "string" || templateId.trim().length === 0) errors.push("templateId is required");
        if (typeof distributionListId !== "string" || distributionListId.trim().length === 0) {
          errors.push("distributionListId is required");
        }
        if (!VALID_CHANNELS.has(channel)) errors.push(`channel must be one of: ${[...VALID_CHANNELS].join(", ")}`);
        if (errors.length > 0) return sendJson(response, 400, { errors });

        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const problem = await validateReferences(auth.client, params.facilityId, {
          templateId,
          distributionListId,
          departmentId,
          roleId
        });
        if (problem) return sendJson(response, 404, { error: problem });

        const row = {
          facility_id: params.facilityId,
          template_id: templateId,
          distribution_list_id: distributionListId,
          department_id: departmentId ?? null,
          role_id: roleId ?? null,
          channel,
          attach_pdf: body.payload.attachPdf === undefined ? false : Boolean(body.payload.attachPdf),
          digest: body.payload.digest === undefined ? false : Boolean(body.payload.digest),
          active: body.payload.active === undefined ? true : Boolean(body.payload.active)
        };
        const rows = await pgInsert(auth.client, "report_distribution_lists", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // --- PATCH /facilities/:facilityId/report-distribution-lists/:id ----------
  router.register(
    "PATCH",
    "/facilities/:facilityId/report-distribution-lists/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const existing = await loadBinding(auth.client, params.facilityId, params.id);
        if (!existing) return sendJson(response, 404, { error: "report distribution binding not found" });

        if (body.payload.channel !== undefined && !VALID_CHANNELS.has(body.payload.channel)) {
          return sendJson(response, 400, { errors: [`channel must be one of: ${[...VALID_CHANNELS].join(", ")}`] });
        }

        const nextTemplateId = body.payload.templateId ?? existing.template_id;
        const nextListId = body.payload.distributionListId ?? existing.distribution_list_id;
        const nextDepartmentId = body.payload.departmentId !== undefined ? body.payload.departmentId : existing.department_id;
        const nextRoleId = body.payload.roleId !== undefined ? body.payload.roleId : existing.role_id;
        if (
          body.payload.templateId !== undefined ||
          body.payload.distributionListId !== undefined ||
          body.payload.departmentId !== undefined ||
          body.payload.roleId !== undefined
        ) {
          const problem = await validateReferences(auth.client, params.facilityId, {
            templateId: nextTemplateId,
            distributionListId: nextListId,
            departmentId: nextDepartmentId,
            roleId: nextRoleId
          });
          if (problem) return sendJson(response, 404, { error: problem });
        }

        const patch = {};
        if (body.payload.templateId !== undefined) patch.template_id = body.payload.templateId;
        if (body.payload.distributionListId !== undefined) patch.distribution_list_id = body.payload.distributionListId;
        if (body.payload.departmentId !== undefined) patch.department_id = body.payload.departmentId;
        if (body.payload.roleId !== undefined) patch.role_id = body.payload.roleId;
        if (body.payload.channel !== undefined) patch.channel = body.payload.channel;
        if (body.payload.attachPdf !== undefined) patch.attach_pdf = Boolean(body.payload.attachPdf);
        if (body.payload.digest !== undefined) patch.digest = Boolean(body.payload.digest);
        if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
        if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
        patch.updated_at = new Date().toISOString();

        const rows = await pgUpdate(
          auth.client,
          "report_distribution_lists",
          { id: params.id, facility_id: params.facilityId },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- DELETE /facilities/:facilityId/report-distribution-lists/:id ---------
  // Soft delete (deleted_at), matching every other soft-delete route in this
  // codebase -- report_distribution_lists carries no hard-delete route or
  // policy path.
  router.register(
    "DELETE",
    "/facilities/:facilityId/report-distribution-lists/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;
        const existing = await loadBinding(auth.client, params.facilityId, params.id);
        if (!existing) return sendJson(response, 404, { error: "report distribution binding not found" });
        const rows = await pgUpdate(
          auth.client,
          "report_distribution_lists",
          { id: params.id, facility_id: params.facilityId },
          { deleted_at: new Date().toISOString(), active: false, updated_at: new Date().toISOString() },
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? { deleted: true });
      })
  );

  // --- GET /reports/:id/deliveries -------------------------------------------
  // Not facility-prefixed -- matches GET /reports/:id / GET /reports/:id/pdf
  // in reports-routes.mjs: the submission's own facility_id (loaded first)
  // is what requireRead checks.
  router.register("GET", "/reports/:id/deliveries", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const submissionRows = await pgSelect(auth.client, "report_submissions", {
        filters: { id: params.id },
        select: SUBMISSION_FACILITY_COLUMNS,
        limit: 1
      });
      const submission = (submissionRows ?? [])[0] ?? null;
      if (!submission) return sendJson(response, 404, { error: "report not found" });
      if (!requireRead(auth, submission.facility_id, response)) return;

      const rows = await pgSelect(auth.client, "report_deliveries", {
        filters: { submission_id: params.id, facility_id: submission.facility_id },
        select: DELIVERY_COLUMNS,
        order: "created_at.asc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  return router;
}
