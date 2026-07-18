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
