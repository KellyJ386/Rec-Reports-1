import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, authCanAccessFacility } from "./guard.mjs";
import {
  validateRequirementInput,
  validatePolicyInput,
  requirementsForRole,
  certGaps
} from "../admin/cert-policy.mjs";
import { loadEntitlements, isEntitled } from "../admin/entitlements.mjs";

const MANAGE = "training.manage";
const ENTITLEMENT = "cert_policies";

const REQUIREMENT_COLUMNS =
  "id,facility_id,certification_type_id,role_id,required_level,enforcement_mode,active,created_at,updated_at";
const POLICY_COLUMNS =
  "id,facility_id,trigger_type,cadence_rule_jsonb,action_jsonb,active,created_at,updated_at";
const CERT_COLUMNS = "id,facility_id,employee_id,certification_type_id,issued_at,expires_at,status";

// Registers the Phase 7 Certification policy API routes on a router, using the
// same injected-primitives shape as registerNotificationRoutes. Reads are open
// to facility members; writes require training.manage AND the cert_policies
// entitlement on the facility's organization (402 otherwise).
export function registerCertPolicyRoutes(router, { authenticate, sendJson, readBody }) {
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
    if (!authCanAccessFacility(auth, facilityId)) {
      sendJson(response, 403, { error: "not a member of this facility" });
      return false;
    }
    return true;
  }

  function requireManage(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, MANAGE);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  async function facilityOrgId(client, facilityId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { id: facilityId },
      select: "organization_id",
      limit: 1
    });
    return (rows ?? [])[0]?.organization_id ?? null;
  }

  // 402-gate a write on the cert_policies entitlement. Missing subscription ->
  // empty entitlements -> denied (fail closed), per loadEntitlements.
  async function requireEntitled(auth, facilityId, response) {
    const orgId = await facilityOrgId(auth.client, facilityId);
    const { entitlements } = await loadEntitlements(auth.client, orgId);
    if (!isEntitled(entitlements, ENTITLEMENT)) {
      sendJson(response, 402, { error: `plan does not include ${ENTITLEMENT}` });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  // --- Certification role requirements --------------------------------------
  router.register("GET", "/facilities/:facilityId/cert-requirements", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireMember(auth, params.facilityId, response)) return;
      const roleId = queryParams(request).get("roleId") || undefined;
      const filters = { facility_id: params.facilityId };
      if (roleId) filters.role_id = roleId;
      const rows = await pgSelect(auth.client, "certification_role_requirements", {
        filters,
        select: REQUIREMENT_COLUMNS,
        order: "created_at.asc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  router.register("POST", "/facilities/:facilityId/cert-requirements", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateRequirementInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      if (!requireManage(auth, params.facilityId, response)) return;
      if (!(await requireEntitled(auth, params.facilityId, response))) return;
      const row = {
        facility_id: params.facilityId,
        certification_type_id: body.payload.certificationTypeId,
        role_id: body.payload.roleId,
        required_level: body.payload.requiredLevel ?? "required",
        enforcement_mode: body.payload.enforcementMode ?? null,
        active: body.payload.active === undefined ? true : Boolean(body.payload.active)
      };
      const rows = await pgInsert(auth.client, "certification_role_requirements", [row], { returning: true });
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/facilities/:facilityId/cert-requirements/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      if (!requireManage(auth, params.facilityId, response)) return;
      if (!(await requireEntitled(auth, params.facilityId, response))) return;
      const patch = {};
      if (body.payload.enforcementMode !== undefined) {
        if (
          body.payload.enforcementMode !== null &&
          body.payload.enforcementMode !== "hard-block" &&
          body.payload.enforcementMode !== "warning"
        ) {
          return sendJson(response, 400, { errors: ["enforcementMode must be 'hard-block', 'warning', or null"] });
        }
        patch.enforcement_mode = body.payload.enforcementMode;
      }
      if (body.payload.requiredLevel !== undefined) patch.required_level = body.payload.requiredLevel;
      if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
      if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(
        auth.client,
        "certification_role_requirements",
        { id: params.id, facility_id: params.facilityId },
        patch,
        { returning: true }
      );
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Certification policies ------------------------------------------------
  router.register("GET", "/facilities/:facilityId/cert-policies", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireMember(auth, params.facilityId, response)) return;
      const rows = await pgSelect(auth.client, "certification_policies", {
        filters: { facility_id: params.facilityId },
        select: POLICY_COLUMNS,
        order: "created_at.asc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  router.register("POST", "/facilities/:facilityId/cert-policies", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validatePolicyInput(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      if (!requireManage(auth, params.facilityId, response)) return;
      if (!(await requireEntitled(auth, params.facilityId, response))) return;
      const row = {
        facility_id: params.facilityId,
        trigger_type: body.payload.triggerType,
        cadence_rule_jsonb: body.payload.cadenceRule ?? {},
        action_jsonb: body.payload.action ?? {},
        active: body.payload.active === undefined ? true : Boolean(body.payload.active)
      };
      const rows = await pgInsert(auth.client, "certification_policies", [row], { returning: true });
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/facilities/:facilityId/cert-policies/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      if (!requireManage(auth, params.facilityId, response)) return;
      if (!(await requireEntitled(auth, params.facilityId, response))) return;
      const patch = {};
      if (body.payload.cadenceRule !== undefined) patch.cadence_rule_jsonb = body.payload.cadenceRule;
      if (body.payload.action !== undefined) patch.action_jsonb = body.payload.action;
      if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
      if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(
        auth.client,
        "certification_policies",
        { id: params.id, facility_id: params.facilityId },
        patch,
        { returning: true }
      );
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Certification gaps report --------------------------------------------
  // Joins the role's requirements against every employee_certification in the
  // facility (two pgSelects) and folds them through certGaps, returning one
  // entry per employee that has at least one gap.
  router.register("GET", "/facilities/:facilityId/cert-gaps", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireMember(auth, params.facilityId, response)) return;
      const roleId = queryParams(request).get("roleId");
      if (!roleId) return sendJson(response, 400, { error: "roleId query parameter is required" });

      const allRequirements = await pgSelect(auth.client, "certification_role_requirements", {
        filters: { facility_id: params.facilityId, role_id: roleId },
        select: REQUIREMENT_COLUMNS
      });
      const requirements = requirementsForRole(allRequirements ?? [], roleId);

      const certs = await pgSelect(auth.client, "employee_certifications", {
        filters: { facility_id: params.facilityId },
        select: CERT_COLUMNS
      });

      const byEmployee = new Map();
      for (const cert of certs ?? []) {
        const list = byEmployee.get(cert.employee_id) ?? [];
        list.push(cert);
        byEmployee.set(cert.employee_id, list);
      }

      const today = new Date();
      const employees = [];
      for (const [employeeId, employeeCerts] of byEmployee.entries()) {
        const gaps = certGaps(employeeCerts, requirements, today);
        if (gaps.length > 0) employees.push({ employeeId, gaps });
      }

      return sendJson(response, 200, { roleId, requirementCount: requirements.length, employees });
    })
  );

  return router;
}
