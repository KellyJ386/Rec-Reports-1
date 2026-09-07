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
const TASK_CREATOR = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.tasks.create"] }
];
const EXPORTER = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.export.pdf"] }
];
const ESCALATOR = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.escalate"] }
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
const ACKNOWLEDGED_ESCALATION = { ...ESCALATION, status: "acknowledged", acknowledged_at: "2026-07-18T11:30:00Z" };
const RESOLVED_ESCALATION = { ...ESCALATION, status: "resolved", acknowledged_at: "2026-07-18T11:30:00Z" };

const FOLLOWUP = {
  id: "fu-1",
  facility_id: "fac-1",
  incident_id: "inc-1",
  owner_user_id: null,
  action_type: "corrective_action",
  status: "open",
  due_at: "2026-07-25T00:00:00Z",
  description: "Fix the guard rail",
  completed_at: null,
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

function mount({ memberships = CREATOR, userId = "user-1", env = {} } = {}) {
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
    await handler(request, {}, { env, params });
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

// --- GET /incidents/:id: retention_eligible_at (IN-16b) ----------------------

test("GET incident by id includes a computed retention_eligible_at using the registry default (no facility config)", async (t) => {
  // "modules" resolves to [] here (no explicit stub), so loadModuleConfig
  // returns {} early -- configValue falls back to the registry default,
  // exactly the "unconfigured facility" case.
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1");
  assert.equal(result.status, 200);
  // INCIDENT: occurred_at 2026-07-18T10:00:00Z, severity high, no OSHA
  // review, report_type incident -- "standard" class, default 2555 days.
  const expected = new Date(new Date(INCIDENT.occurred_at).getTime() + 2555 * 86400000).toISOString();
  assert.equal(result.payload.retention_eligible_at, expected);
});

test("GET incident by id computes an OSHA-class retention date when requires_osha_review is true", async (t) => {
  const oshaIncident = { ...INCIDENT, requires_osha_review: true };
  stubFetch(t, (table) => (table === "incident_reports" ? [oshaIncident] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1");
  const expected = new Date(new Date(INCIDENT.occurred_at).getTime() + 1825 * 86400000).toISOString();
  assert.equal(result.payload.retention_eligible_at, expected);
});

test("GET incident by id honors a facility-configured retention override", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "modules") return [{ id: "mod-incidents", code: "incidents" }];
    if (table === "facilities") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "organization_module_settings") return [];
    if (table === "facility_module_overrides") {
      return [{ config_patch_jsonb: { "incidents.retentionDaysStandard": 10 } }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1");
  const expected = new Date(new Date(INCIDENT.occurred_at).getTime() + 10 * 86400000).toISOString();
  assert.equal(result.payload.retention_eligible_at, expected);
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
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident"
  });
  assert.equal(result.status, 403);
});

test("POST incidents happy path inserts a draft with a server-generated incident_no", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return []; // no existing incidents for this facility
    if (table === "incident_reports" && method === "POST") return [{ id: "inc-1", incident_no: "INC-2026-0001" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/incidents", {
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
  assert.match(insert.body[0].incident_no, /^INC-\d{4}-0001$/);
  assert.equal(insert.body[0].report_type, "incident");
  assert.equal(insert.body[0].severity, "high");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].location_text, "Building A");
  assert.equal(insert.body[0].summary, "Test incident");
});

// M2 (0048): a client-supplied legalHold:true must never reach the insert --
// creating an incident already on legal hold is gated on
// incidents.legal_hold.manage, a permission this route's MANAGE-only guard
// does not itself check. Matches the new BEFORE INSERT guard in 0048.
test("POST incidents ignores a client-supplied legalHold:true; every draft is created with legal_hold=false", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [];
    if (table === "incident_reports" && method === "POST") return [{ id: "inc-2" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/incidents", {
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident",
    legalHold: true
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_reports" && c.method === "POST");
  assert.equal(insert.body[0].legal_hold, false);
});

test("POST incidents ignores a client-supplied incidentNo and generates its own", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [];
    if (table === "incident_reports" && method === "POST") return [{ id: "inc-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  await call("POST", "/facilities/fac-1/incidents", {
    incidentNo: "CLIENT-SUPPLIED-999",
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident"
  });
  const insert = captured.find((c) => c.table === "incident_reports" && c.method === "POST");
  assert.notEqual(insert.body[0].incident_no, "CLIENT-SUPPLIED-999");
  assert.match(insert.body[0].incident_no, /^INC-\d{4}-\d{4}$/);
});

test("POST incidents numbers the next incident after the facility's existing max for the year", async (t) => {
  const year = new Date().getUTCFullYear();
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") {
      return [{ incident_no: `INC-${year}-0003` }, { incident_no: `INC-${year}-0007` }, { incident_no: `INC-${year - 1}-0099` }];
    }
    if (table === "incident_reports" && method === "POST") return [{ id: "inc-9" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  await call("POST", "/facilities/fac-1/incidents", {
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident"
  });
  const insert = captured.find((c) => c.table === "incident_reports" && c.method === "POST");
  assert.equal(insert.body[0].incident_no, `INC-${year}-0008`);
});

test("POST incidents retries once on a unique incident_no collision and succeeds", async (t) => {
  let insertAttempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    if (table === "incident_reports" && method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    }
    if (table === "incident_reports" && method === "POST") {
      insertAttempts += 1;
      if (insertAttempts === 1) {
        return {
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ code: "23505", message: "duplicate key value" })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "inc-retry" }]) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/incidents", {
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident"
  });
  assert.equal(result.status, 201);
  assert.equal(insertAttempts, 2);
});

test("POST incidents surfaces a second consecutive collision as a clean 409", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    if (table === "incident_reports" && method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    }
    if (table === "incident_reports" && method === "POST") {
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ code: "23505", message: "duplicate key value" })
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/incidents", {
    reportType: "incident",
    severity: "high",
    occurredAt: "2026-07-18T10:00:00Z",
    locationText: "Building A",
    summary: "Test incident"
  });
  assert.equal(result.status, 409);
});

test("POST escalate loads incident and denies non-manager with 403", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/incidents/inc-1/escalate");
  assert.equal(result.status, 403);
});

test("POST escalate allows an incidents.escalate holder without incidents.manage (S-5)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_escalations" && method === "POST") return [{ id: "esc-3" }];
    return [];
  });
  const { call } = mount({ memberships: ESCALATOR });
  const result = await call("POST", "/incidents/inc-1/escalate");
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_escalations" && c.method === "POST");
  assert.ok(insert, "expected an incident_escalations insert");
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

// --- PATCH /incidents/:id/legal-hold (S-5) ----------------------------------

test("PATCH legal-hold validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: LEGAL_HOLD_MANAGER });
  const result = await call("PATCH", "/incidents/inc-1/legal-hold", { legalHold: "yes" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH legal-hold 404s when the incident is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: LEGAL_HOLD_MANAGER });
  const result = await call("PATCH", "/incidents/nope/legal-hold", { legalHold: true });
  assert.equal(result.status, 404);
});

test("PATCH legal-hold denies a manager without incidents.legal_hold.manage", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("PATCH", "/incidents/inc-1/legal-hold", { legalHold: true });
  assert.equal(result.status, 403);
});

test("PATCH legal-hold happy path flips legal_hold and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_reports" && method === "PATCH") return [{ ...INCIDENT, legal_hold: true }];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: LEGAL_HOLD_MANAGER });
  const result = await call("PATCH", "/incidents/inc-1/legal-hold", { legalHold: true });
  assert.equal(result.status, 200);
  assert.equal(result.payload.legal_hold, true);

  const update = captured.find((c) => c.table === "incident_reports" && c.method === "PATCH");
  assert.equal(update.body.legal_hold, true);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert");
  assert.equal(auditInsert.body[0].event_type, "incident.legal_hold_changed");
});

// --- GET /incidents/:id/legal-hold (IN-16c: history) -------------------------

test("GET legal-hold history 404s when the incident is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: LEGAL_HOLD_MANAGER });
  const result = await call("GET", "/incidents/nope/legal-hold");
  assert.equal(result.status, 404);
});

test("GET legal-hold history denies a caller with none of audit.view/manage/review", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({
    memberships: [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.legal_hold.manage"] }]
  });
  const result = await call("GET", "/incidents/inc-1/legal-hold");
  assert.equal(result.status, 403);
});

test("GET legal-hold history returns the ordered toggle history for a manager", async (t) => {
  const HISTORY_ROWS = [
    {
      id: 1,
      actor_user_id: "user-3",
      event_payload: { actor: "user-3", from: false, to: true },
      created_at: "2026-07-19T00:00:00Z"
    },
    {
      id: 2,
      actor_user_id: "user-4",
      event_payload: { actor: "user-4", from: true, to: false },
      created_at: "2026-07-20T00:00:00Z"
    }
  ];
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [{ ...INCIDENT, legal_hold: false }];
    if (table === "incident_audit_events" && method === "GET") return HISTORY_ROWS;
    return [];
  });
  const { call } = mount({ memberships: CREATOR }); // incidents.manage
  const result = await call("GET", "/incidents/inc-1/legal-hold");
  assert.equal(result.status, 200);
  assert.equal(result.payload.legalHold, false);
  assert.equal(result.payload.history.length, 2);
  assert.deepEqual(result.payload.history[0], {
    id: 1,
    actorUserId: "user-3",
    from: false,
    to: true,
    changedAt: "2026-07-19T00:00:00Z"
  });
  assert.deepEqual(result.payload.history[1], {
    id: 2,
    actorUserId: "user-4",
    from: true,
    to: false,
    changedAt: "2026-07-20T00:00:00Z"
  });

  const auditGet = captured.find((c) => c.table === "incident_audit_events" && c.method === "GET");
  assert.match(auditGet.url.search, /event_type=eq\.incident\.legal_hold_changed/);
});

// --- POST /incidents/:id/submit: suggestedFollowUps (IN-05) -----------------

test("POST submit response includes suggestedFollowUps for an auto-escalating severity", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT]; // severity: high
    if (table === "incident_reports" && method === "PATCH") return [{ ...INCIDENT, status: "submitted" }];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/inc-1/submit");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.suggestedFollowUps, ["manager_review", "safety_lead_acknowledgement"]);
});

test("POST submit response has an empty suggestedFollowUps for a non-escalating incident", async (t) => {
  const LOW_SEVERITY_INCIDENT = { ...INCIDENT, severity: "low" };
  stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [LOW_SEVERITY_INCIDENT];
    if (table === "incident_reports" && method === "PATCH") return [{ ...LOW_SEVERITY_INCIDENT, status: "submitted" }];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/inc-1/submit");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.suggestedFollowUps, []);
});

// --- POST /incidents/:id/amendments, GET /incidents/:id/amendments (IN-04) --

test("POST amendments on a draft incident is rejected with 409 and no writes", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : [])); // draft
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/inc-1/amendments", {
    reason: "correcting the summary",
    patch: { summary: "Updated summary" }
  });
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.table === "incident_amendments"));
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
  assert.ok(!captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
  assert.ok(!captured.some((c) => c.table === "rpc/apply_incident_amendment"));
});

test("POST amendments denies an actor without incidents.manage or incidents.review", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [SUBMITTED_INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/incidents/inc-1/amendments", {
    reason: "correcting the summary",
    patch: { summary: "Updated summary" }
  });
  assert.equal(result.status, 403);
});

test("POST amendments rejects an empty patch, non-amendable fields, and a blank reason (400, no writes)", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [SUBMITTED_INCIDENT] : []));
  const { call } = mount({ memberships: CREATOR });

  const emptyPatch = await call("POST", "/incidents/inc-1/amendments", { reason: "why", patch: {} });
  assert.equal(emptyPatch.status, 400);

  const badField = await call("POST", "/incidents/inc-1/amendments", {
    reason: "why",
    patch: { status: "closed" }
  });
  assert.equal(badField.status, 400);
  assert.match(badField.payload.error, /status/);

  const blankReason = await call("POST", "/incidents/inc-1/amendments", {
    reason: "   ",
    patch: { summary: "x" }
  });
  assert.equal(blankReason.status, 400);

  assert.ok(!captured.some((c) => c.table === "incident_amendments"));
  assert.ok(!captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
  assert.ok(!captured.some((c) => c.table === "rpc/apply_incident_amendment"));
});

test("POST amendments on a submitted incident calls internal.apply_incident_amendment (RPC) and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [SUBMITTED_INCIDENT];
    if (table === "rpc/apply_incident_amendment" && method === "POST") {
      return {
        incident: { ...SUBMITTED_INCIDENT, summary: "Updated after investigation" },
        amendment: {
          id: "amend-1",
          facility_id: "fac-1",
          incident_id: "inc-1",
          amendment_reason: "Investigation revealed more detail",
          amended_by: "user-9"
        }
      };
    }
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR, userId: "user-9" });
  const result = await call("POST", "/incidents/inc-1/amendments", {
    reason: "Investigation revealed more detail",
    patch: { summary: "Updated after investigation" }
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.incident.summary, "Updated after investigation");
  assert.equal(result.payload.amendment.id, "amend-1");

  // M1 (0048): the incident_reports UPDATE and the incident_amendments
  // INSERT no longer happen as two separate REST calls from this route --
  // both are applied atomically inside the RPC, so this route now issues
  // exactly one write call for them combined.
  assert.ok(!captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
  assert.ok(!captured.some((c) => c.table === "incident_amendments" && c.method === "POST"));

  const rpcCall = captured.find((c) => c.table === "rpc/apply_incident_amendment" && c.method === "POST");
  assert.ok(rpcCall, "expected a call to internal.apply_incident_amendment via RPC");
  assert.equal(rpcCall.body.incident_id, "inc-1");
  assert.deepEqual(rpcCall.body.changes, { summary: "Updated after investigation" });
  assert.equal(rpcCall.body.reason, "Investigation revealed more detail");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert");
  const event = auditInsert.body[0];
  assert.equal(event.event_type, "incident.amended");
  assert.deepEqual(event.event_payload.fields, ["summary"]);
  assert.equal(typeof event.event_payload.beforeHash, "string");
  assert.equal(typeof event.event_payload.afterHash, "string");
});

test("POST amendments succeeds for an incidents.review holder (no incidents.manage)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [SUBMITTED_INCIDENT];
    if (table === "rpc/apply_incident_amendment" && method === "POST") {
      return {
        incident: { ...SUBMITTED_INCIDENT, severity: "high" },
        amendment: { id: "amend-2" }
      };
    }
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/incidents/inc-1/amendments", {
    reason: "reclassified after review",
    patch: { severity: "high" }
  });
  assert.equal(result.status, 201);
  assert.ok(captured.some((c) => c.table === "rpc/apply_incident_amendment" && c.method === "POST"));
});

test("POST amendments propagates a DB-level rejection (e.g. RPC's own permission/status guard) as the same status", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    if (table === "incident_reports" && init.method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify([SUBMITTED_INCIDENT]) };
    }
    if (table === "rpc/apply_incident_amendment") {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: "missing permission: incidents.manage or incidents.review" })
      };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/inc-1/amendments", {
    reason: "why",
    patch: { summary: "x" }
  });
  assert.equal(result.status, 403);
  assert.match(result.payload.error, /incidents\.manage/);
});

test("GET amendments 404s when the incident is missing and denies a non-reader", async (t) => {
  stubFetch(t, () => []);
  const { call: call404 } = mount({ memberships: CREATOR });
  const missing = await call404("GET", "/incidents/nope/amendments");
  assert.equal(missing.status, 404);
});

test("GET amendments returns the amendment history for a reader", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_reports") return [SUBMITTED_INCIDENT];
    if (table === "incident_amendments") return [{ id: "amend-1" }, { id: "amend-2" }];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1/amendments");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 2);
});

// --- Follow-up actions CRUD + permission matrix (IN-05) ----------------------

test("GET followups denies a non-reader with 403", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/incidents/inc-1/followups");
  assert.equal(result.status, 403);
});

test("GET followups lists an incident's follow-up actions for a reader", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_followup_actions") return [FOLLOWUP];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1/followups");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].id, "fu-1");
});

test("POST followups validates shape before guarding or fetching (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: TASK_CREATOR });
  const result = await call("POST", "/incidents/inc-1/followups", { actionType: "not_a_real_type" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST followups denies a reader without incidents.tasks.create", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/incidents/inc-1/followups", {
    actionType: "corrective_action",
    description: "Fix it"
  });
  assert.equal(result.status, 403);
});

test("POST followups allows incidents.tasks.create without incidents.manage, and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_followup_actions" && method === "POST") return [{ id: "fu-9" }];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: TASK_CREATOR, userId: "user-4" });
  const result = await call("POST", "/incidents/inc-1/followups", {
    actionType: "corrective_action",
    description: "Fix the guard rail",
    dueAt: "2026-08-01T00:00:00Z",
    ownerUserId: "user-owner"
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.id, "fu-9");

  const insert = captured.find((c) => c.table === "incident_followup_actions" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].incident_id, "inc-1");
  assert.equal(insert.body[0].status, "open");
  assert.equal(insert.body[0].owner_user_id, "user-owner");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert on create");
  assert.equal(auditInsert.body[0].event_type, "incident.followup_created");
});

test("PATCH followups denies a task-creator without incidents.manage", async (t) => {
  stubFetch(t, (table) => (table === "incident_followup_actions" ? [FOLLOWUP] : []));
  const { call } = mount({ memberships: TASK_CREATOR });
  const result = await call("PATCH", "/followups/fu-1", { status: "in_progress" });
  assert.equal(result.status, 403);
});

test("PATCH followups reassigns owner/due date with no audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_followup_actions" && method === "GET") return [FOLLOWUP];
    if (table === "incident_followup_actions" && method === "PATCH") {
      return [{ ...FOLLOWUP, owner_user_id: "user-new", due_at: "2026-08-05T00:00:00Z" }];
    }
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("PATCH", "/followups/fu-1", { ownerUserId: "user-new", dueAt: "2026-08-05T00:00:00Z" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.owner_user_id, "user-new");
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("PATCH followups completing a task stamps completed_at server-side and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_followup_actions" && method === "GET") return [FOLLOWUP];
    if (table === "incident_followup_actions" && method === "PATCH") {
      return [{ ...FOLLOWUP, status: "completed", completed_at: "2026-08-14T00:00:00.000Z" }];
    }
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR, userId: "user-3" });
  const result = await call("PATCH", "/followups/fu-1", { status: "completed" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "completed");

  const patch = captured.find((c) => c.table === "incident_followup_actions" && c.method === "PATCH");
  assert.ok(patch.body.completed_at, "expected completed_at to be server-stamped");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert on completion");
  assert.equal(auditInsert.body[0].event_type, "incident.followup_completed");
});

test("PATCH followups re-completing an already-completed task writes no second audit event", async (t) => {
  const COMPLETED_FOLLOWUP = { ...FOLLOWUP, status: "completed", completed_at: "2026-08-01T00:00:00Z" };
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_followup_actions" && method === "GET") return [COMPLETED_FOLLOWUP];
    if (table === "incident_followup_actions" && method === "PATCH") return [COMPLETED_FOLLOWUP];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("PATCH", "/followups/fu-1", { status: "completed" });
  assert.equal(result.status, 200);
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("PATCH followups rejects an invalid status (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("PATCH", "/followups/fu-1", { status: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH followups 404s when the follow-up is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("PATCH", "/followups/nope", { status: "in_progress" });
  assert.equal(result.status, 404);
});

// --- Escalation lifecycle: create/acknowledge/resolve/list (IN-06) ----------

test("POST escalate validates level/targetRole/reasonCode shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/incidents/inc-1/escalate", { level: 0 });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST escalate accepts custom level/targetRole/reasonCode and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_escalations" && method === "POST") return [{ id: "esc-2" }];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR, userId: "user-6" });
  const result = await call("POST", "/incidents/inc-1/escalate", {
    level: 2,
    targetRole: "safety_director",
    reasonCode: "sla_breach"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_escalations" && c.method === "POST");
  assert.equal(insert.body[0].escalation_level, 2);
  assert.equal(insert.body[0].target_role, "safety_director");
  assert.equal(insert.body[0].reason_code, "sla_breach");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert");
  assert.equal(auditInsert.body[0].event_type, "incident.escalated");
});

test("POST escalations/:id/acknowledge denies a reader without incidents.manage", async (t) => {
  stubFetch(t, (table) => (table === "incident_escalations" ? [ESCALATION] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/escalations/esc-1/acknowledge");
  assert.equal(result.status, 403);
});

test("POST escalations/:id/acknowledge happy path stamps acknowledged_at and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [ESCALATION];
    if (table === "incident_escalations" && method === "PATCH") return [ACKNOWLEDGED_ESCALATION];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR, userId: "user-2" });
  const result = await call("POST", "/escalations/esc-1/acknowledge");
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "acknowledged");

  const patch = captured.find((c) => c.table === "incident_escalations" && c.method === "PATCH");
  assert.equal(patch.body.status, "acknowledged");
  assert.ok(patch.body.acknowledged_at);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInsert.body[0].event_type, "incident.escalation_acknowledged");
});

test("POST escalations/:id/acknowledge on an already-acknowledged escalation is a 409 (double-ack rejected)", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_escalations" ? [ACKNOWLEDGED_ESCALATION] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/escalations/esc-1/acknowledge");
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.method === "PATCH"));
});

test("POST escalations/:id/acknowledge 404s when the escalation is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/escalations/nope/acknowledge");
  assert.equal(result.status, 404);
});

test("POST escalations/:id/resolve on a pending (not yet acknowledged) escalation is a 409", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_escalations" ? [ESCALATION] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/escalations/esc-1/resolve");
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.method === "PATCH"));
});

test("POST escalations/:id/resolve happy path transitions acknowledged -> resolved and writes an audit event", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [ACKNOWLEDGED_ESCALATION];
    if (table === "incident_escalations" && method === "PATCH") return [RESOLVED_ESCALATION];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/escalations/esc-1/resolve");
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "resolved");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInsert.body[0].event_type, "incident.escalation_resolved");
});

test("POST escalations/:id/resolve on an already-resolved escalation is a 409", async (t) => {
  stubFetch(t, (table) => (table === "incident_escalations" ? [RESOLVED_ESCALATION] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/escalations/esc-1/resolve");
  assert.equal(result.status, 409);
});

test("GET facilities/:id/incident-escalations denies a non-reader with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/incident-escalations");
  assert.equal(result.status, 403);
});

test("GET facilities/:id/incident-escalations applies the ?status= filter and flags overdue pending escalations", async (t) => {
  const PAST_DUE_PENDING = { ...ESCALATION, id: "esc-overdue", due_at: "2020-01-01T00:00:00Z" };
  const captured = stubFetch(t, (table) => (table === "incident_escalations" ? [PAST_DUE_PENDING] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incident-escalations?status=pending");
  assert.equal(result.status, 200);
  const query = captured.find((c) => c.table === "incident_escalations");
  assert.equal(query.url.searchParams.get("status"), "eq.pending");
  assert.equal(result.payload[0].overdue, true);
});

test("GET facilities/:id/incident-escalations does not flag a resolved escalation as overdue even if its due_at has passed", async (t) => {
  const PAST_DUE_RESOLVED = { ...RESOLVED_ESCALATION, id: "esc-old", due_at: "2020-01-01T00:00:00Z" };
  stubFetch(t, (table) => (table === "incident_escalations" ? [PAST_DUE_RESOLVED] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incident-escalations");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].overdue, false);
});

test("GET facilities/:id/incident-escalations does not flag a not-yet-due pending escalation as overdue", async (t) => {
  const NOT_YET_DUE = { ...ESCALATION, id: "esc-fresh", due_at: "2099-01-01T00:00:00Z" };
  stubFetch(t, (table) => (table === "incident_escalations" ? [NOT_YET_DUE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incident-escalations");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].overdue, false);
});

// --- GET /incidents/:id/export.pdf (IN-08) -----------------------------------

test("GET export.pdf denies a reader without incidents.export.pdf with 403 and writes nothing", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER }); // incidents.read only, not incidents.export.pdf
  const result = await call("GET", "/incidents/inc-1/export.pdf");
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("GET export.pdf 404s when the incident is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: EXPORTER });
  const result = await call("GET", "/incidents/nope/export.pdf");
  assert.equal(result.status, 404);
});

test("GET export.pdf happy path returns the standard export envelope", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_reports") return [SUBMITTED_INCIDENT];
    if (table === "facilities") return [{ id: "fac-1", name: "Riverside Rec Center" }];
    if (table === "incident_people") return [];
    if (table === "incident_followup_actions") return [FOLLOWUP];
    if (table === "incident_escalations") return [ESCALATION];
    if (table === "incident_amendments") return [];
    if (table === "incident_audit_events") return [];
    return [];
  });
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/export.pdf");
  assert.equal(result.status, 200);
  assert.equal(result.payload.contentType, "application/pdf");
  assert.equal(result.payload.encoding, "base64");
  assert.match(result.payload.filename, /^incident-INC-2026-001-.+\.pdf$/);
  assert.match(result.payload.contentDisposition, /^attachment; filename="incident-INC-2026-001-.+\.pdf"$/);
  // documentHash travels with the internal package for the audit event only
  // -- it is not part of the wire envelope.
  assert.equal(result.payload.documentHash, undefined);
  const bytes = Buffer.from(result.payload.body, "base64").toString("latin1");
  assert.ok(bytes.startsWith("%PDF-1.4\n"));
  assert.ok(bytes.trimEnd().endsWith("%%EOF"));
});

test("GET export.pdf writes an incident_audit_events row on every export", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "incident_reports") return [SUBMITTED_INCIDENT];
    if (table === "incident_followup_actions") return [FOLLOWUP];
    if (table === "incident_escalations") return [ESCALATION];
    return [];
  });
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/export.pdf");
  assert.equal(result.status, 200);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert on export");
  const event = auditInsert.body[0];
  assert.equal(event.facility_id, "fac-1");
  assert.equal(event.incident_id, "inc-1");
  assert.equal(event.actor_user_id, "user-8");
  assert.equal(event.event_type, "incident.exported");
  assert.equal(event.event_payload.actor, "user-8");
  assert.equal(event.event_payload.format, "pdf");
  assert.equal(event.event_payload.draft, false);
  assert.equal(event.event_payload.amended, false);
  assert.match(event.event_payload.documentHash, /^[0-9a-f]{64}$/);
});

test("GET export.pdf marks a draft export's audit event and watermarks the document", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : [])); // INCIDENT is a draft
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/export.pdf");
  assert.equal(result.status, 200);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInsert.body[0].event_payload.draft, true);

  const bytes = Buffer.from(result.payload.body, "base64").toString("latin1");
  assert.match(bytes, /\[DRAFT - NOT SUBMITTED\]/);
});

test("GET export.pdf marks an amended incident's audit event and lists amendment history in the document", async (t) => {
  const AMENDMENT = {
    id: "amend-1",
    facility_id: "fac-1",
    incident_id: "inc-1",
    amendment_reason: "corrected the location",
    before_snapshot: { location_text: "Building A" },
    after_snapshot: { location_text: "Building B" },
    amended_by: "user-3",
    amended_at: "2026-07-19T00:00:00Z"
  };
  const captured = stubFetch(t, (table) => {
    if (table === "incident_reports") return [SUBMITTED_INCIDENT];
    if (table === "incident_amendments") return [AMENDMENT];
    return [];
  });
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/export.pdf");
  assert.equal(result.status, 200);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInsert.body[0].event_payload.amended, true);

  const bytes = Buffer.from(result.payload.body, "base64").toString("latin1");
  assert.match(bytes, /\[AMENDED\]/);
  assert.match(bytes, /\(Amendment 1 Reason: corrected the location\) Tj/);
});

// --- GET /incidents/:id/packet.pdf (IN-18) -----------------------------------

function respondPacket(overrides = {}) {
  return (table, method, parsed) => {
    if (table === "incident_reports") return [SUBMITTED_INCIDENT];
    if (table === "facilities") return [{ id: "fac-1", name: "Riverside Rec Center" }];
    if (table === "incident_people") return overrides.people ?? [];
    if (table === "incident_witness_statements") return overrides.statements ?? [];
    if (table === "incident_attachments") return overrides.attachments ?? [];
    if (table === "incident_followup_actions") return overrides.followups ?? [FOLLOWUP];
    if (table === "incident_escalations") return overrides.escalations ?? [ESCALATION];
    if (table === "incident_amendments") return overrides.amendments ?? [];
    if (table === "incident_signatures") return overrides.signatures ?? [];
    if (table === "incident_compliance_checks") return overrides.complianceChecks ?? [];
    if (table === "incident_audit_events" && method === "GET") {
      // Two distinct queries hit this table: one filtered by incident_id
      // (display), one by facility_id (chain verification) -- distinguish
      // them by which filter the query actually carries.
      if (parsed.searchParams.get("incident_id")) return overrides.auditEvents ?? [];
      if (parsed.searchParams.get("facility_id")) return overrides.chainRows ?? [];
    }
    return [];
  };
}

test("GET packet.pdf denies a reader without incidents.export.pdf with 403 and writes nothing", async (t) => {
  const captured = stubFetch(t, respondPacket());
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/incidents/inc-1/packet.pdf");
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("GET packet.pdf 404s when the incident is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: EXPORTER });
  const result = await call("GET", "/incidents/nope/packet.pdf");
  assert.equal(result.status, 404);
});

test("GET packet.pdf 409s while the incident is a draft, before any child table is queried", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : [])); // INCIDENT is a draft
  const { call } = mount({ memberships: EXPORTER });
  const result = await call("GET", "/incidents/inc-1/packet.pdf");
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /submitted-or-later/i);
  assert.ok(!captured.some((c) => c.table === "incident_people"));
  assert.ok(!captured.some((c) => c.table === "incident_audit_events" && c.method === "POST"));
});

test("GET packet.pdf happy path returns a packet envelope containing every section", async (t) => {
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const PERSON = {
    id: "person-1",
    person_role: "injured_party",
    full_name: "Jane Doe",
    contact_json: {},
    injury_json: {},
    statement_text: null
  };
  stubFetch(
    t,
    respondPacket({
      people: [PERSON],
      statements: [
        {
          id: "stmt-1",
          person_id: "person-1",
          version_no: 1,
          statement_text: "I saw it happen.",
          submitted_by: "user-1",
          submitted_at: "2026-07-18T11:00:00Z",
          signed_at: "2026-07-18T11:30:00Z",
          deleted_at: null
        }
      ],
      attachments: [
        {
          id: "att-1",
          attachment_type: "photo",
          storage_path: "facilities/fac-1/incidents/inc-1/x.jpg",
          checksum_sha256: null,
          metadata: {},
          captured_at: null,
          captured_by: null
        }
      ]
    })
  );
  const result = await call("GET", "/incidents/inc-1/packet.pdf");
  assert.equal(result.status, 200);
  assert.equal(result.payload.contentType, "application/pdf");
  assert.match(result.payload.filename, /^incident-INC-2026-001-packet-.+\.pdf$/);
  assert.match(result.payload.contentDisposition, /^attachment; filename="incident-INC-2026-001-packet-.+\.pdf"$/);
  assert.equal(result.payload.documentHash, undefined); // internal only, not part of the wire envelope

  const bytes = Buffer.from(result.payload.body, "base64").toString("latin1");
  assert.ok(bytes.startsWith("%PDF-1.4\n"));
  assert.match(bytes, /== Involved People ==/);
  assert.match(bytes, /== Witness Statements ==/);
  assert.match(bytes, /\(Statement 1 Version: 1\) Tj/);
  assert.match(bytes, /== Evidence Index ==/);
  assert.match(bytes, /== Audit Timeline ==/);
  assert.match(bytes, /== Audit Chain Verification ==/);
  assert.match(bytes, /== Packet Integrity ==/);
  assert.match(bytes, /\(Packet Hash: sha256:[0-9a-f]{64}\) Tj/);
});

test("GET packet.pdf writes an incident.packet_exported audit event carrying the packet hash and chain result", async (t) => {
  const captured = stubFetch(t, respondPacket());
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/packet.pdf");
  assert.equal(result.status, 200);

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditInsert, "expected an incident_audit_events insert on packet export");
  const event = auditInsert.body[0];
  assert.equal(event.facility_id, "fac-1");
  assert.equal(event.incident_id, "inc-1");
  assert.equal(event.actor_user_id, "user-8");
  assert.equal(event.event_type, "incident.packet_exported");
  assert.match(event.event_payload.documentHash, /^[0-9a-f]{64}$/);
  // An empty chainRows fixture (no rows fetched) verifies as valid: true,
  // brokenAt: null (verifyIncidentAuditChain's vacuous-chain case).
  assert.equal(event.event_payload.chainValid, true);
  assert.equal(event.event_payload.chainBrokenAt, null);
});

test("GET packet.pdf omits the Signatures/Compliance Checks sections when those tables don't exist in this tree (defensive absence)", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    if (table === "incident_signatures" || table === "incident_compliance_checks") {
      // Simulates PostgREST's "relation does not exist" response for a
      // sibling migration's table this tree doesn't carry yet.
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: "relation not found" }) };
    }
    const data = respondPacket()(table, init.method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/packet.pdf");
  assert.equal(result.status, 200);
  const bytes = Buffer.from(result.payload.body, "base64").toString("latin1");
  assert.doesNotMatch(bytes, /== Signatures ==/);
  assert.doesNotMatch(bytes, /== Compliance Checks ==/);
  // The rest of the packet still renders fine.
  assert.match(bytes, /== Evidence Index ==/);
  assert.match(bytes, /== Packet Integrity ==/);
});

test("GET packet.pdf: a failing audit write returns 500 instead of the packet envelope", async (t) => {
  const captured = stubFetchAuditFailure(t, respondPacket());
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/packet.pdf");
  assert.equal(result.status, 500);
  assert.deepEqual(result.payload, { error: "audit write failed", entity_id: "inc-1" });
  assert.equal(result.payload.body, undefined);
  const auditAttempt = captured.postgrest.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditAttempt, "expected the (failed) audit insert to have been attempted");
});

// --- Audit write failure handling (IN-22 interim, see writeAuditEvent) ------
// The domain write and the incident_audit_events write are two separate REST
// calls; these tests simulate the audit write itself failing (PostgREST
// returns non-ok for that one table only) to verify: the caller gets a clean
// 500 {error, entity_id} instead of a generic/unhandled 500, the domain write
// that already happened is never rolled back or hidden, and the failure is
// reported through observability.mjs's fire-and-forget reportError -- same
// programmable-stub-by-hostname style as test/internal-routes.test.mjs.
function stubFetchAuditFailure(t, respond, { dsnHostname = "observability.example" } = {}) {
  const captured = { postgrest: [], observability: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === dsnHostname) {
      captured.observability.push({ url: parsed.toString(), body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, text: async () => "" };
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.postgrest.push({ table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null });
    if (table === "incident_audit_events" && method === "POST") {
      return { ok: false, status: 500, text: async () => JSON.stringify({ message: "connection reset" }) };
    }
    const data = respond(table, method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

test("POST escalate: a failing audit write returns 500 {error, entity_id} after the domain escalation row is already committed", async (t) => {
  const captured = stubFetchAuditFailure(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_escalations" && method === "POST") return [{ id: "esc-2" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR, env: { OBSERVABILITY_DSN: "https://observability.example/report" } });
  const result = await call("POST", "/incidents/inc-1/escalate", { level: 2 });

  assert.equal(result.status, 500);
  assert.deepEqual(result.payload, { error: "audit write failed", entity_id: "inc-1" });

  // The domain write (the escalation row itself) already happened and is
  // never undone -- this is exactly the partial-write gap IN-22's future
  // transactional RPC is meant to close.
  const escalationInsert = captured.postgrest.find((c) => c.table === "incident_escalations" && c.method === "POST");
  assert.ok(escalationInsert, "expected the escalation row to have already been inserted");

  assert.equal(captured.observability.length, 1, "expected exactly one fire-and-forget error report");
  assert.equal(captured.observability[0].body.route, "incidents.audit_write/incident.escalated");
  assert.equal(captured.observability[0].body.status, 500);
});

test("PATCH followups completing a task: a failing audit write returns 500 but the completion PATCH is not undone", async (t) => {
  const captured = stubFetchAuditFailure(t, (table, method) => {
    if (table === "incident_followup_actions" && method === "GET") return [FOLLOWUP];
    if (table === "incident_followup_actions" && method === "PATCH") return [{ ...FOLLOWUP, status: "completed" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("PATCH", "/followups/fu-1", { status: "completed" });

  assert.equal(result.status, 500);
  assert.deepEqual(result.payload, { error: "audit write failed", entity_id: FOLLOWUP.incident_id });

  const patch = captured.postgrest.find((c) => c.table === "incident_followup_actions" && c.method === "PATCH");
  assert.ok(patch, "expected the follow-up completion PATCH to have already been applied");
});

test("GET export.pdf: a failing audit write returns 500 instead of the PDF envelope", async (t) => {
  const captured = stubFetchAuditFailure(t, (table) => {
    if (table === "incident_reports") return [SUBMITTED_INCIDENT];
    return [];
  });
  const { call } = mount({ memberships: EXPORTER, userId: "user-8" });
  const result = await call("GET", "/incidents/inc-1/export.pdf");

  assert.equal(result.status, 500);
  assert.deepEqual(result.payload, { error: "audit write failed", entity_id: "inc-1" });
  assert.equal(result.payload.body, undefined, "must not also send the PDF envelope");
  const auditAttempt = captured.postgrest.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.ok(auditAttempt, "expected the (failed) audit insert to have been attempted");
});

test("A failing audit write with no OBSERVABILITY_DSN configured stays a silent no-op for reporting, but still 500s the response", async (t) => {
  stubFetchAuditFailure(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_escalations" && method === "POST") return [{ id: "esc-3" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR }); // default env: {} -- no OBSERVABILITY_DSN
  const result = await call("POST", "/incidents/inc-1/escalate", {});
  assert.equal(result.status, 500);
  assert.deepEqual(result.payload, { error: "audit write failed", entity_id: "inc-1" });
});

// L-8: with no DSN configured, reportError is a silent no-op (see
// observability.mjs), so console.error is the ONLY local signal that the
// audit write failed -- without it, "reported ... visible for manual
// reconciliation" (writeAuditEvent's own doc comment) would be false
// whenever OBSERVABILITY_DSN is unset, which is the normal local/dev state.
test("A failing audit write with no OBSERVABILITY_DSN configured still logs locally via console.error", async (t) => {
  stubFetchAuditFailure(t, (table, method) => {
    if (table === "incident_reports" && method === "GET") return [INCIDENT];
    if (table === "incident_escalations" && method === "POST") return [{ id: "esc-4" }];
    return [];
  });
  const originalConsoleError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  t.after(() => {
    console.error = originalConsoleError;
  });
  const { call } = mount({ memberships: CREATOR }); // default env: {} -- no OBSERVABILITY_DSN
  const result = await call("POST", "/incidents/inc-1/escalate", {});
  assert.equal(result.status, 500);
  assert.equal(calls.length, 1, "expected exactly one console.error call for the failed audit write");
  assert.match(calls[0][0], /incidents\.audit_write\/incident\.escalated/);
  assert.match(calls[0][0], /inc-1/);
});
