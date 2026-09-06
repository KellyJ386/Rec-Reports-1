import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import {
  validateTemplateInput,
  nextTemplateVersionNumber,
  buildTemplateDraftUpdate,
  buildTemplatePublish
} from "../report-templates.mjs";
import { validateReportTemplateSchema } from "../report-schema.mjs";

const TEMPLATE_MANAGE = "reports.template.manage";
// Sibling-added catalog code (this batch): a template manager can author and
// edit templates/versions, but only a reports.publish holder may flip a
// version live. Referenced by string only -- the permissions.mjs catalog
// entry is out of scope here (DR-05).
const TEMPLATE_PUBLISH = "reports.publish";

const TEMPLATE_COLUMNS =
  "id,facility_id,department_id,code,name,description,status,active_version,created_at,updated_at";
const VERSION_COLUMNS =
  "id,facility_id,template_id,version_number,schema_json,validation_json,workflow_json,pdf_layout_json,is_published,created_at";

// Registers the Daily Reports template-management admin routes on a router,
// using the same injected-primitives shape as registerFormsRoutes:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads are open to any facility member; writes require reports.template.manage
// on the row's facility (matching the RLS gates added by 0028); publishing a
// version additionally requires reports.publish.
export function registerReportTemplatesRoutes(router, { authenticate, sendJson, readBody }) {
  const { withAuth, requireMember, parseJsonBody, queryParams } = makeGuards({
    authenticate,
    sendJson,
    readBody
  });

  function requireManage(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, TEMPLATE_MANAGE);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function requirePublish(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, TEMPLATE_PUBLISH);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  async function loadTemplateById(client, id) {
    const rows = await pgSelect(client, "report_templates", {
      filters: { id },
      select: TEMPLATE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadVersionById(client, id) {
    const rows = await pgSelect(client, "report_template_versions", {
      filters: { id },
      select: VERSION_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Templates ---------------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/report-templates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const status = queryParams(request).get("status") || undefined;
        const filters = { facility_id: params.facilityId };
        if (status) filters.status = status;
        const rows = await pgSelect(auth.client, "report_templates", {
          filters,
          select: TEMPLATE_COLUMNS,
          order: "name.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a new draft template. code/name are validated before any fetch or
  // permission check; the facility comes straight from the URL param, so the
  // manage guard needs no lookup either.
  router.register(
    "POST",
    "/facilities/:facilityId/report-templates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateTemplateInput({
          code: body.payload.code,
          name: body.payload.name,
          departmentId: body.payload.departmentId
        });
        if (!valid) return sendJson(response, 400, { errors });
        if (!requireManage(auth, params.facilityId, response)) return;
        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.departmentId ?? null,
          code: body.payload.code,
          name: body.payload.name,
          description: body.payload.description ?? null,
          status: "draft"
        };
        const rows = await pgInsert(auth.client, "report_templates", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Edits a template's metadata (name/description/departmentId/code) in
  // place. The row is loaded first so the guard runs on its real facility;
  // an empty patch is rejected with 400.
  router.register("PATCH", "/report-templates/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const target = await loadTemplateById(auth.client, params.id);
      if (!target) return sendJson(response, 404, { error: "report template not found" });
      if (!requireManage(auth, target.facility_id, response)) return;

      const patch = {};
      if (body.payload.name !== undefined) {
        if (typeof body.payload.name !== "string" || body.payload.name.trim().length === 0) {
          return sendJson(response, 400, { errors: ["name must be a non-empty string"] });
        }
        patch.name = body.payload.name;
      }
      if (body.payload.code !== undefined) {
        if (typeof body.payload.code !== "string" || !/^[a-z][a-z0-9_]*$/.test(body.payload.code)) {
          return sendJson(response, 400, { errors: ["code must be snake_case (lowercase letters, digits, underscores)"] });
        }
        patch.code = body.payload.code;
      }
      if (body.payload.description !== undefined) patch.description = body.payload.description;
      if (body.payload.departmentId !== undefined) patch.department_id = body.payload.departmentId;
      if (Object.keys(patch).length === 0) {
        return sendJson(response, 400, { error: "nothing to update (send name/code/description/departmentId)" });
      }
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(auth.client, "report_templates", { id: target.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // Archives a template (status -> 'archived'); never a DELETE, matching the
  // 0028 RLS which grants no DELETE policy at all.
  router.register("POST", "/report-templates/:id/archive", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const target = await loadTemplateById(auth.client, params.id);
      if (!target) return sendJson(response, 404, { error: "report template not found" });
      if (!requireManage(auth, target.facility_id, response)) return;
      const patch = { status: "archived", updated_at: new Date().toISOString() };
      const rows = await pgUpdate(auth.client, "report_templates", { id: target.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Versions ------------------------------------------------------------
  router.register("GET", "/report-templates/:id/versions", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const template = await loadTemplateById(auth.client, params.id);
      if (!template) return sendJson(response, 404, { error: "report template not found" });
      if (!requireMember(auth, template.facility_id, response)) return;
      const rows = await pgSelect(auth.client, "report_template_versions", {
        filters: { template_id: template.id },
        select: VERSION_COLUMNS,
        order: "version_number.desc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  // Creates a new draft version under a template, at
  // nextTemplateVersionNumber(existing). The schema is validated before any
  // fetch; the template is then loaded (for the guard's real facility) before
  // the existing-versions lookup that numbers the new row.
  router.register("POST", "/report-templates/:id/versions", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const schemaErrors = validateReportTemplateSchema(body.payload.schema).map(
        (schemaError) => `schema: ${schemaError}`
      );
      if (schemaErrors.length > 0) return sendJson(response, 400, { errors: schemaErrors });

      const template = await loadTemplateById(auth.client, params.id);
      if (!template) return sendJson(response, 404, { error: "report template not found" });
      if (!requireManage(auth, template.facility_id, response)) return;

      const existing = await pgSelect(auth.client, "report_template_versions", {
        filters: { template_id: template.id },
        select: "version_number"
      });
      const row = {
        facility_id: template.facility_id,
        template_id: template.id,
        version_number: nextTemplateVersionNumber(existing ?? []),
        schema_json: body.payload.schema,
        validation_json: body.payload.validationJson ?? {},
        workflow_json: body.payload.workflowJson ?? {},
        pdf_layout_json: body.payload.pdfLayoutJson ?? {}
      };
      const rows = await pgInsert(auth.client, "report_template_versions", [row], { returning: true });
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  // Edits a draft version's schema in place. buildTemplateDraftUpdate rejects
  // an already-published version with 409 and an invalid schema with 400.
  router.register("PATCH", "/report-template-versions/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const target = await loadVersionById(auth.client, params.id);
      if (!target) return sendJson(response, 404, { error: "report template version not found" });
      if (!requireManage(auth, target.facility_id, response)) return;
      const plan = buildTemplateDraftUpdate(target, body.payload.schema);
      if (plan.errors) return sendJson(response, 400, { errors: plan.errors });
      if (plan.error) return sendJson(response, 409, { error: plan.error });
      const rows = await pgUpdate(auth.client, "report_template_versions", { id: plan.target.id }, plan.target.patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // Publishes a draft version: flips is_published and moves the parent
  // template's active_version/status to point at it. Requires BOTH
  // reports.template.manage and reports.publish; buildTemplatePublish rejects
  // an already-published version (or a mismatched template) with 409.
  router.register(
    "POST",
    "/report-template-versions/:id/publish",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const version = await loadVersionById(auth.client, params.id);
        if (!version) return sendJson(response, 404, { error: "report template version not found" });
        if (!requireManage(auth, version.facility_id, response)) return;
        if (!requirePublish(auth, version.facility_id, response)) return;
        const template = await loadTemplateById(auth.client, version.template_id);
        if (!template) return sendJson(response, 404, { error: "report template not found" });

        const plan = buildTemplatePublish(template, version);
        if (plan.error) return sendJson(response, 409, { error: plan.error });

        const versionRows = await pgUpdate(
          auth.client,
          "report_template_versions",
          { id: plan.versionPatch.id },
          plan.versionPatch.patch,
          { returning: true }
        );
        const templateRows = await pgUpdate(
          auth.client,
          "report_templates",
          { id: plan.templatePatch.id },
          { ...plan.templatePatch.patch, updated_at: new Date().toISOString() },
          { returning: true }
        );
        return sendJson(response, 200, {
          version: (versionRows ?? [])[0] ?? null,
          template: (templateRows ?? [])[0] ?? null
        });
      })
  );

  return router;
}
