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
const REVIEWER = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.review"] }
];
const LEGAL_HOLD_MANAGER = [
  {
    facilityId: "fac-1",
    status: "active",
    permissions: ["incidents.read", "incidents.review", "incidents.legal_hold.manage"]
  }
];

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

const SUBMITTED_INCIDENT = { ...INCIDENT, status: "submitted", submitted_by: "user-1", submitted_at: INCIDENT.reported_at };
const ACTION_PENDING_INCIDENT = { ...INCIDENT, status: "action_pending" };
const ACTION_PENDING_LEGAL_HOLD_INCIDENT = { ...INCIDENT, status: "action_pending", legal_hold: true };

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

// --- POST /incidents/:id/submit ---------------------------------------------

test("POST submit happy path stamps submitted_by/submitted_at and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_reports" && method === "PATCH") {
      return [{ ...INCIDENT, status: "submitted", submitted_by: "user-9", submitted_at: "2026-08-13T00:00:00.000Z" }];
    }
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR, userId: "user-9" });
  const result = await call("POST", "/incidents/inc-1/submit");
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "submitted");

  const patch = captured.find((c) => c.table === "incident_reports" && c.method === "PATCH");
  assert.ok(patch, "expected a PATCH of incident_reports");
  assert.equal(patch.body.status, "submitted");
  assert.equal(patch.body.submitted_by, "user-9");
  assert.ok(patch.body.submitted_at);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert");
  const event = auditInsert.body[0];
  assert.equal(event.facility_id, "fac-1");
  assert.equal(event.incident_id, "inc-1");
  assert.equal(event.actor_user_id, "user-9");
  assert.equal(event.event_type, "incident.submitted");
  assert.deepEqual(event.event_payload, { actor: "user-9", from: "draft", to: "submitted" });
  assert.equal(typeof event.event_hash, "string");
  // prev_hash/row_hash are the DB trigger's job (0013), never set by the API.
  assert.equal(event.prev_hash, undefined);
  assert.equal(event.row_hash, undefined);
});

test("POST submit forbidden role: 403 and no writes", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/incidents/inc-1/submit");
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.method === "PATCH" || (c.table === "incident_audit_events" && c.method === "POST")));
});

test("POST submit invalid transition: already-submitted incident is rejected with 409 and no writes", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [SUBMITTED_INCIDENT] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/inc-1/submit");
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.method === "PATCH" || (c.table === "incident_audit_events" && c.method === "POST")));
});

test("POST submit 404s when the incident is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/nope/submit");
  assert.equal(result.status, 404);
});

// --- POST /incidents/:id/status ---------------------------------------------

test("POST status validates shape before guarding or fetching (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/status", { to: "not_a_real_status" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST status missing `to` is a 400 with zero fetches", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/status", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST status happy path (submitted -> under_review) writes the transition and an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [SUBMITTED_INCIDENT];
    if (table === "incident_reports" && method === "PATCH") {
      return [{ ...SUBMITTED_INCIDENT, status: "under_review" }];
    }
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER, userId: "user-7" });
  const result = await call("POST", "/incidents/inc-1/status", { to: "under_review", reason: "starting review" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "under_review");

  const patch = captured.find((c) => c.table === "incident_reports" && c.method === "PATCH");
  assert.equal(patch.body.status, "under_review");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  const event = auditInsert.body[0];
  assert.equal(event.event_type, "incident.status_changed");
  assert.equal(event.actor_user_id, "user-7");
  assert.deepEqual(event.event_payload, {
    actor: "user-7",
    from: "submitted",
    to: "under_review",
    reason: "starting review"
  });
});

test("POST status forbidden role: a manage-only actor lacks incidents.review and gets 403", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [SUBMITTED_INCIDENT] : []));
  const { call } = mount({ memberships: CREATOR }); // incidents.manage, not incidents.review
  const result = await call("POST", "/incidents/inc-1/status", { to: "under_review" });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.method === "PATCH"));
});

test("POST status invalid transition (structurally illegal edge) is 409", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : [])); // draft
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/status", { to: "closed" });
  assert.equal(result.status, 409);
});

test("POST status closing an incident with open follow-ups is blocked (409) and no writes occur", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [ACTION_PENDING_INCIDENT];
    if (table === "incident_followup_actions" && method === "GET") return [{ id: "f1" }, { id: "f2" }];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/status", { to: "closed" });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /follow-up/);

  const followupQuery = captured.find((c) => c.table === "incident_followup_actions" && c.method === "GET");
  assert.ok(followupQuery, "expected the route to query open follow-ups before closing");
  assert.equal(followupQuery.url.searchParams.get("status"), "in.(open,in_progress)");
  assert.equal(followupQuery.url.searchParams.get("incident_id"), "eq.inc-1");
  assert.ok(!captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("POST status closing succeeds once follow-ups are all closed", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [ACTION_PENDING_INCIDENT];
    if (table === "incident_followup_actions" && method === "GET") return [];
    if (table === "incident_reports" && method === "PATCH") return [{ ...ACTION_PENDING_INCIDENT, status: "closed" }];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/status", { to: "closed" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "closed");
  assert.ok(captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("POST status closing a legal-hold incident without incidents.legal_hold.manage is blocked (409)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [ACTION_PENDING_LEGAL_HOLD_INCIDENT];
    if (table === "incident_followup_actions" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/status", { to: "closed" });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /legal_hold/);
  assert.ok(!captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
});

test("POST status closing a legal-hold incident succeeds with incidents.legal_hold.manage", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [ACTION_PENDING_LEGAL_HOLD_INCIDENT];
    if (table === "incident_followup_actions" && method === "GET") return [];
    if (table === "incident_reports" && method === "PATCH") {
      return [{ ...ACTION_PENDING_LEGAL_HOLD_INCIDENT, status: "closed" }];
    }
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: LEGAL_HOLD_MANAGER });
  const result = await call("POST", "/incidents/inc-1/status", { to: "closed" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "closed");
  assert.ok(captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
});

test("POST status 404s when the incident is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/nope/status", { to: "under_review" });
  assert.equal(result.status, 404);
});
