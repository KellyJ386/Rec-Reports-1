import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requirePermission, requireOrgAdmin } from "./guard.mjs";
import { validateModuleTogglePayload } from "./validate.mjs";
import { mergeSettings } from "../admin-config.mjs";
import {
  validateFacilityInput,
  validateDepartmentInput,
  validateFacilitySettingsPatch
} from "../admin/facilities.mjs";

// Registers the org-tree/admin API routes on a router. All request/response
// primitives are injected so the same registration is unit-testable with stubs:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
export function registerAdminRoutes(router, { authenticate, sendJson, readBody }) {
  async function parseJsonBody(request) {
    let payload;
    try {
      payload = JSON.parse((await readBody(request)) || "{}");
    } catch {
      return { ok: false };
    }
    return { ok: true, payload };
  }

  async function orgFacilityIds(client, organizationId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { organization_id: organizationId },
      select: "id"
    });
    return (rows ?? []).map((row) => row.id);
  }

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  // Read-modify-write of a facility's settings_jsonb: merge the validated patch
  // onto the current settings (mergeSettings), updating the latest version row
  // in place, or inserting a first row when none exists yet.
  async function applyFacilitySettingsPatch(client, facilityId, patch) {
    const rows = await pgSelect(client, "facility_settings", {
      filters: { facility_id: facilityId },
      select: "id,settings_jsonb,version",
      order: "version.desc",
      limit: 1
    });
    const current = (rows ?? [])[0];
    const merged = mergeSettings(current?.settings_jsonb ?? {}, patch);
    if (current) {
      const updated = await pgUpdate(
        client,
        "facility_settings",
        { id: current.id },
        { settings_jsonb: merged },
        { returning: true }
      );
      return (updated ?? [])[0] ?? null;
    }
    const inserted = await pgInsert(
      client,
      "facility_settings",
      [{ facility_id: facilityId, settings_jsonb: merged, version: 1 }],
      { returning: true }
    );
    return (inserted ?? [])[0] ?? null;
  }

  // --- Identity ------------------------------------------------------------
  router.register("GET", "/me", (request, response, { env }) =>
    withAuth(request, response, env, (auth) =>
      sendJson(response, 200, {
        userId: auth.claims.sub,
        memberships: (auth.memberships ?? []).map((m) => ({
          facilityId: m.facilityId,
          status: m.status,
          permissions: m.permissions ?? []
        }))
      })
    )
  );

  // --- Facility module overrides ------------------------------------------
  router.register("GET", "/facilities/:facilityId/module-overrides", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requirePermission(auth.memberships, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgSelect(auth.client, "facility_module_overrides", {
        filters: { facility_id: params.facilityId },
        select: "id,module_id,enabled,config_patch_jsonb,updated_at"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  router.register(
    "PUT",
    "/facilities/:facilityId/module-overrides/:moduleId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateModuleTogglePayload(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        const guard = requirePermission(auth.memberships, params.facilityId, "admin.manage");
        if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
        const rows = await pgInsert(
          auth.client,
          "facility_module_overrides",
          [
            {
              facility_id: params.facilityId,
              module_id: params.moduleId,
              enabled: body.payload.enabled,
              config_patch_jsonb: body.payload.configPatch ?? {},
              updated_by: auth.claims.sub
            }
          ],
          { onConflict: "facility_id,module_id", merge: true, returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Org facilities ------------------------------------------------------
  router.register("GET", "/org/:orgId/facilities", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const facilityIds = await orgFacilityIds(auth.client, params.orgId);
      const guard = requireOrgAdmin(auth.memberships, facilityIds);
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgSelect(auth.client, "facilities", {
        filters: { organization_id: params.orgId },
        select: "id,organization_id,name,timezone,created_at"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  router.register("POST", "/org/:orgId/facilities", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateFacilityInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      const facilityIds = await orgFacilityIds(auth.client, params.orgId);
      const guard = requireOrgAdmin(auth.memberships, facilityIds);
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const row = { organization_id: params.orgId, name: body.payload.name };
      if (body.payload.timezone) row.timezone = body.payload.timezone;
      const rows = await pgInsert(auth.client, "facilities", [row], { returning: true });
      const facility = (rows ?? [])[0] ?? null;
      if (facility && body.payload.locale) {
        await applyFacilitySettingsPatch(auth.client, facility.id, { locale: body.payload.locale });
      }
      return sendJson(response, 201, facility);
    })
  );

  router.register("PATCH", "/facilities/:facilityId", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateFacilityInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      const found = await pgSelect(auth.client, "facilities", {
        filters: { id: params.facilityId },
        select: "id,organization_id",
        limit: 1
      });
      const facility = (found ?? [])[0];
      if (!facility) return sendJson(response, 404, { error: "facility not found" });
      const facilityIds = await orgFacilityIds(auth.client, facility.organization_id);
      const guard = requireOrgAdmin(auth.memberships, facilityIds);
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const patch = {};
      if (body.payload.name !== undefined) patch.name = body.payload.name;
      if (body.payload.timezone !== undefined) patch.timezone = body.payload.timezone;
      let updated = facility;
      if (Object.keys(patch).length > 0) {
        const rows = await pgUpdate(
          auth.client,
          "facilities",
          { id: params.facilityId },
          patch,
          { returning: true }
        );
        updated = (rows ?? [])[0] ?? facility;
      }
      if (body.payload.locale) {
        await applyFacilitySettingsPatch(auth.client, params.facilityId, { locale: body.payload.locale });
      }
      return sendJson(response, 200, updated);
    })
  );

  // --- Departments ---------------------------------------------------------
  router.register("GET", "/facilities/:facilityId/departments", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requirePermission(auth.memberships, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgSelect(auth.client, "departments", {
        filters: { facility_id: params.facilityId },
        select: "id,facility_id,name,code,status,created_at",
        order: "name.asc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  router.register("POST", "/facilities/:facilityId/departments", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateDepartmentInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      const guard = requirePermission(auth.memberships, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgInsert(
        auth.client,
        "departments",
        [{ facility_id: params.facilityId, name: body.payload.name }],
        { returning: true }
      );
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/departments/:departmentId", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateDepartmentInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      const found = await pgSelect(auth.client, "departments", {
        filters: { id: params.departmentId },
        select: "id,facility_id",
        limit: 1
      });
      const department = (found ?? [])[0];
      if (!department) return sendJson(response, 404, { error: "department not found" });
      const guard = requirePermission(auth.memberships, department.facility_id, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgUpdate(
        auth.client,
        "departments",
        { id: params.departmentId },
        { name: body.payload.name },
        { returning: true }
      );
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Facility settings ---------------------------------------------------
  router.register("GET", "/facilities/:facilityId/settings", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requirePermission(auth.memberships, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgSelect(auth.client, "facility_settings", {
        filters: { facility_id: params.facilityId },
        select: "id,facility_id,settings_jsonb,version,published_at,updated_at",
        order: "version.desc",
        limit: 1
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/facilities/:facilityId/settings", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const patch = body.payload.settingsPatch;
      const { valid, errors } = validateFacilitySettingsPatch(patch);
      if (!valid) return sendJson(response, 400, { errors });
      const guard = requirePermission(auth.memberships, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const row = await applyFacilitySettingsPatch(auth.client, params.facilityId, patch);
      return sendJson(response, 200, row);
    })
  );

  return router;
}
