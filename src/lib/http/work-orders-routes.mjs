import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import { loadModuleConfig } from "./module-config.mjs";
import {
  WORK_ORDER_STATUSES,
  WORK_ORDER_PRIORITIES,
  OPEN_STATUSES,
  canTransition,
  applyStatusChange,
  createWorkOrderFromIncident,
  workOrderDueAt
} from "../work-orders.mjs";

const READ = "work_orders.read";
const MANAGE = "work_orders.manage";
const INCIDENT_READ = "incidents.read";

const WORK_ORDER_COLUMNS =
  "id,facility_id,department_id,asset_id,source_type,source_id,title,description,priority,status,assigned_to_employee_id,due_at,completed_at,created_by,created_at,updated_at";

// Minimal incident projection needed to derive a work order (WO-03). Kept
// separate from incidents-routes.mjs's INCIDENT_COLUMNS on purpose -- this
// module never imports from incidents-routes.mjs.
const INCIDENT_FOR_WORK_ORDER_COLUMNS = "id,facility_id,incident_no,severity,summary";

const WORK_ORDER_UPDATE_COLUMNS =
  "id,facility_id,work_order_id,update_type,body,previous_value,new_value,created_by,created_at";

const STATUS_SET = new Set(WORK_ORDER_STATUSES);
const PRIORITY_SET = new Set(WORK_ORDER_PRIORITIES);

// ?order= allowlist for the work orders list endpoint.
const ORDERABLE_COLUMNS = new Set([
  "created_at.asc",
  "created_at.desc",
  "due_at.asc",
  "due_at.desc",
  "priority.asc",
  "priority.desc",
  "updated_at.asc",
  "updated_at.desc"
]);
const DEFAULT_ORDER = "created_at.desc";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

  async function loadIncidentForWorkOrder(client, incidentId) {
    const rows = await pgSelect(client, "incident_reports", {
      filters: { id: incidentId },
      select: INCIDENT_FOR_WORK_ORDER_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Parses and validates the list endpoint's query params entirely from the
  // request URL (no I/O), so an invalid value 400s before any fetch is made.
  // Returns { ok: true, filters, order, limit, offset } or { ok: false, body }.
  function parseListQuery(qp, facilityId, now) {
    const errors = [];
    const filters = { facility_id: facilityId };

    const status = qp.get("status");
    if (status) {
      if (!STATUS_SET.has(status)) errors.push(`unknown status: ${status}`);
      else filters.status = status;
    }

    const priority = qp.get("priority");
    if (priority) {
      if (!PRIORITY_SET.has(priority)) errors.push(`unknown priority: ${priority}`);
      else filters.priority = priority;
    }

    const assignee = qp.get("assignee");
    if (assignee) filters.assigned_to_employee_id = assignee;

    const asset = qp.get("asset");
    if (asset) filters.asset_id = asset;

    const department = qp.get("department");
    if (department) filters.department_id = department;

    const overdue = qp.get("overdue");
    if (overdue === "true") {
      // Only overlay the open-status set when the caller didn't already pin
      // an explicit ?status=; an explicit status stays intersected with the
      // overdue due_at filter instead of being widened.
      if (!filters.status) filters.status = { in: OPEN_STATUSES };
      filters.due_at = { lt: now.toISOString() };
    } else if (overdue !== null && overdue !== "false") {
      errors.push(`unknown overdue value: ${overdue}`);
    }

    let order = DEFAULT_ORDER;
    const orderParam = qp.get("order");
    if (orderParam) {
      if (!ORDERABLE_COLUMNS.has(orderParam)) errors.push(`unknown order: ${orderParam}`);
      else order = orderParam;
    }

    let limit = DEFAULT_LIMIT;
    const limitParam = qp.get("limit");
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1) {
        errors.push(`invalid limit: ${limitParam}`);
      } else {
        limit = Math.min(parsed, MAX_LIMIT);
      }
    }

    let offset = 0;
    const offsetParam = qp.get("offset");
    if (offsetParam !== null) {
      const parsed = Number(offsetParam);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push(`invalid offset: ${offsetParam}`);
      } else {
        offset = parsed;
      }
    }

    if (errors.length > 0) return { ok: false, body: { errors } };
    return { ok: true, filters, order, limit, offset };
  }

  // --- Work Orders -----------------------------------------------------------
  // Lists work orders for a facility. Supports ?status=, ?priority=,
  // ?assignee=, ?asset=, ?department=, ?overdue=true, ?order=, ?limit=,
  // ?offset=. Unknown enum values / out-of-shape pagination 400 before any
  // fetch is issued (validated from the URL alone, ahead of the permission
  // guard, matching the module's validate-shape-first convention).
  router.register(
    "GET",
    "/facilities/:facilityId/work-orders",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const qp = queryParams(request);
        const query = parseListQuery(qp, params.facilityId, new Date());
        if (!query.ok) return sendJson(response, 400, query.body);
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "work_orders", {
          filters: query.filters,
          select: WORK_ORDER_COLUMNS,
          order: query.order,
          limit: query.limit,
          offset: query.offset
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a work order from an incident (WO-03). Dual-guards on the
  // INCIDENT's facility -- both incidents.read AND work_orders.manage are
  // required, so a caller holding only one of the two is denied. The
  // incident is always loaded first and facility_id is always taken from
  // the loaded row, never from the request body (a body-supplied
  // facility_id is silently ignored). Optional body overrides (title,
  // description, assignee, dueAt) are shape-validated before any fetch is
  // issued. When dueAt is not overridden it is derived from the resolved
  // module config's SLA hours via workOrderDueAt -- this partially delivers
  // WO-04's route wiring ahead of that task landing the shared per-request
  // config-loader memoization.
  router.register(
    "POST",
    "/incidents/:id/work-orders",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const { title, description, assignee, dueAt } = body.payload;
        const shape = [];
        if (title !== undefined && (typeof title !== "string" || !title.trim())) {
          shape.push("title must be a non-empty string");
        }
        if (description !== undefined && (typeof description !== "string" || !description.trim())) {
          shape.push("description must be a non-empty string");
        }
        if (assignee !== undefined && (typeof assignee !== "string" || !assignee.trim())) {
          shape.push("assignee must be a non-empty string");
        }
        if (dueAt !== undefined && (typeof dueAt !== "string" || Number.isNaN(new Date(dueAt).getTime()))) {
          shape.push("dueAt must be a valid ISO date string");
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const incident = await loadIncidentForWorkOrder(auth.client, params.id);
        if (!incident) return sendJson(response, 404, { error: "incident not found" });

        // Dual guard: evaluate BOTH permissions before responding, so a
        // caller holding only one of the two always gets a single 403
        // rather than a partial success.
        const readGuard = requireAuthPermission(auth, incident.facility_id, INCIDENT_READ);
        const manageGuard = requireAuthPermission(auth, incident.facility_id, MANAGE);
        if (!readGuard.allowed || !manageGuard.allowed) {
          return sendJson(response, 403, {
            error: !readGuard.allowed ? readGuard.reason : manageGuard.reason
          });
        }

        const config = await loadModuleConfig({
          client: auth.client,
          facilityId: incident.facility_id,
          moduleCode: "work_orders"
        });

        const defaults = {};
        if (title !== undefined) defaults.title = title;
        if (description !== undefined) defaults.description = description;

        const created = createWorkOrderFromIncident(
          {
            id: incident.id,
            facilityId: incident.facility_id,
            incidentNo: incident.incident_no,
            severity: incident.severity,
            summary: incident.summary
          },
          defaults,
          config
        );

        const now = new Date();
        const resolvedDueAt = dueAt ?? workOrderDueAt({ priority: created.priority }, config, now).toISOString();

        const row = {
          facility_id: created.facilityId,
          department_id: null,
          asset_id: null,
          source_type: created.sourceType,
          source_id: created.sourceId,
          title: created.title,
          description: created.description,
          priority: created.priority,
          status: created.status,
          assigned_to_employee_id: assignee ?? null,
          due_at: resolvedDueAt,
          created_by: auth.claims.sub
        };
        const rows = await pgInsert(auth.client, "work_orders", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
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

  // Updates a work order's status, priority and/or assignment. Validates
  // shape (enums, at-least-one-field) before any fetch; loads the row and
  // guards on its facility next; an illegal status transition 409s before
  // any write. Every changed field writes exactly one work_order_updates
  // history row (status_change / assignment_change / priority_change).
  router.register(
    "PATCH",
    "/work-orders/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const { status: nextStatus, priority: nextPriority, assigned_to_employee_id: nextAssignee } = body.payload;
        if (nextStatus === undefined && nextPriority === undefined && nextAssignee === undefined) {
          return sendJson(response, 400, {
            error: "nothing to update (send status, priority, and/or assigned_to_employee_id)"
          });
        }
        const shape = [];
        if (nextStatus !== undefined && !STATUS_SET.has(nextStatus)) shape.push(`unknown status: ${nextStatus}`);
        if (nextPriority !== undefined && !PRIORITY_SET.has(nextPriority)) shape.push(`unknown priority: ${nextPriority}`);
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const workOrder = await loadWorkOrder(auth.client, params.id);
        if (!workOrder) return sendJson(response, 404, { error: "work order not found" });
        if (!requirePerm(auth, workOrder.facility_id, MANAGE, response)) return;

        if (nextStatus !== undefined && !canTransition(workOrder.status, nextStatus)) {
          return sendJson(response, 409, { error: `illegal status transition: ${workOrder.status} -> ${nextStatus}` });
        }

        const now = new Date();
        const patch = {};
        const history = [];

        if (nextStatus !== undefined) {
          Object.assign(patch, applyStatusChange(workOrder, nextStatus, now));
          history.push({
            update_type: "status_change",
            previous_value: workOrder.status ?? null,
            new_value: nextStatus
          });
        }
        if (nextAssignee !== undefined && nextAssignee !== workOrder.assigned_to_employee_id) {
          patch.assigned_to_employee_id = nextAssignee;
          history.push({
            update_type: "assignment_change",
            previous_value: workOrder.assigned_to_employee_id ?? null,
            new_value: nextAssignee
          });
        }
        if (nextPriority !== undefined && nextPriority !== workOrder.priority) {
          patch.priority = nextPriority;
          history.push({
            update_type: "priority_change",
            previous_value: workOrder.priority ?? null,
            new_value: nextPriority
          });
        }
        patch.updated_at = now.toISOString();

        const rows = await pgUpdate(auth.client, "work_orders", { id: params.id }, patch, {
          returning: true
        });

        if (history.length > 0) {
          await pgInsert(
            auth.client,
            "work_order_updates",
            history.map((entry) => ({
              facility_id: workOrder.facility_id,
              work_order_id: workOrder.id,
              update_type: entry.update_type,
              body: null,
              previous_value: entry.previous_value === null ? null : String(entry.previous_value),
              new_value: entry.new_value === null ? null : String(entry.new_value),
              created_by: auth.claims.sub
            })),
            { returning: true }
          );
        }

        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Work Order Updates (comment thread) ------------------------------
  // Chronological thread for a work order. The guard always runs on the
  // PARENT work order's facility_id — loaded first and never trusted from
  // the request — so access can never be steered by a foreign facility_id.
  router.register(
    "GET",
    "/work-orders/:id/updates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const workOrder = await loadWorkOrder(auth.client, params.id);
        if (!workOrder) return sendJson(response, 404, { error: "work order not found" });
        if (!requireRead(auth, workOrder.facility_id, response)) return;
        const rows = await pgSelect(auth.client, "work_order_updates", {
          filters: { work_order_id: workOrder.id },
          select: WORK_ORDER_UPDATE_COLUMNS,
          order: "created_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Posts a comment on a work order's thread. Validates the comment body
  // first (400, zero fetches), then loads the parent and guards on its
  // facility_id; facility_id and created_by are always stamped server-side
  // from the parent row / auth claims, never taken from the request body.
  router.register(
    "POST",
    "/work-orders/:id/updates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const text = typeof body.payload.body === "string" ? body.payload.body.trim() : "";
        if (!text) return sendJson(response, 400, { error: "body is required" });

        const workOrder = await loadWorkOrder(auth.client, params.id);
        if (!workOrder) return sendJson(response, 404, { error: "work order not found" });
        if (!requirePerm(auth, workOrder.facility_id, MANAGE, response)) return;

        const row = {
          facility_id: workOrder.facility_id,
          work_order_id: workOrder.id,
          update_type: "comment",
          body: text,
          previous_value: null,
          new_value: null,
          created_by: auth.claims.sub
        };
        const rows = await pgInsert(auth.client, "work_order_updates", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
