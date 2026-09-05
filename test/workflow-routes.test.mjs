import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerWorkflowRoutes } from "../src/lib/http/workflow-routes.mjs";
import { registerAdminRoutes } from "../src/lib/http/admin-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const ADMIN_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["admin.manage"] }];
const READER_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const INCIDENT_READER_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];

// Programmable fetch stub, matching test/admin-routes.test.mjs / test/audit-routes.test.mjs.
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

function mount({ memberships = ADMIN_ON_FAC1, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerWorkflowRoutes(router, { authenticate, sendJson, readBody });

  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }

  return { call, sent };
}

function mountAdmin({ memberships = ADMIN_ON_FAC1, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
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

// --- POST .../change-requests ------------------------------------------------

test("POST .../change-requests rejects an invalid body with 400 before any guard", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/change-requests", { changeSummary: "" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST .../change-requests denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/change-requests", {
    entityTable: "branding_profiles",
    changeSummary: "Update theme"
  });
  assert.equal(result.status, 403);
});

test("POST .../change-requests happy path inserts a draft row requested by the caller", async (t) => {
  const captured = stubFetch(t, () => [{ id: "cr-1", status: "draft" }]);
  const { call } = mount({ memberships: ADMIN_ON_FAC1, userId: "user-1" });
  const result = await call("POST", "/facilities/fac-1/change-requests", {
    entityTable: "branding_profiles",
    entityId: "bp-1",
    changeSummary: "Update theme colors",
    before: { primary: "#111111" },
    after: { primary: "#222222" }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "admin_change_requests" && c.method === "POST");
  assert.ok(insert);
  assert.deepEqual(insert.body, [
    {
      facility_id: "fac-1",
      entity_table: "branding_profiles",
      entity_id: "bp-1",
      change_summary: "Update theme colors",
      before_jsonb: { primary: "#111111" },
      after_jsonb: { primary: "#222222" },
      status: "draft",
      requested_by: "user-1"
    }
  ]);
});

// --- GET .../change-requests --------------------------------------------------

test("GET .../change-requests denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/change-requests");
  assert.equal(result.status, 403);
});

test("GET .../change-requests filters by status when given", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  await call("GET", "/facilities/fac-1/change-requests?status=pending_review");
  const read = captured.find((c) => c.table === "admin_change_requests" && c.method === "GET");
  assert.equal(read.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(read.url.searchParams.get("status"), "eq.pending_review");
});

// --- POST /change-requests/:id/:action ---------------------------------------

test("transition endpoints 404 when the change request does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/change-requests/missing/submit");
  assert.equal(result.status, 404);
});

test("transition endpoints deny a caller without admin.manage on the CR's facility", async (t) => {
  stubFetch(t, (table) =>
    table === "admin_change_requests" ? [{ id: "cr-1", facility_id: "fac-1", status: "draft" }] : []
  );
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("POST", "/change-requests/cr-1/submit");
  assert.equal(result.status, 403);
});

test("submit happy path moves draft -> pending_review", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "draft", requested_by: "user-1" }];
    }
    if (table === "admin_change_requests" && method === "PATCH") {
      return [{ id: "cr-1", status: "pending_review" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/change-requests/cr-1/submit");
  assert.equal(result.status, 200);
  const update = captured.find((c) => c.table === "admin_change_requests" && c.method === "PATCH");
  assert.deepEqual(update.body, { status: "pending_review" });
});

test("approve endpoint returns 409 on an illegal transition (draft cannot be approved)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "draft", requested_by: "user-1" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-2" });
  const result = await call("POST", "/change-requests/cr-1/approve");
  assert.equal(result.status, 409);
  assert.ok(result.payload.error);
  assert.ok(!captured.some((c) => c.table === "admin_change_requests" && c.method === "PATCH"));
});

test("approve endpoint returns 409 on self-approval", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "pending_review", requested_by: "user-1" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-1" });
  const result = await call("POST", "/change-requests/cr-1/approve");
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /self-approved/);
});

test("approve endpoint happy path stamps reviewed_by/reviewed_at for a different reviewer", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "pending_review", requested_by: "user-1" }];
    }
    if (table === "admin_change_requests" && method === "PATCH") {
      return [{ id: "cr-1", status: "approved" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-2" });
  const result = await call("POST", "/change-requests/cr-1/approve");
  assert.equal(result.status, 200);
  const update = captured.find((c) => c.table === "admin_change_requests" && c.method === "PATCH");
  assert.equal(update.body.status, "approved");
  assert.equal(update.body.reviewed_by, "user-2");
  assert.ok(update.body.reviewed_at);
});

test("publish endpoint 409s from a non-approved status and 200s from approved", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "pending_review", requested_by: "user-1" }];
    }
    return [];
  });
  const { call: callBad } = mount();
  const bad = await callBad("POST", "/change-requests/cr-1/publish");
  assert.equal(bad.status, 409);

  stubFetch(t, (table, method) => {
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "approved", requested_by: "user-1" }];
    }
    if (table === "admin_change_requests" && method === "PATCH") {
      return [{ id: "cr-1", status: "published" }];
    }
    return [];
  });
  const { call: callGood } = mount();
  const good = await callGood("POST", "/change-requests/cr-1/publish");
  assert.equal(good.status, 200);
});

// --- Branding ------------------------------------------------------------

test("GET .../branding denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/branding");
  assert.equal(result.status, 403);
});

test("GET .../branding returns the default (or most recent) profile", async (t) => {
  const captured = stubFetch(t, () => [{ id: "bp-1", is_default: true }]);
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/branding");
  assert.equal(result.status, 200);
  assert.equal(result.payload.id, "bp-1");
  const read = captured.find((c) => c.table === "branding_profiles" && c.method === "GET");
  assert.equal(read.url.searchParams.get("order"), "is_default.desc,updated_at.desc");
});

test("PATCH .../branding rejects an invalid patch with 400", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/facilities/fac-1/branding", { primaryColor: "not-a-color" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH .../branding denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/branding", { name: "N" });
  assert.equal(result.status, 403);
});

test("PATCH .../branding happy path upserts on (facility_id,name)", async (t) => {
  const captured = stubFetch(t, () => [{ id: "bp-1", name: "North Arena Default" }]);
  const { call } = mount({ userId: "user-1" });
  const result = await call("PATCH", "/facilities/fac-1/branding", {
    name: "North Arena Default",
    primaryColor: "#1c6dd0",
    accentColor: "#9ec5a9"
  });
  assert.equal(result.status, 200);
  const write = captured.find((c) => c.table === "branding_profiles" && c.method === "POST");
  assert.equal(write.url.searchParams.get("on_conflict"), "facility_id,name");
  assert.deepEqual(write.body, [
    {
      facility_id: "fac-1",
      name: "North Arena Default",
      theme_jsonb: { primary: "#1c6dd0", accent: "#9ec5a9" },
      updated_by: "user-1"
    }
  ]);
});

// --- Generic data export -------------------------------------------------

test("GET .../export/:table rejects a table outside the allow-list with 400", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/export/app_users");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET .../export/:table denies a caller lacking both the table code and admin.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/export/incident_reports");
  assert.equal(result.status, 403);
});

test("GET .../export/:table allows a caller with the table's own permission code (no admin.manage)", async (t) => {
  stubFetch(t, () => [{ id: "inc-1", facility_id: "fac-1" }]);
  const { call } = mount({ memberships: INCIDENT_READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/export/incident_reports");
  assert.equal(result.status, 200);
});

test("GET .../export/:table defaults to csv with a table-prefixed filename", async (t) => {
  stubFetch(t, () => [{ id: "wo-1", facility_id: "fac-1" }]);
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/export/work_orders");
  assert.equal(result.status, 200);
  assert.equal(result.payload.contentType, "text/csv");
  assert.match(result.payload.filename, /^work_orders-export-.+\.csv$/);
  assert.match(result.payload.contentDisposition, /^attachment; filename="work_orders-export-.+\.csv"$/);
});

test("GET .../export/:table honors format=json", async (t) => {
  const rows = [{ id: "wo-1" }];
  stubFetch(t, () => rows);
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/export/work_orders?format=json");
  assert.equal(result.payload.contentType, "application/json");
  assert.deepEqual(JSON.parse(result.payload.body), rows);
});

// --- Versioned facility_settings writes (admin-routes.mjs) -------------------
// Lives here rather than test/admin-routes.test.mjs because it's Phase 6
// behavior: PATCH .../settings must insert a new version row (never update
// the latest one in place), per the (facility_id, version) unique constraint.

test("PATCH facility settings inserts version = latest + 1 instead of updating in place", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "facility_settings" && method === "GET") {
      return [{ id: "fs-1", settings_jsonb: { locale: "en-US" }, version: 3 }];
    }
    if (table === "facility_settings" && method === "POST") {
      return [{ id: "fs-2", version: 4 }];
    }
    return [];
  });
  const { call } = mountAdmin({ userId: "user-9" });
  const result = await call("PATCH", "/facilities/fac-1/settings", {
    settingsPatch: { locale: "fr-FR" }
  });
  assert.equal(result.status, 200);
  assert.ok(!captured.some((c) => c.table === "facility_settings" && c.method === "PATCH"));
  const insert = captured.find((c) => c.table === "facility_settings" && c.method === "POST");
  assert.equal(insert.body[0].version, 4);
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].published_by, "user-9");
  assert.ok(insert.body[0].published_at);
});

test("PATCH facility settings inserts version 1 with no prior rows", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "facility_settings" && method === "GET") return [];
    if (table === "facility_settings" && method === "POST") return [{ id: "fs-1", version: 1 }];
    return [];
  });
  const { call } = mountAdmin();
  await call("PATCH", "/facilities/fac-1/settings", { settingsPatch: { locale: "en-US" } });
  const insert = captured.find((c) => c.table === "facility_settings" && c.method === "POST");
  assert.equal(insert.body[0].version, 1);
});
