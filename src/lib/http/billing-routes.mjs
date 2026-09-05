import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, requireAuthOrgAdmin, authCanAccessFacility } from "./guard.mjs";
import { entitlementsFor, flagState, usageStatus, loadEntitlements, isEntitled } from "../admin/entitlements.mjs";

const ENTITLEMENT = "advanced_flags";

// Registers the Phase 7 Billing & Subscription + Feature-flag read/write API.
// Reads follow the RLS grants from 0018 (subscription = org member; usage/rules
// = org member/admin; catalogs = read-all). Feature-flag rule writes are gated
// by scope: org rows require org admin; facility rows require admin.manage on
// the facility. Same injected-primitives shape as the other route modules.
export function registerBillingRoutes(router, { authenticate, sendJson, readBody }) {
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

  async function orgFacilities(client, organizationId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { organization_id: organizationId },
      select: "id"
    });
    return (rows ?? []).map((row) => row.id);
  }

  function requireOrgMember(auth, facilityIds, response) {
    const isMember = facilityIds.some((facilityId) => authCanAccessFacility(auth, facilityId));
    if (!isMember) {
      sendJson(response, 403, { error: "not a member of this organization" });
      return false;
    }
    return true;
  }

  // --- Subscription + plan + entitlements -----------------------------------
  router.register("GET", "/org/:orgId/subscription", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const facilityIds = await orgFacilities(auth.client, params.orgId);
      if (!requireOrgMember(auth, facilityIds, response)) return;
      const subs = await pgSelect(auth.client, "tenant_subscriptions", {
        filters: { organization_id: params.orgId },
        select: "id,organization_id,plan_id,status,starts_at,renews_at,seat_limit,usage_limits_jsonb",
        limit: 1
      });
      const subscription = (subs ?? [])[0] ?? null;
      let plan = null;
      if (subscription) {
        const plans = await pgSelect(auth.client, "subscription_plans", {
          filters: { id: subscription.plan_id },
          select: "id,code,name,base_price_cents,billing_period,feature_entitlements_jsonb",
          limit: 1
        });
        plan = (plans ?? [])[0] ?? null;
      }
      return sendJson(response, 200, { subscription, plan, entitlements: entitlementsFor(plan) });
    })
  );

  // --- Usage counters (with soft-limit status) ------------------------------
  router.register("GET", "/org/:orgId/usage", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const facilityIds = await orgFacilities(auth.client, params.orgId);
      if (!requireOrgMember(auth, facilityIds, response)) return;
      const subs = await pgSelect(auth.client, "tenant_subscriptions", {
        filters: { organization_id: params.orgId },
        select: "usage_limits_jsonb",
        limit: 1
      });
      const limits = (subs ?? [])[0]?.usage_limits_jsonb ?? {};
      const counters = await pgSelect(auth.client, "usage_counters", {
        filters: { organization_id: params.orgId },
        select: "id,metric_code,period_start,period_end,value",
        order: "period_start.desc"
      });
      const rows = (counters ?? []).map((counter) => {
        const limit = limits[counter.metric_code] ?? null;
        return { ...counter, limit, ...usageStatus(counter.value, limit) };
      });
      return sendJson(response, 200, rows);
    })
  );

  // --- Feature flags: catalog + effective state -----------------------------
  router.register("GET", "/org/:orgId/feature-flags", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const facilityIds = await orgFacilities(auth.client, params.orgId);
      if (!requireOrgMember(auth, facilityIds, response)) return;
      const facilityId = new URL(request.url ?? "/", "http://localhost").searchParams.get("facilityId") || null;
      const flags = await pgSelect(auth.client, "feature_flags", {
        select: "id,key,description,rollout_type,default_state",
        order: "key.asc"
      });
      const rules = await pgSelect(auth.client, "feature_flag_rules", {
        select: "id,feature_flag_id,scope_type,scope_id,state,rollout_percentage,starts_at,ends_at"
      });
      const now = new Date();
      const bucket = 0; // stable default bucket for the admin preview
      const result = (flags ?? []).map((flag) => {
        const flagRules = (rules ?? []).filter((rule) => rule.feature_flag_id === flag.id);
        return {
          ...flag,
          rules: flagRules,
          effectiveState: flagState(flag, flagRules, {
            organizationId: params.orgId,
            facilityId,
            bucket,
            now
          })
        };
      });
      return sendJson(response, 200, result);
    })
  );

  // --- Feature flag rule writes (scope-gated) -------------------------------
  function guardRuleWrite(auth, scopeType, scopeId, orgFacilityIds, response) {
    if (scopeType === "organization") {
      const guard = requireAuthOrgAdmin(auth, orgFacilityIds);
      if (!guard.allowed) {
        sendJson(response, 403, { error: guard.reason });
        return false;
      }
      return true;
    }
    // facility scope: admin.manage on that facility.
    const guard = requireAuthPermission(auth, scopeId, "admin.manage");
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  // 402-gate a feature-flag-rule write on the advanced_flags entitlement of
  // the org that OWNS the rule (org-scoped rules: the rule's own scope_id;
  // facility-scoped rules: the path org). Missing subscription -> empty
  // entitlements -> denied (fail closed), per loadEntitlements.
  async function requireEntitled(auth, orgId, response) {
    const { entitlements } = await loadEntitlements(auth.client, orgId);
    if (!isEntitled(entitlements, ENTITLEMENT)) {
      sendJson(response, 402, { error: `plan does not include ${ENTITLEMENT}` });
      return false;
    }
    return true;
  }

  router.register("POST", "/org/:orgId/feature-flag-rules", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const errors = [];
      if (typeof body.payload.featureFlagId !== "string" || body.payload.featureFlagId.trim().length === 0) {
        errors.push("featureFlagId is required");
      }
      if (body.payload.scopeType !== "organization" && body.payload.scopeType !== "facility") {
        errors.push("scopeType must be 'organization' or 'facility'");
      }
      if (typeof body.payload.scopeId !== "string" || body.payload.scopeId.trim().length === 0) {
        errors.push("scopeId is required");
      }
      if (
        body.payload.rolloutPercentage !== undefined &&
        body.payload.rolloutPercentage !== null &&
        (!Number.isInteger(body.payload.rolloutPercentage) ||
          body.payload.rolloutPercentage < 0 ||
          body.payload.rolloutPercentage > 100)
      ) {
        errors.push("rolloutPercentage must be an integer between 0 and 100");
      }
      if (errors.length > 0) return sendJson(response, 400, { errors });
      if (body.payload.scopeType === "organization" && body.payload.scopeId !== params.orgId) {
        return sendJson(response, 400, {
          errors: ["organization-scoped rules must target the organization in the path"]
        });
      }
      if (body.payload.scopeType === "facility") {
        const facilityRow = (
          await pgSelect(auth.client, "facilities", {
            filters: { id: body.payload.scopeId },
            select: "id,organization_id",
            limit: 1
          })
        )?.[0];
        if (!facilityRow || facilityRow.organization_id !== params.orgId) {
          return sendJson(response, 400, {
            errors: ["facility-scoped rules must target a facility of the organization in the path"]
          });
        }
      }
      const facilityIds = await orgFacilities(auth.client, params.orgId);
      if (!guardRuleWrite(auth, body.payload.scopeType, body.payload.scopeId, facilityIds, response)) return;
      if (!(await requireEntitled(auth, params.orgId, response))) return;
      const row = {
        feature_flag_id: body.payload.featureFlagId,
        scope_type: body.payload.scopeType,
        scope_id: body.payload.scopeId,
        state: body.payload.state === undefined ? true : Boolean(body.payload.state),
        rollout_percentage: body.payload.rolloutPercentage ?? null,
        starts_at: body.payload.startsAt ?? null,
        ends_at: body.payload.endsAt ?? null
      };
      const rows = await pgInsert(auth.client, "feature_flag_rules", [row], { returning: true });
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/org/:orgId/feature-flag-rules/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const existing = (
        await pgSelect(auth.client, "feature_flag_rules", {
          filters: { id: params.id },
          select: "id,scope_type,scope_id",
          limit: 1
        })
      )?.[0];
      if (!existing) return sendJson(response, 404, { error: "feature flag rule not found" });
      // Authorize against the rule's ACTUAL scope, not the path org: for
      // org-scoped rules the admin check runs on the org the rule targets.
      const guardOrgId = existing.scope_type === "organization" ? existing.scope_id : params.orgId;
      const facilityIds = await orgFacilities(auth.client, guardOrgId);
      if (!guardRuleWrite(auth, existing.scope_type, existing.scope_id, facilityIds, response)) return;
      if (!(await requireEntitled(auth, guardOrgId, response))) return;
      const patch = {};
      if (body.payload.state !== undefined) patch.state = Boolean(body.payload.state);
      if (body.payload.rolloutPercentage !== undefined) {
        if (
          body.payload.rolloutPercentage !== null &&
          (!Number.isInteger(body.payload.rolloutPercentage) ||
            body.payload.rolloutPercentage < 0 ||
            body.payload.rolloutPercentage > 100)
        ) {
          return sendJson(response, 400, { errors: ["rolloutPercentage must be an integer between 0 and 100"] });
        }
        patch.rollout_percentage = body.payload.rolloutPercentage;
      }
      if (body.payload.startsAt !== undefined) patch.starts_at = body.payload.startsAt;
      if (body.payload.endsAt !== undefined) patch.ends_at = body.payload.endsAt;
      if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(auth.client, "feature_flag_rules", { id: params.id }, patch, { returning: true });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  return router;
}
