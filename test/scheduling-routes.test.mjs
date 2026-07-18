import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerSchedulingRoutes } from "../src/lib/http/scheduling-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const READER = [{ facilityId: "fac-1", status: "active", permissions: ["schedule.read"] }];
const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["schedule.read", "schedule.manage"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["schedule.read", "schedule.manage"] }];

const PERIOD = {
  id: "per-1",
  facility_id: "fac-1",
  department_id: null,
  week_start_date: "2026-07-18",
  week_end_date: "2026-07-24",
  status: "draft",
  publish_version: 0,
  metadata: {}
};

const SHIFT = {
  id: "shift-1",
  facility_id: "fac-1",
  schedule_period_id: "per-1",
  department_id: null,
  role_code: "nurse",
  shift_date: "2026-07-18",
  starts_at: "2026-07-18T08:00:00Z",
  ends_at: "2026-07-18T16:00:00Z",
  source: "manual",
  status: "draft",
  required_certification_ids: [],
  notes: null
};

const ASSIGNMENT = {
  id: "asg-1",
  facility_id: "fac-1",
  shift_id: "shift-1",
  employee_id: "emp-1",
  assignment_type: "primary",
  status: "pending",
  assigned_by: null
};

const CERT_TYPE = {
  id: "ct-1",
  facility_id: "fac-1",
  code: "BLS",
  name: "Basic Life Support",
  renewal_window_days: 30
};

const EMPLOYEE_CERT = {
  id: "ec-1",
  facility_id: "fac-1",
  employee_id: "emp-1",
  certification_type_id: "ct-1",
  issued_at: "2025-01-01",
  expires_at: "2027-01-01",
  evidence_path: null,
  status: "active"
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
  registerSchedulingRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET schedule-periods denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/schedule-periods");
  assert.equal(result.status, 403);
});

test("GET schedule-periods returns an empty list for a reader", async (t) => {
  const captured = stubFetch(t, (table) => (table === "schedule_periods" ? [PERIOD] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/schedule-periods");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "per-1");
});

test("POST shifts validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shifts", { roleCode: "nurse" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST shifts denies a reader without schedule.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shifts", {
    schedulePeriodId: "per-1",
    roleCode: "nurse",
    shiftDate: "2026-07-18",
    startsAt: "2026-07-18T08:00:00Z",
    endsAt: "2026-07-18T16:00:00Z"
  });
  assert.equal(result.status, 403);
});

test("POST shifts happy path inserts a draft shift with shaped row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts" && method === "POST") return [{ id: "shift-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/shifts", {
    schedulePeriodId: "per-1",
    roleCode: "nurse",
    shiftDate: "2026-07-18",
    startsAt: "2026-07-18T08:00:00Z",
    endsAt: "2026-07-18T16:00:00Z",
    notes: "test shift"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "schedule_shifts" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].schedule_period_id, "per-1");
  assert.equal(insert.body[0].role_code, "nurse");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].notes, "test shift");
});

test("POST schedule/validate returns 200 with readiness result", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments") return [ASSIGNMENT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "employee_certifications") return [EMPLOYEE_CERT];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.ok("canPublish" in result.payload);
  assert.ok("doubleBookings" in result.payload);
  assert.ok("missingCertifications" in result.payload);
  assert.ok("warnings" in result.payload);
  assert.ok("certEnforcementMode" in result.payload);
  assert.equal(result.payload.canPublish, true);
  assert.equal(result.payload.doubleBookings.length, 0);
});
