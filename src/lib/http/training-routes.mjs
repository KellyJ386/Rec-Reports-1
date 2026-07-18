import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, authCanAccessFacility } from "./guard.mjs";
import { trainingAssignmentState } from "../training.mjs";

const READ = "training.read";
const MANAGE = "training.manage";

const COURSES_COLUMNS =
  "id,facility_id,code,title,description,status,created_at,updated_at";
const TRAINING_ASSIGNMENTS_COLUMNS =
  "id,facility_id,employee_id,course_id,assigned_by,assigned_at,due_at," +
  "reason_code,source_type,source_ref_id,created_at,updated_at";
const TRAINING_COMPLETIONS_COLUMNS =
  "id,facility_id,assignment_id,completed_at,final_score_pct,completion_status,created_at";

// Registers the end-user Training API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require training.read on the row's facility; creating or managing
// training assignments requires training.manage.
export function registerTrainingRoutes(router, { authenticate, sendJson, readBody }) {
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

  async function loadAssignment(client, assignmentId) {
    const rows = await pgSelect(client, "training_assignments", {
      filters: { id: assignmentId },
      select: TRAINING_ASSIGNMENTS_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Courses ---------------------------------------------------------------
  // Lists courses for a facility. Defaults to published only; ?status=all
  // returns every status.
  router.register(
    "GET",
    "/facilities/:facilityId/courses",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const wantAll = queryParams(request).get("status") === "all";
        const filters = { facility_id: params.facilityId };
        if (!wantAll) filters.status = "published";
        const rows = await pgSelect(auth.client, "courses", {
          filters,
          select: COURSES_COLUMNS,
          order: "title.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // --- Training Assignments --------------------------------------------------
  // Lists training assignments for a facility. Optional ?status= narrows
  // the list.
  router.register(
    "GET",
    "/facilities/:facilityId/training-assignments",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        if (status) filters.source_type = status;
        const rows = await pgSelect(auth.client, "training_assignments", {
          filters,
          select: TRAINING_ASSIGNMENTS_COLUMNS,
          order: "assigned_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a training assignment. The payload is validated for minimal shape
  // before the permission guard.
  router.register(
    "POST",
    "/facilities/:facilityId/training-assignments",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { employeeId, courseId } = body.payload;
        const shape = [];
        if (!employeeId) shape.push("employeeId is required");
        if (!courseId) shape.push("courseId is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          employee_id: employeeId,
          course_id: courseId,
          assigned_by: auth.claims.sub,
          due_at: body.payload.dueAt ?? null,
          reason_code: body.payload.reasonCode ?? null,
          source_type: body.payload.sourceType ?? "manual",
          source_ref_id: body.payload.sourceRefId ?? null
        };
        const rows = await pgInsert(auth.client, "training_assignments", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Marks a training assignment complete. Inserts a training_completions row.
  router.register(
    "POST",
    "/training-assignments/:id/complete",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const assignment = await loadAssignment(auth.client, params.id);
        if (!assignment) return sendJson(response, 404, { error: "training assignment not found" });
        if (!requireRead(auth, assignment.facility_id, response)) return;

        const completionRow = {
          facility_id: assignment.facility_id,
          assignment_id: params.id,
          final_score_pct: body.payload.finalScorePct ?? null,
          completion_status: body.payload.completionStatus ?? "passed"
        };
        const rows = await pgInsert(auth.client, "training_completions", [completionRow], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
