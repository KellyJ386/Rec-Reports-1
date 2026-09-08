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

// M-1 (security review, wave3-slice-3c): sla_due_at/first_response_at/
// resolved_at are now stamped through a service-role RPC
// (rpc/set_work_order_sla_fields, POST /rest/v1/rpc/set_work_order_sla_fields)
// rather than a direct work_orders write. A test whose own `respond` doesn't
// recognize that table gets a sensible default here -- echo the requested id
// + fields back as the "row" -- so every test that doesn't care about the
// stamp's exact response shape (most of them) needs no changes; a test that
// DOES care finds the call via `captured` and inspects `body.p_fields`
// directly (see e.g. the "derives sla_due_at" tests below).
function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body });
    let data = respond(table, method, parsed, body);
    if (data === undefined && table === "rpc/set_work_order_sla_fields") {
      data = { id: body?.p_work_order_id, ...(body?.p_fields ?? {}) };
    }
    data = data ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// M-1: every route that can reach a service-role SLA stamp now needs
// env.SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY -- default them here so every
// existing test keeps exercising the real (non-503) path; pass
// `env: { SUPABASE_SERVICE_ROLE_KEY: undefined }` (or omit SUPABASE_URL) to
// a specific `call` to exercise the "service role not configured" case.
const SERVICE_ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" };

function mount({ memberships = MANAGER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerWorkOrderRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body, { env = SERVICE_ENV } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env, params });
    return sent[sent.length - 1];
  }
  return { call };
}

function findSlaRpc(captured) {
  return captured.find((c) => c.table === "rpc/set_work_order_sla_fields" && c.method === "POST");
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
    if (table === "employees" && method === "GET") return [{ id: "emp-5", facility_id: "fac-1" }];
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

// M-1 (security review, wave3-slice-3c): with no service-role client
// available, work order creation must 503 BEFORE any write -- never insert
// the row and then discover the SLA stamp can't be applied.
test("POST work-orders 503s and inserts nothing when SUPABASE_SERVICE_ROLE_KEY is not configured", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call(
    "POST",
    "/facilities/fac-1/work-orders",
    { title: "Fix leak", description: "Water leak in basement", priority: "high" },
    { env: { SUPABASE_URL: "https://example.supabase.co" } } // no SUPABASE_SERVICE_ROLE_KEY
  );
  assert.equal(result.status, 503);
  assert.ok(!captured.some((c) => c.table === "work_orders"), "must not attempt the insert");
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

// M-1: a status-changing PATCH always touches resolved_at, so it 503s
// (before any write) with no service-role client available; a
// priority/assignee-only PATCH never touches an SLA-guarded column and is
// completely unaffected.
test("PATCH work-order status change 503s and writes nothing when SUPABASE_SERVICE_ROLE_KEY is not configured", async (t) => {
  const captured = stubFetch(t, (table, method) =>
    table === "work_orders" && method === "GET" ? [{ id: "wo-1", facility_id: "fac-1", status: "open" }] : []
  );
  const { call } = mount();
  const result = await call(
    "PATCH",
    "/work-orders/wo-1",
    { status: "in_progress" },
    { env: { SUPABASE_URL: "https://example.supabase.co" } }
  );
  assert.equal(result.status, 503);
  assert.ok(!captured.some((c) => c.method === "PATCH" || (c.table === "work_order_updates" && c.method === "POST")));
});

test("PATCH work-order priority-only change succeeds even with no service-role client configured", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") return [{ id: "wo-1", facility_id: "fac-1", priority: "medium" }];
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", priority: "urgent" }];
    return [];
  });
  const { call } = mount();
  const result = await call(
    "PATCH",
    "/work-orders/wo-1",
    { priority: "urgent" },
    { env: { SUPABASE_URL: "https://example.supabase.co" } }
  );
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.priority, "urgent");
});

test("PATCH work-order updates assignment", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-7", facility_id: "fac-1" }];
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

// --- WO-02: status lifecycle / transition matrix / history rows ------------

test("PATCH work-order rejects an unknown status value with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH work-order rejects an unknown priority value with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { priority: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH work-order accepts in_progress -> resolved and sets completed_at", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "in_progress", priority: "medium" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "resolved" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "resolved" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.status, "resolved");
  assert.ok(patch.body.completed_at, "completed_at should be stamped on resolve");
});

test("PATCH work-order accepts resolved -> closed", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "resolved", priority: "medium" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "closed" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "closed" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.status, "closed");
  assert.ok(patch.body.completed_at);
});

test("PATCH work-order rejects closed -> in_progress with 409 and does not write", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "closed", priority: "medium" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 409);
  assert.equal(
    captured.filter((c) => c.method === "PATCH" || (c.table === "work_order_updates" && c.method === "POST")).length,
    0
  );
});

test("PATCH work-order rejects a same-status no-op transition with 409", async (t) => {
  stubFetch(t, (table, method) =>
    table === "work_orders" && method === "GET" ? [{ id: "wo-1", facility_id: "fac-1", status: "open" }] : []
  );
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "open" });
  assert.equal(result.status, 409);
});

test("PATCH work-order reopens resolved -> in_progress and clears completed_at", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "resolved", completed_at: "2026-01-01T00:00:00Z" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "in_progress" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.completed_at, null);
});

test("PATCH work-order status change writes exactly one status_change history row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "open" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "in_progress" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 200);
  const historyInsert = captured.find((c) => c.table === "work_order_updates" && c.method === "POST");
  assert.equal(historyInsert.body.length, 1);
  assert.equal(historyInsert.body[0].update_type, "status_change");
  assert.equal(historyInsert.body[0].previous_value, "open");
  assert.equal(historyInsert.body[0].new_value, "in_progress");
  assert.equal(historyInsert.body[0].facility_id, "fac-1");
  assert.equal(historyInsert.body[0].work_order_id, "wo-1");
  assert.equal(historyInsert.body[0].created_by, "user-9");
});

test("PATCH work-order assignment change writes an assignment_change history row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", assigned_to_employee_id: "emp-1" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-7", facility_id: "fac-1" }];
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { assigned_to_employee_id: "emp-7" });
  assert.equal(result.status, 200);
  const historyInsert = captured.find((c) => c.table === "work_order_updates" && c.method === "POST");
  assert.equal(historyInsert.body.length, 1);
  assert.equal(historyInsert.body[0].update_type, "assignment_change");
  assert.equal(historyInsert.body[0].previous_value, "emp-1");
  assert.equal(historyInsert.body[0].new_value, "emp-7");
});

test("PATCH work-order priority change writes a priority_change history row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", priority: "medium" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", priority: "urgent" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { priority: "urgent" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.priority, "urgent");
  const historyInsert = captured.find((c) => c.table === "work_order_updates" && c.method === "POST");
  assert.equal(historyInsert.body.length, 1);
  assert.equal(historyInsert.body[0].update_type, "priority_change");
  assert.equal(historyInsert.body[0].previous_value, "medium");
  assert.equal(historyInsert.body[0].new_value, "urgent");
});

test("PATCH work-order changing status, assignee and priority together writes one history row per changed field", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "open", priority: "low", assigned_to_employee_id: null }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-3", facility_id: "fac-1" }];
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", {
    status: "in_progress",
    priority: "high",
    assigned_to_employee_id: "emp-3"
  });
  assert.equal(result.status, 200);
  const historyInsert = captured.find((c) => c.table === "work_order_updates" && c.method === "POST");
  assert.equal(historyInsert.body.length, 3);
  const types = historyInsert.body.map((row) => row.update_type).sort();
  assert.deepEqual(types, ["assignment_change", "priority_change", "status_change"]);
});

// --- WO-01: comment thread endpoints (work_order_updates) ------------------

test("GET work-order updates denies a non-member of the parent's facility with 403", async (t) => {
  stubFetch(t, (table) => (table === "work_orders" && [{ id: "wo-1", facility_id: "fac-1" }]) || []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/work-orders/wo-1/updates");
  assert.equal(result.status, 403);
});

test("GET work-order updates 404s when the parent work order is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/work-orders/nope/updates");
  assert.equal(result.status, 404);
});

test("GET work-order updates returns the thread chronologically for a reader", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") return [{ id: "wo-1", facility_id: "fac-1" }];
    if (table === "work_order_updates" && method === "GET") {
      return [{ id: "u-1", work_order_id: "wo-1", update_type: "comment", body: "hi" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/work-orders/wo-1/updates");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "work_order_updates" && c.method === "GET");
  assert.match(get.url.search, /work_order_id=eq\.wo-1/);
  assert.match(get.url.search, /order=created_at\.asc/);
});

test("POST work-order updates rejects an empty comment body with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/work-orders/wo-1/updates", { body: "   " });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST work-order updates denies a reader without work_orders.manage with 403", async (t) => {
  stubFetch(t, (table) => (table === "work_orders" && [{ id: "wo-1", facility_id: "fac-1" }]) || []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/work-orders/wo-1/updates", { body: "Replaced the filter" });
  assert.equal(result.status, 403);
});

test("POST work-order updates denies a non-member of the parent's facility with 403", async (t) => {
  stubFetch(t, (table) => (table === "work_orders" && [{ id: "wo-1", facility_id: "fac-1" }]) || []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/work-orders/wo-1/updates", { body: "Replaced the filter" });
  assert.equal(result.status, 403);
});

test("POST work-order updates 404s when the parent work order is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/work-orders/nope/updates", { body: "Replaced the filter" });
  assert.equal(result.status, 404);
});

test("POST work-order updates stamps facility_id from the parent and created_by from auth claims", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") return [{ id: "wo-1", facility_id: "fac-1" }];
    if (table === "work_order_updates" && method === "POST") {
      return [{ id: "u-1", update_type: "comment", body: "Replaced the filter" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("POST", "/work-orders/wo-1/updates", { body: "Replaced the filter" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_order_updates" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].work_order_id, "wo-1");
  assert.equal(insert.body[0].update_type, "comment");
  assert.equal(insert.body[0].body, "Replaced the filter");
  assert.equal(insert.body[0].created_by, "user-42");
});

// --- WO-05: list filters, sorting, pagination -------------------------------

test("GET work-orders?priority= filters by priority", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?priority=urgent");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /priority=eq\.urgent/);
});

test("GET work-orders?priority=bogus 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?priority=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET work-orders?status=bogus 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?status=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET work-orders?assignee= filters by assigned_to_employee_id", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?assignee=emp-7");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /assigned_to_employee_id=eq\.emp-7/);
});

test("GET work-orders?asset= filters by asset_id", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?asset=asset-1");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /asset_id=eq\.asset-1/);
});

test("GET work-orders?department= filters by department_id", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?department=dept-1");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /department_id=eq\.dept-1/);
});

test("GET work-orders?overdue=true filters open statuses past due_at", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?overdue=true");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /status=in\.%28open%2Cin_progress%2Con_hold%29|status=in\.\(open,in_progress,on_hold\)/);
  assert.match(get.url.search, /due_at=lt\./);
});

test("GET work-orders?overdue=true with an explicit status keeps the eq filter and adds due_at", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?overdue=true&status=in_progress");
  const get = captured.find((c) => c.table === "work_orders");
  assert.match(get.url.search, /status=eq\.in_progress/);
  assert.match(get.url.search, /due_at=lt\./);
});

test("GET work-orders?overdue=bogus 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?overdue=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET work-orders defaults to limit=50 when unspecified", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders");
  const get = captured.find((c) => c.table === "work_orders");
  assert.equal(get.url.searchParams.get("limit"), "50");
});

test("GET work-orders?limit= clamps values above 200 down to the cap", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?limit=9000");
  const get = captured.find((c) => c.table === "work_orders");
  assert.equal(get.url.searchParams.get("limit"), "200");
});

test("GET work-orders?limit=abc 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?limit=abc");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET work-orders?limit=0 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?limit=0");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET work-orders?offset= is passed through to the query", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?offset=40");
  const get = captured.find((c) => c.table === "work_orders");
  assert.equal(get.url.searchParams.get("offset"), "40");
});

test("GET work-orders?offset=-1 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?offset=-1");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET work-orders?order= accepts an allowlisted column", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?order=priority.asc");
  const get = captured.find((c) => c.table === "work_orders");
  assert.equal(get.url.searchParams.get("order"), "priority.asc");
});

test("GET work-orders?order=bogus 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?order=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

// --- WO-03: create work order from incident (dual guard + SLA due_at) ------

const INCIDENT_AND_WO_MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "work_orders.manage"] }
];
const INCIDENT_READ_ONLY = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];
const WO_MANAGE_ONLY = [{ facilityId: "fac-1", status: "active", permissions: ["work_orders.manage"] }];

function stubIncident(table, method, overrides = {}) {
  if (table === "incident_reports" && method === "GET") {
    return [
      {
        id: "inc-1",
        facility_id: "fac-1",
        incident_no: "INC-1",
        severity: "low",
        summary: "x",
        ...overrides
      }
    ];
  }
  return undefined;
}

test("POST incidents/:id/work-orders happy path creates a shaped row with source fields, mapped priority and derived due_at", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    const incident = stubIncident(table, method, { severity: "high", summary: "Deck mat missing" });
    if (incident) return incident;
    if (table === "modules" && method === "GET") return [{ id: "mod-wo", code: "work_orders" }];
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "organization_module_settings" && method === "GET") return [];
    if (table === "facility_module_overrides" && method === "GET") {
      return [{ config_patch_jsonb: { "workOrders.slaHoursUrgent": 6 } }];
    }
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER, userId: "user-9" });
  const before = Date.now();
  const result = await call("POST", "/incidents/inc-1/work-orders", {});
  const after = Date.now();
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].source_type, "incident");
  assert.equal(insert.body[0].source_id, "inc-1");
  assert.equal(insert.body[0].priority, "high"); // severity high -> priority high
  assert.equal(insert.body[0].title, "Follow up: INC-1");
  assert.equal(insert.body[0].description, "Deck mat missing");
  assert.equal(insert.body[0].status, "open");
  assert.equal(insert.body[0].created_by, "user-9");
  assert.ok(insert.body[0].due_at, "due_at should be derived when absent");
  const dueAtMs = new Date(insert.body[0].due_at).getTime();
  assert.ok(dueAtMs >= before + 6 * 60 * 60 * 1000, "due_at should be at least now+6h (configured SLA)");
  assert.ok(dueAtMs <= after + 6 * 60 * 60 * 1000, "due_at should not exceed now+6h by more than call latency");
});

test("POST incidents/:id/work-orders denies a caller with only incidents.read (403)", async (t) => {
  stubFetch(t, (table, method) => stubIncident(table, method) ?? []);
  const { call } = mount({ memberships: INCIDENT_READ_ONLY });
  const result = await call("POST", "/incidents/inc-1/work-orders", {});
  assert.equal(result.status, 403);
});

test("POST incidents/:id/work-orders denies a caller with only work_orders.manage (403)", async (t) => {
  stubFetch(t, (table, method) => stubIncident(table, method) ?? []);
  const { call } = mount({ memberships: WO_MANAGE_ONLY });
  const result = await call("POST", "/incidents/inc-1/work-orders", {});
  assert.equal(result.status, 403);
});

test("POST incidents/:id/work-orders 404s on an unknown incident", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/nope/work-orders", {});
  assert.equal(result.status, 404);
});

test("POST incidents/:id/work-orders inherits facility_id from the incident, never the body", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    const incident = stubIncident(table, method);
    if (incident) return incident;
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", { facility_id: "fac-evil" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
});

test("POST incidents/:id/work-orders rejects an invalid dueAt override with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", { dueAt: "not-a-date" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST incidents/:id/work-orders rejects a blank title override with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", { title: "   " });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST incidents/:id/work-orders honors title/description/assignee/dueAt overrides when valid", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    const incident = stubIncident(table, method);
    if (incident) return incident;
    if (table === "modules" && method === "GET") return [{ id: "mod-wo", code: "work_orders" }];
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "employees" && method === "GET") return [{ id: "emp-3", facility_id: "fac-1" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", {
    title: "Custom title",
    description: "Custom description",
    assignee: "emp-3",
    dueAt: "2026-09-01T00:00:00Z"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].title, "Custom title");
  assert.equal(insert.body[0].description, "Custom description");
  assert.equal(insert.body[0].assigned_to_employee_id, "emp-3");
  assert.equal(insert.body[0].due_at, "2026-09-01T00:00:00Z");
});

// --- WO-09: input hardening -------------------------------------------------

test("POST work-orders rejects an unknown priority with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "critical"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST work-orders rejects an unknown source_type with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    source_type: "bogus"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST work-orders ignores a body-supplied facility_id, always using the path facility", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    facility_id: "fac-evil"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
});

test("POST work-orders rejects a cross-facility asset_id with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "GET") return [{ id: "asset-1", facility_id: "fac-2" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    asset_id: "asset-1"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /asset_id/);
  assert.ok(!captured.some((c) => c.table === "work_orders"), "must not attempt the insert");
});

test("POST work-orders 404s on a nonexistent asset_id, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "GET") return [];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    asset_id: "asset-nope"
  });
  assert.equal(result.status, 404);
  assert.ok(!captured.some((c) => c.table === "work_orders"), "must not attempt the insert");
});

test("POST work-orders rejects a cross-facility department_id with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "departments" && method === "GET") return [{ id: "dept-1", facility_id: "fac-2" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    department_id: "dept-1"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /department_id/);
  assert.ok(!captured.some((c) => c.table === "work_orders"), "must not attempt the insert");
});

test("POST work-orders rejects a cross-facility assigned_to_employee_id with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-9", facility_id: "fac-2" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    assigned_to_employee_id: "emp-9"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /assigned_to_employee_id/);
  assert.ok(!captured.some((c) => c.table === "work_orders"), "must not attempt the insert");
});

test("PATCH work-order rejects a cross-facility assigned_to_employee_id with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") return [{ id: "wo-1", facility_id: "fac-1" }];
    if (table === "employees" && method === "GET") return [{ id: "emp-9", facility_id: "fac-2" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { assigned_to_employee_id: "emp-9" });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /assigned_to_employee_id/);
  assert.ok(!captured.some((c) => c.table === "work_orders" && c.method === "PATCH"), "must not attempt the update");
});

// --- WO-15: SLA fields (server-derived sla_due_at, rejected client writes,
// first_response_at stamping, list filter) ----------------------------------

test("POST work-orders derives sla_due_at from the resolved workOrders SLA config, ignoring due_at", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "modules" && method === "GET") return [{ id: "mod-wo", code: "work_orders" }];
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "organization_module_settings" && method === "GET") return [];
    if (table === "facility_module_overrides" && method === "GET") {
      return [{ config_patch_jsonb: { "workOrders.slaHoursUrgent": 6 } }];
    }
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const before = Date.now();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    due_at: "2099-01-01T00:00:00Z"
  });
  const after = Date.now();
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].due_at, "2099-01-01T00:00:00Z"); // client's human target, untouched
  // M-1: sla_due_at is no longer part of the INSERT body -- 0060's DB
  // trigger rejects an authenticated write to it. It is stamped via the
  // service-role RPC right after the insert instead.
  assert.equal(insert.body[0].sla_due_at, undefined);
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call stamping sla_due_at");
  assert.equal(rpc.body.p_work_order_id, "wo-1");
  assert.ok(rpc.body.p_fields.sla_due_at, "sla_due_at should be set");
  const slaDueAtMs = new Date(rpc.body.p_fields.sla_due_at).getTime();
  assert.ok(slaDueAtMs >= before + 6 * 60 * 60 * 1000);
  assert.ok(slaDueAtMs <= after + 6 * 60 * 60 * 1000);
});

test("POST work-orders rejects a client-supplied sla_due_at with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/work-orders", {
    title: "Fix leak",
    description: "Water leak in basement",
    priority: "high",
    sla_due_at: "2026-01-01T00:00:00Z"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.errors[0], /sla_due_at/);
  assert.equal(captured.length, 0);
});

test("POST work-orders rejects client-supplied sla_breached_at/first_response_at/resolved_at with 400", async (t) => {
  const { call } = mount();
  for (const field of ["sla_breached_at", "first_response_at", "resolved_at"]) {
    const result = await call("POST", "/facilities/fac-1/work-orders", {
      title: "Fix leak",
      description: "Water leak in basement",
      priority: "high",
      [field]: "2026-01-01T00:00:00Z"
    });
    assert.equal(result.status, 400, `expected 400 for field ${field}`);
    assert.match(result.payload.errors[0], new RegExp(field));
  }
});

test("POST incidents/:id/work-orders derives sla_due_at from config even when dueAt is overridden", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    const incident = stubIncident(table, method, { severity: "high" });
    if (incident) return incident;
    if (table === "modules" && method === "GET") return [{ id: "mod-wo", code: "work_orders" }];
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "organization_module_settings" && method === "GET") return [];
    if (table === "facility_module_overrides" && method === "GET") return [];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", { dueAt: "2099-06-01T00:00:00Z" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(insert.body[0].due_at, "2099-06-01T00:00:00Z");
  // M-1: sla_due_at is stamped via the service-role RPC, not the INSERT.
  assert.equal(insert.body[0].sla_due_at, undefined);
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call");
  assert.notEqual(rpc.body.p_fields.sla_due_at, "2099-06-01T00:00:00Z");
  assert.ok(rpc.body.p_fields.sla_due_at, "sla_due_at should still be set from config");
});

test("POST incidents/:id/work-orders rejects a client-supplied sla_due_at with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", { sla_due_at: "2026-01-01T00:00:00Z" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH work-order rejects a client-supplied sla_breached_at with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { sla_breached_at: "2026-01-01T00:00:00Z" });
  assert.equal(result.status, 400);
  assert.match(result.payload.errors[0], /sla_breached_at/);
  assert.equal(captured.length, 0);
});

test("PATCH work-order rejects sla_due_at/first_response_at/resolved_at in the body with 400", async (t) => {
  const { call } = mount();
  for (const field of ["sla_due_at", "first_response_at", "resolved_at"]) {
    const result = await call("PATCH", "/work-orders/wo-1", { [field]: "2026-01-01T00:00:00Z" });
    assert.equal(result.status, 400, `expected 400 for field ${field}`);
  }
});

test("PATCH work-order stamps first_response_at on the first status change off open", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "open", first_response_at: null }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "in_progress" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 200);
  // M-1: first_response_at/resolved_at are stamped via the service-role RPC,
  // not the primary work_orders PATCH.
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.first_response_at, undefined);
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call");
  assert.equal(rpc.body.p_work_order_id, "wo-1");
  assert.ok(rpc.body.p_fields.first_response_at, "first_response_at should be stamped");
});

test("PATCH work-order does not re-stamp first_response_at once already set", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [
        {
          id: "wo-1",
          facility_id: "fac-1",
          status: "open",
          first_response_at: "2026-01-01T00:00:00Z"
        }
      ];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "in_progress" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.first_response_at, undefined);
  // M-1: the RPC call still fires (resolved_at is always part of a status
  // change's slaPatch), but must NOT carry a first_response_at key since it
  // was already set.
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call for resolved_at");
  assert.equal(rpc.body.p_fields.first_response_at, undefined);
});

test("PATCH work-order stamps resolved_at on entering resolved and preserves it through resolved -> closed", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", status: "in_progress", priority: "medium" }];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "resolved" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "resolved" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.resolved_at, undefined);
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call");
  assert.ok(rpc.body.p_fields.resolved_at, "resolved_at should be stamped on resolve");
});

test("PATCH work-order clears resolved_at when reopening", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [
        { id: "wo-1", facility_id: "fac-1", status: "resolved", resolved_at: "2026-01-01T00:00:00Z" }
      ];
    }
    if (table === "work_orders" && method === "PATCH") return [{ id: "wo-1", status: "in_progress" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/work-orders/wo-1", { status: "in_progress" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.equal(patch.body.resolved_at, undefined);
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call");
  assert.equal(rpc.body.p_fields.resolved_at, null, "resolved_at should be explicitly cleared, not merely omitted");
});

test("POST work-order updates stamps first_response_at on the first comment", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", first_response_at: null }];
    }
    if (table === "work_order_updates" && method === "POST") {
      return [{ id: "u-1", update_type: "comment", body: "hi" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/work-orders/wo-1/updates", { body: "hi" });
  assert.equal(result.status, 201);
  // M-1: the stamp now goes through the service-role RPC, not a direct
  // work_orders PATCH under the caller's own client.
  assert.ok(!captured.some((c) => c.table === "work_orders" && c.method === "PATCH"));
  const rpc = findSlaRpc(captured);
  assert.ok(rpc, "expected a set_work_order_sla_fields RPC call stamping first_response_at");
  assert.equal(rpc.body.p_work_order_id, "wo-1");
  assert.ok(rpc.body.p_fields.first_response_at);
});

// M-1: 503s BEFORE posting the comment when a first_response_at stamp will
// be needed and no service-role client is available -- never post the
// comment and then discover the stamp can't be applied.
test("POST work-order updates 503s and posts nothing when a stamp is needed but SUPABASE_SERVICE_ROLE_KEY is not configured", async (t) => {
  const captured = stubFetch(t, (table, method) =>
    table === "work_orders" && method === "GET" ? [{ id: "wo-1", facility_id: "fac-1", first_response_at: null }] : []
  );
  const { call } = mount();
  const result = await call(
    "POST",
    "/work-orders/wo-1/updates",
    { body: "hi" },
    { env: { SUPABASE_URL: "https://example.supabase.co" } }
  );
  assert.equal(result.status, 503);
  assert.ok(!captured.some((c) => c.table === "work_order_updates" && c.method === "POST"));
});

test("POST work-order updates succeeds with no service-role client when first_response_at is already set", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", first_response_at: "2026-01-01T00:00:00Z" }];
    }
    if (table === "work_order_updates" && method === "POST") return [{ id: "u-1", update_type: "comment", body: "hi" }];
    return [];
  });
  const { call } = mount();
  const result = await call(
    "POST",
    "/work-orders/wo-1/updates",
    { body: "hi" },
    { env: { SUPABASE_URL: "https://example.supabase.co" } }
  );
  assert.equal(result.status, 201);
  assert.ok(captured.some((c) => c.table === "work_order_updates" && c.method === "POST"));
});

test("POST work-order updates does not re-stamp first_response_at once already set", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "work_orders" && method === "GET") {
      return [{ id: "wo-1", facility_id: "fac-1", first_response_at: "2026-01-01T00:00:00Z" }];
    }
    if (table === "work_order_updates" && method === "POST") {
      return [{ id: "u-1", update_type: "comment", body: "hi" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/work-orders/wo-1/updates", { body: "hi" });
  assert.equal(result.status, 201);
  assert.ok(!captured.some((c) => c.table === "work_orders" && c.method === "PATCH"));
});

test("GET work-order by id exposes an sla state alongside the row", async (t) => {
  stubFetch(t, (table) =>
    table === "work_orders"
      ? [{ id: "wo-1", facility_id: "fac-1", sla_due_at: "2099-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" }]
      : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/work-orders/wo-1");
  assert.equal(result.status, 200);
  assert.ok(result.payload.sla, "expected an sla object on the detail response");
  assert.equal(result.payload.sla.state, "on_track");
});

test("GET work-orders exposes sla on every listed row", async (t) => {
  stubFetch(t, (table) =>
    table === "work_orders" ? [{ id: "wo-1", facility_id: "fac-1", sla_due_at: null }] : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload[0].sla, { state: "on_track", dueAt: null, remainingHours: null });
});

test("GET work-orders?sla=breached filters on the durable sla_breached_at stamp via SQL", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/work-orders?sla=breached");
  const get = captured.find((c) => c.table === "work_orders");
  assert.equal(get.url.searchParams.get("sla_breached_at"), "not.is.null");
});

test("GET work-orders?sla=at_risk over-fetches candidates and filters/paginates in JS", async (t) => {
  const now = new Date();
  const past = new Date(now.getTime() - 1000).toISOString(); // already breached window edge case guard
  const atRisk = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(); // 2h out, under the 4h floor
  const onTrack = new Date(now.getTime() + 30 * 60 * 60 * 1000).toISOString(); // 30h out
  const captured = stubFetch(t, (table) =>
    table === "work_orders"
      ? [
          { id: "wo-risk", facility_id: "fac-1", status: "open", sla_due_at: atRisk, created_at: past },
          { id: "wo-safe", facility_id: "fac-1", status: "open", sla_due_at: onTrack, created_at: past }
        ]
      : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?sla=at_risk");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "wo-risk");
  const get = captured.find((c) => c.table === "work_orders");
  assert.equal(get.url.searchParams.get("sla_breached_at"), "is.null");
  assert.equal(get.url.searchParams.get("sla_due_at"), "not.is.null");
  assert.match(get.url.search, /status=in\.%28open%2Cin_progress%2Con_hold%29|status=in\.\(open,in_progress,on_hold\)/);
});

test("GET work-orders?sla=bogus 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/work-orders?sla=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST incidents/:id/work-orders rejects a cross-facility assignee override with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    const incident = stubIncident(table, method);
    if (incident) return incident;
    if (table === "employees" && method === "GET") return [{ id: "emp-9", facility_id: "fac-other" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount({ memberships: INCIDENT_AND_WO_MANAGER });
  const result = await call("POST", "/incidents/inc-1/work-orders", { assignee: "emp-9" });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /assigned_to_employee_id/);
  assert.ok(!captured.some((c) => c.table === "work_orders"), "must not attempt the insert");
});
