import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAdminRoutes } from "../src/lib/http/admin-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const ADMIN_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["admin.manage"] }];
const READER_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];

// Programmable fetch stub in the style of test/supabase-rest.test.mjs. `respond`
// receives (table, method, url) and returns the rows the PostgREST call yields.
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

// Mounts the admin routes with stubbed auth/response primitives and drives one
// request through the matched handler. Returns the captured sendJson call and
// the captured fetch calls.
function mount({ memberships = ADMIN_ON_FAC1, respond = () => [], env = {} } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({
    claims: { sub: "user-1" },
    client,
    memberships,
    error: null
  });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerAdminRoutes(router, { authenticate, sendJson, readBody });

  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env, params });
    return sent[sent.length - 1];
  }

  return { call, sent, respond };
}

test("GET /config returns the Supabase URL and anon key from env", async () => {
  const { call } = mount({
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-key" }
  });
  const result = await call("GET", "/config");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key"
  });
});

test("GET /config returns 503 when the Supabase env is not configured", async () => {
  const { call } = mount({ env: {} });
  const result = await call("GET", "/config");
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /not available/);
});

test("GET /config requires no authentication and touches no DB", async (t) => {
  const captured = stubFetch(t, () => []);
  const router = createRouter();
  const sent = [];
  registerAdminRoutes(router, {
    authenticate: async () => ({ error: { status: 401, body: { error: "no token" } } }),
    sendJson: (response, status, payload) => sent.push({ status, payload }),
    readBody: async () => "{}"
  });
  const { handler, params } = router.match({ method: "GET", url: "/config" });
  assert.ok(handler, "no route matched GET /config");
  await handler(
    {},
    {},
    { env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-key" }, params }
  );
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].payload.supabaseAnonKey, "anon-key");
  assert.equal(captured.length, 0, "GET /config must not touch the database");
});

test("GET /me returns the user id and their memberships", async () => {
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("GET", "/me");
  assert.equal(result.status, 200);
  assert.equal(result.payload.userId, "user-1");
  assert.deepEqual(result.payload.memberships, [
    { facilityId: "fac-1", departmentId: null, status: "active", permissions: ["admin.manage"] }
  ]);
});

test("PUT module-overrides denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("PUT", "/facilities/fac-1/module-overrides/mod-1", { enabled: true });
  assert.equal(result.status, 403);
  assert.match(result.payload.error, /admin\.manage/);
});

test("PUT module-overrides rejects an invalid payload with 400 before any guard", async () => {
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PUT", "/facilities/fac-1/module-overrides/mod-1", { enabled: "yes" });
  assert.equal(result.status, 400);
  assert.ok(Array.isArray(result.payload.errors));
});

test("PUT module-overrides happy path writes the right table and payload", async (t) => {
  const captured = stubFetch(t, () => [{ id: "override-1" }]);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PUT", "/facilities/fac-1/module-overrides/mod-1", {
    enabled: true,
    configPatch: { threshold: 5 }
  });
  assert.equal(result.status, 200);
  const write = captured.find((c) => c.table === "facility_module_overrides" && c.method === "POST");
  assert.ok(write, "expected an insert into facility_module_overrides");
  assert.deepEqual(write.body, [
    {
      facility_id: "fac-1",
      module_id: "mod-1",
      enabled: true,
      config_patch_jsonb: { threshold: 5 },
      updated_by: "user-1"
    }
  ]);
  assert.equal(write.url.searchParams.get("on_conflict"), "facility_id,module_id");
});

test("POST facilities denies when the caller is not an org admin", async (t) => {
  stubFetch(t, (table) => (table === "facilities" ? [{ id: "fac-9" }] : []));
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/org/org-1/facilities", {
    name: "New Rink",
    timezone: "America/New_York"
  });
  assert.equal(result.status, 403);
});

test("POST facilities rejects a missing name with 400 (no DB call)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/org/org-1/facilities", { timezone: "America/New_York" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST facilities happy path inserts into facilities for an org admin", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "facilities" && method === "GET") return [{ id: "fac-1" }];
    if (table === "facilities" && method === "POST") return [{ id: "fac-new", name: "New Rink" }];
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/org/org-1/facilities", {
    name: "New Rink",
    timezone: "America/Chicago"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "facilities" && c.method === "POST");
  assert.deepEqual(insert.body, [
    { organization_id: "org-1", name: "New Rink", timezone: "America/Chicago" }
  ]);
});

test("PATCH department resolves the facility, guards on it, and updates by id", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "departments" && method === "GET") return [{ id: "dep-1", facility_id: "fac-1" }];
    if (table === "departments" && method === "PATCH") return [{ id: "dep-1", name: "Ops" }];
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/departments/dep-1", { name: "Ops" });
  assert.equal(result.status, 200);
  const update = captured.find((c) => c.table === "departments" && c.method === "PATCH");
  assert.deepEqual(update.body, { name: "Ops" });
  assert.equal(update.url.searchParams.get("id"), "eq.dep-1");
});

test("PATCH department 404s when the department does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/departments/missing", { name: "Ops" });
  assert.equal(result.status, 404);
});

test("PATCH department denies a non-admin on the resolved facility", async (t) => {
  stubFetch(t, (table, method) =>
    table === "departments" && method === "GET" ? [{ id: "dep-1", facility_id: "fac-1" }] : []
  );
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("PATCH", "/departments/dep-1", { name: "Ops" });
  assert.equal(result.status, 403);
});

test("PATCH facility settings merges the patch onto the current settings_jsonb and inserts a new version", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "facility_settings" && method === "GET") {
      return [{ id: "fs-1", settings_jsonb: { locale: "en-US" }, version: 1 }];
    }
    if (table === "facility_settings" && method === "POST") {
      return [{ id: "fs-2", version: 2 }];
    }
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/settings", {
    settingsPatch: { reporting: { dailyReportDueHour: 9 } }
  });
  assert.equal(result.status, 200);
  // The latest version is never updated in place -- a new row is inserted at
  // version = latest + 1, so facility_settings history stays immutable.
  assert.ok(
    !captured.some((c) => c.table === "facility_settings" && c.method === "PATCH"),
    "facility_settings must never be updated in place"
  );
  const insert = captured.find((c) => c.table === "facility_settings" && c.method === "POST");
  assert.ok(insert, "expected an insert into facility_settings");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].version, 2);
  assert.deepEqual(insert.body[0].settings_jsonb, {
    locale: "en-US",
    reporting: { dailyReportDueHour: 9 }
  });
  assert.equal(insert.body[0].published_by, "user-1");
  assert.ok(insert.body[0].published_at, "expected published_at to be stamped");
});

test("PATCH facility settings rejects an invalid patch with 400", async () => {
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/settings", {
    settingsPatch: { reporting: { dailyReportDueHour: 99 } }
  });
  assert.equal(result.status, 400);
});

test("POST department happy path inserts into departments", async (t) => {
  const captured = stubFetch(t, () => [{ id: "dep-new", name: "Maintenance" }]);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("POST", "/facilities/fac-1/departments", { name: "Maintenance" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "departments" && c.method === "POST");
  assert.deepEqual(insert.body, [{ facility_id: "fac-1", name: "Maintenance" }]);
});

// --- Settings registry + per-module config -------------------------------

test("GET /settings-registry returns the definitions to any authenticated user", async () => {
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/settings-registry");
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.payload.definitions));
  assert.ok(result.payload.definitions.some((d) => d.key === "scheduling.certEnforcementMode"));
});

test("GET module config resolves per-key value + source from org and facility layers", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "modules" && method === "GET") return [{ id: "mod-sched", code: "scheduling" }];
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "organization_module_settings" && method === "GET") {
      return [{ config_jsonb: { "scheduling.publishCadenceDays": 14 } }];
    }
    if (table === "facility_module_overrides" && method === "GET") {
      return [{ config_patch_jsonb: { "scheduling.certEnforcementMode": "warning" } }];
    }
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/modules/scheduling/config");
  assert.equal(result.status, 200);
  assert.equal(result.payload.moduleCode, "scheduling");
  assert.deepEqual(result.payload.settings["scheduling.certEnforcementMode"], {
    value: "warning",
    source: "facility"
  });
  assert.deepEqual(result.payload.settings["scheduling.publishCadenceDays"], {
    value: 14,
    source: "organization"
  });
  assert.deepEqual(result.payload.settings["scheduling.conflictCheckEnabled"], {
    value: true,
    source: "default"
  });
});

test("GET module config denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/modules/scheduling/config");
  assert.equal(result.status, 403);
});

test("PATCH module config rejects an unknown key with 400 before any DB call", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/modules/scheduling/config", {
    settings: { "scheduling.bogusKey": 1 }
  });
  assert.equal(result.status, 400);
  assert.ok(Array.isArray(result.payload.errors));
  assert.equal(captured.length, 0);
});

test("PATCH module config rejects an invalid value with 400", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/modules/scheduling/config", {
    settings: { "scheduling.certEnforcementMode": "soft" }
  });
  assert.equal(result.status, 400);
});

test("PATCH module config denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/modules/scheduling/config", {
    settings: { "scheduling.certEnforcementMode": "warning" }
  });
  assert.equal(result.status, 403);
});

test("PATCH module config merges the validated patch into config_patch_jsonb", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "modules" && method === "GET") return [{ id: "mod-sched", code: "scheduling" }];
    if (table === "facility_module_overrides" && method === "GET") {
      return [{ config_patch_jsonb: { "scheduling.publishCadenceDays": 14 } }];
    }
    if (table === "facility_module_overrides" && method === "POST") {
      return [{ id: "ovr-1" }];
    }
    return [];
  });
  const { call } = mount({ memberships: ADMIN_ON_FAC1 });
  const result = await call("PATCH", "/facilities/fac-1/modules/scheduling/config", {
    settings: { "scheduling.certEnforcementMode": "warning" }
  });
  assert.equal(result.status, 200);
  const write = captured.find((c) => c.table === "facility_module_overrides" && c.method === "POST");
  assert.ok(write, "expected an upsert into facility_module_overrides");
  assert.deepEqual(write.body, [
    {
      facility_id: "fac-1",
      module_id: "mod-sched",
      config_patch_jsonb: {
        "scheduling.publishCadenceDays": 14,
        "scheduling.certEnforcementMode": "warning"
      },
      updated_by: "user-1"
    }
  ]);
  assert.equal(write.url.searchParams.get("on_conflict"), "facility_id,module_id");
  assert.deepEqual(result.payload.settings["scheduling.certEnforcementMode"], {
    value: "warning",
    source: "facility"
  });
});
