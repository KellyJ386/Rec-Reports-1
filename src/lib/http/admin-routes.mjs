import { pgSelect, pgInsert, pgUpdate, pgDelete } from "../supabase-rest.mjs";
import { requireAuthPermission, requireAuthOrgAdmin } from "./guard.mjs";
import {
  validateModuleTogglePayload,
  validateMembershipInput,
  validateMembershipPatch,
  validateModuleSettingsPatch
} from "./validate.mjs";
import { mergeSettings } from "../admin-config.mjs";
import {
  settingsRegistry,
  settingsForModule,
  resolveEffectiveSettings
} from "../settings-registry.mjs";
import {
  validateFacilityInput,
  validateDepartmentInput,
  validateFacilitySettingsPatch
} from "../admin/facilities.mjs";
import { validateRoleGrant, simulateAccess } from "../admin/rbac.mjs";
import { permissions } from "../permissions.mjs";

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

  // Read-then-append of a facility's settings_jsonb: merge the validated patch
  // onto the current (highest-version) settings, then INSERT a new row at
  // version = latest + 1 rather than updating the latest row in place. This
  // keeps every prior settings_jsonb immutable and queryable (the
  // (facility_id, version) unique constraint from 0008 backs it), and stamps
  // published_at/published_by on the new row so "who published what, when" is
  // never ambiguous. GET .../settings already reads by version.desc limit 1,
  // so it transparently picks up the new row.
  async function applyFacilitySettingsPatch(client, facilityId, patch, actorUserId) {
    const rows = await pgSelect(client, "facility_settings", {
      filters: { facility_id: facilityId },
      select: "id,settings_jsonb,version",
      order: "version.desc",
      limit: 1
    });
    const current = (rows ?? [])[0];
    const merged = mergeSettings(current?.settings_jsonb ?? {}, patch);
    const nextVersion = (current?.version ?? 0) + 1;
    const inserted = await pgInsert(
      client,
      "facility_settings",
      [
        {
          facility_id: facilityId,
          settings_jsonb: merged,
          version: nextVersion,
          published_at: new Date().toISOString(),
          published_by: actorUserId ?? null
        }
      ],
      { returning: true }
    );
    return (inserted ?? [])[0] ?? null;
  }

  // --- Public config --------------------------------------------------------
  // Unauthenticated and DB-free: exposes only what the browser needs to talk
  // to Supabase Auth directly (the anon key is public by design). Returns 503
  // until the server environment is configured.
  router.register("GET", "/config", (request, response, { env }) => {
    const supabaseUrl = env?.SUPABASE_URL ?? "";
    const supabaseAnonKey = env?.SUPABASE_ANON_KEY ?? "";
    if (!supabaseUrl || !supabaseAnonKey) {
      return sendJson(response, 503, { error: "Supabase configuration is not available" });
    }
    return sendJson(response, 200, { supabaseUrl, supabaseAnonKey });
  });

  // --- Identity ------------------------------------------------------------
  router.register("GET", "/me", (request, response, { env }) =>
    withAuth(request, response, env, (auth) =>
      sendJson(response, 200, {
        userId: auth.claims.sub,
        platformAdmin: auth.platformAdmin === true,
        memberships: (auth.memberships ?? []).map((m) => ({
          facilityId: m.facilityId,
          departmentId: m.departmentId ?? null,
          status: m.status,
          permissions: m.permissions ?? []
        }))
      })
    )
  );

  // --- Facility module overrides ------------------------------------------
  router.register("GET", "/facilities/:facilityId/module-overrides", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
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
        const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
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
      const guard = requireAuthOrgAdmin(auth, facilityIds);
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
      const guard = requireAuthOrgAdmin(auth, facilityIds);
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const row = { organization_id: params.orgId, name: body.payload.name };
      if (body.payload.timezone) row.timezone = body.payload.timezone;
      const rows = await pgInsert(auth.client, "facilities", [row], { returning: true });
      const facility = (rows ?? [])[0] ?? null;
      if (facility && body.payload.locale) {
        await applyFacilitySettingsPatch(auth.client, facility.id, { locale: body.payload.locale }, auth.claims.sub);
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
      const guard = requireAuthOrgAdmin(auth, facilityIds);
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
        await applyFacilitySettingsPatch(
          auth.client,
          params.facilityId,
          { locale: body.payload.locale },
          auth.claims.sub
        );
      }
      return sendJson(response, 200, updated);
    })
  );

  // --- Departments ---------------------------------------------------------
  router.register("GET", "/facilities/:facilityId/departments", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
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
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
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
      const guard = requireAuthPermission(auth, department.facility_id, "admin.manage");
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
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
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
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const row = await applyFacilitySettingsPatch(auth.client, params.facilityId, patch, auth.claims.sub);
      return sendJson(response, 200, row);
    })
  );

  // --- Roles ---------------------------------------------------------------
  function mapRole(row) {
    return {
      id: row.id,
      facilityId: row.facility_id,
      name: row.name,
      isSystemRole: row.is_system_role ?? false,
      active: row.active ?? true,
      createdAt: row.created_at,
      permissionCodes: (row.role_permissions ?? []).map((entry) => entry.permission_code)
    };
  }

  // Replace a role's permission set with `codes` by deleting the current rows and
  // inserting the new ones. Bulk-set semantics keep the API idempotent.
  async function replaceRolePermissions(client, roleId, codes) {
    await pgDelete(client, "role_permissions", { role_id: roleId });
    if (codes.length > 0) {
      await pgInsert(
        client,
        "role_permissions",
        codes.map((code) => ({ role_id: roleId, permission_code: code })),
        { returning: false }
      );
    }
  }

  router.register("GET", "/facilities/:facilityId/roles", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgSelect(auth.client, "roles", {
        filters: { facility_id: params.facilityId },
        select: "id,facility_id,name,is_system_role,active,created_at,role_permissions(permission_code)",
        order: "name.asc"
      });
      return sendJson(response, 200, (rows ?? []).map(mapRole));
    })
  );

  router.register("POST", "/facilities/:facilityId/roles", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const codes = body.payload.permissionCodes ?? [];
      const { valid, errors } = validateRoleGrant({ name: body.payload.name }, codes);
      if (!valid) return sendJson(response, 400, { errors });
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const roleRows = await pgInsert(
        auth.client,
        "roles",
        [{ facility_id: params.facilityId, name: body.payload.name.trim() }],
        { returning: true }
      );
      const role = (roleRows ?? [])[0] ?? null;
      if (role) {
        await replaceRolePermissions(auth.client, role.id, codes);
      }
      return sendJson(response, 201, role ? { ...mapRole(role), permissionCodes: codes } : null);
    })
  );

  router.register("PUT", "/roles/:roleId/permissions", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const found = await pgSelect(auth.client, "roles", {
        filters: { id: params.roleId },
        select: "id,facility_id,name",
        limit: 1
      });
      const role = (found ?? [])[0];
      if (!role) return sendJson(response, 404, { error: "role not found" });
      const codes = body.payload.permissionCodes ?? [];
      const { valid, errors } = validateRoleGrant({ name: role.name }, codes);
      if (!valid) return sendJson(response, 400, { errors });
      const guard = requireAuthPermission(auth, role.facility_id, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      await replaceRolePermissions(auth.client, params.roleId, codes);
      return sendJson(response, 200, { roleId: params.roleId, permissionCodes: codes });
    })
  );

  // --- Memberships ---------------------------------------------------------
  function mapMembership(row) {
    return {
      id: row.id,
      userId: row.user_id,
      facilityId: row.facility_id,
      departmentId: row.department_id ?? null,
      roleId: row.role_id,
      status: row.status,
      createdAt: row.created_at,
      userName: row.app_users?.full_name ?? null,
      userEmail: row.app_users?.email ?? null,
      roleName: row.roles?.name ?? null
    };
  }

  router.register("GET", "/facilities/:facilityId/memberships", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgSelect(auth.client, "memberships", {
        filters: { facility_id: params.facilityId },
        select: "id,user_id,facility_id,department_id,role_id,status,created_at,app_users(full_name,email),roles(name)",
        order: "created_at.asc"
      });
      return sendJson(response, 200, (rows ?? []).map(mapMembership));
    })
  );

  router.register("POST", "/facilities/:facilityId/memberships", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateMembershipInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const rows = await pgInsert(
        auth.client,
        "memberships",
        [
          {
            facility_id: params.facilityId,
            user_id: body.payload.userId,
            role_id: body.payload.roleId,
            status: body.payload.status ?? "active",
            department_id: body.payload.departmentId ?? null
          }
        ],
        { returning: true }
      );
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/memberships/:membershipId", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateMembershipPatch(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      const found = await pgSelect(auth.client, "memberships", {
        filters: { id: params.membershipId },
        select: "id,facility_id",
        limit: 1
      });
      const membership = (found ?? [])[0];
      if (!membership) return sendJson(response, 404, { error: "membership not found" });
      const guard = requireAuthPermission(auth, membership.facility_id, "admin.manage");
      if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
      const patch = {};
      if (body.payload.roleId !== undefined) patch.role_id = body.payload.roleId;
      if (body.payload.status !== undefined) patch.status = body.payload.status;
      if (body.payload.departmentId !== undefined) patch.department_id = body.payload.departmentId;
      const rows = await pgUpdate(
        auth.client,
        "memberships",
        { id: params.membershipId },
        patch,
        { returning: true }
      );
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Access simulator ----------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/access-simulator",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
        if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
        const url = new URL(request.url ?? "/", "http://localhost");
        const userId = url.searchParams.get("userId");
        if (!userId) return sendJson(response, 400, { error: "userId query parameter is required" });
        const rows = await pgSelect(auth.client, "memberships", {
          filters: { user_id: userId, facility_id: params.facilityId },
          select: "id,facility_id,status,role_id,roles(role_permissions(permission_code))"
        });
        const memberships = (rows ?? []).map((row) => ({
          facilityId: row.facility_id,
          status: row.status,
          permissions: (row.roles?.role_permissions ?? []).map((entry) => entry.permission_code)
        }));
        const matrix = permissions.map((permission) => {
          const { allowed, reason } = simulateAccess(memberships, params.facilityId, permission);
          return { permission, allowed, reason };
        });
        return sendJson(response, 200, matrix);
      })
  );

  // --- Settings registry (public catalog) ----------------------------------
  // Any authenticated user may read the registry so the admin UI can render the
  // per-module settings forms generically from a single source of truth.
  router.register("GET", "/settings-registry", (request, response, { env }) =>
    withAuth(request, response, env, () =>
      sendJson(response, 200, { definitions: settingsRegistry })
    )
  );

  // --- Per-module configuration -------------------------------------------
  async function loadModuleByCode(client, code) {
    const rows = await pgSelect(client, "modules", {
      filters: { code },
      select: "id,code",
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadFacilityOrgId(client, facilityId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { id: facilityId },
      select: "id,organization_id",
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolve the effective per-key {value, source} for one module at a facility.
  // Org layer = organization_module_settings.config_jsonb (by organization_id +
  // module_id); facility layer = facility_module_overrides.config_patch_jsonb.
  router.register(
    "GET",
    "/facilities/:facilityId/modules/:moduleCode/config",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
        if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
        const module = await loadModuleByCode(auth.client, params.moduleCode);
        if (!module) return sendJson(response, 404, { error: "module not found" });
        const facility = await loadFacilityOrgId(auth.client, params.facilityId);
        if (!facility) return sendJson(response, 404, { error: "facility not found" });

        let orgLayer = {};
        if (facility.organization_id) {
          const orgRows = await pgSelect(auth.client, "organization_module_settings", {
            filters: { organization_id: facility.organization_id, module_id: module.id },
            select: "config_jsonb",
            limit: 1
          });
          orgLayer = (orgRows ?? [])[0]?.config_jsonb ?? {};
        }
        const facRows = await pgSelect(auth.client, "facility_module_overrides", {
          filters: { facility_id: params.facilityId, module_id: module.id },
          select: "config_patch_jsonb",
          limit: 1
        });
        const facilityLayer = (facRows ?? [])[0]?.config_patch_jsonb ?? {};

        const definitions = settingsForModule(params.moduleCode);
        const settings = resolveEffectiveSettings({ orgLayer, facilityLayer, definitions });
        return sendJson(response, 200, { moduleCode: params.moduleCode, settings });
      })
  );

  // Merge a validated { settings: { key: value } } patch into the facility's
  // module override config_patch_jsonb. Unknown key / invalid value -> 400.
  router.register(
    "PATCH",
    "/facilities/:facilityId/modules/:moduleCode/config",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const settings = body.payload.settings;
        const { valid, errors } = validateModuleSettingsPatch(params.moduleCode, settings);
        if (!valid) return sendJson(response, 400, { errors });
        const guard = requireAuthPermission(auth, params.facilityId, "admin.manage");
        if (!guard.allowed) return sendJson(response, 403, { error: guard.reason });
        const module = await loadModuleByCode(auth.client, params.moduleCode);
        if (!module) return sendJson(response, 404, { error: "module not found" });

        const existing = await pgSelect(auth.client, "facility_module_overrides", {
          filters: { facility_id: params.facilityId, module_id: module.id },
          select: "config_patch_jsonb",
          limit: 1
        });
        const currentPatch = (existing ?? [])[0]?.config_patch_jsonb ?? {};
        const mergedPatch = { ...currentPatch, ...settings };
        const rows = await pgInsert(
          auth.client,
          "facility_module_overrides",
          [
            {
              facility_id: params.facilityId,
              module_id: module.id,
              config_patch_jsonb: mergedPatch,
              updated_by: auth.claims.sub
            }
          ],
          { onConflict: "facility_id,module_id", merge: true, returning: true }
        );
        const definitions = settingsForModule(params.moduleCode);
        const resolved = resolveEffectiveSettings({ facilityLayer: mergedPatch, definitions });
        return sendJson(response, 200, {
          moduleCode: params.moduleCode,
          settings: resolved,
          override: (rows ?? [])[0] ?? null
        });
      })
  );

  return router;
}
