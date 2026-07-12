import { pgSelect, pgInsert, pgUpdate, pgDelete } from "../supabase-rest.mjs";
import { requirePermission } from "./guard.mjs";
import { canAccessFacility } from "../permissions.mjs";
import { buildNotificationJob } from "../admin/notifications.mjs";
import { loadEntitlements, isEntitled } from "../admin/entitlements.mjs";

const PUBLISH = "communications.publish";
const ENTITLEMENT = "notification_routing";

const LIST_COLUMNS = "id,facility_id,name,description,active,created_at,updated_at";
const MEMBER_COLUMNS = "id,facility_id,distribution_list_id,member_type,member_ref_id,created_at";
const ROUTE_COLUMNS = "id,facility_id,event_code,priority,route_jsonb,active,created_at,updated_at";

// Registers the Phase 7 Notifications routing API routes on a router, using the
// same injected-primitives shape as registerWorkflowRoutes. Reads on
// facility-scoped tables are open to members; writes require
// communications.publish. The global event catalog is readable by any
// authenticated caller.
export function registerNotificationRoutes(router, { authenticate, sendJson, readBody }) {
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

  function requirePublish(auth, facilityId, response) {
    const guard = requirePermission(auth.memberships, facilityId, PUBLISH);
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

  // 402-gate a write on the notification_routing entitlement. Loaded once per
  // request. Missing subscription -> empty entitlements -> denied (fail closed).
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

  // --- Event catalog (global, read-all) --------------------------------------
  router.register("GET", "/notification-events", (request, response, { env }) =>
    withAuth(request, response, env, async (auth) => {
      const rows = await pgSelect(auth.client, "notification_events", {
        select: "id,code,severity,module_code,default_channels_jsonb",
        order: "code.asc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  // --- Distribution lists ----------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/distribution-lists",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "distribution_lists", {
          filters: { facility_id: params.facilityId },
          select: LIST_COLUMNS,
          order: "name.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/distribution-lists",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (typeof body.payload.name !== "string" || body.payload.name.trim().length === 0) {
          return sendJson(response, 400, { errors: ["name is required"] });
        }
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const row = {
          facility_id: params.facilityId,
          name: body.payload.name.trim(),
          description: body.payload.description ?? null
        };
        const rows = await pgInsert(auth.client, "distribution_lists", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  router.register(
    "PATCH",
    "/facilities/:facilityId/distribution-lists/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const patch = {};
        if (body.payload.name !== undefined) {
          if (typeof body.payload.name !== "string" || body.payload.name.trim().length === 0) {
            return sendJson(response, 400, { errors: ["name must be a non-empty string"] });
          }
          patch.name = body.payload.name.trim();
        }
        if (body.payload.description !== undefined) patch.description = body.payload.description;
        if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
        if (Object.keys(patch).length === 0) {
          return sendJson(response, 400, { error: "nothing to update" });
        }
        patch.updated_at = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "distribution_lists",
          { id: params.id, facility_id: params.facilityId },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Distribution list members --------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/distribution-lists/:id/members",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "distribution_list_members", {
          filters: { facility_id: params.facilityId, distribution_list_id: params.id },
          select: MEMBER_COLUMNS,
          order: "created_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/distribution-lists/:id/members",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const errors = [];
        if (body.payload.memberType !== "employee" && body.payload.memberType !== "role") {
          errors.push("memberType must be 'employee' or 'role'");
        }
        if (typeof body.payload.memberRefId !== "string" || body.payload.memberRefId.trim().length === 0) {
          errors.push("memberRefId is required");
        }
        if (errors.length > 0) return sendJson(response, 400, { errors });
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const row = {
          facility_id: params.facilityId,
          distribution_list_id: params.id,
          member_type: body.payload.memberType,
          member_ref_id: body.payload.memberRefId
        };
        const rows = await pgInsert(auth.client, "distribution_list_members", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  router.register(
    "DELETE",
    "/facilities/:facilityId/distribution-lists/:id/members/:memberId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        await pgDelete(auth.client, "distribution_list_members", {
          id: params.memberId,
          facility_id: params.facilityId,
          distribution_list_id: params.id
        });
        return sendJson(response, 200, { deleted: true });
      })
  );

  // --- Notification routes ---------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/notification-routes",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const eventCode = queryParams(request).get("event") || undefined;
        const filters = { facility_id: params.facilityId };
        if (eventCode) filters.event_code = eventCode;
        const rows = await pgSelect(auth.client, "notification_routes", {
          filters,
          select: ROUTE_COLUMNS,
          order: "event_code.asc,priority.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/notification-routes",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const errors = [];
        if (typeof body.payload.eventCode !== "string" || body.payload.eventCode.trim().length === 0) {
          errors.push("eventCode is required");
        }
        if (body.payload.priority !== undefined && !Number.isInteger(body.payload.priority)) {
          errors.push("priority must be an integer");
        }
        if (errors.length > 0) return sendJson(response, 400, { errors });
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const row = {
          facility_id: params.facilityId,
          event_code: body.payload.eventCode,
          priority: body.payload.priority ?? 0,
          route_jsonb: body.payload.route ?? {},
          active: body.payload.active === undefined ? true : Boolean(body.payload.active)
        };
        const rows = await pgInsert(auth.client, "notification_routes", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  router.register(
    "PATCH",
    "/facilities/:facilityId/notification-routes/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const patch = {};
        if (body.payload.priority !== undefined) {
          if (!Number.isInteger(body.payload.priority)) {
            return sendJson(response, 400, { errors: ["priority must be an integer"] });
          }
          patch.priority = body.payload.priority;
        }
        if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
        if (body.payload.route !== undefined) patch.route_jsonb = body.payload.route;
        if (Object.keys(patch).length === 0) {
          return sendJson(response, 400, { error: "nothing to update" });
        }
        patch.updated_at = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "notification_routes",
          { id: params.id, facility_id: params.facilityId },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // POST .../notification-routes/:id/test -- the "test notification sandbox".
  // Builds a notification_job for the route via buildNotificationJob and inserts
  // it into the existing notification_jobs table with a {test:true} payload
  // marker, so a route can be exercised end-to-end without a real trigger.
  router.register(
    "POST",
    "/facilities/:facilityId/notification-routes/:id/test",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePublish(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const route = (
          await pgSelect(auth.client, "notification_routes", {
            filters: { id: params.id, facility_id: params.facilityId },
            select: ROUTE_COLUMNS,
            limit: 1
          })
        )?.[0];
        if (!route) return sendJson(response, 404, { error: "notification route not found" });
        const job = buildNotificationJob(route.event_code, route, []);
        job.payload_jsonb = { ...job.payload_jsonb, test: true };
        const rows = await pgInsert(auth.client, "notification_jobs", [job], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
