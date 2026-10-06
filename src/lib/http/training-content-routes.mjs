// TR-07 / TR-08: end-user API for quizzes, video/PDF module content and the
// course player (0065_training_content.sql).
//
//   GET    /facilities/:facilityId/modules/:moduleId/quiz           (training.read)
//   POST   /facilities/:facilityId/modules/:moduleId/quiz           (training.manage)
//   PATCH  /quizzes/:id                                              (training.manage)
//   POST   /quizzes/:id/questions                                    (training.manage)
//   DELETE /quiz-questions/:id                                       (training.manage; soft delete)
//   POST   /training-assignments/:id/quizzes/:quizId/attempts        (the assignment's OWN employee)
//   GET    /training-assignments/:id/quiz-attempts                   (own employee or training.manage)
//   GET    /training-assignments/:id/player                          (own employee or training.manage)
//   GET    /facilities/:facilityId/modules/:moduleId/content         (training.read)
//   POST   /facilities/:facilityId/modules/:moduleId/content         (training.manage; raw upload)
//   DELETE /training-content/:id                                     (training.manage; soft delete)
//   GET    /training-content/:id/url                                 (training.read; signed URL)
//
// Answer keys never reach a non-manager: the key table (quiz_option_keys) is
// only ever SELECTed by a training.manage caller (and RLS denies everyone
// else regardless), and the scorer is the SECURITY DEFINER RPC
// public.submit_quiz_attempt, which reads the keys inside the database and
// returns counts only.
import { createHash } from "node:crypto";
import { pgSelect, pgInsert, pgUpdate, pgDelete, pgRpc, PostgrestError } from "../supabase-rest.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import { assignmentReadyToComplete, trainingAssignmentState } from "../training.mjs";
import { configValue } from "../settings-registry.mjs";
import { loadModuleConfig } from "./module-config.mjs";
import {
  validateQuizInput,
  validateQuestionInput,
  validateAnswersPayload,
  shapeQuizForTaker,
  shapeQuizForManager,
  quizAttemptState
} from "../training-quiz.mjs";
import {
  TRAINING_STORAGE_MODULE,
  ALLOWED_CONTENT_MIME_TYPES,
  validateContentUpload,
  shapeContentItem
} from "../training-content.mjs";
import {
  createStorageClientFromEnv,
  buildAttachmentPath,
  assertMimeAllowed,
  assertWithinSizeCap,
  assertPathInFacility,
  uploadObject,
  deleteObject,
  createSignedUrl,
  DEFAULT_MAX_UPLOAD_BYTES,
  StorageValidationError
} from "../storage.mjs";
import { readRawBody, UploadTooLargeError } from "./attachments-routes.mjs";

const READ = "training.read";
const MANAGE = "training.manage";
const SIGNED_URL_TTL_SECONDS = 300;
const TRAINING_MODULE_CODE = "training";

const QUIZ_COLUMNS = "id,facility_id,module_id,title,pass_score_pct,max_attempts,created_at,updated_at,deleted_at";
const QUESTION_COLUMNS = "id,facility_id,quiz_id,prompt,question_type,points,order_no,deleted_at";
const OPTION_COLUMNS = "id,facility_id,question_id,label,order_no";
const KEY_COLUMNS = "option_id,facility_id,is_correct";
const ATTEMPT_COLUMNS = "id,quiz_id,assignment_id,employee_id,attempt_no,score_pct,correct_count,total_questions,passed,submitted_at";
const MODULE_COLUMNS = "id,facility_id,course_id,module_type,title,order_no,content_jsonb,required";
const CONTENT_COLUMNS = "id,facility_id,module_id,kind,title,storage_path,mime_type,size_bytes,order_no,created_at,deleted_at";
const ASSIGNMENT_COLUMNS =
  "id,facility_id,employee_id,course_id,assigned_by,assigned_at,due_at,reason_code,source_type,source_ref_id";
const PROGRESS_COLUMNS = "id,assignment_id,module_id,state,started_at,completed_at,score_pct,attempts";

function camelAttempt(result) {
  return {
    attemptId: result?.attempt_id ?? null,
    attemptNo: result?.attempt_no ?? null,
    scorePct: result?.score_pct ?? null,
    passed: result?.passed === true,
    correctCount: result?.correct_count ?? null,
    totalQuestions: result?.total_questions ?? null,
    passScorePct: result?.pass_score_pct ?? null,
    maxAttempts: result?.max_attempts ?? null,
    attemptsRemaining: result?.attempts_remaining ?? null,
    progressState: result?.progress_state ?? null
  };
}

function shapeAttemptRow(row) {
  return {
    id: row.id,
    quizId: row.quiz_id,
    assignmentId: row.assignment_id,
    attemptNo: row.attempt_no,
    scorePct: Number(row.score_pct),
    correctCount: row.correct_count,
    totalQuestions: row.total_questions,
    passed: row.passed === true,
    submittedAt: row.submitted_at
  };
}

export function registerTrainingContentRoutes(
  router,
  { authenticate, sendJson, readBody, createStorageClient = (env) => createStorageClientFromEnv(env) }
) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams } = guards;
  const requireRead = guards.requireRead(READ);

  function decodeHeader(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  async function loadModule(client, moduleId) {
    const rows = await pgSelect(client, "course_modules", {
      filters: { id: moduleId },
      select: MODULE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadQuizByModule(client, moduleId) {
    const rows = await pgSelect(client, "quizzes", {
      filters: { module_id: moduleId },
      select: QUIZ_COLUMNS,
      extra: { deleted_at: "is.null" },
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadQuizById(client, quizId) {
    const rows = await pgSelect(client, "quizzes", {
      filters: { id: quizId },
      select: QUIZ_COLUMNS,
      extra: { deleted_at: "is.null" },
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadAssignment(client, assignmentId) {
    const rows = await pgSelect(client, "training_assignments", {
      filters: { id: assignmentId },
      select: ASSIGNMENT_COLUMNS,
      extra: { deleted_at: "is.null" },
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadCallerEmployeeId(client, facilityId, userId) {
    const rows = await pgSelect(client, "employees", {
      filters: { facility_id: facilityId, user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? [])[0]?.id ?? null;
  }

  // Self-or-manager access to an assignment, the same shape the progress and
  // completion routes (training-routes.mjs) use: training.manage on the
  // assignment's facility, or training.read AND being that assignment's own
  // employee.
  async function resolveAssignmentAccess(auth, assignment) {
    const manage = requireAuthPermission(auth, assignment.facility_id, MANAGE).allowed;
    const read = requireAuthPermission(auth, assignment.facility_id, READ).allowed;
    const callerEmployeeId = await loadCallerEmployeeId(auth.client, assignment.facility_id, auth.claims.sub);
    const isOwner = callerEmployeeId !== null && callerEmployeeId === assignment.employee_id;
    return { manage, isOwner, allowed: manage || (read && isOwner), callerEmployeeId };
  }

  async function loadQuizDefinition(client, quiz, { includeKeys }) {
    const questions =
      (await pgSelect(client, "quiz_questions", {
        filters: { quiz_id: quiz.id },
        select: QUESTION_COLUMNS,
        extra: { deleted_at: "is.null" },
        order: "order_no.asc"
      })) ?? [];
    const questionIds = questions.map((question) => question.id);
    const options =
      questionIds.length === 0
        ? []
        : ((await pgSelect(client, "quiz_options", {
            filters: { question_id: { in: questionIds } },
            select: OPTION_COLUMNS,
            order: "order_no.asc"
          })) ?? []);
    if (!includeKeys) return shapeQuizForTaker(quiz, questions, options);
    const optionIds = options.map((option) => option.id);
    const keys =
      optionIds.length === 0
        ? []
        : ((await pgSelect(client, "quiz_option_keys", {
            filters: { option_id: { in: optionIds } },
            select: KEY_COLUMNS
          })) ?? []);
    return shapeQuizForManager(quiz, questions, options, keys);
  }

  // --- Quiz definition ---------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/modules/:moduleId/quiz",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const wantKeys = queryParams(request).get("includeKeys") === "true";
        if (wantKeys && !requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const module = await loadModule(auth.client, params.moduleId);
        if (!module || module.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "module not found" });
        }
        const quiz = await loadQuizByModule(auth.client, module.id);
        if (!quiz) return sendJson(response, 404, { error: "this module has no quiz" });
        return sendJson(response, 200, await loadQuizDefinition(auth.client, quiz, { includeKeys: wantKeys }));
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/modules/:moduleId/quiz",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateQuizInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const module = await loadModule(auth.client, params.moduleId);
        if (!module || module.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "module not found" });
        }
        if (module.module_type !== "quiz") {
          return sendJson(response, 400, { error: `module is of type ${module.module_type}; quizzes attach to quiz modules` });
        }

        let passScorePct = body.payload.passScorePct;
        if (passScorePct === undefined) {
          const config = await loadModuleConfig({
            client: auth.client,
            facilityId: params.facilityId,
            moduleCode: TRAINING_MODULE_CODE
          });
          passScorePct = configValue(config, "training.quizDefaultPassPct");
        }
        const row = {
          facility_id: params.facilityId,
          module_id: module.id,
          title: body.payload.title.trim(),
          pass_score_pct: passScorePct,
          max_attempts: body.payload.maxAttempts ?? null,
          created_by: auth.claims.sub
        };
        try {
          const rows = await pgInsert(auth.client, "quizzes", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (error) {
          if (error instanceof PostgrestError && error.status === 409) {
            return sendJson(response, 409, { error: "this module already has a quiz" });
          }
          throw error;
        }
      })
  );

  router.register(
    "PATCH",
    "/quizzes/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateQuizInput(body.payload, { partial: true });
        if (!valid) return sendJson(response, 400, { errors });
        const quiz = await loadQuizById(auth.client, params.id);
        if (!quiz) return sendJson(response, 404, { error: "quiz not found" });
        if (!requirePerm(auth, quiz.facility_id, MANAGE, response)) return;

        const patch = {};
        if (body.payload.title !== undefined) patch.title = body.payload.title.trim();
        if (body.payload.passScorePct !== undefined) patch.pass_score_pct = body.payload.passScorePct;
        if (body.payload.maxAttempts !== undefined) patch.max_attempts = body.payload.maxAttempts;
        if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
        patch.updated_at = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "quizzes",
          { id: quiz.id, facility_id: quiz.facility_id },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Adds one question with its options and answer keys. Three inserts that
  // PostgREST cannot make atomic: the payload is fully validated first, and a
  // failure after the question row exists deletes it again (options/keys
  // cascade) so a half-written question never survives.
  router.register(
    "POST",
    "/quizzes/:id/questions",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateQuestionInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        const quiz = await loadQuizById(auth.client, params.id);
        if (!quiz) return sendJson(response, 404, { error: "quiz not found" });
        if (!requirePerm(auth, quiz.facility_id, MANAGE, response)) return;

        let question;
        try {
          const rows = await pgInsert(
            auth.client,
            "quiz_questions",
            [
              {
                facility_id: quiz.facility_id,
                quiz_id: quiz.id,
                prompt: body.payload.prompt.trim(),
                question_type: body.payload.questionType ?? "single",
                points: body.payload.points ?? 1,
                order_no: body.payload.orderNo
              }
            ],
            { returning: true }
          );
          question = (rows ?? [])[0];
        } catch (error) {
          if (error instanceof PostgrestError && error.status === 409) {
            return sendJson(response, 409, { error: "a question with this order_no already exists for this quiz" });
          }
          throw error;
        }

        try {
          const optionRows = await pgInsert(
            auth.client,
            "quiz_options",
            body.payload.options.map((option, index) => ({
              facility_id: quiz.facility_id,
              question_id: question.id,
              label: option.label.trim(),
              order_no: index + 1
            })),
            { returning: true }
          );
          const sorted = [...(optionRows ?? [])].sort((a, b) => a.order_no - b.order_no);
          await pgInsert(
            auth.client,
            "quiz_option_keys",
            sorted.map((option, index) => ({
              option_id: option.id,
              facility_id: quiz.facility_id,
              is_correct: body.payload.options[index].isCorrect === true
            })),
            { returning: false }
          );
        } catch (error) {
          try {
            await pgDelete(auth.client, "quiz_questions", { id: question.id, facility_id: quiz.facility_id });
          } catch {
            // best effort: an option-less shell is never scoreable (the RPC
            // counts it as an unanswerable question), and the original error
            // below is what the caller needs to see
          }
          throw error;
        }
        return sendJson(response, 201, { id: question.id, orderNo: question.order_no });
      })
  );

  router.register(
    "DELETE",
    "/quiz-questions/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const rows = await pgSelect(auth.client, "quiz_questions", {
          filters: { id: params.id },
          select: QUESTION_COLUMNS,
          extra: { deleted_at: "is.null" },
          limit: 1
        });
        const question = (rows ?? [])[0] ?? null;
        if (!question) return sendJson(response, 404, { error: "question not found" });
        if (!requirePerm(auth, question.facility_id, MANAGE, response)) return;
        await pgUpdate(
          auth.client,
          "quiz_questions",
          { id: question.id, facility_id: question.facility_id },
          { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { returning: false }
        );
        return sendJson(response, 200, { id: question.id, deleted: true });
      })
  );

  // --- Attempts ----------------------------------------------------------
  // Only the assignment's OWN employee may submit (a manager is refused here
  // and again inside the RPC). The route validates the answers' shape before
  // any fetch; scoring, max_attempts, the already-passed check and the
  // progress write all happen inside the RPC, transactionally.
  router.register(
    "POST",
    "/training-assignments/:id/quizzes/:quizId/attempts",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateAnswersPayload(body.payload?.answers);
        if (!valid) return sendJson(response, 400, { errors });

        const assignment = await loadAssignment(auth.client, params.id);
        if (!assignment) return sendJson(response, 404, { error: "training assignment not found" });
        const access = await resolveAssignmentAccess(auth, assignment);
        if (!access.isOwner || !requireAuthPermission(auth, assignment.facility_id, READ).allowed) {
          return sendJson(response, 403, { error: "a quiz attempt can only be submitted for your own training assignment" });
        }

        let result;
        try {
          result = await pgRpc(auth.client, "submit_quiz_attempt", {
            p_assignment_id: assignment.id,
            p_quiz_id: params.quizId,
            p_answers: body.payload.answers
          });
        } catch (error) {
          if (error instanceof PostgrestError && [400, 403, 404, 409].includes(error.status)) {
            return sendJson(response, error.status, { error: error.body?.message ?? "quiz attempt rejected" });
          }
          throw error;
        }
        return sendJson(response, 201, camelAttempt(result));
      })
  );

  router.register(
    "GET",
    "/training-assignments/:id/quiz-attempts",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const assignment = await loadAssignment(auth.client, params.id);
        if (!assignment) return sendJson(response, 404, { error: "training assignment not found" });
        const access = await resolveAssignmentAccess(auth, assignment);
        if (!access.allowed) {
          return sendJson(response, 403, { error: "cannot read another employee's quiz attempts" });
        }
        const filters = { assignment_id: assignment.id, facility_id: assignment.facility_id };
        const quizId = queryParams(request).get("quizId");
        if (quizId) filters.quiz_id = quizId;
        const rows = await pgSelect(auth.client, "quiz_attempts", {
          filters,
          select: ATTEMPT_COLUMNS,
          order: "attempt_no.asc"
        });
        return sendJson(response, 200, (rows ?? []).map(shapeAttemptRow));
      })
  );

  // --- Course player -------------------------------------------------------
  // One payload for the whole course view: modules in order, each with its
  // content items, quiz summary + attempt state, the assignment's progress
  // row, plus the completion row and TR-06's readiness verdict.
  router.register(
    "GET",
    "/training-assignments/:id/player",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const assignment = await loadAssignment(auth.client, params.id);
        if (!assignment) return sendJson(response, 404, { error: "training assignment not found" });
        const access = await resolveAssignmentAccess(auth, assignment);
        if (!access.allowed) {
          return sendJson(response, 403, { error: "cannot open another employee's training assignment" });
        }

        const facilityId = assignment.facility_id;
        const [courseRows, moduleRows, progressRows, completionRows] = await Promise.all([
          pgSelect(auth.client, "courses", {
            filters: { id: assignment.course_id, facility_id: facilityId },
            select: "id,code,title,description,status",
            limit: 1
          }),
          pgSelect(auth.client, "course_modules", {
            filters: { facility_id: facilityId, course_id: assignment.course_id },
            select: MODULE_COLUMNS,
            extra: { deleted_at: "is.null" },
            order: "order_no.asc"
          }),
          pgSelect(auth.client, "training_progress", {
            filters: { facility_id: facilityId, assignment_id: assignment.id },
            select: PROGRESS_COLUMNS
          }),
          pgSelect(auth.client, "training_completions", {
            filters: { facility_id: facilityId, assignment_id: assignment.id },
            select: "id,assignment_id,completed_at,final_score_pct,completion_status",
            limit: 1
          })
        ]);
        const modules = moduleRows ?? [];
        const moduleIds = modules.map((module) => module.id);

        const [contentRows, quizRows] =
          moduleIds.length === 0
            ? [[], []]
            : await Promise.all([
                pgSelect(auth.client, "training_content_items", {
                  filters: { facility_id: facilityId, module_id: { in: moduleIds } },
                  select: CONTENT_COLUMNS,
                  extra: { deleted_at: "is.null" },
                  order: "order_no.asc"
                }),
                pgSelect(auth.client, "quizzes", {
                  filters: { facility_id: facilityId, module_id: { in: moduleIds } },
                  select: QUIZ_COLUMNS,
                  extra: { deleted_at: "is.null" }
                })
              ]);
        const quizzes = quizRows ?? [];
        const attemptRows =
          quizzes.length === 0
            ? []
            : ((await pgSelect(auth.client, "quiz_attempts", {
                filters: {
                  facility_id: facilityId,
                  assignment_id: assignment.id,
                  quiz_id: { in: quizzes.map((quiz) => quiz.id) }
                },
                select: ATTEMPT_COLUMNS,
                order: "attempt_no.asc"
              })) ?? []);

        const progressByModule = new Map((progressRows ?? []).map((row) => [row.module_id, row]));
        const completion = (completionRows ?? [])[0] ?? null;
        const itemsByModule = new Map();
        for (const item of contentRows ?? []) {
          const list = itemsByModule.get(item.module_id) ?? [];
          list.push(shapeContentItem(item));
          itemsByModule.set(item.module_id, list);
        }
        const quizByModule = new Map(quizzes.map((quiz) => [quiz.module_id, quiz]));

        const shapedModules = modules.map((module) => {
          const quiz = quizByModule.get(module.id) ?? null;
          const progress = progressByModule.get(module.id) ?? null;
          return {
            id: module.id,
            moduleType: module.module_type,
            title: module.title,
            orderNo: module.order_no,
            required: module.required,
            content: module.content_jsonb ?? {},
            contentItems: itemsByModule.get(module.id) ?? [],
            quiz: quiz
              ? {
                  id: quiz.id,
                  title: quiz.title,
                  passScorePct: Number(quiz.pass_score_pct),
                  maxAttempts: quiz.max_attempts ?? null,
                  ...quizAttemptState(
                    quiz,
                    attemptRows.filter((attempt) => attempt.quiz_id === quiz.id)
                  )
                }
              : null,
            progress: progress
              ? {
                  state: progress.state,
                  startedAt: progress.started_at,
                  completedAt: progress.completed_at,
                  scorePct: progress.score_pct === null ? null : Number(progress.score_pct),
                  attempts: progress.attempts
                }
              : null
          };
        });

        const readiness = assignmentReadyToComplete(
          modules.map((module) => ({ id: module.id, required: module.required, title: module.title })),
          (progressRows ?? []).map((row) => ({ moduleId: row.module_id, state: row.state }))
        );
        return sendJson(response, 200, {
          assignment: {
            id: assignment.id,
            courseId: assignment.course_id,
            employeeId: assignment.employee_id,
            dueAt: assignment.due_at,
            sourceType: assignment.source_type,
            state: trainingAssignmentState({ completedAt: completion?.completed_at ?? null, dueAt: assignment.due_at }, new Date())
          },
          course: (courseRows ?? [])[0] ?? null,
          modules: shapedModules,
          completion,
          readiness,
          viewer: { isOwner: access.isOwner, canManage: access.manage }
        });
      })
  );

  // --- Module content (TR-08) --------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/modules/:moduleId/content",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "training_content_items", {
          filters: { facility_id: params.facilityId, module_id: params.moduleId },
          select: CONTENT_COLUMNS,
          extra: { deleted_at: "is.null" },
          order: "order_no.asc"
        });
        return sendJson(response, 200, (rows ?? []).map(shapeContentItem));
      })
  );

  // Raw binary upload proxied through the BFF (same shape and order as
  // attachments-routes.mjs and the TR-03 evidence route): header/shape checks
  // with zero I/O first, then the module is loaded and training.manage is
  // checked on ITS facility, and only then is the body read. The storage path
  // and checksum are always server-derived.
  router.register(
    "POST",
    "/facilities/:facilityId/modules/:moduleId/content",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        let contentType;
        try {
          contentType = assertMimeAllowed(request.headers["content-type"], ALLOWED_CONTENT_MIME_TYPES);
        } catch (error) {
          return sendJson(response, 400, { error: error.message, code: error.code });
        }
        const filenameHeader = request.headers["x-file-name"];
        if (!filenameHeader) return sendJson(response, 400, { error: "x-file-name header is required" });

        const declared = Number(request.headers["content-length"]);
        if (Number.isFinite(declared) && declared > DEFAULT_MAX_UPLOAD_BYTES) {
          if (typeof request.destroy === "function") request.destroy();
          return sendJson(response, 413, {
            error: `request body of ${declared} bytes exceeds the ${DEFAULT_MAX_UPLOAD_BYTES}-byte cap`
          });
        }

        const module = await loadModule(auth.client, params.moduleId);
        if (!module || module.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "module not found" });
        }
        if (!requirePerm(auth, module.facility_id, MANAGE, response)) return;

        const titleHeader = request.headers["x-content-title"];
        const filename = decodeHeader(filenameHeader);
        const title = titleHeader ? decodeHeader(titleHeader).trim() : filename;
        const validation = validateContentUpload({ moduleType: module.module_type, contentType, title });
        if (!validation.valid) return sendJson(response, 400, { errors: validation.errors });

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
          return sendJson(response, error.code === "file_too_large" ? 413 : 400, { error: error.message, code: error.code });
        }
        if (bodyBuffer.length === 0) return sendJson(response, 400, { error: "request body is empty" });

        let path;
        try {
          path = buildAttachmentPath(module.facility_id, TRAINING_STORAGE_MODULE, module.id, filename);
        } catch (error) {
          if (error instanceof StorageValidationError) {
            return sendJson(response, 400, { error: error.message, code: error.code });
          }
          throw error;
        }

        const storageClient = createStorageClient(env);
        try {
          await uploadObject(storageClient, { path, body: bodyBuffer, contentType });
        } catch {
          return sendJson(response, 502, { error: "storage upload failed" });
        }

        let rows;
        try {
          rows = await pgInsert(
            auth.client,
            "training_content_items",
            [
              {
                facility_id: module.facility_id,
                module_id: module.id,
                kind: validation.kind,
                title,
                storage_path: path,
                mime_type: contentType,
                size_bytes: bodyBuffer.length,
                checksum_sha256: createHash("sha256").update(bodyBuffer).digest("hex"),
                created_by: auth.claims.sub
              }
            ],
            { returning: true }
          );
        } catch (error) {
          // The object is already stored: remove it so a refused row (RLS,
          // path guard) never leaves an unreferenced file behind. Best effort;
          // the original error is what the caller needs.
          try {
            await deleteObject(storageClient, path);
          } catch {
            // ignore
          }
          throw error;
        }
        return sendJson(response, 201, shapeContentItem((rows ?? [])[0]));
      })
  );

  router.register(
    "DELETE",
    "/training-content/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const rows = await pgSelect(auth.client, "training_content_items", {
          filters: { id: params.id },
          select: CONTENT_COLUMNS,
          extra: { deleted_at: "is.null" },
          limit: 1
        });
        const item = (rows ?? [])[0] ?? null;
        if (!item) return sendJson(response, 404, { error: "content item not found" });
        if (!requirePerm(auth, item.facility_id, MANAGE, response)) return;
        await pgUpdate(
          auth.client,
          "training_content_items",
          { id: item.id, facility_id: item.facility_id },
          { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { returning: false }
        );
        return sendJson(response, 200, { id: item.id, deleted: true });
      })
  );

  // Short-TTL signed URL for one content item. A denied read and a path that
  // disagrees with the row's own facility/module both answer 404 (never 403:
  // that would confirm the item exists), and the storage client is never
  // touched on a mismatch.
  router.register(
    "GET",
    "/training-content/:id/url",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const rows = await pgSelect(auth.client, "training_content_items", {
          filters: { id: params.id },
          select: CONTENT_COLUMNS,
          extra: { deleted_at: "is.null" },
          limit: 1
        });
        const item = (rows ?? [])[0] ?? null;
        if (!item) return sendJson(response, 404, { error: "content item not found" });
        if (!requirePerm(auth, item.facility_id, READ, response, { notFoundOnDeny: true, notFoundMessage: "content item not found" })) {
          return;
        }
        try {
          assertPathInFacility(item.storage_path, item.facility_id, TRAINING_STORAGE_MODULE, item.module_id);
        } catch (error) {
          if (error instanceof StorageValidationError) {
            return sendJson(response, 404, { error: "content item not found" });
          }
          throw error;
        }
        try {
          const url = await createSignedUrl(createStorageClient(env), item.storage_path, SIGNED_URL_TTL_SECONDS);
          return sendJson(response, 200, { url, expiresInSeconds: SIGNED_URL_TTL_SECONDS, kind: item.kind, mimeType: item.mime_type });
        } catch {
          return sendJson(response, 502, { error: "failed to create signed url" });
        }
      })
  );

  return router;
}
