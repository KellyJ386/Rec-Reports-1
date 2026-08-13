import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerTrainingRoutes } from "../src/lib/http/training-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["training.read", "training.manage"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["training.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["training.read", "training.manage"] }];
// A plain facility member with no training permissions at all -- exercises
// the self-service /me and employee-scoped paths, which require only
// facility membership, distinctly from the facility-wide list/manage paths
// which require training.read/training.manage.
const NO_PERMS = [{ facilityId: "fac-1", status: "active", permissions: [] }];

const PUBLISHED_COURSE = {
  id: "course-1",
  facility_id: "fac-1",
  code: "onboarding-101",
  title: "Onboarding Training",
  description: "Required for all new hires",
  status: "published",
  created_at: "2026-07-18T00:00:00Z",
  updated_at: "2026-07-18T00:00:00Z"
};

const TRAINING_ASSIGNMENT = {
  id: "assign-1",
  facility_id: "fac-1",
  employee_id: "emp-1",
  course_id: "course-1",
  assigned_by: "user-1",
  assigned_at: "2026-07-18T00:00:00Z",
  due_at: "2026-08-18T00:00:00Z",
  reason_code: null,
  source_type: "manual",
  source_ref_id: null,
  created_at: "2026-07-18T00:00:00Z",
  updated_at: "2026-07-18T00:00:00Z"
};

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null });
    const data = respond(table, method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// Like stubFetch, but the write matching (conflictTable, conflictMethod)
// returns a non-2xx 409 response (as PostgREST does for a unique_violation),
// so route-layer conflict handling can be exercised without a real DB.
function stubFetchWithConflict(t, conflictTable, conflictMethod, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null });
    if (table === conflictTable && method === conflictMethod) {
      return {
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" })
      };
    }
    const data = respond(table, method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = MANAGER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerTrainingRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET courses denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/courses");
  assert.equal(result.status, 403);
});

test("GET courses returns published only by default", async (t) => {
  const captured = stubFetch(t, (table) => (table === "courses" ? [PUBLISHED_COURSE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/courses");
  assert.equal(result.status, 200);
  const get = captured.find((c) => c.table === "courses");
  assert.match(get.url.search, /status=eq\.published/);
});

test("GET courses?status=all drops the published filter", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/courses?status=all");
  const get = captured.find((c) => c.table === "courses");
  assert.doesNotMatch(get.url.search, /status=eq/);
});

test("GET training-assignments returns a list for a reader", async (t) => {
  const captured = stubFetch(t, (table) =>
    table === "training_assignments" ? [TRAINING_ASSIGNMENT] : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/training-assignments");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].id, "assign-1");
});

test("POST training-assignments validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/training-assignments", {
    employeeId: "emp-1"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST training-assignments denies a reader without training.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/training-assignments", {
    employeeId: "emp-1",
    courseId: "course-1"
  });
  assert.equal(result.status, 403);
});

test("POST training-assignments happy path inserts a shaped row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "training_assignments" && method === "POST") return [{ id: "assign-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/training-assignments", {
    employeeId: "emp-1",
    courseId: "course-1",
    dueAt: "2026-08-18T00:00:00Z",
    reasonCode: "onboarding"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "training_assignments" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].employee_id, "emp-1");
  assert.equal(insert.body[0].course_id, "course-1");
  assert.equal(insert.body[0].assigned_by, "user-9");
  assert.equal(insert.body[0].reason_code, "onboarding");
  assert.equal(insert.body[0].source_type, "manual");
});

test("POST training-assignments/complete denies a non-member", async (t) => {
  stubFetch(t, (table) =>
    table === "training_assignments" ? [TRAINING_ASSIGNMENT] : []
  );
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/training-assignments/assign-1/complete", {
    completionStatus: "passed"
  });
  assert.equal(result.status, 403);
});

test("POST training-assignments/complete 404s when assignment missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/training-assignments/nope/complete", {
    completionStatus: "passed"
  });
  assert.equal(result.status, 404);
});

test("POST training-assignments/complete happy path inserts a completion row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "training_assignments" && method === "GET") return [TRAINING_ASSIGNMENT];
    if (table === "training_completions" && method === "POST") return [{ id: "comp-1" }];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/training-assignments/assign-1/complete", {
    completionStatus: "passed",
    finalScorePct: 92.5
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "training_completions" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].assignment_id, "assign-1");
  assert.equal(insert.body[0].completion_status, "passed");
  assert.equal(insert.body[0].final_score_pct, 92.5);
});

// --- TR-01: employee-scoped queries + derived state -------------------------

test("GET training-assignments filters by employeeId", async (t) => {
  const captured = stubFetch(t, (table) => (table === "training_assignments" ? [TRAINING_ASSIGNMENT] : []));
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/training-assignments?employeeId=emp-1");
  const get = captured.find((c) => c.table === "training_assignments" && c.method === "GET");
  assert.match(get.url.search, /employee_id=eq\.emp-1/);
});

test("GET training-assignments includes a derived state per assignment", async (t) => {
  const overdue = {
    ...TRAINING_ASSIGNMENT,
    id: "assign-overdue",
    due_at: new Date(Date.now() - 86400000).toISOString()
  };
  const notStarted = {
    ...TRAINING_ASSIGNMENT,
    id: "assign-fresh",
    due_at: new Date(Date.now() + 86400000 * 30).toISOString()
  };
  const completed = {
    ...TRAINING_ASSIGNMENT,
    id: "assign-done",
    due_at: new Date(Date.now() - 86400000).toISOString()
  };
  stubFetch(t, (table) => {
    if (table === "training_assignments") return [overdue, notStarted, completed];
    if (table === "training_completions") {
      return [{ assignment_id: "assign-done", completed_at: "2026-01-01T00:00:00Z" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/training-assignments");
  assert.equal(result.status, 200);
  const byId = Object.fromEntries(result.payload.map((a) => [a.id, a.state]));
  assert.equal(byId["assign-overdue"], "overdue");
  assert.equal(byId["assign-fresh"], "not_started");
  assert.equal(byId["assign-done"], "complete");
});

test("facility-wide training-assignments list still requires training.read for a plain facility member", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: NO_PERMS });
  const result = await call("GET", "/facilities/fac-1/training-assignments");
  assert.equal(result.status, 403);
});

test("GET /me/training-assignments requires a facilityId query parameter", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: NO_PERMS });
  const result = await call("GET", "/me/training-assignments");
  assert.equal(result.status, 400);
});

test("GET /me/training-assignments denies a non-member facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/me/training-assignments?facilityId=fac-1");
  assert.equal(result.status, 403);
});

test("GET /me/training-assignments works for a member without training.read (self-service)", async (t) => {
  stubFetch(t, (table) => {
    if (table === "employees") return [{ id: "emp-1" }];
    if (table === "training_assignments") return [TRAINING_ASSIGNMENT];
    return [];
  });
  const { call } = mount({ memberships: NO_PERMS, userId: "user-1" });
  const result = await call("GET", "/me/training-assignments?facilityId=fac-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].id, "assign-1");
  assert.ok(result.payload[0].state);
});

test("GET /me/training-assignments returns an empty list when the caller has no employee record", async (t) => {
  stubFetch(t, (table) => (table === "employees" ? [] : [TRAINING_ASSIGNMENT]));
  const { call } = mount({ memberships: NO_PERMS });
  const result = await call("GET", "/me/training-assignments?facilityId=fac-1");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, []);
});

test("GET /me/training-assignments always resolves the caller's own employee row -- a smuggled employeeId is ignored", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "employees") return [{ id: "emp-1" }];
    if (table === "training_assignments") return [TRAINING_ASSIGNMENT];
    return [];
  });
  const { call } = mount({ memberships: NO_PERMS, userId: "user-1" });
  // /me/training-assignments takes no employeeId parameter -- an attempt to
  // smuggle one in through the query string is simply ignored; the query is
  // always scoped to the server-resolved employeeId, so a caller can never
  // read another employee's queue this way.
  await call("GET", "/me/training-assignments?facilityId=fac-1&employeeId=someone-elses-id");
  const get = captured.find((c) => c.table === "training_assignments" && c.method === "GET");
  assert.match(get.url.search, /employee_id=eq\.emp-1/);
  assert.doesNotMatch(get.url.search, /someone-elses-id/);
});

// --- TR-02: certification wallet ---------------------------------------------

const CERT_TYPE_CPR = {
  id: "type-cpr",
  facility_id: "fac-1",
  code: "cpr",
  name: "CPR",
  renewal_window_days: 30
};

test("GET employee-certifications denies a non-member facility when no employeeId is given", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/employee-certifications");
  assert.equal(result.status, 403);
});

test("GET employee-certifications with ?employeeId= requires training.read", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: NO_PERMS });
  const result = await call("GET", "/facilities/fac-1/employee-certifications?employeeId=emp-2");
  assert.equal(result.status, 403);
});

test("GET employee-certifications self-scope resolves the caller's own wallet without training.read", async (t) => {
  const cert = {
    id: "cert-1",
    facility_id: "fac-1",
    employee_id: "emp-1",
    certification_type_id: "type-cpr",
    issued_at: "2026-01-01T00:00:00Z",
    expires_at: new Date(Date.now() + 86400000 * 365).toISOString(),
    evidence_path: null,
    status: "active"
  };
  stubFetch(t, (table) => {
    if (table === "employees") return [{ id: "emp-1" }];
    if (table === "employee_certifications") return [cert];
    if (table === "certification_types") return [CERT_TYPE_CPR];
    return [];
  });
  const { call } = mount({ memberships: NO_PERMS, userId: "user-1" });
  const result = await call("GET", "/facilities/fac-1/employee-certifications");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].status, "active");
  assert.equal(result.payload[0].certification_type_name, "CPR");
  assert.equal(result.payload[0].evidence_path, null);
});

test("GET employee-certifications returns an empty wallet when the caller has no employee record", async (t) => {
  stubFetch(t, (table) => (table === "employees" ? [] : []));
  const { call } = mount({ memberships: NO_PERMS });
  const result = await call("GET", "/facilities/fac-1/employee-certifications");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, []);
});

test("GET employee-certifications maps every certificationStatus outcome", async (t) => {
  const active = {
    id: "cert-active",
    facility_id: "fac-1",
    employee_id: "emp-2",
    certification_type_id: "type-cpr",
    expires_at: new Date(Date.now() + 86400000 * 365).toISOString(),
    status: "active"
  };
  const expiring = {
    id: "cert-expiring",
    facility_id: "fac-1",
    employee_id: "emp-2",
    certification_type_id: "type-cpr",
    expires_at: new Date(Date.now() + 86400000 * 5).toISOString(),
    status: "active"
  };
  const expired = {
    id: "cert-expired",
    facility_id: "fac-1",
    employee_id: "emp-2",
    certification_type_id: "type-cpr",
    expires_at: new Date(Date.now() - 86400000).toISOString(),
    status: "active"
  };
  const revoked = {
    id: "cert-revoked",
    facility_id: "fac-1",
    employee_id: "emp-2",
    certification_type_id: "type-cpr",
    expires_at: new Date(Date.now() + 86400000 * 365).toISOString(),
    status: "revoked"
  };
  stubFetch(t, (table) => {
    if (table === "employee_certifications") return [active, expiring, expired, revoked];
    if (table === "certification_types") return [CERT_TYPE_CPR];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/employee-certifications?employeeId=emp-2");
  assert.equal(result.status, 200);
  const byId = Object.fromEntries(result.payload.map((c) => [c.id, c.status]));
  assert.equal(byId["cert-active"], "active");
  assert.equal(byId["cert-expiring"], "expiring");
  assert.equal(byId["cert-expired"], "expired");
  assert.equal(byId["cert-revoked"], "revoked");
});

// --- TR-05: Training Studio minimal admin CRUD -------------------------------

test("POST courses validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/courses", { title: "Missing code" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST courses denies a reader without training.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/courses", { code: "c1", title: "Course 1" });
  assert.equal(result.status, 403);
});

test("POST courses happy path defaults to draft status", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "courses" && method === "POST") return [{ id: "course-2" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/courses", { code: "c1", title: "Course 1" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "courses" && c.method === "POST");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].facility_id, "fac-1");
});

test("POST courses surfaces a duplicate code as a clean 409", async (t) => {
  stubFetchWithConflict(t, "courses", "POST", () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/courses", { code: "dup", title: "Duplicate" });
  assert.equal(result.status, 409);
});

test("PATCH courses denies without training.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/courses/course-1", { status: "published" });
  assert.equal(result.status, 403);
});

test("PATCH courses rejects an empty patch", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/courses/course-1", {});
  assert.equal(result.status, 400);
});

test("PATCH courses happy path flips status to published", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "courses" && method === "PATCH") return [{ id: "course-1", status: "published" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/courses/course-1", { status: "published" });
  assert.equal(result.status, 200);
  const update = captured.find((c) => c.table === "courses" && c.method === "PATCH");
  assert.equal(update.body.status, "published");
});

test("PATCH courses surfaces a duplicate code as a clean 409", async (t) => {
  stubFetchWithConflict(t, "courses", "PATCH", () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/courses/course-1", { code: "dup" });
  assert.equal(result.status, 409);
});

test("POST course modules validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/courses/course-1/modules", {
    title: "No type or order"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST course modules denies without training.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/courses/course-1/modules", {
    moduleType: "video",
    title: "Intro",
    orderNo: 0
  });
  assert.equal(result.status, 403);
});

test("POST course modules happy path inserts a shaped row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "course_modules" && method === "POST") return [{ id: "module-1" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/courses/course-1/modules", {
    moduleType: "sop_link",
    title: "SOP",
    orderNo: 1,
    content: { url: "https://example.com/sop" }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "course_modules" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].course_id, "course-1");
  assert.equal(insert.body[0].module_type, "sop_link");
  assert.equal(insert.body[0].order_no, 1);
  assert.deepEqual(insert.body[0].content_jsonb, { url: "https://example.com/sop" });
  assert.equal(insert.body[0].required, true);
});

test("POST course modules surfaces an order_no collision as a clean 409", async (t) => {
  stubFetchWithConflict(t, "course_modules", "POST", () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/courses/course-1/modules", {
    moduleType: "video",
    title: "Intro",
    orderNo: 1
  });
  assert.equal(result.status, 409);
});

test("PATCH course modules denies without training.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/courses/course-1/modules/module-1", {
    orderNo: 2
  });
  assert.equal(result.status, 403);
});

test("PATCH course modules surfaces an order_no collision as a clean 409", async (t) => {
  stubFetchWithConflict(t, "course_modules", "PATCH", () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/courses/course-1/modules/module-1", {
    orderNo: 2
  });
  assert.equal(result.status, 409);
});
