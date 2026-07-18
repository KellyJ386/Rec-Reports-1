import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerReportRoutes } from "../src/lib/http/reports-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const CREATOR = [
  { facilityId: "fac-1", status: "active", permissions: ["reports.read", "reports.create", "reports.submit"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["reports.read", "reports.create"] }];

const SCHEMA = {
  sections: [
    {
      title: "Opening",
      fields: [
        { key: "supervisor", label: "Supervisor", type: "text", required: true },
        { key: "attendance", label: "Attendance", type: "number", required: true }
      ]
    }
  ]
};

const PUBLISHED_TEMPLATE = {
  id: "tpl-1",
  facility_id: "fac-1",
  department_id: null,
  code: "daily-open",
  name: "Daily Opening",
  status: "published",
  active_version: 3
};
const VERSION = { id: "ver-3", template_id: "tpl-1", version_number: 3, schema_json: SCHEMA, is_published: true };

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

function mount({ memberships = CREATOR, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerReportRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET report-templates denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/report-templates");
  assert.equal(result.status, 403);
});

test("GET report-templates returns published only by default", async (t) => {
  const captured = stubFetch(t, (table) => (table === "report_templates" ? [PUBLISHED_TEMPLATE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-templates");
  assert.equal(result.status, 200);
  const get = captured.find((c) => c.table === "report_templates");
  assert.match(get.url.search, /status=eq\.published/);
});

test("GET report-templates?status=all drops the published filter", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/report-templates?status=all");
  const get = captured.find((c) => c.table === "report_templates");
  assert.doesNotMatch(get.url.search, /status=eq/);
});

test("GET report-template by id includes the active version schema", async (t) => {
  stubFetch(t, (table) => {
    if (table === "report_templates") return [PUBLISHED_TEMPLATE];
    if (table === "report_template_versions") return [VERSION];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-templates/tpl-1");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.schema_json, SCHEMA);
  assert.equal(result.payload.active_version_id, "ver-3");
});

test("GET report-template by id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-templates/nope");
  assert.equal(result.status, 404);
});

test("POST reports validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports", { reportDate: "not-a-date" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST reports denies a reader without reports.create", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-1",
    reportDate: "2026-07-18"
  });
  assert.equal(result.status, 403);
});

test("POST reports 409s when the template is not published", async (t) => {
  stubFetch(t, (table) =>
    table === "report_templates" ? [{ ...PUBLISHED_TEMPLATE, status: "draft" }] : []
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-1",
    reportDate: "2026-07-18"
  });
  assert.equal(result.status, 409);
});

test("POST reports happy path inserts a draft with the resolved version", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates") return [PUBLISHED_TEMPLATE];
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submissions" && method === "POST") return [{ id: "sub-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-1",
    reportDate: "2026-07-18",
    payload: { supervisor: "Sam" }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_submissions" && c.method === "POST");
  assert.equal(insert.body[0].template_id, "tpl-1");
  assert.equal(insert.body[0].template_version_id, "ver-3");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.deepEqual(insert.body[0].payload_json, { supervisor: "Sam" });
});

test("PATCH report edits a draft's payload", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [{ id: "sub-1", facility_id: "fac-1", status: "draft" }];
    }
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/reports/sub-1", { payload: { supervisor: "Kim" } });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.deepEqual(patch.body.payload_json, { supervisor: "Kim" });
});

test("PATCH report refuses to edit a submitted report (409)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-1", status: "submitted" }]
      : []
  );
  const { call } = mount();
  const result = await call("PATCH", "/reports/sub-1", { payload: { supervisor: "Kim" } });
  assert.equal(result.status, 409);
});

test("POST submit 422s when required fields are missing", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam" }
        }
      ];
    }
    if (table === "report_template_versions") return [VERSION];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 422);
  assert.ok(result.payload.errors.some((e) => /Attendance/.test(e)));
});

test("POST submit finalizes a valid draft and stamps the submitter", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount({ userId: "user-7" });
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.status, "submitted");
  assert.equal(patch.body.submitted_by, "user-7");
  assert.ok(patch.body.submitted_at);
});

test("POST submit refuses a non-draft report (409)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-1", status: "submitted", template_version_id: "ver-3" }]
      : []
  );
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 409);
});
