// WO-12: the assets registry routes (GET/POST /facilities/:facilityId/assets,
// GET/PATCH /assets/:id, POST /assets/:id/retire) live in
// work-orders-routes.mjs alongside the work order routes (see that file's
// header comment above its asset route registrations for why), but get
// their own test file here rather than growing work-orders-routes.test.mjs
// further -- same "one test file per feature area" convention as e.g.
// incidents-people-routes vs incidents-routes.
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

// Like stubFetch, but the write matching (conflictTable, conflictMethod)
// returns a non-2xx 409 response (as PostgREST does for a unique_violation),
// so route-layer conflict handling can be exercised without a real DB.
// Mirrors training-routes.test.mjs's helper of the same name exactly.
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

// --- GET /facilities/:facilityId/assets -------------------------------------

test("GET assets denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/assets");
  assert.equal(result.status, 403);
});

test("GET assets returns assets for a reader, scoped to the facility", async (t) => {
  const captured = stubFetch(t, (table) =>
    table === "assets" ? [{ id: "asset-1", facility_id: "fac-1", name: "Pool Pump" }] : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/assets");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "assets");
  assert.match(get.url.search, /facility_id=eq\.fac-1/);
});

test("GET assets?status=retired filters by status", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/assets?status=retired");
  const get = captured.find((c) => c.table === "assets");
  assert.match(get.url.search, /status=eq\.retired/);
});

test("GET assets rejects an unknown status with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/assets?status=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET assets?category= filters by category", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/assets?category=mechanical");
  const get = captured.find((c) => c.table === "assets");
  assert.match(get.url.search, /category=eq\.mechanical/);
});

test("GET assets?q= builds an ilike or= filter over name and asset_tag", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/assets?q=pump");
  const get = captured.find((c) => c.table === "assets");
  assert.match(get.url.search, /or=%28name\.ilike\.\*pump\*%2Casset_tag\.ilike\.\*pump\*%29/);
});

test("GET assets?q= rejects a too-short query with 400 and zero fetches (same bound as search-routes.mjs)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/assets?q=a");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET assets?q= strips PostgREST-reserved characters before the length check", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  // "p,u()mp" sanitizes down to "pump" (4 chars, passes); the raw string
  // contains every character PostgREST's filter grammar reserves.
  await call("GET", "/facilities/fac-1/assets?q=p%2Cu()mp");
  const get = captured.find((c) => c.table === "assets");
  assert.match(get.url.search, /or=%28name\.ilike\.\*pump\*%2Casset_tag\.ilike\.\*pump\*%29/);
});

// --- POST /facilities/:facilityId/assets ------------------------------------

test("POST assets validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/assets", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST assets denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump" });
  assert.equal(result.status, 403);
});

test("POST assets happy path inserts a shaped row with defaults", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "POST") return [{ id: "asset-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "assets" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].name, "Pool Pump");
  assert.equal(insert.body[0].status, "active");
  assert.equal(insert.body[0].asset_tag, null);
  assert.deepEqual(insert.body[0].metadata, {});
});

test("POST assets accepts category, criticality, dates, and metadata", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "POST") return [{ id: "asset-1" }];
    return [];
  });
  const { call } = mount();
  await call("POST", "/facilities/fac-1/assets", {
    name: "Pool Pump",
    asset_tag: "PUMP-01",
    category: "mechanical",
    criticality: "high",
    install_date: "2024-01-15",
    warranty_expires_at: "2026-01-15",
    metadata: { manufacturer: "Acme" }
  });
  const insert = captured.find((c) => c.table === "assets" && c.method === "POST");
  assert.equal(insert.body[0].asset_tag, "PUMP-01");
  assert.equal(insert.body[0].category, "mechanical");
  assert.equal(insert.body[0].criticality, "high");
  assert.equal(insert.body[0].install_date, "2024-01-15");
  assert.equal(insert.body[0].warranty_expires_at, "2026-01-15");
  assert.deepEqual(insert.body[0].metadata, { manufacturer: "Acme" });
});

test("POST assets rejects an unknown criticality with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump", criticality: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST assets rejects a non-object metadata with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump", metadata: "not an object" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST assets 404s on a nonexistent department_id", async (t) => {
  stubFetch(t, (table) => (table === "departments" ? [] : []));
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump", department_id: "dept-x" });
  assert.equal(result.status, 404);
});

test("POST assets 400s on a cross-facility department_id", async (t) => {
  stubFetch(t, (table) => (table === "departments" ? [{ id: "dept-x", facility_id: "fac-2" }] : []));
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump", department_id: "dept-x" });
  assert.equal(result.status, 400);
});

test("POST assets returns 409 (not 500) on a duplicate (facility_id, asset_tag)", async (t) => {
  const captured = stubFetchWithConflict(t, "assets", "POST", () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/assets", { name: "Pool Pump", asset_tag: "PUMP-01" });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /already exists/);
  assert.equal(captured.filter((c) => c.table === "assets" && c.method === "POST").length, 1);
});

// --- GET /assets/:id ---------------------------------------------------------

test("GET asset by id returns the asset plus its open_work_order_count", async (t) => {
  stubFetch(t, (table) => {
    if (table === "assets") return [{ id: "asset-1", facility_id: "fac-1", name: "Pool Pump" }];
    if (table === "work_orders") return [{ id: "wo-1" }, { id: "wo-2" }];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/assets/asset-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.id, "asset-1");
  assert.equal(result.payload.open_work_order_count, 2);
});

test("GET asset by id filters the open-work-order count to OPEN_STATUSES", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "assets") return [{ id: "asset-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount({ memberships: READER });
  await call("GET", "/assets/asset-1");
  const woGet = captured.find((c) => c.table === "work_orders");
  assert.match(woGet.url.search, /asset_id=eq\.asset-1/);
  assert.match(woGet.url.search, /status=in\.%28open%2Cin_progress%2Con_hold%29/);
});

test("GET asset by id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/assets/nope");
  assert.equal(result.status, 404);
});

test("GET asset by id 403s a caller without work_orders.read on the asset's own facility", async (t) => {
  stubFetch(t, (table) => (table === "assets" ? [{ id: "asset-1", facility_id: "fac-1" }] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/assets/asset-1");
  assert.equal(result.status, 403);
});

// --- PATCH /assets/:id -------------------------------------------------------

test("PATCH asset updates fields and returns the open_work_order_count", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "GET") return [{ id: "asset-1", facility_id: "fac-1", status: "active" }];
    if (table === "assets" && method === "PATCH") return [{ id: "asset-1", name: "Renamed Pump", status: "active" }];
    if (table === "work_orders") return [];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/assets/asset-1", { name: "Renamed Pump", criticality: "medium" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.open_work_order_count, 0);
  const patch = captured.find((c) => c.table === "assets" && c.method === "PATCH");
  assert.equal(patch.body.name, "Renamed Pump");
  assert.equal(patch.body.criticality, "medium");
  assert.ok(patch.body.updated_at);
});

test("PATCH asset denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, (table) => (table === "assets" ? [{ id: "asset-1", facility_id: "fac-1" }] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/assets/asset-1", { name: "Renamed Pump" });
  assert.equal(result.status, 403);
});

test("PATCH asset 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/assets/nope", { name: "Renamed Pump" });
  assert.equal(result.status, 404);
});

test("PATCH asset rejects an empty patch with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/assets/asset-1", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH asset rejects an unknown status with 400 and zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/assets/asset-1", { status: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH asset returns 409 (not 500) on a duplicate (facility_id, asset_tag)", async (t) => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method });
    if (table === "assets" && method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "asset-1", facility_id: "fac-1" }]) };
    }
    if (table === "assets" && method === "PATCH") {
      return {
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" })
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount();
  const result = await call("PATCH", "/assets/asset-1", { asset_tag: "DUP-01" });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /already exists/);
});

// --- POST /assets/:id/retire -------------------------------------------------

test("POST asset retire sets status to retired and does not touch work_orders", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "GET") return [{ id: "asset-1", facility_id: "fac-1", status: "active" }];
    if (table === "assets" && method === "PATCH") return [{ id: "asset-1", status: "retired" }];
    if (table === "work_orders") return [{ id: "wo-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/assets/asset-1/retire");
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "retired");
  // Proves WO-12's "retire does not cascade-delete work orders" acceptance
  // criterion at the route layer: the only WRITE issued anywhere in this
  // request is the single `assets` PATCH -- work_orders is read (for the
  // count) but never written.
  const patch = captured.find((c) => c.table === "assets" && c.method === "PATCH");
  assert.equal(patch.body.status, "retired");
  assert.equal(captured.filter((c) => c.table === "work_orders").length, 1);
  assert.equal(captured.filter((c) => c.table === "work_orders" && c.method !== "GET").length, 0);
  assert.equal(result.payload.open_work_order_count, 1);
});

test("POST asset retire denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, (table) => (table === "assets" ? [{ id: "asset-1", facility_id: "fac-1", status: "active" }] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/assets/asset-1/retire");
  assert.equal(result.status, 403);
});

test("POST asset retire 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/assets/nope/retire");
  assert.equal(result.status, 404);
});

test("POST asset retire 409s an already-retired asset and issues no write", async (t) => {
  const captured = stubFetch(t, (table) => (table === "assets" ? [{ id: "asset-1", facility_id: "fac-1", status: "retired" }] : []));
  const { call } = mount();
  const result = await call("POST", "/assets/asset-1/retire");
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /already retired/);
  assert.equal(captured.filter((c) => c.method === "PATCH").length, 0);
});
