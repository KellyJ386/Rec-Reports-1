import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { requireAuthPermission, authCanAccessFacility } from "./guard.mjs";
import { trainingAssignmentState, certificationStatus } from "../training.mjs";
import {
  validateCourseInput,
  validateCourseUpdateInput,
  validateCourseModuleInput,
  validateCourseModuleUpdateInput
} from "../admin/training.mjs";

const READ = "training.read";
const MANAGE = "training.manage";

const COURSES_COLUMNS =
  "id,facility_id,code,title,description,status,created_at,updated_at";
const COURSE_MODULES_COLUMNS =
  "id,facility_id,course_id,module_type,title,order_no,content_jsonb,required,created_at,updated_at";
const TRAINING_ASSIGNMENTS_COLUMNS =
  "id,facility_id,employee_id,course_id,assigned_by,assigned_at,due_at," +
  "reason_code,source_type,source_ref_id,created_at,updated_at";
const TRAINING_COMPLETIONS_COLUMNS =
  "id,facility_id,assignment_id,completed_at,final_score_pct,completion_status,created_at";
const EMPLOYEE_CERT_COLUMNS =
  "id,facility_id,employee_id,certification_type_id,issued_at,expires_at,evidence_path,status,created_at,updated_at";
const CERT_TYPE_COLUMNS = "id,facility_id,code,name,renewal_window_days,created_at,updated_at";

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

  // Resolves the caller's own employees.id in a facility from their auth user
  // id (auth.claims.sub). Mirrors communications-routes.mjs's
  // loadCallerEmployeeId: training_assignments/employee_certifications RLS
  // keys self-service ownership off employees.id (via employees.user_id =
  // auth.uid()), which is NOT the same value as the auth user id itself.
  async function loadCallerEmployeeId(client, facilityId, userId) {
    const rows = await pgSelect(client, "employees", {
      filters: { facility_id: facilityId, user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? [])[0]?.id ?? null;
  }

  // Attaches a derived `state` (trainingAssignmentState) to every assignment
  // row. training_assignments itself carries no completed_at/started_at
  // column, so completion is resolved with one extra lookup against
  // training_completions (facility + assignment_id in (...)); per-module
  // progress (started_at) is out of scope until TR-06 lands, so an assignment
  // with progress but no completion still derives to 'not_started'/'overdue'.
  async function attachAssignmentStates(client, facilityId, assignments) {
    if (!assignments || assignments.length === 0) return [];
    const ids = assignments.map((a) => a.id);
    const completions = await pgSelect(client, "training_completions", {
      filters: { facility_id: facilityId, assignment_id: { in: ids } },
      select: "assignment_id,completed_at"
    });
    const completedAtByAssignment = new Map(
      (completions ?? []).map((c) => [c.assignment_id, c.completed_at])
    );
    const now = new Date();
    return assignments.map((assignment) => ({
      ...assignment,
      state: trainingAssignmentState(
        {
          completedAt: completedAtByAssignment.get(assignment.id) ?? null,
          dueAt: assignment.due_at,
          startedAt: null
        },
        now
      )
    }));
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

  // Creates a course (Training Studio, minimal admin CRUD -- TR-05). Content
  // authoring lives on the modules below; this only creates the course shell.
  // Defaults to status='draft', matching the schema default, which keeps it
  // invisible to the default GET /courses list above until an admin flips it
  // to 'published'.
  router.register(
    "POST",
    "/facilities/:facilityId/courses",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateCourseInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          code: body.payload.code,
          title: body.payload.title,
          description: body.payload.description ?? null,
          status: body.payload.status ?? "draft"
        };
        try {
          const rows = await pgInsert(auth.client, "courses", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, { error: "a course with this code already exists for this facility" });
          }
          throw err;
        }
      })
  );

  // Updates a course (status flips draft -> published -> archived, or edits
  // to code/title/description). Scoped to the facility via the update filter,
  // matching cert-policy-routes.mjs's PATCH pattern.
  router.register(
    "PATCH",
    "/facilities/:facilityId/courses/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateCourseUpdateInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const patch = {};
        if (body.payload.code !== undefined) patch.code = body.payload.code;
        if (body.payload.title !== undefined) patch.title = body.payload.title;
        if (body.payload.description !== undefined) patch.description = body.payload.description;
        if (body.payload.status !== undefined) patch.status = body.payload.status;
        if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
        patch.updated_at = new Date().toISOString();

        try {
          const rows = await pgUpdate(
            auth.client,
            "courses",
            { id: params.id, facility_id: params.facilityId },
            patch,
            { returning: true }
          );
          return sendJson(response, 200, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, { error: "a course with this code already exists for this facility" });
          }
          throw err;
        }
      })
  );

  // --- Course modules ----------------------------------------------------
  // Lists a course's modules in display order.
  router.register(
    "GET",
    "/facilities/:facilityId/courses/:courseId/modules",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "course_modules", {
          filters: { facility_id: params.facilityId, course_id: params.courseId },
          select: COURSE_MODULES_COLUMNS,
          order: "order_no.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a module on a course. content_jsonb stays free-form (URL/text
  // only) for M1. order_no carries a `unique(course_id, order_no)` DB
  // constraint -- a collision is caught and surfaced as a clean 409 rather
  // than the raw PostgREST error.
  router.register(
    "POST",
    "/facilities/:facilityId/courses/:courseId/modules",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateCourseModuleInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          course_id: params.courseId,
          module_type: body.payload.moduleType,
          title: body.payload.title,
          order_no: body.payload.orderNo,
          content_jsonb: body.payload.content ?? {},
          required: body.payload.required === undefined ? true : Boolean(body.payload.required)
        };
        try {
          const rows = await pgInsert(auth.client, "course_modules", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, { error: "a module with this order_no already exists for this course" });
          }
          throw err;
        }
      })
  );

  // Updates a module (reorder, retitle, edit content, flip required). Scoped
  // to the facility and the parent course via the update filter.
  router.register(
    "PATCH",
    "/facilities/:facilityId/courses/:courseId/modules/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateCourseModuleUpdateInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const patch = {};
        if (body.payload.moduleType !== undefined) patch.module_type = body.payload.moduleType;
        if (body.payload.title !== undefined) patch.title = body.payload.title;
        if (body.payload.orderNo !== undefined) patch.order_no = body.payload.orderNo;
        if (body.payload.content !== undefined) patch.content_jsonb = body.payload.content;
        if (body.payload.required !== undefined) patch.required = Boolean(body.payload.required);
        if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
        patch.updated_at = new Date().toISOString();

        try {
          const rows = await pgUpdate(
            auth.client,
            "course_modules",
            { id: params.id, facility_id: params.facilityId, course_id: params.courseId },
            patch,
            { returning: true }
          );
          return sendJson(response, 200, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, { error: "a module with this order_no already exists for this course" });
          }
          throw err;
        }
      })
  );

  // --- Training Assignments --------------------------------------------------
  // Lists training assignments for a facility. Optional ?status= narrows the
  // list; optional ?employeeId= narrows to one employee. Every assignment
  // carries a derived `state` (trainingAssignmentState).
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
        const employeeId = qp.get("employeeId");
        if (employeeId) filters.employee_id = employeeId;
        const rows = await pgSelect(auth.client, "training_assignments", {
          filters,
          select: TRAINING_ASSIGNMENTS_COLUMNS,
          order: "assigned_at.desc"
        });
        const withState = await attachAssignmentStates(auth.client, params.facilityId, rows ?? []);
        return sendJson(response, 200, withState);
      })
  );

  // Lists the caller's own training-assignment queue ("My Queue"). Resolves
  // employees.id from the caller's auth user id (loadCallerEmployeeId) rather
  // than trusting a client-supplied employeeId, so a caller without
  // training.manage can only ever see their own assignments here -- the
  // facility-wide list above still requires training.read. Requires facility
  // membership (not training.read) since this is a self-service view.
  router.register(
    "GET",
    "/me/training-assignments",
    (request, response, { env }) =>
      withAuth(request, response, env, async (auth) => {
        const facilityId = queryParams(request).get("facilityId");
        if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
        if (!authCanAccessFacility(auth, facilityId)) {
          return sendJson(response, 403, { error: "not a member of this facility" });
        }
        const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
        if (!employeeId) return sendJson(response, 200, []);
        const rows = await pgSelect(auth.client, "training_assignments", {
          filters: { facility_id: facilityId, employee_id: employeeId },
          select: TRAINING_ASSIGNMENTS_COLUMNS,
          order: "assigned_at.desc"
        });
        const withState = await attachAssignmentStates(auth.client, facilityId, rows ?? []);
        return sendJson(response, 200, withState);
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

  // --- Certification wallet (TR-02) -------------------------------------
  // Returns the target employee's employee_certifications, each with a
  // derived `status` (certificationStatus) that folds in the matching
  // certification_types.renewal_window_days -- two pgSelects, no DB join,
  // following the scheduling-routes.mjs cert-loading pattern. With
  // ?employeeId= given, requires training.read (an admin/manager browsing
  // any employee's wallet); without it, resolves the caller's own employee
  // row and only requires facility membership, matching the /me self-service
  // shape used by /me/training-assignments above.
  router.register(
    "GET",
    "/facilities/:facilityId/employee-certifications",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const requestedEmployeeId = queryParams(request).get("employeeId");
        let employeeId;
        if (requestedEmployeeId) {
          if (!requireRead(auth, params.facilityId, response)) return;
          employeeId = requestedEmployeeId;
        } else {
          if (!authCanAccessFacility(auth, params.facilityId)) {
            return sendJson(response, 403, { error: "not a member of this facility" });
          }
          employeeId = await loadCallerEmployeeId(auth.client, params.facilityId, auth.claims.sub);
          if (!employeeId) return sendJson(response, 200, []);
        }

        const [certs, certTypes] = await Promise.all([
          pgSelect(auth.client, "employee_certifications", {
            filters: { facility_id: params.facilityId, employee_id: employeeId },
            select: EMPLOYEE_CERT_COLUMNS,
            order: "expires_at.asc"
          }),
          pgSelect(auth.client, "certification_types", {
            filters: { facility_id: params.facilityId },
            select: CERT_TYPE_COLUMNS
          })
        ]);

        const typeById = new Map((certTypes ?? []).map((t) => [t.id, t]));
        const now = new Date();
        const wallet = (certs ?? []).map((cert) => {
          const type = typeById.get(cert.certification_type_id) ?? null;
          const status = certificationStatus(
            {
              status: cert.status,
              expiresAt: cert.expires_at,
              renewalWindowDays: type?.renewal_window_days
            },
            now
          );
          return {
            ...cert,
            status,
            certification_type_code: type?.code ?? null,
            certification_type_name: type?.name ?? null
          };
        });
        return sendJson(response, 200, wallet);
      })
  );

  return router;
}
