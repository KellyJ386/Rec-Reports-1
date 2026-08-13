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
    if (table === "messages" && method === "POST") return [{ id: "msg-2" }];
    return [];
  });
  const { call } = mount({ userId: "emp-99" });
  const result = await call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-1",
    subject: "Alert",
    bodyText: "Staff meeting",
    priority: "urgent"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "messages" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].channel_id, "ch-1");
  assert.equal(insert.body[0].subject, "Alert");
  assert.equal(insert.body[0].body_text, "Staff meeting");
  assert.equal(insert.body[0].priority, "urgent");
  assert.equal(insert.body[0].author_employee_id, "emp-99");
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
