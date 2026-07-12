import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requirePermission } from "./guard.mjs";
import { canAccessFacility } from "../permissions.mjs";
import {
  validateCustomFieldInput,
  validateFormDefinition,
  nextVersionNo,
  buildFormPublish
} from "../admin/forms.mjs";

const TEMPLATE_MANAGE = "reports.template.manage";

const CUSTOM_FIELD_COLUMNS =
  "id,facility_id,entity_type,key,label,data_type,validation_jsonb,active,created_by,created_at,updated_at";
const FORM_COLUMNS =
  "id,facility_id,module_code,form_code,version_no,status,schema_jsonb,created_by,created_at,updated_at";

// Registers the Phase 7 Forms & Fields (lite) API routes on a router, using the
// same injected-primitives shape as registerWorkflowRoutes:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads are open to any facility member; writes require reports.template.manage
// on the row's facility (matching the RLS gates in 0015).
export function registerFormsRoutes(router, { authenticate, sendJson, readBody }) {
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

  function requireMember(auth, facilityId, response) {
    if (!canAccessFacility(auth.memberships, facilityId)) {
      sendJson(response, 403, { error: "not a member of this facility" });
      return false;
    }
    return true;
  }

  function requireManage(auth, facilityId, response) {
    const guard = requirePermission(auth.memberships, facilityId, TEMPLATE_MANAGE);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  // --- Custom fields ---------------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/custom-fields",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const entityType = queryParams(request).get("entity_type") || undefined;
        const filters = { facility_id: params.facilityId };
        if (entityType) filters.entity_type = entityType;
        const rows = await pgSelect(auth.client, "custom_fields", {
          filters,
          select: CUSTOM_FIELD_COLUMNS,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/custom-fields",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateCustomFieldInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requireManage(auth, params.facilityId, response)) return;
        const row = {
          facility_id: params.facilityId,
          entity_type: body.payload.entityType ?? "report",
          key: body.payload.key,
          label: body.payload.label,
          data_type: body.payload.dataType,
          validation_jsonb: body.payload.validation ?? {},
          active: body.payload.active === undefined ? true : Boolean(body.payload.active),
          created_by: auth.claims.sub
        };
        const rows = await pgInsert(auth.client, "custom_fields", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // PATCH toggles active and/or edits the label of a single field. The field's
  // facility is loaded first so the manage guard runs on the right facility.
  router.register("PATCH", "/custom-fields/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const existing = (
        await pgSelect(auth.client, "custom_fields", {
          filters: { id: params.id },
          select: CUSTOM_FIELD_COLUMNS,
          limit: 1
        })
      )?.[0];
      if (!existing) return sendJson(response, 404, { error: "custom field not found" });
      if (!requireManage(auth, existing.facility_id, response)) return;
      const patch = {};
      if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
      if (body.payload.label !== undefined) {
        if (typeof body.payload.label !== "string" || body.payload.label.trim().length === 0) {
          return sendJson(response, 400, { errors: ["label must be a non-empty string"] });
        }
        patch.label = body.payload.label;
      }
      if (Object.keys(patch).length === 0) {
        return sendJson(response, 400, { error: "nothing to update (send active and/or label)" });
      }
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(auth.client, "custom_fields", { id: params.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Form definitions ------------------------------------------------------
  router.register("GET", "/facilities/:facilityId/forms", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireMember(auth, params.facilityId, response)) return;
      const moduleCode = queryParams(request).get("module") || undefined;
      const filters = { facility_id: params.facilityId };
      if (moduleCode) filters.module_code = moduleCode;
      const rows = await pgSelect(auth.client, "form_definitions", {
        filters,
        select: FORM_COLUMNS,
        order: "form_code.asc,version_no.desc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  // POST creates a new draft. When the form_code already exists, the draft
  // lands on version = max(existing) + 1; otherwise version 1.
  router.register("POST", "/facilities/:facilityId/forms", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateFormDefinition({
        moduleCode: body.payload.moduleCode,
        formCode: body.payload.formCode,
        schema: body.payload.schema
      });
      if (!valid) return sendJson(response, 400, { errors });
      if (!requireManage(auth, params.facilityId, response)) return;
      const existing = await pgSelect(auth.client, "form_definitions", {
        filters: { facility_id: params.facilityId, form_code: body.payload.formCode },
        select: "version_no"
      });
      const row = {
        facility_id: params.facilityId,
        module_code: body.payload.moduleCode,
        form_code: body.payload.formCode,
        version_no: nextVersionNo(existing ?? []),
        status: "draft",
        schema_jsonb: body.payload.schema,
        created_by: auth.claims.sub
      };
      const rows = await pgInsert(auth.client, "form_definitions", [row], { returning: true });
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  // POST /forms/:id/publish publishes this version and retires every other
  // currently-published version of the same form_code (buildFormPublish shapes
  // the patch list; only drafts can be published).
  router.register("POST", "/forms/:id/publish", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const target = (
        await pgSelect(auth.client, "form_definitions", {
          filters: { id: params.id },
          select: FORM_COLUMNS,
          limit: 1
        })
      )?.[0];
      if (!target) return sendJson(response, 404, { error: "form definition not found" });
      if (!requireManage(auth, target.facility_id, response)) return;
      const siblings = await pgSelect(auth.client, "form_definitions", {
        filters: { facility_id: target.facility_id, form_code: target.form_code, status: "published" },
        select: FORM_COLUMNS
      });
      const plan = buildFormPublish(target, siblings ?? []);
      if (plan.error) return sendJson(response, 409, { error: plan.error });
      for (const retirement of plan.retirements) {
        await pgUpdate(auth.client, "form_definitions", { id: retirement.id }, retirement.patch, {
          returning: false
        });
      }
      const rows = await pgUpdate(auth.client, "form_definitions", { id: plan.target.id }, plan.target.patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  return router;
}
