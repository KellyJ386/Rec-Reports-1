import { createHash } from "node:crypto";
import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { requireAuthPermission, authCanAccessFacility } from "./guard.mjs";
import { trainingAssignmentState, certificationStatus, assignmentReadyToComplete } from "../training.mjs";
import {
  validateCourseInput,
  validateCourseUpdateInput,
  validateCourseModuleInput,
  validateCourseModuleUpdateInput
} from "../admin/training.mjs";
import { certificationEventFor, evidenceUploadedPayload } from "../admin/cert-evidence.mjs";
import {
  createStorageClientFromEnv,
  buildAttachmentPath,
  assertMimeAllowed,
  assertWithinSizeCap,
  uploadObject,
  createSignedUrl,
  DEFAULT_MAX_UPLOAD_BYTES,
  StorageValidationError
} from "../storage.mjs";

const READ = "training.read";
const MANAGE = "training.manage";
const EVIDENCE_STORAGE_MODULE = "certifications";
const EVIDENCE_SIGNED_URL_TTL_SECONDS = 300;
const CERTIFICATION_STATUSES = ["active", "expired", "revoked"];

const COURSES_COLUMNS =
  "id,facility_id,code,title,description,status,created_at,updated_at";
const COURSE_MODULES_COLUMNS =
  "id,facility_id,course_id,module_type,title,order_no,content_jsonb,required,created_at,updated_at";
const TRAINING_ASSIGNMENTS_COLUMNS =
  "id,facility_id,employee_id,course_id,assigned_by,assigned_at,due_at," +
  "reason_code,source_type,source_ref_id,created_at,updated_at";
const TRAINING_COMPLETIONS_COLUMNS =
  "id,facility_id,assignment_id,completed_at,final_score_pct,completion_status,created_at";
const TRAINING_PROGRESS_COLUMNS =
  "id,facility_id,assignment_id,module_id,state,started_at,completed_at,score_pct,attempts,created_at,updated_at";
// Matches the 0007 training_progress.state check constraint exactly.
const TRAINING_PROGRESS_STATES = ["not_started", "in_progress", "completed", "failed"];
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
//
// createStorageClient(env) -> storage client (see src/lib/storage.mjs); only
// used by the TR-03 evidence routes below. Defaults to
// createStorageClientFromEnv(env), same convention as
// attachments-routes.mjs's registerAttachmentRoutes -- tests inject a stub
// client with a fake fetchImpl instead of hitting real Storage REST.
export function registerTrainingRoutes(
  router,
  { authenticate, sendJson, readBody, createStorageClient = (env) => createStorageClientFromEnv(env) }
) {
  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  // Thrown by readRawBody when the request body (declared or actual)
  // exceeds the per-route cap.
  class UploadTooLargeError extends Error {
    constructor(message) {
      super(message);
      this.name = "UploadTooLargeError";
    }
  }

  // Reads the declared Content-Length header, if any, as a plain number (no
  // I/O) so an oversize upload can 413 before the cert row is even loaded.
  function declaredContentLength(request) {
    const header = request.headers?.["content-length"];
    if (header === undefined || header === null || header === "") return null;
    const value = Number(header);
    return Number.isFinite(value) ? value : null;
  }

  // Reads the raw request body into a Buffer, enforcing maxBytes as data
  // arrives. Duplicated from attachments-routes.mjs's readRawBody (not
  // exported there) rather than sharing an import, per plans/TRAINING_PLAN.md
  // TR-03 -- noted here as a candidate for a future shared http-body helper.
  function readRawBody(request, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let received = 0;
      request.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          if (typeof request.destroy === "function") request.destroy();
          reject(new UploadTooLargeError(`request body exceeds the ${maxBytes}-byte cap`));
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
  }

  // A StorageValidationError's `code` decides the HTTP status: only
  // "file_too_large" is a 413, everything else (bad mime, unsafe path
  // segments, empty/invalid filename) is a 400 shape problem.
  function storageErrorStatus(error) {
    return error.code === "file_too_large" ? 413 : 400;
  }

  // A percent-encoded x-file-name is decoded here; a plain ASCII filename
  // with no "%" round-trips through decodeURIComponent unchanged, so this is
  // safe either way. A malformed percent-encoding falls back to the raw
  // header value -- sanitizeFilename (inside buildAttachmentPath) rejects/
  // cleans whatever comes out.
  function decodeFilenameHeader(rawHeader) {
    try {
      return decodeURIComponent(rawHeader);
    } catch {
      return rawHeader;
    }
  }

  function sha256Hex(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
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

  async function loadCertification(client, certificationId) {
    const rows = await pgSelect(client, "employee_certifications", {
      filters: { id: certificationId },
      select: EMPLOYEE_CERT_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Loads a single course_modules row by id, unscoped -- callers cross-check
  // its facility_id/course_id against the parent they expect (see the
  // progress route below) rather than trusting a client-supplied facility.
  async function loadCourseModule(client, moduleId) {
    const rows = await pgSelect(client, "course_modules", {
      filters: { id: moduleId },
      select: COURSE_MODULES_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // All of a course's modules (TR-06: feeds assignmentReadyToComplete).
  async function loadModulesForCourse(client, facilityId, courseId) {
    const rows = await pgSelect(client, "course_modules", {
      filters: { facility_id: facilityId, course_id: courseId },
      select: COURSE_MODULES_COLUMNS,
      order: "order_no.asc"
    });
    return rows ?? [];
  }

  // All of an assignment's training_progress rows (TR-06: feeds
  // assignmentReadyToComplete).
  async function loadProgressForAssignment(client, facilityId, assignmentId) {
    const rows = await pgSelect(client, "training_progress", {
      filters: { facility_id: facilityId, assignment_id: assignmentId },
      select: TRAINING_PROGRESS_COLUMNS
    });
    return rows ?? [];
  }

  // Appends a certification_events row (0007 columns: facility_id,
  // employee_certification_id, event_type, payload_jsonb). event_at is left
  // to the column default (now()).
  async function insertCertificationEvent(client, { facilityId, certificationId, eventType, payload }) {
    const row = {
      facility_id: facilityId,
      employee_certification_id: certificationId,
      event_type: eventType,
      payload_jsonb: payload ?? {}
    };
    const rows = await pgInsert(client, "certification_events", [row], { returning: true });
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

  // --- Module progress (TR-06) --------------------------------------------
  // Upserts a training_progress row (state, started_at, completed_at,
  // score_pct, attempts) for one module of a training assignment. Unique on
  // (assignment_id, module_id) (0007), so this is a merge-upsert exactly
  // like communications-routes.mjs's POST /messages/:id/receipt -- only the
  // fields the caller actually sends are included in the row, so a partial
  // update (e.g. just bumping attempts) never clobbers a previously recorded
  // started_at/completed_at.
  //
  // Self-service: the caller may write only their OWN progress (their
  // employees.id must equal the assignment's employee_id) unless they hold
  // training.manage, mirroring the 0036 RLS policy shape exactly -- this is
  // a defense-in-depth application-layer check on top of that DB policy, not
  // a substitute for it.
  router.register(
    "POST",
    "/training-assignments/:id/modules/:moduleId/progress",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const assignment = await loadAssignment(auth.client, params.id);
        if (!assignment) return sendJson(response, 404, { error: "training assignment not found" });

        const module = await loadCourseModule(auth.client, params.moduleId);
        if (!module || module.course_id !== assignment.course_id || module.facility_id !== assignment.facility_id) {
          return sendJson(response, 404, { error: "module not found for this training assignment" });
        }

        const { state } = body.payload;
        if (state === undefined || !TRAINING_PROGRESS_STATES.includes(state)) {
          return sendJson(response, 400, {
            error: `state must be one of: ${TRAINING_PROGRESS_STATES.join(", ")}`
          });
        }

        const manageGuard = requireAuthPermission(auth, assignment.facility_id, MANAGE);
        let allowed = manageGuard.allowed;
        if (!allowed) {
          const readGuard = requireAuthPermission(auth, assignment.facility_id, READ);
          const callerEmployeeId = await loadCallerEmployeeId(auth.client, assignment.facility_id, auth.claims.sub);
          allowed = readGuard.allowed && callerEmployeeId !== null && callerEmployeeId === assignment.employee_id;
        }
        if (!allowed) {
          return sendJson(response, 403, { error: "cannot record progress for another employee's training assignment" });
        }

        const row = {
          facility_id: assignment.facility_id,
          assignment_id: assignment.id,
          module_id: params.moduleId,
          state
        };
        if (body.payload.startedAt !== undefined) row.started_at = body.payload.startedAt;
        if (body.payload.completedAt !== undefined) row.completed_at = body.payload.completedAt;
        if (body.payload.scorePct !== undefined) row.score_pct = body.payload.scorePct;
        if (body.payload.attempts !== undefined) row.attempts = body.payload.attempts;

        const rows = await pgInsert(auth.client, "training_progress", [row], {
          onConflict: "assignment_id,module_id",
          merge: true,
          returning: true
        });
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Marks a training assignment complete. Inserts a training_completions row.
  // TR-06: a completion_status of 'passed' is refused with a 400 (naming the
  // outstanding modules) unless every required module already has a
  // training_progress row in state 'completed' for this assignment
  // (assignmentReadyToComplete) -- completion no longer rests on caller
  // assertion alone. A course with zero required modules has nothing to gate
  // on and is completable immediately. 'failed'/'waived' completions skip
  // this gate entirely: those statuses are never a claim of "did the work".
  //
  // Ownership (closes the gap plans/RLS_AUDIT.md escalated and
  // 0039_training_completion_ownership.sql now enforces at the DB layer):
  // the caller may record a completion only for their OWN training
  // assignment (their employees.id must equal the assignment's employee_id)
  // unless they hold training.manage, mirroring the 0039 RLS policy shape
  // exactly -- and the same self-vs-manager check the module progress route
  // above (TR-06) already uses. This is a defense-in-depth application-layer
  // check on top of that DB policy, not a substitute for it -- it exists so
  // the API returns a clean 403 rather than an opaque RLS denial.
  router.register(
    "POST",
    "/training-assignments/:id/complete",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const assignment = await loadAssignment(auth.client, params.id);
        if (!assignment) return sendJson(response, 404, { error: "training assignment not found" });

        const manageGuard = requireAuthPermission(auth, assignment.facility_id, MANAGE);
        let allowed = manageGuard.allowed;
        if (!allowed) {
          const readGuard = requireAuthPermission(auth, assignment.facility_id, READ);
          const callerEmployeeId = await loadCallerEmployeeId(auth.client, assignment.facility_id, auth.claims.sub);
          allowed = readGuard.allowed && callerEmployeeId !== null && callerEmployeeId === assignment.employee_id;
        }
        if (!allowed) {
          return sendJson(response, 403, {
            error: "cannot record a completion for another employee's training assignment"
          });
        }

        const completionStatus = body.payload.completionStatus ?? "passed";
        if (completionStatus === "passed") {
          const [modules, progressRows] = await Promise.all([
            loadModulesForCourse(auth.client, assignment.facility_id, assignment.course_id),
            loadProgressForAssignment(auth.client, assignment.facility_id, assignment.id)
          ]);
          const readiness = assignmentReadyToComplete(
            modules.map((m) => ({ id: m.id, required: m.required, title: m.title })),
            progressRows.map((p) => ({ moduleId: p.module_id, state: p.state }))
          );
          if (!readiness.ready) {
            return sendJson(response, 400, {
              error: "cannot mark this assignment passed: required modules are not yet completed",
              outstandingModules: readiness.outstandingModules
            });
          }
        }

        const completionRow = {
          facility_id: assignment.facility_id,
          assignment_id: params.id,
          final_score_pct: body.payload.finalScorePct ?? null,
          completion_status: completionStatus
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

  // --- Certification lifecycle writes (TR-04) --------------------------------
  // Issues a new employee_certifications row and appends the matching
  // certification_events row (always 'created' for a fresh issue --
  // certificationEventFor(null, after) is unconditional). Guarded
  // training.manage on the target facility; validated before the guard so a
  // malformed payload never reaches the permission check or a fetch.
  router.register(
    "POST",
    "/facilities/:facilityId/employee-certifications",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { employeeId, certificationTypeId } = body.payload;
        const shape = [];
        if (typeof employeeId !== "string" || employeeId.trim().length === 0) {
          shape.push("employeeId is required");
        }
        if (typeof certificationTypeId !== "string" || certificationTypeId.trim().length === 0) {
          shape.push("certificationTypeId is required");
        }
        if (body.payload.status !== undefined && !CERTIFICATION_STATUSES.includes(body.payload.status)) {
          shape.push(`status must be one of: ${CERTIFICATION_STATUSES.join(", ")}`);
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          employee_id: employeeId,
          certification_type_id: certificationTypeId,
          issued_at: body.payload.issuedAt ?? null,
          expires_at: body.payload.expiresAt ?? null,
          status: body.payload.status ?? "active"
        };
        const rows = await pgInsert(auth.client, "employee_certifications", [row], { returning: true });
        const created = (rows ?? [])[0] ?? null;
        if (created) {
          const event = certificationEventFor(null, created);
          if (event) {
            await insertCertificationEvent(auth.client, {
              facilityId: params.facilityId,
              certificationId: created.id,
              eventType: event.eventType,
              payload: event.payload
            });
          }
        }
        return sendJson(response, 201, created);
      })
  );

  // Renews (later expiresAt) or revokes (status: 'revoked') an existing
  // certification -- a single PATCH endpoint, since both are "edit this
  // cert's lifecycle fields" and the resulting event type is derived (never
  // caller-supplied) by certificationEventFor from the before/after rows.
  // Loads the row first (before both the shape validation and the guard)
  // purely to resolve its facility_id -- the guard always runs against the
  // row's OWN facility, never a client-supplied one.
  router.register(
    "PATCH",
    "/employee-certifications/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const before = await loadCertification(auth.client, params.id);
        if (!before) return sendJson(response, 404, { error: "certification not found" });
        if (!requirePerm(auth, before.facility_id, MANAGE, response)) return;

        const shape = [];
        if (body.payload.status !== undefined && !CERTIFICATION_STATUSES.includes(body.payload.status)) {
          shape.push(`status must be one of: ${CERTIFICATION_STATUSES.join(", ")}`);
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const patch = {};
        if (body.payload.expiresAt !== undefined) patch.expires_at = body.payload.expiresAt;
        if (body.payload.issuedAt !== undefined) patch.issued_at = body.payload.issuedAt;
        if (body.payload.status !== undefined) patch.status = body.payload.status;
        if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
        patch.updated_at = new Date().toISOString();

        const rows = await pgUpdate(
          auth.client,
          "employee_certifications",
          { id: params.id, facility_id: before.facility_id },
          patch,
          { returning: true }
        );
        const after = (rows ?? [])[0] ?? null;
        if (after) {
          const event = certificationEventFor(before, after);
          if (event) {
            await insertCertificationEvent(auth.client, {
              facilityId: before.facility_id,
              certificationId: after.id,
              eventType: event.eventType,
              payload: event.payload
            });
          }
        }
        return sendJson(response, 200, after);
      })
  );

  // --- Evidence upload (TR-03) ------------------------------------------
  // Raw binary upload proxied through the BFF, reusing the platform storage
  // primitive (src/lib/storage.mjs) rather than a parallel client -- same
  // shape as attachments-routes.mjs's POST /<module>/:id/attachments (see
  // the readRawBody family of helpers above for why this is a local copy
  // rather than a shared import).
  //
  // Order: shape-only checks (mime, filename header, declared
  // Content-Length) with zero I/O first; then load the cert and guard
  // training.manage on ITS facility_id; only then is the body actually read
  // off the socket. storage_path, checksum, and the certification_events
  // payload are always server-derived.
  router.register(
    "POST",
    "/employee-certifications/:id/evidence",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        let contentType;
        try {
          contentType = assertMimeAllowed(request.headers["content-type"]);
        } catch (error) {
          return sendJson(response, storageErrorStatus(error), { error: error.message, code: error.code });
        }

        const filenameHeader = request.headers["x-file-name"];
        if (!filenameHeader) {
          return sendJson(response, 400, { error: "x-file-name header is required" });
        }

        const declaredLength = declaredContentLength(request);
        if (declaredLength !== null && declaredLength > DEFAULT_MAX_UPLOAD_BYTES) {
          if (typeof request.destroy === "function") request.destroy();
          return sendJson(response, 413, {
            error: `request body of ${declaredLength} bytes exceeds the ${DEFAULT_MAX_UPLOAD_BYTES}-byte cap`
          });
        }

        const cert = await loadCertification(auth.client, params.id);
        if (!cert) return sendJson(response, 404, { error: "certification not found" });
        if (!requirePerm(auth, cert.facility_id, MANAGE, response)) return;

        let bodyBuffer;
        try {
          bodyBuffer = await readRawBody(request, DEFAULT_MAX_UPLOAD_BYTES);
        } catch (error) {
          if (error instanceof UploadTooLargeError) return sendJson(response, 413, { error: error.message });
          return sendJson(response, 400, { error: "failed to read request body" });
        }

        try {
          assertWithinSizeCap(bodyBuffer.length);
        } catch (error) {
          return sendJson(response, storageErrorStatus(error), { error: error.message, code: error.code });
        }
        if (bodyBuffer.length === 0) {
          return sendJson(response, 400, { error: "request body is empty" });
        }

        const filename = decodeFilenameHeader(filenameHeader);
        let path;
        try {
          path = buildAttachmentPath(cert.facility_id, EVIDENCE_STORAGE_MODULE, cert.id, filename);
        } catch (error) {
          if (error instanceof StorageValidationError) {
            return sendJson(response, 400, { error: error.message, code: error.code });
          }
          throw error;
        }

        const checksum = sha256Hex(bodyBuffer);
        const storageClient = createStorageClient(env);
        try {
          await uploadObject(storageClient, { path, body: bodyBuffer, contentType });
        } catch {
          return sendJson(response, 502, { error: "storage upload failed" });
        }

        const rows = await pgUpdate(
          auth.client,
          "employee_certifications",
          { id: params.id, facility_id: cert.facility_id },
          { evidence_path: path, updated_at: new Date().toISOString() },
          { returning: true }
        );
        const updated = (rows ?? [])[0] ?? null;

        await insertCertificationEvent(auth.client, {
          facilityId: cert.facility_id,
          certificationId: cert.id,
          eventType: "evidence_uploaded",
          payload: evidenceUploadedPayload({
            path,
            checksumSha256: checksum,
            contentType,
            sizeBytes: bodyBuffer.length
          })
        });

        return sendJson(response, 201, updated);
      })
  );

  // Short-TTL signed URL for a certification's evidence file. Read-guarded:
  // either training.read on the cert's facility (an admin/manager), OR the
  // caller's own certification (self-scoping, same pattern the wallet route
  // above uses -- resolve the caller's own employees.id and compare it
  // against the row rather than trusting a client-supplied identity).
  router.register(
    "GET",
    "/employee-certifications/:id/evidence-url",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const cert = await loadCertification(auth.client, params.id);
        if (!cert) return sendJson(response, 404, { error: "certification not found" });

        const readGuard = requireAuthPermission(auth, cert.facility_id, READ);
        let allowed = readGuard.allowed;
        if (!allowed) {
          const callerEmployeeId = await loadCallerEmployeeId(auth.client, cert.facility_id, auth.claims.sub);
          allowed = callerEmployeeId !== null && callerEmployeeId === cert.employee_id;
        }
        if (!allowed) return sendJson(response, 403, { error: readGuard.reason });

        if (!cert.evidence_path) {
          return sendJson(response, 404, { error: "no evidence uploaded for this certification" });
        }

        const storageClient = createStorageClient(env);
        try {
          const url = await createSignedUrl(storageClient, cert.evidence_path, EVIDENCE_SIGNED_URL_TTL_SECONDS);
          return sendJson(response, 200, { url, expiresInSeconds: EVIDENCE_SIGNED_URL_TTL_SECONDS });
        } catch {
          return sendJson(response, 502, { error: "failed to create signed url" });
        }
      })
  );

  return router;
}
