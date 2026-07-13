import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAdminRoutes } from "../src/lib/http/admin-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const ADMIN_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["admin.manage"] }];
const READER_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];

// Programmable fetch stub mirroring test/admin-routes.test.mjs.
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

// Like the admin-routes mount but the request carries `url` so query-string
// endpoints (the access simulator) can read their params.
function mount({ memberships = ADMIN_ON_FAC1 } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: "user-1" }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerAdminRoutes(router, { authenticate, sendJson, readBody });

  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }

  return { call };
}

test("POST roles rejects an unknown permission code with 400 (no DB write)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/roles", {
    name: "Weird Role",
    permissionCodes: ["reports.read", "reports.destroy"]
  });
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors.some((e) => e.includes("reports.destroy")));
  assert.equal(captured.length, 0, "validation must precede any DB call");
});

test("POST roles denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/roles", {
    name: "Ops",
    permissionCodes: ["reports.read"]
  });
  assert.equal(result.status, 403);
  assert.match(result.payload.error, /admin\.manage/);
});

test("POST roles happy path writes roles and role_permissions", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "roles" && method === "POST") return [{ id: "role-9", facility_id: "fac-1", name: "Ops" }];
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/roles", {
    name: "Ops",
    permissionCodes: ["reports.read", "admin.manage"]
  });
  assert.equal(result.status, 201);
  const roleInsert = captured.find((c) => c.table === "roles" && c.method === "POST");
  assert.deepEqual(roleInsert.body, [{ facility_id: "fac-1", name: "Ops" }]);
  const permInsert = captured.find((c) => c.table === "role_permissions" && c.method === "POST");
  assert.deepEqual(permInsert.body, [
    { role_id: "role-9", permission_code: "reports.read" },
    { role_id: "role-9", permission_code: "admin.manage" }
  ]);
  assert.deepEqual(result.payload.permissionCodes, ["reports.read", "admin.manage"]);
});

test("GET roles maps embedded permission codes", async (t) => {
  stubFetch(t, (table) =>
    table === "roles"
      ? [
          {
            id: "role-1",
            facility_id: "fac-1",
            name: "Tenant Owner",
            is_system_role: true,
            active: true,
            role_permissions: [{ permission_code: "admin.manage" }, { permission_code: "reports.read" }]
          }
        ]
      : []
  );
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/roles");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload[0].permissionCodes, ["admin.manage", "reports.read"]);
  assert.equal(result.payload[0].isSystemRole, true);
});

test("PUT role permissions bulk-replaces via delete then insert", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "roles" && method === "GET") return [{ id: "role-1", facility_id: "fac-1", name: "Ops" }];
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PUT", "/roles/role-1/permissions", {
    permissionCodes: ["schedule.read", "schedule.manage"]
  });
  assert.equal(result.status, 200);
  const del = captured.find((c) => c.table === "role_permissions" && c.method === "DELETE");
  assert.ok(del, "expected a delete of the old role_permissions");
  assert.equal(del.url.searchParams.get("role_id"), "eq.role-1");
  const ins = captured.find((c) => c.table === "role_permissions" && c.method === "POST");
  assert.deepEqual(ins.body, [
    { role_id: "role-1", permission_code: "schedule.read" },
    { role_id: "role-1", permission_code: "schedule.manage" }
  ]);
  // The delete must be captured before the insert.
  assert.ok(captured.indexOf(del) < captured.indexOf(ins));
});

test("PUT role permissions rejects an unknown code with 400", async (t) => {
  stubFetch(t, (table, method) =>
    table === "roles" && method === "GET" ? [{ id: "role-1", facility_id: "fac-1", name: "Ops" }] : []
  );
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PUT", "/roles/role-1/permissions", { permissionCodes: ["nope.bad"] });
  assert.equal(result.status, 400);
});

test("PUT role permissions 404s for an unknown role", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PUT", "/roles/missing/permissions", { permissionCodes: [] });
  assert.equal(result.status, 404);
});

test("POST memberships writes the membership with a default status", async (t) => {
  const captured = stubFetch(t, () => [{ id: "mem-1" }]);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/memberships", {
    userId: "user-7",
    roleId: "role-1"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "memberships" && c.method === "POST");
  assert.deepEqual(insert.body, [
    { facility_id: "fac-1", user_id: "user-7", role_id: "role-1", status: "active", department_id: null }
  ]);
});

test("POST memberships rejects a missing userId with 400", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/memberships", { roleId: "role-1" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH membership resolves the facility, guards, and updates by id", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "memberships" && method === "GET") return [{ id: "mem-1", facility_id: "fac-1" }];
    if (table === "memberships" && method === "PATCH") return [{ id: "mem-1", status: "disabled" }];
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/memberships/mem-1", { status: "disabled" });
  assert.equal(result.status, 200);
  const update = captured.find((c) => c.table === "memberships" && c.method === "PATCH");
  assert.deepEqual(update.body, { status: "disabled" });
  assert.equal(update.url.searchParams.get("id"), "eq.mem-1");
});

test("PATCH membership denies a non-admin on the resolved facility", async (t) => {
  stubFetch(t, (table, method) =>
    table === "memberships" && method === "GET" ? [{ id: "mem-1", facility_id: "fac-1" }] : []
  );
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("PATCH", "/memberships/mem-1", { status: "disabled" });
  assert.equal(result.status, 403);
});

test("GET access-simulator returns a 16-row matrix reflecting the user's grants", async (t) => {
  stubFetch(t, (table) =>
    table === "memberships"
      ? [
          {
            id: "mem-1",
            facility_id: "fac-1",
            status: "active",
            role_id: "role-1",
            roles: { role_permissions: [{ permission_code: "reports.read" }, { permission_code: "admin.manage" }] }
          }
        ]
      : []
  );
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/access-simulator?userId=user-7");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 16);
  const readRow = result.payload.find((r) => r.permission === "reports.read");
  assert.deepEqual(readRow, { permission: "reports.read", allowed: true, reason: "granted" });
  const missingRow = result.payload.find((r) => r.permission === "training.manage");
  assert.deepEqual(missingRow, {
    permission: "training.manage",
    allowed: false,
    reason: "permission-missing"
  });
});

test("GET access-simulator requires a userId query param", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/access-simulator");
  assert.equal(result.status, 400);
});

test("GET access-simulator denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/access-simulator?userId=user-7");
  assert.equal(result.status, 403);
});
