import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerIncidentPeopleRoutes } from "../src/lib/http/incidents-people-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.manage"] }];
const REVIEWER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.review"] }];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["incidents.read", "incidents.manage"] }];

const INCIDENT = { id: "inc-1", facility_id: "fac-1" };

const PERSON = {
  id: "person-1",
  facility_id: "fac-1",
  incident_id: "inc-1",
  person_role: "witness",
  full_name: "Jamie Rivera",
  contact_json: {},
  injury_json: {},
  statement_text: null,
  statement_submitted_at: null,
  created_at: "2026-07-18T11:00:00Z",
  updated_at: "2026-07-18T11:00:00Z",
  deleted_at: null
};

const DELETED_PERSON = { ...PERSON, id: "person-deleted", deleted_at: "2026-07-19T00:00:00Z" };

const STATEMENT = {
  id: "stmt-1",
  facility_id: "fac-1",
  incident_id: "inc-1",
  person_id: "person-1",
  version_no: 1,
  statement_text: "I saw the whole thing.",
  submitted_by: "user-1",
  submitted_at: "2026-07-18T12:00:00Z",
  signed_at: null,
  deleted_at: null
};

const SIGNED_STATEMENT = { ...STATEMENT, signed_at: "2026-07-19T00:00:00Z" };

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

function mount({ memberships = MANAGER, userId = "user-1", env = {} } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerIncidentPeopleRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env, params });
    return sent[sent.length - 1];
  }
  return { call };
}

function respondBase(table, method, extra = {}) {
  return (t, m, url) => {
    if (t === "incident_reports" && m === "GET") return [INCIDENT];
    if (extra[t]) return extra[t](m, url);
    return [];
  };
}

// --- GET .../people ----------------------------------------------------------

test("GET people denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, respondBase());
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/incidents/inc-1/people");
  assert.equal(result.status, 403);
});

test("GET people 404s when the incident does not belong to the facility in the URL", async (t) => {
  stubFetch(t, respondBase());
  // A reader of fac-2 (the URL's facility) probing an incident that
  // actually belongs to fac-1 -- permission on fac-2 is held, so this
  // exercises the facility-match check itself rather than the permission
  // gate in front of it.
  const readerOfFac2 = [{ facilityId: "fac-2", status: "active", permissions: ["incidents.read"] }];
  const { call } = mount({ memberships: readerOfFac2 });
  const result = await call("GET", "/facilities/fac-2/incidents/inc-1/people");
  assert.equal(result.status, 404);
});

test("GET people 404s when the incident does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incidents/inc-1/people");
  assert.equal(result.status, 404);
});

test("GET people returns the list for a reader, excluding soft-deleted rows via the query", async (t) => {
  const captured = stubFetch(
    t,
    respondBase("incident_reports", "GET", { incident_people: () => [PERSON] })
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incidents/inc-1/people");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "person-1");
  const peopleGet = captured.find((c) => c.table === "incident_people");
  assert.match(peopleGet.url.search, /deleted_at=is\.null/);
  assert.match(peopleGet.url.search, /incident_id=eq\.inc-1/);
});

// --- POST .../people -----------------------------------------------------------

test("POST people validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, respondBase());
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people", { fullName: "No role" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST people rejects an unknown personRole with 400", async (t) => {
  stubFetch(t, respondBase());
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people", {
    personRole: "bystander",
    fullName: "Jamie Rivera"
  });
  assert.equal(result.status, 400);
});

test("POST people denies a reader without incidents.manage or incidents.review", async (t) => {
  stubFetch(t, respondBase());
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people", {
    personRole: "witness",
    fullName: "Jamie Rivera"
  });
  assert.equal(result.status, 403);
});

test("POST people succeeds for a reviewer (incidents.review, no incidents.manage)", async (t) => {
  const captured = stubFetch(
    t,
    respondBase("incident_reports", "GET", {
      incident_people: (m) => (m === "POST" ? [PERSON] : []),
      incident_audit_events: () => []
    })
  );
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people", {
    personRole: "witness",
    fullName: "Jamie Rivera"
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.id, "person-1");
  const insert = captured.find((c) => c.table === "incident_people" && c.method === "POST");
  assert.equal(insert.body[0].incident_id, "inc-1");
  assert.equal(insert.body[0].facility_id, "fac-1");
  const audit = captured.find((c) => c.table === "incident_audit_events");
  assert.equal(audit.body[0].event_type, "incident.person_added");
});

test("POST people 404s when the incident does not belong to the facility in the URL", async (t) => {
  stubFetch(t, respondBase());
  const managerOfFac2 = [{ facilityId: "fac-2", status: "active", permissions: ["incidents.read", "incidents.manage"] }];
  const { call } = mount({ memberships: managerOfFac2 });
  const result = await call("POST", "/facilities/fac-2/incidents/inc-1/people", {
    personRole: "witness",
    fullName: "Jamie Rivera"
  });
  assert.equal(result.status, 404);
});

test("POST people returns 500 and does not swallow an audit write failure", async (t) => {
  stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people" && m === "POST") return [PERSON];
    if (t2 === "incident_audit_events") throw new Error("boom");
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people", {
    personRole: "witness",
    fullName: "Jamie Rivera"
  });
  assert.equal(result.status, 500);
});

// --- PATCH .../people/:personId --------------------------------------------

test("PATCH person 404s when the person does not belong to the incident", async (t) => {
  stubFetch(
    t,
    respondBase("incident_reports", "GET", { incident_people: () => [{ ...PERSON, incident_id: "inc-999" }] })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/incidents/inc-1/people/person-1", { fullName: "New name" });
  assert.equal(result.status, 404);
});

test("PATCH person 409s when the person was already removed", async (t) => {
  stubFetch(
    t,
    respondBase("incident_reports", "GET", { incident_people: () => [DELETED_PERSON] })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/incidents/inc-1/people/person-deleted", {
    fullName: "New name"
  });
  assert.equal(result.status, 409);
});

test("PATCH person updates only the provided fields", async (t) => {
  const captured = stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people" && m === "GET") return [PERSON];
    if (t2 === "incident_people" && m === "PATCH") return [{ ...PERSON, full_name: "Updated Name" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/incidents/inc-1/people/person-1", {
    fullName: "Updated Name"
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.full_name, "Updated Name");
  const patch = captured.find((c) => c.table === "incident_people" && c.method === "PATCH");
  assert.equal(patch.body.full_name, "Updated Name");
  assert.equal(patch.body.person_role, undefined);
});

// --- DELETE .../people/:personId -------------------------------------------

test("DELETE person soft-deletes and audits the removal", async (t) => {
  const captured = stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people" && m === "GET") return [PERSON];
    if (t2 === "incident_people" && m === "PATCH") return [{ ...PERSON, deleted_at: "2026-07-20T00:00:00Z" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("DELETE", "/facilities/fac-1/incidents/inc-1/people/person-1");
  assert.equal(result.status, 200);
  assert.ok(result.payload.deleted_at);
  const patch = captured.find((c) => c.table === "incident_people" && c.method === "PATCH");
  assert.ok(patch.body.deleted_at);
  const audit = captured.find((c) => c.table === "incident_audit_events");
  assert.equal(audit.body[0].event_type, "incident.person_removed");
});

test("DELETE person 409s on an already-removed person", async (t) => {
  stubFetch(t, respondBase("incident_reports", "GET", { incident_people: () => [DELETED_PERSON] }));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("DELETE", "/facilities/fac-1/incidents/inc-1/people/person-deleted");
  assert.equal(result.status, 409);
});

// --- GET .../statements ------------------------------------------------------

test("GET statements 404s when the person does not belong to the facility", async (t) => {
  stubFetch(t, respondBase("incident_reports", "GET", { incident_people: () => [{ ...PERSON, facility_id: "fac-2" }] }));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incidents/inc-1/people/person-1/statements");
  assert.equal(result.status, 404);
});

test("GET statements returns versions oldest-first for a reader", async (t) => {
  const captured = stubFetch(
    t,
    respondBase("incident_reports", "GET", {
      incident_people: () => [PERSON],
      incident_witness_statements: () => [STATEMENT]
    })
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incidents/inc-1/people/person-1/statements");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "incident_witness_statements" && c.method === "GET");
  assert.match(get.url.search, /order=version_no\.asc/);
});

// --- POST .../statements -----------------------------------------------------

test("POST statement validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, respondBase());
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST statement denies a reader without incidents.manage or incidents.review", async (t) => {
  stubFetch(t, respondBase("incident_reports", "GET", { incident_people: () => [PERSON] }));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements", {
    statementText: "Saw it happen."
  });
  assert.equal(result.status, 403);
});

test("POST statement 409s when the person has been removed", async (t) => {
  stubFetch(t, respondBase("incident_reports", "GET", { incident_people: () => [DELETED_PERSON] }));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-deleted/statements", {
    statementText: "Saw it happen."
  });
  assert.equal(result.status, 409);
});

test("POST statement computes version_no as max(existing)+1", async (t) => {
  const captured = stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people") return [PERSON];
    if (t2 === "incident_witness_statements" && m === "GET") {
      return [
        { version_no: 1, signed_at: null },
        { version_no: 2, signed_at: null }
      ];
    }
    if (t2 === "incident_witness_statements" && m === "POST") return [{ ...STATEMENT, version_no: 3 }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements", {
    statementText: "Third version."
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.version_no, 3);
  const insert = captured.find((c) => c.table === "incident_witness_statements" && c.method === "POST");
  assert.equal(insert.body[0].version_no, 3);
  assert.equal(insert.body[0].submitted_by, "user-1");
});

test("POST statement first version defaults to version_no 1 when none exist", async (t) => {
  const captured = stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people") return [PERSON];
    if (t2 === "incident_witness_statements" && m === "GET") return [];
    if (t2 === "incident_witness_statements" && m === "POST") return [STATEMENT];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements", {
    statementText: "First version."
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_witness_statements" && c.method === "POST");
  assert.equal(insert.body[0].version_no, 1);
});

test("POST statement 409s once any existing version is signed", async (t) => {
  const captured = stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people") return [PERSON];
    if (t2 === "incident_witness_statements" && m === "GET") {
      return [{ version_no: 1, signed_at: "2026-07-19T00:00:00Z" }];
    }
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements", {
    statementText: "Attempted second version."
  });
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.table === "incident_witness_statements" && c.method === "POST"));
});

// --- POST .../statements/:statementId/sign ----------------------------------

test("POST sign denies a reader without incidents.manage or incidents.review", async (t) => {
  stubFetch(
    t,
    respondBase("incident_reports", "GET", { incident_people: () => [PERSON] })
  );
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements/stmt-1/sign");
  assert.equal(result.status, 403);
});

test("POST sign 404s when the statement does not belong to the person", async (t) => {
  stubFetch(
    t,
    respondBase("incident_reports", "GET", {
      incident_people: () => [PERSON],
      incident_witness_statements: () => [{ ...STATEMENT, person_id: "person-999" }]
    })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements/stmt-1/sign");
  assert.equal(result.status, 404);
});

test("POST sign 409s when the statement is already signed", async (t) => {
  stubFetch(
    t,
    respondBase("incident_reports", "GET", {
      incident_people: () => [PERSON],
      incident_witness_statements: () => [SIGNED_STATEMENT]
    })
  );
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements/stmt-1/sign");
  assert.equal(result.status, 409);
});

test("POST sign succeeds for a reviewer and writes an audit event", async (t) => {
  const captured = stubFetch(t, (t2, m) => {
    if (t2 === "incident_reports") return [INCIDENT];
    if (t2 === "incident_people") return [PERSON];
    if (t2 === "incident_witness_statements" && m === "GET") return [STATEMENT];
    if (t2 === "incident_witness_statements" && m === "PATCH") return [SIGNED_STATEMENT];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/people/person-1/statements/stmt-1/sign");
  assert.equal(result.status, 200);
  assert.ok(result.payload.signed_at);
  const patch = captured.find((c) => c.table === "incident_witness_statements" && c.method === "PATCH");
  assert.ok(patch.body.signed_at);
  const audit = captured.find((c) => c.table === "incident_audit_events");
  assert.equal(audit.body[0].event_type, "incident.statement_signed");
});
