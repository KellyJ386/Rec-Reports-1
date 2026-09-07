import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerReportDistributionRoutes } from "../src/lib/http/report-distribution-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read", "reports.distribution.manage"] }];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["reports.read", "reports.distribution.manage"] }];

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body });
    const data = respond(table, method, parsed, body) ?? [];
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
  registerReportDistributionRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

// Every write test that reaches validateReferences needs report_templates/
// distribution_lists (and, when supplied, departments/roles) to resolve --
// this responder covers the "everything exists" happy path; individual
// tests override specific tables to exercise the 404 branches.
function existingReferences(table) {
  if (table === "report_templates") return [{ id: "tpl-1" }];
  if (table === "distribution_lists") return [{ id: "list-1" }];
  if (table === "departments") return [{ id: "dept-1" }];
  if (table === "roles") return [{ id: "role-1" }];
  return null;
}

// --- GET list ----------------------------------------------------------

test("GET report-distribution-lists denies a non-member of the facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/report-distribution-lists");
  assert.equal(result.status, 403);
});

test("GET report-distribution-lists returns the facility's bindings and filters by template_id", async (t) => {
  const captured = stubFetch(t, (table) =>
    table === "report_distribution_lists" ? [{ id: "bind-1", facility_id: "fac-1", template_id: "tpl-1" }] : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-distribution-lists?template_id=tpl-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "report_distribution_lists" && c.method === "GET");
  assert.equal(get.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(get.url.searchParams.get("template_id"), "eq.tpl-1");
  assert.equal(get.url.searchParams.get("deleted_at"), "is.null");
});

// --- POST create ---------------------------------------------------------

test("POST report-distribution-lists validates required fields before guarding", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/report-distribution-lists", { channel: "carrier-pigeon" });
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors.some((e) => e.includes("templateId")));
  assert.ok(result.payload.errors.some((e) => e.includes("distributionListId")));
  assert.ok(result.payload.errors.some((e) => e.includes("channel")));
  assert.equal(captured.length, 0);
});

test("POST report-distribution-lists denies a reader without reports.distribution.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/report-distribution-lists", {
    templateId: "tpl-1",
    distributionListId: "list-1",
    channel: "email"
  });
  assert.equal(result.status, 403);
});

test("POST report-distribution-lists 404s when the template does not exist in this facility", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "report_templates") return [];
    if (table === "distribution_lists") return [{ id: "list-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/report-distribution-lists", {
    templateId: "tpl-missing",
    distributionListId: "list-1",
    channel: "email"
  });
  assert.equal(result.status, 404);
  assert.match(result.payload.error, /report template not found/);
  assert.ok(!captured.some((c) => c.table === "report_distribution_lists" && c.method === "POST"));
});

test("POST report-distribution-lists 404s when the distribution list does not exist in this facility (cross-facility rejected)", async (t) => {
  stubFetch(t, (table) => {
    if (table === "report_templates") return [{ id: "tpl-1" }];
    if (table === "distribution_lists") return []; // belongs to another facility, or doesn't exist
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/report-distribution-lists", {
    templateId: "tpl-1",
    distributionListId: "list-cross-facility",
    channel: "email"
  });
  assert.equal(result.status, 404);
  assert.match(result.payload.error, /distribution list not found/);
});

test("POST report-distribution-lists happy path inserts the shaped row with defaults", async (t) => {
  const captured = stubFetch(t, (table) => {
    const existing = existingReferences(table);
    if (existing) return existing;
    if (table === "report_distribution_lists") return [{ id: "bind-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/report-distribution-lists", {
    templateId: "tpl-1",
    distributionListId: "list-1",
    channel: "email"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_distribution_lists" && c.method === "POST");
  assert.deepEqual(insert.body[0], {
    facility_id: "fac-1",
    template_id: "tpl-1",
    distribution_list_id: "list-1",
    department_id: null,
    role_id: null,
    channel: "email",
    attach_pdf: false,
    digest: false,
    active: true
  });
});

test("POST report-distribution-lists honors explicit department/role/attach_pdf/digest and validates them", async (t) => {
  const captured = stubFetch(t, (table) => {
    const existing = existingReferences(table);
    if (existing) return existing;
    if (table === "report_distribution_lists") return [{ id: "bind-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/report-distribution-lists", {
    templateId: "tpl-1",
    distributionListId: "list-1",
    departmentId: "dept-1",
    roleId: "role-1",
    channel: "push",
    attachPdf: true,
    digest: true
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_distribution_lists" && c.method === "POST");
  assert.equal(insert.body[0].department_id, "dept-1");
  assert.equal(insert.body[0].role_id, "role-1");
  assert.equal(insert.body[0].channel, "push");
  assert.equal(insert.body[0].attach_pdf, true);
  assert.equal(insert.body[0].digest, true);
});

// --- PATCH update ----------------------------------------------------------

test("PATCH report-distribution-lists/:id denies a reader without reports.distribution.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/report-distribution-lists/bind-1", { active: false });
  assert.equal(result.status, 403);
});

test("PATCH report-distribution-lists/:id 404s for an unknown binding", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/facilities/fac-1/report-distribution-lists/missing", { active: false });
  assert.equal(result.status, 404);
});

test("PATCH report-distribution-lists/:id rejects an empty patch with 400", async (t) => {
  stubFetch(t, (table) => (table === "report_distribution_lists" ? [{ id: "bind-1", facility_id: "fac-1" }] : []));
  const { call } = mount();
  const result = await call("PATCH", "/facilities/fac-1/report-distribution-lists/bind-1", {});
  assert.equal(result.status, 400);
  assert.equal(result.payload.error, "nothing to update");
});

test("PATCH report-distribution-lists/:id rejects an invalid channel", async (t) => {
  stubFetch(t, (table) => (table === "report_distribution_lists" ? [{ id: "bind-1", facility_id: "fac-1" }] : []));
  const { call } = mount();
  const result = await call("PATCH", "/facilities/fac-1/report-distribution-lists/bind-1", { channel: "carrier-pigeon" });
  assert.equal(result.status, 400);
});

test("PATCH report-distribution-lists/:id happy path updates fields and stamps updated_at", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "report_distribution_lists") {
      return [
        {
          id: "bind-1",
          facility_id: "fac-1",
          template_id: "tpl-1",
          distribution_list_id: "list-1",
          department_id: null,
          role_id: null,
          channel: "email",
          active: true
        }
      ];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/facilities/fac-1/report-distribution-lists/bind-1", {
    active: false,
    digest: true
  });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_distribution_lists" && c.method === "PATCH");
  assert.equal(patch.body.active, false);
  assert.equal(patch.body.digest, true);
  assert.ok(patch.body.updated_at);
});

test("PATCH report-distribution-lists/:id re-validates a new distribution_list_id and 404s if cross-facility", async (t) => {
  stubFetch(t, (table) => {
    if (table === "report_distribution_lists") {
      return [{ id: "bind-1", facility_id: "fac-1", template_id: "tpl-1", distribution_list_id: "list-1", channel: "email" }];
    }
    if (table === "distribution_lists") return []; // the new id doesn't belong to fac-1
    return [{ id: "tpl-1" }];
  });
  const { call } = mount();
  const result = await call("PATCH", "/facilities/fac-1/report-distribution-lists/bind-1", {
    distributionListId: "list-elsewhere"
  });
  assert.equal(result.status, 404);
  assert.match(result.payload.error, /distribution list not found/);
});

// --- DELETE (soft delete) ---------------------------------------------------

test("DELETE report-distribution-lists/:id denies a reader without reports.distribution.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("DELETE", "/facilities/fac-1/report-distribution-lists/bind-1");
  assert.equal(result.status, 403);
});

test("DELETE report-distribution-lists/:id 404s for an unknown binding", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("DELETE", "/facilities/fac-1/report-distribution-lists/missing");
  assert.equal(result.status, 404);
});

test("DELETE report-distribution-lists/:id soft-deletes (sets deleted_at/active=false), never a hard delete", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "report_distribution_lists") return [{ id: "bind-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("DELETE", "/facilities/fac-1/report-distribution-lists/bind-1");
  assert.equal(result.status, 200);
  assert.ok(!captured.some((c) => c.table === "report_distribution_lists" && c.method === "DELETE"));
  const patch = captured.find((c) => c.table === "report_distribution_lists" && c.method === "PATCH");
  assert.ok(patch.body.deleted_at);
  assert.equal(patch.body.active, false);
});

// --- GET /reports/:id/deliveries --------------------------------------------

test("GET /reports/:id/deliveries 404s when the submission does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/reports/sub-missing/deliveries");
  assert.equal(result.status, 404);
});

test("GET /reports/:id/deliveries denies a caller without reports.read on the submission's facility", async (t) => {
  stubFetch(t, (table) => (table === "report_submissions" ? [{ id: "sub-1", facility_id: "fac-1" }] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/reports/sub-1/deliveries");
  assert.equal(result.status, 403);
});

test("GET /reports/:id/deliveries returns the submission's delivery rows", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "report_submissions") return [{ id: "sub-1", facility_id: "fac-1" }];
    if (table === "report_deliveries") {
      return [{ id: "del-1", facility_id: "fac-1", submission_id: "sub-1", channel: "email", status: "sent" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/reports/sub-1/deliveries");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "report_deliveries" && c.method === "GET");
  assert.equal(get.url.searchParams.get("submission_id"), "eq.sub-1");
  assert.equal(get.url.searchParams.get("facility_id"), "eq.fac-1");
});
