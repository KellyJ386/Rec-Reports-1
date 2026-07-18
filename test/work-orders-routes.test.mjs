import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerWorkOrderRoutes } from "../src/lib/http/work-orders-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["work_orders.read", "work_orders.manage"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["work_orders.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["work_orders.read", "work_orders.manage"] }];

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
  registerWorkOrderRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET work-orders denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/work-orders");
  assert.equal(result.status, 403);
});

test("GET work-orders returns work orders for a reader", async (t) => {
  const captured = stubFetch(t, (table) =>
    table === "work_orders" ? [{ id: "wo-1", facility_id: "fac-1", title: "Fix leak" }] : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /facility_id=eq\.fac-1/);
});

test("GET work-orders?status=resolved filters by status", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?status=resolved");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /status=eq\.resolved/);
});

test("POST work-orders validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/work-orders", { title: "Fix leak" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST work-orders denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high"
  });
  assert.equal(result.status, 403);
});

test("POST work-orders happy path inserts a shaped row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    assigned_to_employee_id: "emp-5"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].title, "Fix leak");
  assert.equal(insert.body[0].description, "Water leak in basement");
  assert.equal(insert.body[0].priority, "high");
  assert.equal(insert.body[0].status, "open");
  assert.equal(insert.body[0].assigned_to_employee_id, "emp-5");
  assert.equal(insert.body[0].created_by, "user-9");
});

test("GET work-order by id returns a single work order", async (t) => {
  stubFetch(t, (table) =>
    table === "work_orders" ? [{ id: "wo-1", facility_id: "fac-1", title: "Fix leak" }] : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/work-orders/wo-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.id, "wo-1");
});

test("GET work-order by id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/work-orders/nope");
  assert.equal(result.status, 404);
});

test("PATCH work-order updates status", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "open" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "in_progress" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.status, "in_progress");
  assert.ok(patch.body.updated_at);
});

test("PATCH work-order updates assignment", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { assigned_to_employee_id: "emp-7" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.assigned_to_employee_id, "emp-7");
});

test("PATCH work-order denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, (table) => (table === "work_orders" && [{ id: "wo-1", facility_id: "fac-1" }]) || []);
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 403);
});

test("PATCH work-order 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/nope", { status: "in_progress" });
  assert.equal(result.status, 404);
});

test("PATCH work-order rejects empty patch", async (t) => {
  stubFetch(t, (table) => (table === "work_orders" && [{ id: "wo-1", facility_id: "fac-1" }]) || []);
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", {});
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /nothing to update/);
});
