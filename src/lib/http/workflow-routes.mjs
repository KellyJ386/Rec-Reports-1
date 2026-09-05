import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import {
  createChangeRequest,
  advanceChangeRequest,
  validateChangeRequestInput
} from "../admin/change-requests.mjs";
import { validateThemePatch, buildBrandingUpsert } from "../admin/branding.mjs";
import { exportTable, isExportableTable, permissionForTable } from "../admin/export.mjs";

const EXPORT_LIMIT = 10000;
const TRANSITION_ACTIONS = ["submit", "approve", "reject", "publish"];

const CHANGE_REQUEST_COLUMNS =
  "id,facility_id,entity_table,entity_id,change_summary,before_jsonb,after_jsonb,status,requested_by,reviewed_by,reviewed_at,published_at,created_at,updated_at";

// Registers the Phase 6 workflow API routes (draft/publish change requests,
// branding, generic data export) on a router, following the same
// injected-primitives shape as registerAdminRoutes/registerAuditRoutes:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Note on /change-requests/:id/publish: it only flips the change request's
// own status to 'published' (via advanceChangeRequest, mirroring the DB's
// fn_enforce_change_request_transition). It does NOT replay after_jsonb onto
// the target entity_table/entity_id automatically -- applying a staged
// change is the responsibility of the specific admin surface that created
// the request. For branding, that's pages/branding.js: it calls
// PATCH .../branding to apply the theme patch itself, then calls this
// endpoint to mark the change request published as a record of what
// happened. A generic "replay this jsonb patch onto an arbitrary table" isn't
// implemented here (see ADMIN_CONTROL_CENTER_IMPLEMENTATION_PLAN.md Phase 6).
export function registerWorkflowRoutes(router, { authenticate, sendJson, readBody }) {
  async function parseJsonBody(request) {
    let payload;
    try {
      payload = JSON.parse((await readBody(request)) || "{}");
    } catch {
      return { ok: false };
    }
    return { ok: true, payload };
  }

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  function requireAdmin(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, "admin.manage");
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  async function loadChangeRequest(client, id) {
    const rows = await pgSelect(client, "admin_change_requests", {
      filters: { id },
      select: CHANGE_REQUEST_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Change requests -------------------------------------------------
  router.register(
    "POST",
    "/facilities/:facilityId/change-requests",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateChangeRequestInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requireAdmin(auth, params.facilityId, response)) return;
        const row = createChangeRequest({
          facilityId: params.facilityId,
          entityTable: body.payload.entityTable,
          entityId: body.payload.entityId,
          changeSummary: body.payload.changeSummary,
          before: body.payload.before,
          after: body.payload.after,
          requestedBy: auth.claims.sub
        });
        const rows = await pgInsert(auth.client, "admin_change_requests", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  router.register(
    "GET",
    "/facilities/:facilityId/change-requests",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireAdmin(auth, params.facilityId, response)) return;
        const search = queryParams(request);
        const status = search.get("status") || undefined;
        const filters = { facility_id: params.facilityId };
        if (status) filters.status = status;
        const rows = await pgSelect(auth.client, "admin_change_requests", {
          filters,
          select: CHANGE_REQUEST_COLUMNS,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // POST /change-requests/:id/submit|approve|reject|publish -- one route per
  // action, all sharing the same load -> guard -> advance -> persist shape.
  // Illegal transitions (per advanceChangeRequest, mirroring the DB trigger)
  // surface as 409 rather than 400: the request body is fine, the resource's
  // current state just doesn't allow this action right now.
  function registerTransition(action) {
    router.register("POST", `/change-requests/:id/${action}`, (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const cr = await loadChangeRequest(auth.client, params.id);
        if (!cr) return sendJson(response, 404, { error: "change request not found" });
        if (!requireAdmin(auth, cr.facility_id, response)) return;
        const patch = advanceChangeRequest(cr, action, auth.claims.sub);
        if (patch.error) return sendJson(response, 409, { error: patch.error });
        const rows = await pgUpdate(auth.client, "admin_change_requests", { id: params.id }, patch, {
          returning: true
        });
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
    );
  }
  for (const action of TRANSITION_ACTIONS) registerTransition(action);

  // --- Branding ------------------------------------------------------------
  // GET returns the facility's default branding profile (falling back to the
  // most recently updated one when no default is flagged).
  router.register("GET", "/facilities/:facilityId/branding", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireAdmin(auth, params.facilityId, response)) return;
      const rows = await pgSelect(auth.client, "branding_profiles", {
        filters: { facility_id: params.facilityId },
        select: "id,facility_id,name,theme_jsonb,logo_path,is_default,updated_at,created_at",
        order: "is_default.desc,updated_at.desc",
        limit: 1
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  router.register("PATCH", "/facilities/:facilityId/branding", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateThemePatch(body.payload);
      if (!valid) return sendJson(response, 400, { errors });
      if (!requireAdmin(auth, params.facilityId, response)) return;
      const row = buildBrandingUpsert(params.facilityId, body.payload, auth.claims.sub);
      const rows = await pgInsert(auth.client, "branding_profiles", [row], {
        onConflict: "facility_id,name",
        merge: true,
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Generic data export --------------------------------------------------
  // GET /facilities/:facilityId/export/:table?format=csv|json|pdf. `table` must be
  // in export.mjs's EXPORTABLE_TABLES allow-list; the caller needs either that
  // table's mapped permission code or admin.manage. Response envelope matches
  // registerAuditRoutes' export route ({contentType, filename, body,
  // contentDisposition}) so pages/export.js can reuse the same Blob-download
  // pattern as pages/audit.js.
  router.register(
    "GET",
    "/facilities/:facilityId/export/:table",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!isExportableTable(params.table)) {
          return sendJson(response, 400, { error: `table is not exportable: ${params.table}` });
        }
        const requiredCode = permissionForTable(params.table);
        const tableGuard = requireAuthPermission(auth, params.facilityId, requiredCode);
        const adminGuard = requireAuthPermission(auth, params.facilityId, "admin.manage");
        if (!tableGuard.allowed && !adminGuard.allowed) {
          return sendJson(response, 403, { error: tableGuard.reason });
        }
        const search = queryParams(request);
        const requested = (search.get("format") || "csv").toLowerCase();
        const format = requested === "json" || requested === "pdf" ? requested : "csv";
        const rows = await pgSelect(auth.client, params.table, {
          filters: { facility_id: params.facilityId },
          limit: EXPORT_LIMIT
        });
        const pkg = exportTable(rows ?? [], format, params.table);
        if (pkg.error) return sendJson(response, 400, { error: pkg.error });
        return sendJson(response, 200, {
          ...pkg,
          contentDisposition: `attachment; filename="${pkg.filename}"`
        });
      })
  );

  return router;
}
