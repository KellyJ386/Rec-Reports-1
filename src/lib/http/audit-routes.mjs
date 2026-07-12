import { requirePermission } from "./guard.mjs";
import { queryAuditTimeline, buildExportPackage } from "../admin/audit-export.mjs";
import { verifyDbChain } from "../audit.mjs";

const VERIFY_LIMIT = 10000;
const EXPORT_LIMIT = 10000;

// Registers the Audit & Compliance API routes on a router, following the same
// injected-primitives shape as registerAdminRoutes (admin-routes.mjs):
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>   (unused here -- every route is a
//     read; kept in the signature so this registration function is a drop-in
//     alongside registerAdminRoutes in scripts/server.mjs)
export function registerAuditRoutes(router, { authenticate, sendJson, readBody }) {
  void readBody;

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  function requireAuditAccess(auth, facilityId, response) {
    const guard = requirePermission(auth.memberships, facilityId, "admin.manage");
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  // GET /facilities/:facilityId/audit?entityTable=&eventType=&limit=
  router.register("GET", "/facilities/:facilityId/audit", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireAuditAccess(auth, params.facilityId, response)) return;
      const search = queryParams(request);
      const limitParam = search.get("limit");
      const limit = limitParam ? Number(limitParam) : undefined;
      const rows = await queryAuditTimeline(auth.client, {
        facilityId: params.facilityId,
        entityTable: search.get("entityTable") || undefined,
        eventType: search.get("eventType") || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
      });
      return sendJson(response, 200, rows);
    })
  );

  // GET /facilities/:facilityId/audit/verify -- fetches the facility's chain
  // ascending and runs verifyDbChain over it.
  router.register("GET", "/facilities/:facilityId/audit/verify", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireAuditAccess(auth, params.facilityId, response)) return;
      const rows = await queryAuditTimeline(auth.client, {
        facilityId: params.facilityId,
        order: "created_at.asc",
        limit: VERIFY_LIMIT
      });
      const { valid, brokenAt } = verifyDbChain(rows);
      return sendJson(response, 200, { valid, brokenAt, checked: rows.length });
    })
  );

  // GET /facilities/:facilityId/audit/export?format=csv|json
  //
  // The shared sendJson primitive (scripts/server.mjs) always serializes its
  // payload as application/json -- registerAuditRoutes only receives that one
  // response primitive, matching registerAdminRoutes exactly, so this route
  // cannot set a raw text/csv Content-Type or Content-Disposition header on
  // the HTTP response itself. Instead it returns buildExportPackage's
  // {contentType, filename, body} envelope as JSON, plus a ready-to-use
  // contentDisposition string; the client (pages/audit.js) is the one that
  // turns `body` into a Blob with `contentType` and triggers the download as
  // `filename`, which is also the only way to attach the Bearer auth header
  // an export request needs (a bare <a href> can't set request headers).
  router.register("GET", "/facilities/:facilityId/audit/export", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireAuditAccess(auth, params.facilityId, response)) return;
      const search = queryParams(request);
      const format = (search.get("format") || "csv").toLowerCase() === "json" ? "json" : "csv";
      const rows = await queryAuditTimeline(auth.client, {
        facilityId: params.facilityId,
        entityTable: search.get("entityTable") || undefined,
        eventType: search.get("eventType") || undefined,
        order: "created_at.asc",
        limit: EXPORT_LIMIT
      });
      const pkg = buildExportPackage(rows, format);
      return sendJson(response, 200, {
        ...pkg,
        contentDisposition: `attachment; filename="${pkg.filename}"`
      });
    })
  );

  return router;
}
