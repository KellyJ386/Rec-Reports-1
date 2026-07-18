import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, authCanAccessFacility } from "./guard.mjs";

const READ = "work_orders.read";
const MANAGE = "work_orders.manage";

const WORK_ORDER_COLUMNS =
  "id,facility_id,department_id,asset_id,source_type,source_id,title,description,priority,status,assigned_to_employee_id,due_at,completed_at,created_by,created_at,updated_at";

// Registers the end-user Work Orders API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require work_orders.read on the row's facility; managing (creating,
// updating) requires work_orders.manage.
export function registerWorkOrderRoutes(router, { authenticate, sendJson, readBody }) {
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

  async function loadWorkOrder(client, workOrderId) {
    const rows = await pgSelect(client, "work_orders", {
      filters: { id: workOrderId },
      select: WORK_ORDER_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Work Orders -----------------------------------------------------------
  // Lists work orders for a facility. Optional ?status= narrows the list;
  // ordered by creation date descending.
  router.register(
    "GET",
    "/facilities/:facilityId/work-orders",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        if (status) filters.status = status;
        const rows = await pgSelect(auth.client, "work_orders", {
          filters,
          select: WORK_ORDER_COLUMNS,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Returns a single work order by id.
  router.register(
    "GET",
    "/work-orders/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const workOrder = await loadWorkOrder(auth.client, params.id);
        if (!workOrder) return sendJson(response, 404, { error: "work order not found" });
        if (!requireRead(auth, workOrder.facility_id, response)) return;
        return sendJson(response, 200, workOrder);
      })
  );

  // Creates a new work order. Requires title, description, and priority; validates
  // shape first (400 before guard), no fetch if invalid.
  router.register(
    "POST",
    "/facilities/:facilityId/work-orders",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { title, description, priority } = body.payload;
        const shape = [];
        if (!title) shape.push("title is required");
        if (!description) shape.push("description is required");
        if (!priority) shape.push("priority is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.department_id ?? null,
          asset_id: body.payload.asset_id ?? null,
          source_type: body.payload.source_type ?? null,
          source_id: body.payload.source_id ?? null,
          title,
          description,
          priority,
          status: "open",
          assigned_to_employee_id: body.payload.assigned_to_employee_id ?? null,
          due_at: body.payload.due_at ?? null,
          created_by: auth.claims.sub
        };
        const rows = await pgInsert(auth.client, "work_orders", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Updates a work order's status and/or assignment. The guard runs on the
  // loaded row's facility.
  router.register(
    "PATCH",
    "/work-orders/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const workOrder = await loadWorkOrder(auth.client, params.id);
        if (!workOrder) return sendJson(response, 404, { error: "work order not found" });
        if (!requirePerm(auth, workOrder.facility_id, MANAGE, response)) return;

        const patch = {};
        if (body.payload.status !== undefined) patch.status = body.payload.status;
        if (body.payload.assigned_to_employee_id !== undefined) {
          patch.assigned_to_employee_id = body.payload.assigned_to_employee_id;
        }
        if (Object.keys(patch).length === 0) {
          return sendJson(response, 400, { error: "nothing to update (send status and/or assigned_to_employee_id)" });
        }
        patch.updated_at = new Date().toISOString();

        const rows = await pgUpdate(auth.client, "work_orders", { id: params.id }, patch, {
          returning: true
        });
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
