import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerIncidentRoutes } from "../src/lib/http/incidents-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const CREATOR = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.manage"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["incidents.read", "incidents.manage"] }];

const INCIDENT = {
  id: "inc-1",
  facility_id: "fac-1",
  department_id: null,
  incident_no: "INC-2026-001",
  report_type: "incident",
  status: "draft",
  severity: "high",
  occurred_at: "2026-07-18T10:00:00Z",
  reported_at: "2026-07-18T11:00:00Z",
  location_text: "Building A",
  summary: "Test incident",
  immediate_actions: null,
  requires_osha_review: false,
  legal_hold: false,
  submitted_by: null,
  submitted_at: null,
  created_at: "2026-07-18T11:00:00Z",
  updated_at: "2026-07-18T11:00:00Z"
};

const ESCALATION = {
  id: "esc-1",
  facility_id: "fac-1",
  incident_id: "inc-1",
  escalation_level: 1,
  reason_code: "user_escalation",
  target_role: "manager",
  target_user_id: null,
  status: "pending",
  due_at: "2026-07-18T12:00:00Z",
  created_at: "2026-07-18T11:00:00Z",
  updated_at: "2026-07-18T11:00:00Z"
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

function mount({ memberships = CREATOR, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerIncidentRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call, captured: [] };
}

test("GET incidents denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/incidents");
  assert.equal(result.status, 403);
});

test("GET incidents returns list for a reader", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incidents");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "inc-1");
});

test("GET incidents with status filter applies the filter", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/incidents?status=escalated");
  const get = captured.find((c) => c.table === "incident_reports");
  assert.match(get.url.search, /status=eq\.escalated/);
});

test("GET incident by id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/nope");
  assert.equal(result.status, 404);
});

test("GET incident by id returns the incident for a reader", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.id, "inc-1");
});

test("POST incidents validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents", { summary: "missing fields" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST incidents denies a reader without incidents.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents", {
    incidentNo: "INC-2026-001",
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident"
  });
  assert.equal(result.status, 403);
});

test("POST incidents happy path inserts a draft with correct shape", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "POST") return [{ id: "inc-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/incidents", {
    incidentNo: "INC-2026-001",
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident",
    departmentId: "dept-1",
    immediateActions: "Called supervisor",
    requiresOshaReview: false,
    legalHold: false
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_reports" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].incident_no, "INC-2026-001");
  assert.equal(insert.body[0].report_type, "incident");
  assert.equal(insert.body[0].severity, "high");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].location_text, "Building A");
  assert.equal(insert.body[0].summary, "Test incident");
});

test("POST escalate loads incident and denies non-manager with 403", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/incidents/inc-1/escalate");
  assert.equal(result.status, 403);
});

test("POST escalate happy path inserts an escalation row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_escalations" && method === "POST") return [{ id: "esc-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-5" });
  const result = await call("POST", "/incidents/inc-1/escalate");
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_escalations" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].incident_id, "inc-1");
  assert.equal(insert.body[0].escalation_level, 1);
  assert.equal(insert.body[0].reason_code, "user_escalation");
  assert.equal(insert.body[0].status, "pending");
  assert.ok(insert.body[0].due_at);
});
