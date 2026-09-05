import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerCommunicationRoutes } from "../src/lib/http/communications-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const CREATOR = [
  { facilityId: "fac-1", status: "active", permissions: ["communications.read", "communications.publish"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["communications.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["communications.read"] }];

const MESSAGE = {
  id: "msg-1",
  facility_id: "fac-1",
  channel_id: "ch-1",
  author_employee_id: "emp-1",
  message_type: "announcement",
  subject: "Daily Briefing",
  body_text: "Team standup at 9am",
  priority: "normal",
  is_required_ack: false,
  ack_due_at: null,
  published_at: "2026-07-18T08:00:00Z",
  created_at: "2026-07-18T08:00:00Z",
  updated_at: "2026-07-18T08:00:00Z"
};

// A not-yet-published message for the CM-03 publish-flow tests below.
const DRAFT_MESSAGE = {
  ...MESSAGE,
  id: "msg-draft",
  priority: "urgent",
  published_at: null
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
  registerCommunicationRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET /facilities/:facilityId/messages denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/messages");
  assert.equal(result.status, 403);
});

test("GET /facilities/:facilityId/messages returns 200 for a reader", async (t) => {
  const captured = stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/messages");
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.payload));
});

test("GET /facilities/:facilityId/messages?status=published filters published_at with a PostgREST is-null operator, not eq.not-null", async (t) => {
  const captured = stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/messages?status=published");
  assert.equal(result.status, 200);
  const messagesCall = captured.find((c) => c.table === "messages");
  assert.equal(messagesCall.url.searchParams.get("published_at"), "not.is.null");
});

test("GET /facilities/:facilityId/messages?status=draft filters published_at with is.null", async (t) => {
  const captured = stubFetch(t, (table) => (table === "messages" ? [DRAFT_MESSAGE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/messages?status=draft");
  assert.equal(result.status, 200);
  const messagesCall = captured.find((c) => c.table === "messages");
  assert.equal(messagesCall.url.searchParams.get("published_at"), "is.null");
});

test("POST /facilities/:facilityId/messages validates shape before guard (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/messages", { subject: "No channel" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST /facilities/:facilityId/messages denies a reader without communications.publish", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-1",
    subject: "Test",
    bodyText: "Body"
  });
  assert.equal(result.status, 403);
});

test("POST /facilities/:facilityId/messages happy path inserts a shaped row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "messages" && method === "POST") return [{ id: "msg-2" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-1",
    subject: "Alert",
    bodyText: "Staff meeting",
    priority: "urgent"
  });
  assert.equal(result.status, 201);

  const employeeLookup = captured.find((c) => c.table === "employees" && c.method === "GET");
  assert.ok(employeeLookup, "expected a lookup of the caller's employee row");
  assert.equal(employeeLookup.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(employeeLookup.url.searchParams.get("user_id"), "eq.user-42");

  const insert = captured.find((c) => c.table === "messages" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].channel_id, "ch-1");
  assert.equal(insert.body[0].subject, "Alert");
  assert.equal(insert.body[0].body_text, "Staff meeting");
  assert.equal(insert.body[0].priority, "urgent");
  // author_employee_id must be the resolved employees.id (RLS WITH CHECK
  // validates it via fn_assert_same_facility against the employees table),
  // NEVER the caller's raw auth user id.
  assert.equal(insert.body[0].author_employee_id, "emp-own-row");
});

test("POST /facilities/:facilityId/messages returns 404 when the caller has no employee row in the facility", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ userId: "user-ghost" });
  const result = await call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-1",
    subject: "Alert",
    bodyText: "Staff meeting"
  });
  assert.equal(result.status, 404);
  assert.ok(!captured.some((c) => c.table === "messages" && c.method === "POST"));
});

test("POST /messages/:id/acknowledge resolves the caller's own employee row and inserts an acknowledgement row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [MESSAGE];
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "message_acknowledgements" && method === "POST") return [{ id: "ack-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("POST", "/messages/msg-1/acknowledge");
  assert.equal(result.status, 201);

  const employeeLookup = captured.find((c) => c.table === "employees" && c.method === "GET");
  assert.ok(employeeLookup, "expected a lookup of the caller's employee row");
  assert.equal(employeeLookup.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(employeeLookup.url.searchParams.get("user_id"), "eq.user-42");

  const insert = captured.find((c) => c.table === "message_acknowledgements" && c.method === "POST");
  assert.equal(insert.body[0].message_id, "msg-1");
  // employee_id must be the resolved employees.id, NOT the caller's auth user id --
  // RLS keys ownership off employees.user_id = auth.uid(), which is a different value.
  assert.equal(insert.body[0].employee_id, "emp-own-row");
  assert.notEqual(insert.body[0].employee_id, "user-42");
  assert.equal(insert.body[0].ack_state, "acknowledged");
  assert.ok(insert.body[0].acknowledged_at);
});

test("POST /messages/:id/acknowledge denies with 403 when the caller has no employee record in the facility", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [MESSAGE];
    if (table === "employees" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ userId: "user-no-employee" });
  const result = await call("POST", "/messages/msg-1/acknowledge");
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "message_acknowledgements"));
});

test("GET /messages/:id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/messages/nope");
  assert.equal(result.status, 404);
});

test("POST /messages/:id/acknowledge denies a non-reader", async (t) => {
  stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/messages/msg-1/acknowledge");
  assert.equal(result.status, 403);
});

// --- Message audiences (CM-02) -----------------------------------------------

test("GET /messages/:id/audiences returns list of audiences", async (t) => {
  const audiences = [
    { id: "aud-1", message_id: "msg-1", audience_type: "role", audience_ref_id: "role-1" },
    { id: "aud-2", message_id: "msg-1", audience_type: "department", audience_ref_id: "dept-1" }
  ];
  const captured = stubFetch(t, (table) => {
    if (table === "messages") return [MESSAGE];
    if (table === "message_audiences") return audiences;
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/messages/msg-1/audiences");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 2);
  assert.equal(result.payload[0].audience_type, "role");
});

test("GET /messages/:id/audiences denies non-reader with 403", async (t) => {
  stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/messages/msg-1/audiences");
  assert.equal(result.status, 403);
});

test("GET /messages/:id/audiences 404s when message missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/messages/nope/audiences");
  assert.equal(result.status, 404);
});

test("POST /messages/:id/audiences validates body is array", async (t) => {
  stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/messages/msg-1/audiences", { audienceType: "role" });
  assert.equal(result.status, 400);
  assert.equal(result.payload.error, "body must be an array");
});

test("POST /messages/:id/audiences rejects invalid audienceType with 400", async (t) => {
  const captured = stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/messages/msg-1/audiences", [
    { audienceType: "invalid", audienceRefId: "ref-1" }
  ]);
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors);
  // Verify no fetches beyond message lookup
  assert.equal(captured.length, 1, "should only fetch messages");
});

test("POST /messages/:id/audiences denies non-publisher with 403", async (t) => {
  stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/messages/msg-1/audiences", [
    { audienceType: "role", audienceRefId: "role-1" }
  ]);
  assert.equal(result.status, 403);
});

test("POST /messages/:id/audiences happy path inserts shaped rows", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages") return [MESSAGE];
    if (table === "roles") return [{ id: "role-1", facility_id: "fac-1" }];
    if (table === "departments") return [{ id: "dept-1", facility_id: "fac-1" }];
    if (table === "message_audiences" && method === "POST") return [{ id: "aud-1" }, { id: "aud-2" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/messages/msg-1/audiences", [
    { audienceType: "role", audienceRefId: "role-1" },
    { audienceType: "department", audienceRefId: "dept-1" }
  ]);
  assert.equal(result.status, 201);
  assert.equal(result.payload.length, 2);

  const insert = captured.find((c) => c.table === "message_audiences" && c.method === "POST");
  assert.ok(insert, "expected message_audiences POST");
  assert.equal(insert.body.length, 2);
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].message_id, "msg-1");
  assert.equal(insert.body[0].audience_type, "role");
  assert.equal(insert.body[0].audience_ref_id, "role-1");
  assert.equal(insert.body[1].audience_type, "department");
});

test("POST /messages/:id/audiences rejects a cross-facility ref with 400 (S-8)", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "messages") return [MESSAGE];
    // role-1 belongs to a different facility than the message (fac-1).
    if (table === "roles") return [{ id: "role-1", facility_id: "fac-2" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/messages/msg-1/audiences", [
    { audienceType: "role", audienceRefId: "role-1" }
  ]);
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /does not belong to this facility/);
  assert.ok(!captured.some((c) => c.table === "message_audiences"), "must not insert on a cross-facility ref");
});

test("POST /messages/:id/audiences rejects a nonexistent ref with 400 (S-8)", async (t) => {
  const captured = stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/messages/msg-1/audiences", [
    { audienceType: "employee", audienceRefId: "emp-missing" }
  ]);
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /not found/);
  assert.ok(!captured.some((c) => c.table === "message_audiences"));
});

test("POST /messages/:id/audiences denies non-publisher from different facility", async (t) => {
  stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/messages/msg-1/audiences", [
    { audienceType: "role", audienceRefId: "role-1" }
  ]);
  assert.equal(result.status, 403);
});

// --- Communication channels (CM-04) ------------------------------------------

test("GET /facilities/:facilityId/channels returns list", async (t) => {
  const channels = [
    { id: "ch-1", facility_id: "fac-1", name: "Announcements", channel_type: "facility" },
    { id: "ch-2", facility_id: "fac-1", name: "Urgent", channel_type: "facility" }
  ];
  const captured = stubFetch(t, (table) => (table === "communication_channels" ? channels : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/channels");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 2);
  assert.equal(result.payload[0].name, "Announcements");
});

test("GET /facilities/:facilityId/channels denies non-reader with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/channels");
  assert.equal(result.status, 403);
});

test("POST /facilities/:facilityId/channels validates name required", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/channels", { type: "facility" });
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors.some((e) => e.includes("name")));
});

test("POST /facilities/:facilityId/channels validates type required", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/channels", { name: "Test" });
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors.some((e) => e.includes("type")));
});

test("POST /facilities/:facilityId/channels denies non-publisher with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/channels", {
    name: "Test Channel",
    type: "facility"
  });
  assert.equal(result.status, 403);
});

test("POST /facilities/:facilityId/channels happy path creates channel", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "communication_channels" && method === "POST")
      return [{ id: "ch-new", facility_id: "fac-1", name: "Test Channel", channel_type: "facility" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/channels", {
    name: "Test Channel",
    type: "facility",
    departmentId: "dept-1",
    shiftScoped: true,
    emergencyEnabled: false
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.name, "Test Channel");

  const insert = captured.find((c) => c.table === "communication_channels" && c.method === "POST");
  assert.ok(insert, "expected communication_channels POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].name, "Test Channel");
  assert.equal(insert.body[0].channel_type, "facility");
  assert.equal(insert.body[0].department_id, "dept-1");
  assert.equal(insert.body[0].shift_scoped, true);
  assert.equal(insert.body[0].emergency_enabled, false);
});

test("POST /facilities/:facilityId/channels maps a real PostgrestError 409 to a friendly conflict response", async (t) => {
  // Exercises the actual pgInsert -> PostgrestError path (a non-ok PostgREST
  // response, as a real unique-constraint violation on (facility_id, name)
  // would produce), not a hand-thrown plain Error -- the route must catch
  // via `instanceof PostgrestError`, not by pattern-matching error.message.
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const table = new URL(url).pathname.replace("/rest/v1/", "");
    if (table === "communication_channels") {
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ message: "duplicate key value violates unique constraint" })
      };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/channels", {
    name: "Duplicate",
    type: "facility"
  });
  assert.equal(result.status, 409);
  assert.equal(result.payload.error, "channel with this name already exists in this facility");
});

test("POST /facilities/:facilityId/channels rethrows a non-409 PostgrestError instead of masking it as a conflict", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const table = new URL(url).pathname.replace("/rest/v1/", "");
    if (table === "communication_channels") {
      return { ok: false, status: 500, text: async () => JSON.stringify({ message: "internal error" }) };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount({ memberships: CREATOR });
  await assert.rejects(
    () => call("POST", "/facilities/fac-1/channels", { name: "Whatever", type: "facility" }),
    /PostgREST POST communication_channels failed with status 500/
  );
});

// --- Message receipts (CM-05) ------------------------------------------------

test("POST /messages/:id/receipt upserts delivery marker for caller", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages") return [MESSAGE];
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "message_receipts" && method === "POST") return [{ id: "receipt-1", delivered_at: "2026-07-18T10:00:00Z" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("POST", "/messages/msg-1/receipt", { deliveredAt: "2026-07-18T10:00:00Z" });
  assert.equal(result.status, 200);

  const insert = captured.find((c) => c.table === "message_receipts" && c.method === "POST");
  assert.ok(insert, "expected message_receipts POST");
  assert.equal(insert.body[0].message_id, "msg-1");
  assert.equal(insert.body[0].employee_id, "emp-own-row");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].delivered_at, "2026-07-18T10:00:00Z");
});

test("POST /messages/:id/receipt idempotent on double-call", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages") return [MESSAGE];
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "message_receipts" && method === "POST") {
      return [{ id: "receipt-1", message_id: "msg-1", employee_id: "emp-own-row", read_at: "2026-07-18T11:00:00Z" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result1 = await call("POST", "/messages/msg-1/receipt", { deliveredAt: "2026-07-18T10:00:00Z" });
  const result2 = await call("POST", "/messages/msg-1/receipt", { readAt: "2026-07-18T11:00:00Z" });
  assert.equal(result1.status, 200);
  assert.equal(result2.status, 200);
});

test("POST /messages/:id/receipt denies non-member with 403", async (t) => {
  stubFetch(t, (table) => (table === "messages" ? [MESSAGE] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/messages/msg-1/receipt", { deliveredAt: "2026-07-18T10:00:00Z" });
  assert.equal(result.status, 403);
});

test("POST /messages/:id/receipt denies when no employee record", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "messages") return [MESSAGE];
    if (table === "employees") return [];
    return [];
  });
  const { call } = mount({ userId: "user-no-employee" });
  const result = await call("POST", "/messages/msg-1/receipt", { deliveredAt: "2026-07-18T10:00:00Z" });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "message_receipts"));
});

test("POST /messages/:id/receipt 404s when message missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/messages/nope/receipt", { deliveredAt: "2026-07-18T10:00:00Z" });
  assert.equal(result.status, 404);
});

// --- Publish flow (CM-03) -----------------------------------------------------

test("POST .../messages/:id/publish resolves department+employee audiences, publishes, and enqueues a shaped job", async (t) => {
  const audiences = [
    { id: "aud-1", message_id: "msg-draft", audience_type: "department", audience_ref_id: "dept-1" },
    { id: "aud-2", message_id: "msg-draft", audience_type: "employee", audience_ref_id: "emp-5" }
  ];
  const employees = [
    { id: "emp-1", department_id: "dept-1", user_id: "user-1" },
    { id: "emp-2", department_id: "dept-2", user_id: "user-2" }
  ];
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [DRAFT_MESSAGE];
    if (table === "messages" && method === "PATCH") return [{ ...DRAFT_MESSAGE, published_at: "2026-08-13T00:00:00Z" }];
    if (table === "message_audiences" && method === "GET") return audiences;
    if (table === "employees" && method === "GET") return employees;
    if (table === "notification_jobs" && method === "POST") return [{ id: "job-1" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages/msg-draft/publish", {});
  assert.equal(result.status, 200);
  assert.ok(result.payload.publishedAt);
  assert.equal(result.payload.recipientCount, 2);
  assert.deepEqual(result.payload.unresolvedAudiences, []);

  const patch = captured.find((c) => c.table === "messages" && c.method === "PATCH");
  assert.ok(patch, "expected messages PATCH");
  assert.equal(patch.url.searchParams.get("id"), "eq.msg-draft");
  assert.ok(patch.body.published_at);

  const jobInsert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.ok(jobInsert, "expected notification_jobs POST");
  assert.equal(jobInsert.body[0].facility_id, "fac-1");
  assert.equal(jobInsert.body[0].event_type, "message.published");
  assert.equal(jobInsert.body[0].status, "pending");
  // department dept-1 resolves emp-1 only (emp-2 is in dept-2); employee
  // audience emp-5 passes through directly; recipients dedup+sort.
  assert.deepEqual(jobInsert.body[0].payload_jsonb.recipients, ["emp-1", "emp-5"]);
  // priority 'urgent' -> in_app + push, and bypasses quiet hours.
  assert.deepEqual(jobInsert.body[0].payload_jsonb.channels, ["in_app", "push"]);
  assert.equal(jobInsert.body[0].payload_jsonb.quietHoursBypass, true);
  assert.equal(jobInsert.body[0].payload_jsonb.messageId, "msg-draft");
});

test("POST .../messages/:id/publish resolves a role audience via memberships joined to employees", async (t) => {
  const audiences = [{ id: "aud-1", message_id: "msg-draft", audience_type: "role", audience_ref_id: "role-1" }];
  const employees = [
    { id: "emp-1", department_id: "dept-1", user_id: "user-1" },
    { id: "emp-2", department_id: "dept-2", user_id: "user-2" }
  ];
  const memberships = [{ user_id: "user-1", role_id: "role-1" }];
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [DRAFT_MESSAGE];
    if (table === "messages" && method === "PATCH") return [DRAFT_MESSAGE];
    if (table === "message_audiences" && method === "GET") return audiences;
    if (table === "employees" && method === "GET") return employees;
    if (table === "memberships" && method === "GET") return memberships;
    if (table === "notification_jobs" && method === "POST") return [{ id: "job-1" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages/msg-draft/publish", {});
  assert.equal(result.status, 200);
  assert.equal(result.payload.recipientCount, 1);

  const membershipLookup = captured.find((c) => c.table === "memberships" && c.method === "GET");
  assert.ok(membershipLookup, "expected a memberships lookup for the role audience");
  assert.equal(membershipLookup.url.searchParams.get("role_id"), "in.(role-1)");

  const jobInsert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.deepEqual(jobInsert.body[0].payload_jsonb.recipients, ["emp-1"]);
});

test("POST .../messages/:id/publish reports shift audiences unresolved when no shiftWindow is supplied", async (t) => {
  const audiences = [
    { id: "aud-1", message_id: "msg-draft", audience_type: "shift", audience_ref_id: "shift-1" },
    { id: "aud-2", message_id: "msg-draft", audience_type: "employee", audience_ref_id: "emp-5" }
  ];
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [DRAFT_MESSAGE];
    if (table === "messages" && method === "PATCH") return [DRAFT_MESSAGE];
    if (table === "message_audiences" && method === "GET") return audiences;
    if (table === "notification_jobs" && method === "POST") return [{ id: "job-1" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages/msg-draft/publish", {});
  assert.equal(result.status, 200);
  assert.equal(result.payload.recipientCount, 1);
  assert.equal(result.payload.unresolvedAudiences.length, 1);
  assert.equal(result.payload.unresolvedAudiences[0].audienceType, "shift");
  assert.equal(result.payload.unresolvedAudiences[0].audienceRefId, "shift-1");
  // No shift_assignments query should have been issued without a shiftWindow.
  assert.ok(!captured.some((c) => c.table === "shift_assignments"));

  const jobInsert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.deepEqual(jobInsert.body[0].payload_jsonb.recipients, ["emp-5"]);
});

test("POST .../messages/:id/publish resolves shift audiences against shift_assignments when shiftWindow is supplied", async (t) => {
  const audiences = [{ id: "aud-1", message_id: "msg-draft", audience_type: "shift", audience_ref_id: "shift-1" }];
  const shiftAssignments = [{ shift_id: "shift-1", employee_id: "emp-9" }];
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [DRAFT_MESSAGE];
    if (table === "messages" && method === "PATCH") return [DRAFT_MESSAGE];
    if (table === "message_audiences" && method === "GET") return audiences;
    if (table === "shift_assignments" && method === "GET") return shiftAssignments;
    if (table === "notification_jobs" && method === "POST") return [{ id: "job-1" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages/msg-draft/publish", {
    shiftWindow: { start: "2026-08-13T00:00:00Z", end: "2026-08-13T23:59:59Z" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.recipientCount, 1);
  assert.deepEqual(result.payload.unresolvedAudiences, []);

  const jobInsert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.deepEqual(jobInsert.body[0].payload_jsonb.recipients, ["emp-9"]);
});

test("POST .../messages/:id/publish returns 409 when the message is already published", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [MESSAGE];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages/msg-1/publish", {});
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.table === "message_audiences"));
  assert.ok(!captured.some((c) => c.table === "notification_jobs"));
});

test("POST .../messages/:id/publish denies a non-publisher with 403", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [DRAFT_MESSAGE];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/messages/msg-draft/publish", {});
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "message_audiences"));
  assert.ok(!captured.some((c) => c.table === "notification_jobs"));
});

test("POST .../messages/:id/publish 404s when message missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages/nope/publish", {});
  assert.equal(result.status, 404);
});

test("POST .../messages/:id/publish 404s when the message belongs to a different facility", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "messages" && method === "GET") return [DRAFT_MESSAGE];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-2/messages/msg-draft/publish", {});
  assert.equal(result.status, 404);
});

// --- Create route: draft-then-publish (CM-03) --------------------------------

test("POST /facilities/:facilityId/messages defaults to a draft (published_at null)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "messages" && method === "POST") return [{ id: "msg-new" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-1",
    subject: "Draft",
    bodyText: "Body"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "messages" && c.method === "POST");
  assert.equal(insert.body[0].published_at, null);
});

// --- Device tokens (CM-07) ----------------------------------------------------

test("POST /me/device-tokens registers the caller's own token, resolved via loadCallerEmployeeId", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "employee_device_tokens" && method === "POST") return [{ id: "dt-1", token: "tok-abc" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("POST", "/me/device-tokens", { facilityId: "fac-1", platform: "ios", token: "tok-abc" });
  assert.equal(result.status, 201);

  const employeeLookup = captured.find((c) => c.table === "employees" && c.method === "GET");
  assert.equal(employeeLookup.url.searchParams.get("user_id"), "eq.user-42");

  const insert = captured.find((c) => c.table === "employee_device_tokens" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  // employee_id must be the resolved employees.id, never the caller's raw auth user id.
  assert.equal(insert.body[0].employee_id, "emp-own-row");
  assert.equal(insert.body[0].platform, "ios");
  assert.equal(insert.body[0].token, "tok-abc");
  assert.ok(insert.body[0].last_seen_at);
  assert.equal(insert.body[0].revoked_at, null);
  // Re-registering the same token must upsert on the token column, not duplicate.
  assert.equal(insert.url.searchParams.get("on_conflict"), "token");
});

test("POST /me/device-tokens ignores a body-supplied employeeId and always resolves the caller's own row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-real-owner" }];
    if (table === "employee_device_tokens" && method === "POST") return [{ id: "dt-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  await call("POST", "/me/device-tokens", {
    facilityId: "fac-1",
    platform: "android",
    token: "tok-xyz",
    employeeId: "emp-someone-else"
  });
  const insert = captured.find((c) => c.table === "employee_device_tokens" && c.method === "POST");
  assert.equal(insert.body[0].employee_id, "emp-real-owner");
  assert.notEqual(insert.body[0].employee_id, "emp-someone-else");
});

test("POST /me/device-tokens validates shape before any facility check", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/me/device-tokens", { platform: "ios" });
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors.some((e) => e.includes("facilityId")));
  assert.ok(result.payload.errors.some((e) => e.includes("token")));
  assert.equal(captured.length, 0);
});

test("POST /me/device-tokens denies a caller who is not a member of the facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/me/device-tokens", { facilityId: "fac-1", platform: "ios", token: "tok-1" });
  assert.equal(result.status, 403);
});

test("POST /me/device-tokens denies with 403 when the caller has no employee record in the facility", async (t) => {
  const captured = stubFetch(t, (table) => (table === "employees" ? [] : []));
  const { call } = mount({ userId: "user-no-employee" });
  const result = await call("POST", "/me/device-tokens", { facilityId: "fac-1", platform: "ios", token: "tok-1" });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "employee_device_tokens"));
});

test("DELETE /me/device-tokens/:id revokes the caller's own token, scoped by their resolved employee id", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "employee_device_tokens" && method === "PATCH") return [{ id: "dt-1", revoked_at: "2026-08-14T00:00:00Z" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("DELETE", "/me/device-tokens/dt-1?facilityId=fac-1");
  assert.equal(result.status, 200);

  const patch = captured.find((c) => c.table === "employee_device_tokens" && c.method === "PATCH");
  assert.equal(patch.url.searchParams.get("id"), "eq.dt-1");
  assert.equal(patch.url.searchParams.get("employee_id"), "eq.emp-own-row");
  assert.ok(patch.body.revoked_at);
});

test("DELETE /me/device-tokens/:id 404s when the update matches no row (not owned by the caller)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "employee_device_tokens" && method === "PATCH") return []; // employee_id filter matched nothing
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("DELETE", "/me/device-tokens/dt-not-mine?facilityId=fac-1");
  assert.equal(result.status, 404);
});

test("DELETE /me/device-tokens/:id requires a facilityId query parameter", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("DELETE", "/me/device-tokens/dt-1");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("DELETE /me/device-tokens/:id denies a caller who is not a member of the facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("DELETE", "/me/device-tokens/dt-1?facilityId=fac-1");
  assert.equal(result.status, 403);
});

// --- Notification preferences (CM-07) -------------------------------------------

test("GET /me/notification-preferences returns shipped defaults when no row exists yet", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("GET", "/me/notification-preferences?facilityId=fac-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.push_enabled, true);
  assert.equal(result.payload.quiet_hours_start, null);
  assert.equal(result.payload.employee_id, "emp-own-row");
});

test("GET /me/notification-preferences returns the caller's existing row when one exists", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "employee_notification_preferences" && method === "GET") {
      return [{ id: "pref-1", facility_id: "fac-1", employee_id: "emp-own-row", push_enabled: false }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("GET", "/me/notification-preferences?facilityId=fac-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.id, "pref-1");
  assert.equal(result.payload.push_enabled, false);
});

test("GET /me/notification-preferences requires a facilityId query parameter", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/me/notification-preferences");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET /me/notification-preferences denies a caller who is not a member of the facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/me/notification-preferences?facilityId=fac-1");
  assert.equal(result.status, 403);
});

test("PUT /me/notification-preferences upserts the caller's own row (round trip)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "employee_notification_preferences" && method === "POST") {
      return [{ id: "pref-1", facility_id: "fac-1", employee_id: "emp-own-row", push_enabled: false, quiet_hours_start: "20:00", quiet_hours_end: "07:00" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  const result = await call("PUT", "/me/notification-preferences", {
    facilityId: "fac-1",
    pushEnabled: false,
    quietHoursStart: "20:00",
    quietHoursEnd: "07:00"
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.push_enabled, false);

  const upsert = captured.find((c) => c.table === "employee_notification_preferences" && c.method === "POST");
  assert.equal(upsert.body[0].facility_id, "fac-1");
  assert.equal(upsert.body[0].employee_id, "emp-own-row");
  assert.equal(upsert.body[0].push_enabled, false);
  assert.equal(upsert.body[0].quiet_hours_start, "20:00");
  assert.equal(upsert.body[0].in_app_enabled, true); // omitted -> shipped default
  assert.equal(upsert.url.searchParams.get("on_conflict"), "facility_id,employee_id");
});

test("PUT /me/notification-preferences ignores a body-supplied employeeId and always resolves the caller's own row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-real-owner" }];
    if (table === "employee_notification_preferences" && method === "POST") return [{ id: "pref-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-42" });
  await call("PUT", "/me/notification-preferences", { facilityId: "fac-1", employeeId: "emp-someone-else", pushEnabled: true });
  const upsert = captured.find((c) => c.table === "employee_notification_preferences" && c.method === "POST");
  assert.equal(upsert.body[0].employee_id, "emp-real-owner");
});

test("PUT /me/notification-preferences requires facilityId in the body", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PUT", "/me/notification-preferences", { pushEnabled: true });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PUT /me/notification-preferences denies a caller who is not a member of the facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("PUT", "/me/notification-preferences", { facilityId: "fac-1", pushEnabled: true });
  assert.equal(result.status, 403);
});

test("POST /facilities/:facilityId/messages publishes immediately with legacy publishNow:true", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [{ id: "emp-own-row" }];
    if (table === "messages" && method === "POST") return [{ id: "msg-new" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-1",
    subject: "Immediate",
    bodyText: "Body",
    publishNow: true
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "messages" && c.method === "POST");
  assert.ok(insert.body[0].published_at, "expected published_at to be stamped");
});
