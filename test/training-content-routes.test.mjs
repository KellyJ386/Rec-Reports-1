import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerTrainingContentRoutes } from "../src/lib/http/training-content-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { createStorageClient } from "../src/lib/storage.mjs";

// buildAttachmentPath requires a UUID facility id.
const FAC = "f0000000-0000-4000-8000-000000000001";
const OTHER_FAC = "f0000000-0000-4000-8000-000000000002";
const MODULE_ID = "d0000000-0000-4000-8000-000000000001";
const QUIZ_ID = "e0000000-0000-4000-8000-000000000001";
const Q1 = "e1000000-0000-4000-8000-000000000001";
const Q2 = "e1000000-0000-4000-8000-000000000002";
const O1 = "e2000000-0000-4000-8000-000000000001";
const O2 = "e2000000-0000-4000-8000-000000000002";
const O3 = "e2000000-0000-4000-8000-000000000003";

const MANAGER = [{ facilityId: FAC, status: "active", permissions: ["training.read", "training.manage"] }];
const READER = [{ facilityId: FAC, status: "active", permissions: ["training.read"] }];
const OUTSIDER = [{ facilityId: OTHER_FAC, status: "active", permissions: ["training.read", "training.manage"] }];

const QUIZ_MODULE = { id: MODULE_ID, facility_id: FAC, course_id: "course-1", module_type: "quiz", title: "Quiz", order_no: 1, content_jsonb: {}, required: true };
const VIDEO_MODULE = { ...QUIZ_MODULE, id: "d0000000-0000-4000-8000-000000000002", module_type: "video", title: "Video" };
const QUIZ = { id: QUIZ_ID, facility_id: FAC, module_id: MODULE_ID, title: "Safety quiz", pass_score_pct: "80.00", max_attempts: 3, deleted_at: null };
const QUESTIONS = [
  { id: Q1, facility_id: FAC, quiz_id: QUIZ_ID, prompt: "Pick A", question_type: "single", points: 1, order_no: 1, deleted_at: null },
  { id: Q2, facility_id: FAC, quiz_id: QUIZ_ID, prompt: "Pick B and C", question_type: "multiple", points: 1, order_no: 2, deleted_at: null }
];
const OPTIONS = [
  { id: O1, facility_id: FAC, question_id: Q1, label: "A", order_no: 1 },
  { id: O2, facility_id: FAC, question_id: Q1, label: "B", order_no: 2 },
  { id: O3, facility_id: FAC, question_id: Q2, label: "C", order_no: 1 }
];
const KEYS = [
  { option_id: O1, facility_id: FAC, is_correct: true },
  { option_id: O2, facility_id: FAC, is_correct: false },
  { option_id: O3, facility_id: FAC, is_correct: true }
];

const ASSIGNMENT = {
  id: "assign-1",
  facility_id: FAC,
  employee_id: "emp-1",
  course_id: "course-1",
  assigned_by: null,
  assigned_at: "2026-07-18T00:00:00Z",
  due_at: "2026-08-18T00:00:00Z",
  reason_code: null,
  source_type: "manual",
  source_ref_id: null
};

function errorResponse(status, body = {}) {
  return { __stubStatus: status, __stubBody: body };
}

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const entry = { table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null };
    captured.push(entry);
    const data = respond(table, method, parsed, entry.body) ?? [];
    if (data && typeof data === "object" && "__stubStatus" in data) {
      return { ok: data.__stubStatus < 400, status: data.__stubStatus, text: async () => JSON.stringify(data.__stubBody) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = MANAGER, userId = "user-1", storageClient } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerTrainingContentRoutes(router, {
    authenticate,
    sendJson,
    readBody,
    ...(storageClient ? { createStorageClient: () => storageClient } : {})
  });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    await handler({ url: path, __body: body === undefined ? undefined : JSON.stringify(body) }, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  async function callRaw(method, path, { headers = {}, body = Buffer.alloc(0) } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = Readable.from(body.length > 0 ? [body] : []);
    request.url = path;
    request.headers = headers;
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call, callRaw };
}

function stubStorage(respond = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const result = respond(calls[calls.length - 1]);
    return { ok: result.status < 300, status: result.status, text: async () => JSON.stringify(result.body ?? {}) };
  };
  return { client: createStorageClient({ url: "https://example.supabase.co", key: "k", bucket: "attachments", fetchImpl }), calls };
}

const quizTables = (table) => {
  if (table === "course_modules") return [QUIZ_MODULE];
  if (table === "quizzes") return [QUIZ];
  if (table === "quiz_questions") return QUESTIONS;
  if (table === "quiz_options") return OPTIONS;
  if (table === "quiz_option_keys") return KEYS;
  return [];
};

// --- GET quiz ---------------------------------------------------------------
test("GET quiz denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  assert.equal((await call("GET", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`)).status, 403);
});

test("GET quiz returns the taker view and NEVER reads or returns the answer key", async (t) => {
  const captured = stubFetch(t, quizTables);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`);
  assert.equal(result.status, 200);
  assert.equal(result.payload.questions.length, 2);
  assert.equal(result.payload.questions[0].options.length, 2);
  assert.equal(JSON.stringify(result.payload).includes("isCorrect"), false);
  assert.equal(JSON.stringify(result.payload).includes("is_correct"), false);
  assert.equal(captured.some((c) => c.table === "quiz_option_keys"), false);
});

test("GET quiz?includeKeys=true is a 403 for a reader and reads no key rows", async (t) => {
  const captured = stubFetch(t, quizTables);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", `/facilities/${FAC}/modules/${MODULE_ID}/quiz?includeKeys=true`);
  assert.equal(result.status, 403);
  assert.equal(captured.some((c) => c.table === "quiz_option_keys"), false);
});

test("GET quiz?includeKeys=true returns isCorrect for a training manager", async (t) => {
  stubFetch(t, quizTables);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("GET", `/facilities/${FAC}/modules/${MODULE_ID}/quiz?includeKeys=true`);
  assert.equal(result.status, 200);
  assert.equal(result.payload.questions[0].options[0].isCorrect, true);
  assert.equal(result.payload.questions[0].options[1].isCorrect, false);
});

test("GET quiz 404s for a module of another facility and for a module without a quiz", async (t) => {
  stubFetch(t, (table) => (table === "course_modules" ? [{ ...QUIZ_MODULE, facility_id: OTHER_FAC }] : []));
  let { call } = mount({ memberships: READER });
  assert.equal((await call("GET", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`)).status, 404);

  stubFetch(t, (table) => (table === "course_modules" ? [QUIZ_MODULE] : []));
  ({ call } = mount({ memberships: READER }));
  assert.equal((await call("GET", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`)).status, 404);
});

// --- quiz authoring ---------------------------------------------------------
test("POST quiz validates before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`, { passScorePct: 500 });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST quiz denies a reader and a non-member", async (t) => {
  stubFetch(t, () => []);
  assert.equal((await mount({ memberships: READER }).call("POST", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`, { title: "x" })).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`, { title: "x" })).status, 403);
});

test("POST quiz refuses a non-quiz module (400) and a module of another facility (404)", async (t) => {
  stubFetch(t, (table) => (table === "course_modules" ? [VIDEO_MODULE] : []));
  let result = await mount().call("POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/quiz`, { title: "x" });
  assert.equal(result.status, 400);
  stubFetch(t, (table) => (table === "course_modules" ? [{ ...QUIZ_MODULE, facility_id: OTHER_FAC }] : []));
  result = await mount().call("POST", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`, { title: "x" });
  assert.equal(result.status, 404);
});

test("POST quiz creates the quiz with the facility's default pass mark and maps a duplicate to 409", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "course_modules") return [QUIZ_MODULE];
    if (table === "modules") return [{ id: "mod-training", code: "training" }];
    if (table === "facilities") return [{ id: FAC, organization_id: "org-1" }];
    if (table === "facility_module_overrides") return [{ config_patch_jsonb: { "training.quizDefaultPassPct": 65 } }];
    if (table === "quizzes" && method === "POST") return [QUIZ];
    return [];
  });
  const result = await mount().call("POST", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`, { title: " Safety quiz ", maxAttempts: 2 });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "quizzes" && c.method === "POST");
  assert.equal(insert.body[0].pass_score_pct, 65);
  assert.equal(insert.body[0].max_attempts, 2);
  assert.equal(insert.body[0].title, "Safety quiz");
  assert.equal(insert.body[0].facility_id, FAC);

  stubFetch(t, (table, method) => {
    if (table === "course_modules") return [QUIZ_MODULE];
    if (table === "quizzes" && method === "POST") return errorResponse(409, { code: "23505" });
    return [];
  });
  const dup = await mount().call("POST", `/facilities/${FAC}/modules/${MODULE_ID}/quiz`, { title: "x", passScorePct: 70 });
  assert.equal(dup.status, 409);
});

test("POST quiz question validates, guards on the quiz's own facility, and writes options + keys in order", async (t) => {
  let captured = stubFetch(t, () => []);
  assert.equal((await mount().call("POST", `/quizzes/${QUIZ_ID}/questions`, { prompt: "" })).status, 400);
  assert.equal(captured.length, 0);

  stubFetch(t, (table) => (table === "quizzes" ? [QUIZ] : []));
  assert.equal(
    (await mount({ memberships: READER }).call("POST", `/quizzes/${QUIZ_ID}/questions`, {
      prompt: "P", orderNo: 1, options: [{ label: "a", isCorrect: true }, { label: "b" }]
    })).status,
    403
  );

  captured = stubFetch(t, (table, method, url, body) => {
    if (table === "quizzes") return [QUIZ];
    if (table === "quiz_questions" && method === "POST") return [{ id: Q1, order_no: 1 }];
    if (table === "quiz_options" && method === "POST") return body.map((row, index) => ({ ...row, id: `opt-${index}` }));
    return [];
  });
  const result = await mount().call("POST", `/quizzes/${QUIZ_ID}/questions`, {
    prompt: "Pick one",
    orderNo: 1,
    options: [{ label: "wrong" }, { label: "right", isCorrect: true }]
  });
  assert.equal(result.status, 201);
  const keys = captured.find((c) => c.table === "quiz_option_keys");
  assert.deepEqual(keys.body.map((row) => [row.option_id, row.is_correct]), [["opt-0", false], ["opt-1", true]]);
  assert.equal(keys.body.every((row) => row.facility_id === FAC), true);
});

test("POST quiz question deletes the question shell when writing its options fails", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "quizzes") return [QUIZ];
    if (table === "quiz_questions" && method === "POST") return [{ id: Q1, order_no: 1 }];
    if (table === "quiz_options" && method === "POST") return errorResponse(500, { message: "boom" });
    return [];
  });
  await assert.rejects(
    mount().call("POST", `/quizzes/${QUIZ_ID}/questions`, {
      prompt: "Pick one", orderNo: 1, options: [{ label: "a", isCorrect: true }, { label: "b" }]
    })
  );
  assert.ok(captured.some((c) => c.table === "quiz_questions" && c.method === "DELETE"));
});

test("DELETE quiz-question soft-deletes under training.manage only", async (t) => {
  const captured = stubFetch(t, (table) => (table === "quiz_questions" ? [QUESTIONS[0]] : []));
  assert.equal((await mount({ memberships: READER }).call("DELETE", `/quiz-questions/${Q1}`)).status, 403);
  const result = await mount().call("DELETE", `/quiz-questions/${Q1}`);
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "quiz_questions" && c.method === "PATCH");
  assert.ok(patch.body.deleted_at);
});

// --- attempts ---------------------------------------------------------------
const answers = { [Q1]: [O1], [Q2]: [O3] };

test("POST attempts validates the answers shape before any fetch (400)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  assert.equal((await call("POST", `/training-assignments/assign-1/quizzes/${QUIZ_ID}/attempts`, {})).status, 400);
  assert.equal((await call("POST", `/training-assignments/assign-1/quizzes/${QUIZ_ID}/attempts`, { answers: { bad: [] } })).status, 400);
  assert.equal(captured.length, 0);
});

test("POST attempts 404s for an unknown assignment", async (t) => {
  stubFetch(t, () => []);
  assert.equal((await mount({ memberships: READER }).call("POST", `/training-assignments/nope/quizzes/${QUIZ_ID}/attempts`, { answers })).status, 404);
});

test("POST attempts: only the assignment's own employee may submit -- another employee and a manager are 403 and never reach the RPC", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "training_assignments") return [ASSIGNMENT];
    if (table === "employees") return [{ id: "emp-2" }]; // the caller is NOT emp-1
    return [];
  });
  const other = await mount({ memberships: READER }).call("POST", `/training-assignments/assign-1/quizzes/${QUIZ_ID}/attempts`, { answers });
  assert.equal(other.status, 403);
  const manager = await mount({ memberships: MANAGER }).call("POST", `/training-assignments/assign-1/quizzes/${QUIZ_ID}/attempts`, { answers });
  assert.equal(manager.status, 403);
  assert.equal(captured.some((c) => c.table === "rpc/submit_quiz_attempt"), false);
});

test("POST attempts: the own employee's attempt goes through the scoring RPC and returns counts, never a key", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "training_assignments") return [ASSIGNMENT];
    if (table === "employees") return [{ id: "emp-1" }];
    if (table === "rpc/submit_quiz_attempt") {
      return {
        attempt_id: "att-1", attempt_no: 1, score_pct: 50, passed: false, correct_count: 1, total_questions: 2,
        pass_score_pct: 80, max_attempts: 3, attempts_remaining: 2, progress_state: "failed"
      };
    }
    return [];
  });
  const result = await mount({ memberships: READER }).call("POST", `/training-assignments/assign-1/quizzes/${QUIZ_ID}/attempts`, { answers });
  assert.equal(result.status, 201);
  assert.deepEqual(result.payload, {
    attemptId: "att-1", attemptNo: 1, scorePct: 50, passed: false, correctCount: 1, totalQuestions: 2,
    passScorePct: 80, maxAttempts: 3, attemptsRemaining: 2, progressState: "failed"
  });
  const rpc = captured.find((c) => c.table === "rpc/submit_quiz_attempt");
  assert.deepEqual(rpc.body, { p_assignment_id: "assign-1", p_quiz_id: QUIZ_ID, p_answers: answers });
  // the route never reads the key table and never writes attempts/progress/completions itself
  assert.equal(captured.some((c) => c.table === "quiz_option_keys"), false);
  assert.equal(captured.some((c) => ["quiz_attempts", "training_progress", "training_completions"].includes(c.table) && c.method !== "GET"), false);
});

test("POST attempts maps the RPC's 409 (max attempts / already passed), 404 and 403 through", async (t) => {
  for (const status of [409, 404, 403, 400]) {
    stubFetch(t, (table) => {
      if (table === "training_assignments") return [ASSIGNMENT];
      if (table === "employees") return [{ id: "emp-1" }];
      if (table === "rpc/submit_quiz_attempt") return errorResponse(status, { message: `rpc said ${status}` });
      return [];
    });
    const result = await mount({ memberships: READER }).call("POST", `/training-assignments/assign-1/quizzes/${QUIZ_ID}/attempts`, { answers });
    assert.equal(result.status, status);
    assert.equal(result.payload.error, `rpc said ${status}`);
  }
});

// --- quiz-attempts + player --------------------------------------------------
const ATTEMPT = { id: "att-1", quiz_id: QUIZ_ID, assignment_id: "assign-1", employee_id: "emp-1", attempt_no: 1, score_pct: "50.00", correct_count: 1, total_questions: 2, passed: false, submitted_at: "2026-07-18T00:00:00Z" };

test("GET quiz-attempts: own employee and manager see them, another employee is 403", async (t) => {
  stubFetch(t, (table) => {
    if (table === "training_assignments") return [ASSIGNMENT];
    if (table === "employees") return [{ id: "emp-1" }];
    if (table === "quiz_attempts") return [ATTEMPT];
    return [];
  });
  const own = await mount({ memberships: READER }).call("GET", "/training-assignments/assign-1/quiz-attempts");
  assert.equal(own.status, 200);
  assert.equal(own.payload[0].scorePct, 50);
  assert.equal(JSON.stringify(own.payload).includes("answers"), false);
  assert.equal((await mount({ memberships: MANAGER }).call("GET", "/training-assignments/assign-1/quiz-attempts")).status, 200);

  stubFetch(t, (table) => {
    if (table === "training_assignments") return [ASSIGNMENT];
    if (table === "employees") return [{ id: "emp-2" }];
    return [];
  });
  assert.equal((await mount({ memberships: READER }).call("GET", "/training-assignments/assign-1/quiz-attempts")).status, 403);
});

const playerTables = (table) => {
  if (table === "training_assignments") return [ASSIGNMENT];
  if (table === "employees") return [{ id: "emp-1" }];
  if (table === "courses") return [{ id: "course-1", code: "C", title: "Safety", description: null, status: "published" }];
  if (table === "course_modules") return [QUIZ_MODULE, { ...VIDEO_MODULE, order_no: 2 }];
  if (table === "training_progress") return [{ id: "p1", assignment_id: "assign-1", module_id: MODULE_ID, state: "failed", started_at: "2026-07-18T00:00:00Z", completed_at: null, score_pct: "50", attempts: 1 }];
  if (table === "training_completions") return [];
  if (table === "training_content_items") {
    return [{ id: "i1", facility_id: FAC, module_id: VIDEO_MODULE.id, kind: "video", title: "Intro", storage_path: "facilities/secret/path", mime_type: "video/mp4", size_bytes: 5, order_no: 0, created_at: "x" }];
  }
  if (table === "quizzes") return [QUIZ];
  if (table === "quiz_attempts") return [ATTEMPT];
  return [];
};

test("GET player assembles modules, content (no storage paths), quiz state, progress and readiness for the own employee", async (t) => {
  stubFetch(t, playerTables);
  const result = await mount({ memberships: READER }).call("GET", "/training-assignments/assign-1/player");
  assert.equal(result.status, 200);
  const { modules, readiness, viewer, assignment, course } = result.payload;
  assert.equal(course.title, "Safety");
  assert.equal(assignment.state, "overdue");
  assert.deepEqual(viewer, { isOwner: true, canManage: false });
  assert.equal(modules.length, 2);
  assert.equal(modules[0].quiz.state, "in_progress");
  assert.equal(modules[0].quiz.attemptsRemaining, 2);
  assert.equal(modules[0].progress.state, "failed");
  assert.equal(modules[1].contentItems[0].kind, "video");
  assert.equal(JSON.stringify(result.payload).includes("facilities/secret"), false);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.outstandingModules.length, 2);
});

test("GET player is 403 for another employee, 200 for a manager, 404 for an unknown assignment", async (t) => {
  stubFetch(t, (table) => (table === "employees" ? [{ id: "emp-2" }] : playerTables(table)));
  assert.equal((await mount({ memberships: READER }).call("GET", "/training-assignments/assign-1/player")).status, 403);
  stubFetch(t, playerTables);
  const manager = await mount({ memberships: MANAGER }).call("GET", "/training-assignments/assign-1/player");
  assert.equal(manager.status, 200);
  assert.equal(manager.payload.viewer.canManage, true);
  stubFetch(t, () => []);
  assert.equal((await mount({ memberships: READER }).call("GET", "/training-assignments/nope/player")).status, 404);
});

// --- content ---------------------------------------------------------------
test("GET content lists items without storage paths; a non-member is 403", async (t) => {
  stubFetch(t, (table) => (table === "training_content_items" ? playerTables(table) : []));
  const ok = await mount({ memberships: READER }).call("GET", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload[0].title, "Intro");
  assert.equal("storage_path" in ok.payload[0], false);
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`)).status, 403);
});

const uploadHeaders = (overrides = {}) => ({ "content-type": "video/mp4", "x-file-name": "Intro Video.mp4", ...overrides });

test("POST content rejects a bad mime type and a missing filename before any I/O (400)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { callRaw } = mount();
  assert.equal((await callRaw("POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: uploadHeaders({ "content-type": "image/png" }), body: Buffer.from("x") })).status, 400);
  assert.equal((await callRaw("POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: { "content-type": "video/mp4" }, body: Buffer.from("x") })).status, 400);
  assert.equal(captured.length, 0);
});

test("POST content: reader 403, module of another facility 404, wrong module type 400 -- none touch storage", async (t) => {
  const storage = stubStorage();
  stubFetch(t, (table) => (table === "course_modules" ? [VIDEO_MODULE] : []));
  const reader = await mount({ memberships: READER, storageClient: storage.client }).callRaw(
    "POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: uploadHeaders(), body: Buffer.from("x") }
  );
  assert.equal(reader.status, 403);

  stubFetch(t, (table) => (table === "course_modules" ? [{ ...VIDEO_MODULE, facility_id: OTHER_FAC }] : []));
  const cross = await mount({ storageClient: storage.client }).callRaw(
    "POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: uploadHeaders(), body: Buffer.from("x") }
  );
  assert.equal(cross.status, 404);

  stubFetch(t, (table) => (table === "course_modules" ? [{ ...VIDEO_MODULE, module_type: "pdf" }] : []));
  const wrongType = await mount({ storageClient: storage.client }).callRaw(
    "POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: uploadHeaders(), body: Buffer.from("x") }
  );
  assert.equal(wrongType.status, 400);
  assert.equal(storage.calls.length, 0);
});

test("POST content uploads under facilities/{facility}/training/{module}/ and records the item", async (t) => {
  const storage = stubStorage();
  const captured = stubFetch(t, (table, method) => {
    if (table === "course_modules") return [VIDEO_MODULE];
    if (table === "training_content_items" && method === "POST") {
      return [{ id: "i-new", module_id: VIDEO_MODULE.id, kind: "video", title: "Intro Video.mp4", mime_type: "video/mp4", size_bytes: 5, order_no: 0, created_at: "x" }];
    }
    return [];
  });
  const result = await mount({ storageClient: storage.client }).callRaw(
    "POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: uploadHeaders(), body: Buffer.from("video") }
  );
  assert.equal(result.status, 201);
  assert.equal(storage.calls.length, 1);
  const insert = captured.find((c) => c.table === "training_content_items" && c.method === "POST");
  assert.match(insert.body[0].storage_path, new RegExp(`^facilities/${FAC}/training/${VIDEO_MODULE.id}/[0-9a-f-]{36}-Intro-Video\\.mp4$`));
  assert.equal(insert.body[0].kind, "video");
  assert.equal(insert.body[0].size_bytes, 5);
  assert.match(insert.body[0].checksum_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.payload).includes("facilities/"), false);
});

test("POST content removes the stored object again when the row insert is refused", async (t) => {
  const storage = stubStorage();
  stubFetch(t, (table, method) => {
    if (table === "course_modules") return [VIDEO_MODULE];
    if (table === "training_content_items" && method === "POST") return errorResponse(403, { message: "denied" });
    return [];
  });
  const result = await mount({ storageClient: storage.client }).callRaw(
    "POST", `/facilities/${FAC}/modules/${VIDEO_MODULE.id}/content`, { headers: uploadHeaders(), body: Buffer.from("video") }
  );
  assert.ok(result.status >= 400);
  assert.equal(storage.calls.length, 2, "one upload, then one delete of the same object");
});

const ITEM = {
  id: "i1", facility_id: FAC, module_id: VIDEO_MODULE.id, kind: "video", title: "Intro",
  storage_path: `facilities/${FAC}/training/${VIDEO_MODULE.id}/uuid-intro.mp4`, mime_type: "video/mp4", size_bytes: 5, order_no: 0, created_at: "x"
};

test("GET content url signs the path for a reader and refuses a path outside the row's facility/module without touching storage", async (t) => {
  const storage = stubStorage(() => ({ status: 200, body: { signedURL: "/object/sign/attachments/x?token=abc" } }));
  stubFetch(t, (table) => (table === "training_content_items" ? [ITEM] : []));
  const ok = await mount({ memberships: READER, storageClient: storage.client }).call("GET", "/training-content/i1/url");
  assert.equal(ok.status, 200);
  assert.match(ok.payload.url, /token=abc/);
  assert.equal(ok.payload.expiresInSeconds, 300);
  assert.equal(storage.calls.length, 1);

  const bad = stubStorage();
  stubFetch(t, (table) => (table === "training_content_items" ? [{ ...ITEM, storage_path: `facilities/${OTHER_FAC}/training/${VIDEO_MODULE.id}/x.mp4` }] : []));
  assert.equal((await mount({ memberships: READER, storageClient: bad.client }).call("GET", "/training-content/i1/url")).status, 404);
  stubFetch(t, (table) => (table === "training_content_items" ? [{ ...ITEM, storage_path: `facilities/${FAC}/training/other-module/x.mp4` }] : []));
  assert.equal((await mount({ memberships: READER, storageClient: bad.client }).call("GET", "/training-content/i1/url")).status, 404);
  assert.equal(bad.calls.length, 0);
});

test("GET content url answers 404 (not 403) to a non-member and for an unknown item", async (t) => {
  const storage = stubStorage();
  stubFetch(t, (table) => (table === "training_content_items" ? [ITEM] : []));
  assert.equal((await mount({ memberships: OUTSIDER, storageClient: storage.client }).call("GET", "/training-content/i1/url")).status, 404);
  stubFetch(t, () => []);
  assert.equal((await mount({ memberships: READER, storageClient: storage.client }).call("GET", "/training-content/nope/url")).status, 404);
  assert.equal(storage.calls.length, 0);
});

test("DELETE training-content soft-deletes under training.manage only", async (t) => {
  const captured = stubFetch(t, (table) => (table === "training_content_items" ? [ITEM] : []));
  assert.equal((await mount({ memberships: READER }).call("DELETE", "/training-content/i1")).status, 403);
  assert.equal((await mount().call("DELETE", "/training-content/i1")).status, 200);
  assert.ok(captured.find((c) => c.method === "PATCH").body.deleted_at);
});
