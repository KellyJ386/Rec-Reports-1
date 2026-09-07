import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import { loadModuleConfig } from "./module-config.mjs";
import {
  WORK_ORDER_STATUSES,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_SOURCE_TYPES,
  OPEN_STATUSES,
  ASSET_STATUSES,
  ASSET_CRITICALITY_LEVELS,
  canTransition,
  applyStatusChange,
  createWorkOrderFromIncident,
  workOrderDueAt,
  isResolvingStatus,
  slaState
} from "../work-orders.mjs";

const READ = "work_orders.read";
const MANAGE = "work_orders.manage";
const INCIDENT_READ = "incidents.read";

const WORK_ORDER_COLUMNS =
  "id,facility_id,department_id,asset_id,source_type,source_id,title,description,priority,status," +
  "assigned_to_employee_id,due_at,completed_at,sla_due_at,first_response_at,sla_breached_at,resolved_at," +
  "created_by,created_at,updated_at";

// WO-15: server-authoritative SLA fields -- a client can never set any of
// these directly on create or through a PATCH. sla_due_at is always derived
// from the facility's resolved workOrders.slaHours* config (never the
// request body); first_response_at/resolved_at are stamped by this route
// layer itself off other request fields (a status transition, a posted
// comment), never taken verbatim from the body; sla_breached_at is stamped
// ONLY by the SLA scan (src/lib/work-order-sla-scan.mjs) -- 0060's DB
// trigger is the backstop for that one specifically, this list is the
// route-layer rejection for all four.
const CLIENT_IMMUTABLE_SLA_FIELDS = ["sla_due_at", "first_response_at", "sla_breached_at", "resolved_at"];

function rejectedSlaFields(payload) {
  return CLIENT_IMMUTABLE_SLA_FIELDS.filter((field) => payload[field] !== undefined);
}

// Maps one DB-shaped work_orders row (snake_case) to slaState's camelCase
// input shape and attaches the result as `sla` on a shallow copy of the row
// -- used by both the list and detail responses so the two never drift.
function withSla(row, now) {
  return {
    ...row,
    sla: slaState({ slaDueAt: row.sla_due_at, slaBreachedAt: row.sla_breached_at, createdAt: row.created_at }, {}, now)
  };
}

// WO-12: the assets registry (WO-11/0059) lives in this same file, not a
// dedicated assets-routes.mjs module. It shares this file's permission
// codes (see the header comment above the asset route registrations below
// for the full "why work_orders.read/.manage, not a new assets.* code"
// rationale), its resolveFacilityRefs/FACILITY_REF_TABLES helper for
// department_id, and its PostgrestError-409-on-unique-violation convention
// -- keeping it here avoids re-deriving all of that in a second file for a
// table that has been part of this module's schema (0005) since day one.
const ASSET_COLUMNS =
  "id,facility_id,department_id,asset_tag,name,location_text,status,category,criticality,metadata,install_date,warranty_expires_at,created_at,updated_at";
const ASSET_STATUS_SET = new Set(ASSET_STATUSES);
const ASSET_CRITICALITY_SET = new Set(ASSET_CRITICALITY_LEVELS);

// Same [\p{L}\p{N}_\s-] sanitizer and 2-64 length bound as
// search-routes.mjs's sanitizeSearchQuery (that file's own comment gives
// the full PostgREST-filter-grammar rationale for the character class).
// Duplicated rather than imported: this module deliberately never imports
// from a sibling route module (see the INCIDENT_FOR_WORK_ORDER_COLUMNS
// comment above), so every route file stays independently readable/
// testable without cross-module coupling.
const ASSET_QUERY_MIN_LENGTH = 2;
const ASSET_QUERY_MAX_LENGTH = 64;

function sanitizeAssetQuery(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const stripped = trimmed.replace(/[^\p{L}\p{N}_\s-]/gu, "");
  if (stripped.length < ASSET_QUERY_MIN_LENGTH || stripped.length > ASSET_QUERY_MAX_LENGTH) return null;
  return stripped;
}

// Builds `(name.ilike.*q*,asset_tag.ilike.*q*)` -- q has already passed
// through sanitizeAssetQuery by the only call site below.
function assetQueryOrFilter(q) {
  return `(name.ilike.*${q}*,asset_tag.ilike.*${q}*)`;
}

// A generous but bounded cap on how many of an asset's OPEN work orders are
// fetched to compute open_work_order_count (below) -- a plain row count, not
// pgSelect's `count` option (unused/unwired: supabase-rest.mjs's `request()`
// never surfaces the Content-Range header a count=exact Prefer would need,
// and wiring that through is out of scope for this migration/route slice).
// No real facility's open-work-order backlog against a single asset is
// expected to approach this, so `.length` against a capped id-only fetch is
// an exact count in practice while keeping the request itself bounded.
const OPEN_WORK_ORDER_COUNT_CAP = 1000;

// Minimal incident projection needed to derive a work order (WO-03). Kept
// separate from incidents-routes.mjs's INCIDENT_COLUMNS on purpose -- this
// module never imports from incidents-routes.mjs.
const INCIDENT_FOR_WORK_ORDER_COLUMNS = "id,facility_id,incident_no,severity,summary";

const WORK_ORDER_UPDATE_COLUMNS =
  "id,facility_id,work_order_id,update_type,body,previous_value,new_value,created_by,created_at";

const STATUS_SET = new Set(WORK_ORDER_STATUSES);
const PRIORITY_SET = new Set(WORK_ORDER_PRIORITIES);
const SOURCE_TYPE_SET = new Set(WORK_ORDER_SOURCE_TYPES);

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
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams, parseListLimitOffset } = guards;
  const requireRead = guards.requireRead(READ);

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

  async function loadAsset(client, assetId) {
    const rows = await pgSelect(client, "assets", {
      filters: { id: assetId },
      select: ASSET_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // WO-12: "Detail response includes open_work_order_count" -- counts the
  // asset's OPEN work orders only (OPEN_STATUSES, imported above; the same
  // set the work-orders list route's ?overdue=true filter uses), under the
  // SAME caller-scoped client every other query in this route file uses, so
  // it is naturally bounded by RLS (a caller who can read this asset via
  // work_orders.read can, by construction, also read work_orders on the same
  // facility -- both policies key off the identical permission code).
  async function countOpenWorkOrders(client, assetId) {
    const rows = await pgSelect(client, "work_orders", {
      filters: { asset_id: assetId, status: { in: OPEN_STATUSES } },
      select: "id",
      limit: OPEN_WORK_ORDER_COUNT_CAP
    });
    return (rows ?? []).length;
  }

  // --- WO-09: facility-scope resolution for body-supplied foreign keys ------
  // asset_id / department_id / assigned_to_employee_id are all FKs into
  // facility-scoped tables. The DB only guards asset_id (0026's
  // fn_assert_same_facility in work_orders' WITH CHECK) -- department_id and
  // assigned_to_employee_id have NO cross-facility guard at all today (a
  // cross-facility value is silently accepted, verified empirically against
  // a live Postgres instance while auditing this route). Even where the DB
  // does guard it, a raw RLS/FK rejection surfaces as an uncaught
  // PostgrestError -> an unhandled 500 from scripts/server.mjs's catch-all,
  // not a clean 400/404. Resolving every one of the three here, in JS, before
  // any insert/update is issued closes both gaps at once: a nonexistent id
  // 404s, a cross-facility id 400s, and Postgres never sees either case.
  const FACILITY_REF_TABLES = {
    asset_id: { table: "assets", label: "asset_id" },
    department_id: { table: "departments", label: "department_id" },
    assigned_to_employee_id: { table: "employees", label: "assigned_to_employee_id" }
  };

  async function resolveFacilityRef(client, field, id, facilityId) {
    if (id === undefined || id === null) return { ok: true };
    const { table, label } = FACILITY_REF_TABLES[field];
    const rows = await pgSelect(client, table, {
      filters: { id },
      select: "id,facility_id",
      limit: 1
    });
    const row = (rows ?? [])[0];
    if (!row) return { ok: false, status: 404, error: `${label} not found` };
    if (row.facility_id !== facilityId) {
      return { ok: false, status: 400, error: `${label} does not belong to this facility` };
    }
    return { ok: true };
  }

  // Resolves each { field: id } pair in refs against facilityId in turn,
  // short-circuiting (and issuing no further fetches) on the first invalid
  // one. Absent/null ids are always ok (nothing to check -- e.g. clearing an
  // assignment or never setting a department).
  async function resolveFacilityRefs(client, facilityId, refs) {
    for (const [field, id] of Object.entries(refs)) {
      const result = await resolveFacilityRef(client, field, id, facilityId);
      if (!result.ok) return result;
    }
    return { ok: true };
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

    // WO-15: ?sla=breached|at_risk. 'breached' is a plain SQL predicate on
    // the durable sla_breached_at stamp, applied server-side like every
    // other filter here. 'at_risk' is NOT a stored column -- it is derived
    // per-row from slaState -- so it cannot be expressed as a PostgREST
    // predicate; the route handler below over-fetches open, unbreached,
    // due-dated candidates and applies slaState/limit/offset in JS instead
    // (see its own comment for the documented pagination caveat that
    // implies).
    let sla = null;
    const slaParam = qp.get("sla");
    if (slaParam !== null) {
      if (slaParam !== "breached" && slaParam !== "at_risk") {
        errors.push(`unknown sla value: ${slaParam}`);
      } else {
        sla = slaParam;
        if (sla === "at_risk" && !filters.status) filters.status = { in: OPEN_STATUSES };
      }
    }

    let order = DEFAULT_ORDER;
    const orderParam = qp.get("order");
    if (orderParam) {
      if (!ORDERABLE_COLUMNS.has(orderParam)) errors.push(`unknown order: ${orderParam}`);
      else order = orderParam;
    }

    // P-12: limit/offset parsing itself moved to the shared
    // parseListLimitOffset (guard.mjs), which always returns the single-
    // field `{ error }` shape on a bad value -- reconciled with
    // reports-routes.mjs's shape, which this file used to disagree with
    // (this function batched every bad query param, limit/offset included,
    // into `{ errors: [...] }` with `invalid limit: X` wording). A bad
    // limit/offset now short-circuits with that single-field body
    // immediately, ahead of the batched `errors` from the checks above,
    // rather than joining them.
    if (errors.length > 0) return { ok: false, body: { errors } };

    const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
    if (!paging.ok) return { ok: false, body: { error: paging.error } };

    return { ok: true, filters, order, limit: paging.limit, offset: paging.offset, sla };
  }

  // WO-12: parses ?status=/?category=/?q=/?limit=/?offset= for the assets
  // list route, entirely from the URL (no I/O) -- mirrors parseListQuery
  // above's validate-shape-first shape: an unknown status or an out-of-
  // bounds q/limit/offset 400s before any fetch. category has no DB
  // check-constraint enum (free-text, unlike status) so any non-empty value
  // is accepted as a plain eq filter.
  function parseAssetListQuery(qp, facilityId) {
    const errors = [];
    const filters = { facility_id: facilityId };
    const extra = {};

    const status = qp.get("status");
    if (status) {
      if (!ASSET_STATUS_SET.has(status)) errors.push(`unknown status: ${status}`);
      else filters.status = status;
    }

    const category = qp.get("category");
    if (category) filters.category = category;

    const rawQ = qp.get("q");
    if (rawQ !== null) {
      const q = sanitizeAssetQuery(rawQ);
      if (!q) {
        errors.push(
          `q must be ${ASSET_QUERY_MIN_LENGTH}-${ASSET_QUERY_MAX_LENGTH} characters (letters, digits, spaces, hyphens) after sanitizing`
        );
      } else {
        extra.or = assetQueryOrFilter(q);
      }
    }

    if (errors.length > 0) return { ok: false, body: { errors } };

    const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
    if (!paging.ok) return { ok: false, body: { error: paging.error } };

    return { ok: true, filters, extra, limit: paging.limit, offset: paging.offset };
  }

  // WO-12: shape-validates the fields an asset create/update body may carry
  // (all optional on PATCH; name is additionally required on POST, checked
  // by each route's own caller). Never touches the network -- every route
  // below runs this before its permission guard, same convention as
  // parseListQuery/the work-order create-body checks above.
  function validateAssetFields(payload, { requireName }) {
    const errors = [];
    if (requireName && (!payload.name || typeof payload.name !== "string" || !payload.name.trim())) {
      errors.push("name is required");
    } else if (payload.name !== undefined && (typeof payload.name !== "string" || !payload.name.trim())) {
      errors.push("name must be a non-empty string");
    }
    if (payload.status !== undefined && !ASSET_STATUS_SET.has(payload.status)) {
      errors.push(`unknown status: ${payload.status}`);
    }
    if (payload.criticality !== undefined && payload.criticality !== null && !ASSET_CRITICALITY_SET.has(payload.criticality)) {
      errors.push(`unknown criticality: ${payload.criticality}`);
    }
    if (
      payload.metadata !== undefined &&
      payload.metadata !== null &&
      (typeof payload.metadata !== "object" || Array.isArray(payload.metadata))
    ) {
      errors.push("metadata must be an object");
    }
    for (const field of ["install_date", "warranty_expires_at"]) {
      const value = payload[field];
      if (value !== undefined && value !== null && (typeof value !== "string" || Number.isNaN(new Date(value).getTime()))) {
        errors.push(`${field} must be a valid date string`);
      }
    }
    return errors;
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
        const now = new Date();
        const query = parseListQuery(qp, params.facilityId, now);
        if (!query.ok) return sendJson(response, 400, query.body);
        if (!requireRead(auth, params.facilityId, response)) return;

        // WO-15: ?sla=at_risk has no stored column to filter/paginate on in
        // SQL -- over-fetch every open, unbreached, due-dated candidate (up
        // to MAX_LIMIT, not the caller's own ?limit=) and apply slaState +
        // the caller's requested limit/offset in JS below. ?sla=breached, by
        // contrast, is a plain predicate on the durable sla_breached_at
        // column and keeps normal SQL-side pagination.
        const extra = {};
        let fetchLimit = query.limit;
        let fetchOffset = query.offset;
        if (query.sla === "breached") {
          extra.sla_breached_at = "not.is.null";
        } else if (query.sla === "at_risk") {
          extra.sla_breached_at = "is.null";
          extra.sla_due_at = "not.is.null";
          fetchLimit = MAX_LIMIT;
          fetchOffset = 0;
        }

        const rows = await pgSelect(auth.client, "work_orders", {
          filters: query.filters,
          select: WORK_ORDER_COLUMNS,
          order: query.order,
          limit: fetchLimit,
          offset: fetchOffset,
          extra: Object.keys(extra).length > 0 ? extra : undefined
        });

        let shaped = (rows ?? []).map((row) => withSla(row, now));
        if (query.sla === "at_risk") {
          shaped = shaped
            .filter((row) => row.sla.state === "at_risk")
            .slice(query.offset, query.offset + query.limit);
        }
        return sendJson(response, 200, shaped);
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
        const rejectedSla = rejectedSlaFields(body.payload);
        if (rejectedSla.length > 0) {
          shape.push(`these fields are server-computed and cannot be set directly: ${rejectedSla.join(", ")}`);
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

        const refCheck = await resolveFacilityRefs(auth.client, incident.facility_id, {
          assigned_to_employee_id: assignee
        });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

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
        // WO-15: sla_due_at is ALWAYS the config-derived deadline, even when
        // the caller overrides dueAt (the human target) -- the two are
        // independent columns from here on. due_at keeps its pre-WO-15
        // fallback behavior (the same config-derived value) when the caller
        // supplies no override.
        const slaDueAt = workOrderDueAt({ priority: created.priority }, config, now).toISOString();
        const resolvedDueAt = dueAt ?? slaDueAt;

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
          sla_due_at: slaDueAt,
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
        return sendJson(response, 200, withSla(workOrder, new Date()));
      })
  );

  // Creates a new work order. Requires title, description, and priority;
  // validates shape -- including that priority and an optional source_type
  // match their DB check-constraint enums -- entirely from the body first
  // (400 before any fetch, before the guard). A body-supplied facility_id is
  // never read: facility_id always comes from the :facilityId path param.
  // asset_id / department_id / assigned_to_employee_id are resolved against
  // this facility (WO-09) after the permission guard, before insert, so a
  // cross-facility or nonexistent reference 400s/404s cleanly rather than
  // surfacing a raw Postgres FK/RLS/check-constraint error as a 500.
  router.register(
    "POST",
    "/facilities/:facilityId/work-orders",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { title, description, priority, source_type: sourceType } = body.payload;
        const shape = [];
        if (!title) shape.push("title is required");
        if (!description) shape.push("description is required");
        if (!priority) shape.push("priority is required");
        else if (!PRIORITY_SET.has(priority)) shape.push(`unknown priority: ${priority}`);
        if (sourceType !== undefined && sourceType !== null && !SOURCE_TYPE_SET.has(sourceType)) {
          shape.push(`unknown source_type: ${sourceType}`);
        }
        const rejectedSla = rejectedSlaFields(body.payload);
        if (rejectedSla.length > 0) {
          shape.push(`these fields are server-computed and cannot be set directly: ${rejectedSla.join(", ")}`);
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const refCheck = await resolveFacilityRefs(auth.client, params.facilityId, {
          asset_id: body.payload.asset_id,
          department_id: body.payload.department_id,
          assigned_to_employee_id: body.payload.assigned_to_employee_id
        });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

        // WO-15: sla_due_at is always the facility's resolved
        // workOrders.slaHours* deadline -- never the client-supplied due_at
        // (which stays the human target, unchanged).
        const config = await loadModuleConfig({ client: auth.client, facilityId: params.facilityId, moduleCode: "work_orders" });
        const now = new Date();
        const slaDueAt = workOrderDueAt({ priority }, config, now).toISOString();

        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.department_id ?? null,
          asset_id: body.payload.asset_id ?? null,
          source_type: sourceType ?? null,
          source_id: body.payload.source_id ?? null,
          title,
          description,
          priority,
          status: "open",
          sla_due_at: slaDueAt,
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

        // WO-15: an SLA field in the body 400s before even the
        // "nothing to update" shape check below, so the response always
        // names the offending field(s) rather than "nothing to update" when
        // that is the ONLY thing the caller sent.
        const rejectedSla = rejectedSlaFields(body.payload);
        if (rejectedSla.length > 0) {
          return sendJson(response, 400, {
            errors: [`these fields are server-computed and cannot be set directly: ${rejectedSla.join(", ")}`]
          });
        }

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

        // WO-09: a reassignment must resolve to an employee in the SAME
        // facility as the work order -- the DB has no guard on
        // assigned_to_employee_id at all (only asset_id is), so this JS check
        // is the only thing standing between a cross-facility reassignment
        // and a silent write.
        const refCheck = await resolveFacilityRefs(auth.client, workOrder.facility_id, {
          assigned_to_employee_id: nextAssignee
        });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

        if (nextStatus !== undefined && !canTransition(workOrder.status, nextStatus)) {
          return sendJson(response, 409, { error: `illegal status transition: ${workOrder.status} -> ${nextStatus}` });
        }

        const now = new Date();
        const patch = {};
        const history = [];

        if (nextStatus !== undefined) {
          Object.assign(patch, applyStatusChange(workOrder, nextStatus, now));
          // WO-15: resolved_at stamps once on entering resolved/closed and
          // keeps its original timestamp through a resolved -> closed
          // transition (isResolvingStatus is true for both); it clears on
          // any transition OUT of that pair (e.g. a resolved -> in_progress
          // reopen), mirroring completed_at's own reopen-clears behavior
          // above. first_response_at stamps once, the first time a work
          // order moves off 'open' -- never re-stamped or cleared after.
          patch.resolved_at = isResolvingStatus(nextStatus) ? workOrder.resolved_at ?? now.toISOString() : null;
          if (workOrder.status === "open" && !workOrder.first_response_at) {
            patch.first_response_at = now.toISOString();
          }
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

        const updated = (rows ?? [])[0] ?? null;
        return sendJson(response, 200, updated ? withSla(updated, now) : null);
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

        // WO-15: a comment is a "first response" exactly like a status
        // change off open is (see the PATCH route above) -- stamp it once,
        // only when nothing has stamped it yet, never overwrite it.
        if (!workOrder.first_response_at) {
          await pgUpdate(
            auth.client,
            "work_orders",
            { id: workOrder.id },
            { first_response_at: new Date().toISOString() },
            { returning: false }
          );
        }

        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // --- Assets registry (WO-12) -------------------------------------------
  // Permission decision (escalated per the plan, decided here): stays on
  // `work_orders.read` / `work_orders.manage` rather than adding a new
  // `assets.*` code. Reasons:
  //   1. Assets are this module's own equipment registry (0005_work_orders.sql
  //      created `assets` in the SAME migration as `work_orders`, and it has
  //      carried the work_orders.read/.manage RLS policies -- never a
  //      dedicated pair -- since day one; WO-11/0059 only added columns, it
  //      did not touch that boundary).
  //   2. No pilot requirement on file asks for an asset-registry-specific
  //      role (e.g. "a technician who can edit assets but not work orders,
  //      or vice versa") -- the plan's own WO-12 note frames this as "stay
  //      on the existing pair unless the pilot demands otherwise", and
  //      nothing demands otherwise yet.
  //   3. S-5 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md): any BFF-enforced
  //      permission code with no `has_permission()` occurrence in RLS is a
  //      known gap the plan is actively closing (see the eight codes listed
  //      there). Introducing a brand-new `assets.manage` code here would add
  //      a NINTH unless it were also wired into 0059's RLS policies -- extra
  //      migration surface this slice's own scope (purely additive columns
  //      plus routes) does not call for. Reusing work_orders.read/.manage
  //      keeps every asset route backed by the SAME RLS boundary the SQL
  //      suite below (assets_registry.sql) already proves, with zero new
  //      policy surface.
  // If a pilot facility later needs assets and work orders split apart by
  // role, that is a follow-up migration (new code + 0059-style policy
  // rewrite on `assets`), not a retrofit of this decision.

  // Lists an facility's assets. Supports ?status=, ?category=, ?q= (ilike on
  // name/asset_tag, same sanitizer rules as search-routes.mjs's global
  // search -- see sanitizeAssetQuery above), ?limit=, ?offset=. Shape
  // validated from the URL alone before the permission guard, matching this
  // file's work-orders list route.
  router.register(
    "GET",
    "/facilities/:facilityId/assets",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const qp = queryParams(request);
        const query = parseAssetListQuery(qp, params.facilityId);
        if (!query.ok) return sendJson(response, 400, query.body);
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "assets", {
          filters: query.filters,
          extra: query.extra,
          select: ASSET_COLUMNS,
          order: "name.asc",
          limit: query.limit,
          offset: query.offset
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates an asset. Requires `name`; every other field is optional. A
  // body-supplied facility_id is never read -- it always comes from the
  // :facilityId path param. department_id is resolved against that facility
  // (WO-09's resolveFacilityRefs, reused as-is) before insert. A
  // `(facility_id, asset_tag)` unique violation (0005's constraint,
  // unchanged by 0059) is caught and answered 409, never left to surface as
  // an uncaught PostgrestError -> 500 -- mirrors training-routes.mjs's
  // course-code conflict handling exactly.
  router.register(
    "POST",
    "/facilities/:facilityId/assets",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const shape = validateAssetFields(body.payload, { requireName: true });
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const refCheck = await resolveFacilityRefs(auth.client, params.facilityId, {
          department_id: body.payload.department_id
        });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.department_id ?? null,
          asset_tag: body.payload.asset_tag ?? null,
          name: body.payload.name.trim(),
          location_text: body.payload.location_text ?? null,
          status: body.payload.status ?? "active",
          category: body.payload.category ?? null,
          criticality: body.payload.criticality ?? null,
          metadata: body.payload.metadata ?? {},
          install_date: body.payload.install_date ?? null,
          warranty_expires_at: body.payload.warranty_expires_at ?? null
        };
        try {
          const rows = await pgInsert(auth.client, "assets", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, { error: "an asset with this tag already exists for this facility" });
          }
          throw err;
        }
      })
  );

  // Returns a single asset, plus its open work order count (WO-12's
  // acceptance criterion). facility_id is always taken from the loaded row
  // -- a caller cannot steer the guard by URL alone -- so a wrong/foreign id
  // 404s before any permission is even evaluated.
  router.register(
    "GET",
    "/assets/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const asset = await loadAsset(auth.client, params.id);
        if (!asset) return sendJson(response, 404, { error: "asset not found" });
        if (!requireRead(auth, asset.facility_id, response)) return;
        const openWorkOrderCount = await countOpenWorkOrders(auth.client, asset.id);
        return sendJson(response, 200, { ...asset, open_work_order_count: openWorkOrderCount });
      })
  );

  // Updates an asset's fields (name, tag, location, department, category,
  // criticality, metadata, lifecycle dates, and/or status). Loads the row
  // first and guards on ITS facility (never a body-supplied one), matching
  // every other PATCH :id route in this file. A tag collision 409s the same
  // way the create route does.
  router.register(
    "PATCH",
    "/assets/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const {
          name,
          asset_tag: assetTag,
          location_text: locationText,
          department_id: departmentId,
          category,
          criticality,
          metadata,
          install_date: installDate,
          warranty_expires_at: warrantyExpiresAt,
          status
        } = body.payload;
        if (
          [name, assetTag, locationText, departmentId, category, criticality, metadata, installDate, warrantyExpiresAt, status].every(
            (value) => value === undefined
          )
        ) {
          return sendJson(response, 400, { error: "nothing to update" });
        }
        const shape = validateAssetFields(body.payload, { requireName: false });
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const asset = await loadAsset(auth.client, params.id);
        if (!asset) return sendJson(response, 404, { error: "asset not found" });
        if (!requirePerm(auth, asset.facility_id, MANAGE, response)) return;

        const refCheck = await resolveFacilityRefs(auth.client, asset.facility_id, { department_id: departmentId });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

        const patch = { updated_at: new Date().toISOString() };
        if (name !== undefined) patch.name = name.trim();
        if (assetTag !== undefined) patch.asset_tag = assetTag;
        if (locationText !== undefined) patch.location_text = locationText;
        if (departmentId !== undefined) patch.department_id = departmentId;
        if (category !== undefined) patch.category = category;
        if (criticality !== undefined) patch.criticality = criticality;
        if (metadata !== undefined) patch.metadata = metadata;
        if (installDate !== undefined) patch.install_date = installDate;
        if (warrantyExpiresAt !== undefined) patch.warranty_expires_at = warrantyExpiresAt;
        if (status !== undefined) patch.status = status;

        try {
          const rows = await pgUpdate(auth.client, "assets", { id: params.id }, patch, { returning: true });
          const updated = (rows ?? [])[0] ?? null;
          if (!updated) return sendJson(response, 200, updated);
          const openWorkOrderCount = await countOpenWorkOrders(auth.client, updated.id);
          return sendJson(response, 200, { ...updated, open_work_order_count: openWorkOrderCount });
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, { error: "an asset with this tag already exists for this facility" });
          }
          throw err;
        }
      })
  );

  // Retires an asset (status -> 'retired'). Deliberately touches ONLY the
  // `assets` row -- no work_orders write of any kind, so any work order
  // still referencing this asset (open or closed) is completely unaffected;
  // supabase/tests/assets_registry.sql and test/assets-routes.test.mjs both
  // assert this explicitly (WO-12's "retire does not cascade-delete work
  // orders" acceptance criterion). Idempotent-but-not-silent: retiring an
  // already-retired asset 409s, matching
  // incidents-people-routes.mjs's "person already removed" convention for a
  // repeated terminal state transition, rather than silently no-op
  // succeeding a second time.
  router.register(
    "POST",
    "/assets/:id/retire",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const asset = await loadAsset(auth.client, params.id);
        if (!asset) return sendJson(response, 404, { error: "asset not found" });
        if (!requirePerm(auth, asset.facility_id, MANAGE, response)) return;
        if (asset.status === "retired") return sendJson(response, 409, { error: "asset already retired" });

        const rows = await pgUpdate(
          auth.client,
          "assets",
          { id: params.id },
          { status: "retired", updated_at: new Date().toISOString() },
          { returning: true }
        );
        const updated = (rows ?? [])[0] ?? null;
        if (!updated) return sendJson(response, 200, updated);
        const openWorkOrderCount = await countOpenWorkOrders(auth.client, updated.id);
        return sendJson(response, 200, { ...updated, open_work_order_count: openWorkOrderCount });
      })
  );

  return router;
}
