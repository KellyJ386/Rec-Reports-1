import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerFormsRoutes } from "../src/lib/http/forms-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.template.manage"] }];
const MEMBER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["reports.template.manage"] }];

const VALID_SCHEMA = {
  sections: [{ title: "Fields", fields: [{ key: "k1", label: "K1", type: "text", required: true }] }]
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
  registerFormsRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET custom-fields denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/custom-fields");
  assert.equal(result.status, 403);
});

test("GET custom-fields allows a plain member (read is not manage-gated)", async (t) => {
  stubFetch(t, () => [{ id: "cf-1" }]);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("GET", "/facilities/fac-1/custom-fields");
  assert.equal(result.status, 200);
});

test("POST custom-fields validates before guarding (400 on bad input)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/custom-fields", { key: "Bad Key", label: "x", dataType: "text" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST custom-fields denies a member without reports.template.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/custom-fields", {
    key: "pool_ready",
    label: "Pool ready",
    dataType: "select"
  });
  assert.equal(result.status, 403);
});

test("POST custom-fields happy path inserts the shaped row", async (t) => {
  const captured = stubFetch(t, () => [{ id: "cf-1" }]);
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/custom-fields", {
    key: "pool_ready",
    label: "Pool ready",
    dataType: "select"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "custom_fields" && c.method === "POST");
  assert.equal(insert.body[0].key, "pool_ready");
  assert.equal(insert.body[0].data_type, "select");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].created_by, "user-9");
});

test("POST forms creates a draft at version = max(existing) + 1", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "form_definitions" && method === "GET") return [{ version_no: 1 }, { version_no: 2 }];
    if (table === "form_definitions" && method === "POST") return [{ id: "f-3", version_no: 3 }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/forms", {
    moduleCode: "daily_reports",
    formCode: "opening",
    schema: VALID_SCHEMA
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "form_definitions" && c.method === "POST");
  assert.equal(insert.body[0].version_no, 3);
  assert.equal(insert.body[0].status, "draft");
});

test("POST forms rejects an invalid schema with 400 before any write", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/forms", {
    moduleCode: "daily_reports",
    formCode: "opening",
    schema: { sections: [] }
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST forms/:id/publish publishes the draft and retires published siblings", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "form_definitions" && method === "GET") {
      // The publish handler first loads the target by id, then loads siblings.
      if (url.searchParams.get("id") === "eq.f-3") {
        return [{ id: "f-3", facility_id: "fac-1", form_code: "opening", status: "draft" }];
      }
      // siblings query (facility + form_code + status=published)
      return [{ id: "f-1", facility_id: "fac-1", form_code: "opening", status: "published" }];
    }
    if (table === "form_definitions" && method === "PATCH") {
      return [{ id: url.searchParams.get("id"), status: "updated" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/forms/f-3/publish");
  assert.equal(result.status, 200);
  const patches = captured.filter((c) => c.table === "form_definitions" && c.method === "PATCH");
  const retire = patches.find((c) => c.url.searchParams.get("id") === "eq.f-1");
  const publish = patches.find((c) => c.url.searchParams.get("id") === "eq.f-3");
  assert.ok(retire);
  assert.deepEqual(retire.body, { status: "retired" });
  assert.ok(publish);
  assert.deepEqual(publish.body, { status: "published" });
});

test("POST forms/:id/publish 404s when the form is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/forms/missing/publish");
  assert.equal(result.status, 404);
});
