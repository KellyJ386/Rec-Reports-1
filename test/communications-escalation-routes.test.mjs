import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerCommunicationsEscalationRoutes } from "../src/lib/http/communications-escalation-routes.mjs";
import { registerCommunicationRoutes } from "../src/lib/http/communications-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const PUBLISHER = [
  { facilityId: "fac-1", status: "active", permissions: ["communications.read", "communications.publish"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["communications.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["communications.read", "communications.publish"] }];
const NO_COMMS = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];

const DRAFT_EMERGENCY = {
  id: "msg-e",
  facility_id: "fac-1",
  channel_id: "ch-em",
  author_employee_id: "emp-me",
  subject: "Severe weather",
  body_text: "Move indoors now",
  priority: "emergency",
  is_required_ack: false,
  ack_due_at: null,
  published_at: null,
  deleted_at: null
};
const PUBLISHED_EMERGENCY = { ...DRAFT_EMERGENCY, published_at: "2026-08-13T12:00:00Z" };
const PENDING_LAUNCH = { id: "l-1", facility_id: "fac-1", message_id: "msg-e", requested_by_employee_id: "emp-req", status: "pending_approval" };
const AUDIENCES = [
  { id: "a1", message_id: "msg-e", audience_type: "employee", audience_ref_id: "emp-1" },
  { id: "a2", message_id: "msg-e", audience_type: "employee", audience_ref_id: "emp-2" },
  { id: "a3", message_id: "msg-e", audience_type: "employee", audience_ref_id: "emp-3" }
];

// respond(table, method, url, body) -> rows | { __status, __body }
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
    if (data && data.__status) {
      return { ok: false, status: data.__status, text: async () => JSON.stringify(data.__body ?? { message: "boom" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = PUBLISHER, userId = "user-me" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerCommunicationRoutes(router, { authenticate, sendJson, readBody });
  registerCommunicationsEscalationRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body, { raw = null } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: raw !== null ? raw : body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call, sent };
}

// Default world: the caller is employee emp-me; channel ch-em is emergency-enabled.
function world(overrides = {}) {
  return (table, method, url) => {
    if (overrides[`${table} ${method}`]) return overrides[`${table} ${method}`](url);
    if (table === "messages" && method === "GET") return [DRAFT_EMERGENCY];
    if (table === "employees" && method === "GET") return [{ id: "emp-me", first_name: "Pat", last_name: "Lee" }];
    if (table === "communication_channels" && method === "GET") return [{ id: "ch-em", emergency_enabled: true }];
    if (table === "emergency_alert_launches" && method === "GET") return [];
    return [];
  };
}

// --- emergency-launch -------------------------------------------------------------

test("emergency-launch: 403 for a reader, and for a publisher of another facility", async (t) => {
  stubFetch(t, world());
  assert.equal((await mount({ memberships: READER }).call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 403);
});

test("emergency-launch: 400 on a malformed body", async (t) => {
  stubFetch(t, world());
  const result = await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", undefined, { raw: "{nope" });
  assert.equal(result.status, 400);
});

test("emergency-launch: 404 unknown message; 409 not emergency / published / channel not enabled / already requested", async (t) => {
  stubFetch(t, world({ "messages GET": () => [] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 404);

  stubFetch(t, world({ "messages GET": () => [{ ...DRAFT_EMERGENCY, priority: "urgent" }] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 409);

  stubFetch(t, world({ "messages GET": () => [PUBLISHED_EMERGENCY] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 409);

  stubFetch(t, world({ "communication_channels GET": () => [{ id: "ch-em", emergency_enabled: false }] }));
  const disabled = await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {});
  assert.equal(disabled.status, 409);
  assert.match(disabled.payload.error, /emergency-enabled/);

  stubFetch(t, world({ "emergency_alert_launches GET": () => [{ id: "l-1", status: "pending_approval" }] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 409);
});

test("emergency-launch: 403 when the caller has no employee record", async (t) => {
  stubFetch(t, world({ "employees GET": () => [] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", {})).status, 403);
});

test("emergency-launch: 201 records the request attributed to the caller's own employee", async (t) => {
  const captured = stubFetch(t, world({ "emergency_alert_launches POST": () => [{ id: "l-1", status: "pending_approval" }] }));
  const result = await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-launch", { requestedByEmployeeId: "emp-someone-else" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "emergency_alert_launches" && c.method === "POST");
  assert.deepEqual(insert.body, [{ facility_id: "fac-1", message_id: "msg-e", requested_by_employee_id: "emp-me" }]);
});

// --- emergency-approve --------------------------------------------------------------
// H-1b: the route makes ONE call, public.approve_emergency_launch(p_message_id). It
// writes no message, no launch row and no notification job itself -- a client session
// cannot (the 0064 guards refuse it), so the approval, the publish, the job and the
// `launched` stamp are the database function's single transaction.

const LAUNCHED_RESULT = {
  launchId: "l-1",
  status: "launched",
  publishedAt: "2026-08-13T12:00:00+00:00",
  recipientCount: 3,
  channels: ["in_app", "push", "sms", "email"],
  quietHoursBypass: true,
  unresolvedAudiences: 0
};

function approveWorld(extra = {}) {
  return world({
    "rpc/approve_emergency_launch POST": () => LAUNCHED_RESULT,
    ...extra
  });
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

test("emergency-approve: 403 for a reader; 400 for a malformed body; 404 for an unknown message", async (t) => {
  const captured = stubFetch(t, approveWorld());
  assert.equal((await mount({ memberships: READER }).call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", {})).status, 403);
  assert.equal(
    (await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", undefined, { raw: "[oops" })).status,
    400
  );
  assert.ok(!captured.some((c) => c.table.startsWith("rpc/")), "no database call for a refused request");
  stubFetch(t, approveWorld({ "messages GET": () => [] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", {})).status, 404);
});

test("H-1b: emergency-approve calls the definer function with only the message id and writes nothing itself", async (t) => {
  const captured = stubFetch(t, approveWorld());
  // The body tries to steer the broadcast; none of it may matter.
  const result = await mount({ userId: "user-approver" }).call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", {
    quietHoursBypass: false,
    channels: ["in_app"],
    recipients: ["attacker"],
    approvedByEmployeeId: "emp-someone-else"
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "launched");
  assert.equal(result.payload.recipientCount, 3);
  assert.equal(result.payload.quietHoursBypass, true);
  assert.deepEqual(result.payload.channels, ["in_app", "push", "sms", "email"]);
  assert.equal(result.payload.launchId, "l-1");

  const writes = captured.filter((c) => WRITE_METHODS.has(c.method));
  assert.deepEqual(writes.map((c) => `${c.method} ${c.table}`), ["POST rpc/approve_emergency_launch"]);
  assert.deepEqual(writes[0].body, { p_message_id: "msg-e" }, "the caller supplies nothing but the message id");
  assert.ok(!captured.some((c) => c.table === "notification_jobs"), "the route no longer writes jobs");
  assert.ok(!captured.some((c) => c.table === "messages" && c.method === "PATCH"), "the route no longer publishes the message");
  assert.ok(!captured.some((c) => c.table === "emergency_alert_launches" && WRITE_METHODS.has(c.method)));
});

test("emergency-approve: the function's refusals surface with their own status (403 second approver, 409 conflicts, 404)", async (t) => {
  for (const [status, message] of [
    [403, "emergency launch: a second approver (a different person than the requester) is required"],
    [409, "the message content changed since the launch was requested; cancel it and request a new launch"],
    [409, "the message audience resolves to no recipients"],
    [409, "emergency already launched"],
    [409, "the message channel is not emergency-enabled"],
    [404, "no emergency launch has been requested for this message"]
  ]) {
    const captured = stubFetch(
      t,
      approveWorld({ "rpc/approve_emergency_launch POST": () => ({ __status: status, __body: { code: `PT${status}`, message } }) })
    );
    const result = await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", {});
    assert.equal(result.status, status, message);
    assert.equal(result.payload.error, message);
    assert.ok(!captured.some((c) => c.table === "notification_jobs"));
  }
});

test("emergency-approve: an unexpected database failure is not swallowed", async (t) => {
  stubFetch(t, approveWorld({ "rpc/approve_emergency_launch POST": () => ({ __status: 500, __body: { message: "boom" } }) }));
  await assert.rejects(() => mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", {}));
});

test("emergency-approve: the route is not a way around the freeze either -- it does not edit the message", async (t) => {
  const captured = stubFetch(t, approveWorld());
  await mount().call("POST", "/facilities/fac-1/messages/msg-e/emergency-approve", { subject: "EVACUATE", bodyText: "attacker text" });
  assert.ok(!captured.some((c) => c.table === "messages" && WRITE_METHODS.has(c.method)));
});

test("the ordinary publish and create routes refuse emergency messages", async (t) => {
  const captured = stubFetch(t, world());
  const publish = await mount().call("POST", "/facilities/fac-1/messages/msg-e/publish", {});
  assert.equal(publish.status, 409);
  assert.ok(!captured.some((c) => c.table === "notification_jobs"));

  const create = await mount().call("POST", "/facilities/fac-1/messages", {
    channelId: "ch-em",
    subject: "x",
    bodyText: "y",
    priority: "emergency",
    publishNow: true
  });
  assert.equal(create.status, 409);
  assert.ok(!captured.some((c) => c.table === "messages" && c.method === "POST"));
});

// --- emergency-cancel / launches list -------------------------------------------------

test("emergency-cancel: 403, 400, 404, 409 and 200", async (t) => {
  const cancelWorld = (extra = {}) =>
    world({
      "emergency_alert_launches GET": () => [PENDING_LAUNCH],
      "emergency_alert_launches PATCH": () => [{ ...PENDING_LAUNCH, status: "cancelled" }],
      ...extra
    });
  const captured = stubFetch(t, cancelWorld());
  const path = "/facilities/fac-1/messages/msg-e/emergency-cancel";
  assert.equal((await mount({ memberships: READER }).call("POST", path, {})).status, 403);
  assert.equal((await mount().call("POST", path, undefined, { raw: "{" })).status, 400);
  const ok = await mount().call("POST", path, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.status, "cancelled");
  // The cancel is a conditional UPDATE: it can only land while the launch is still open, so it cannot
  // un-launch an alert the approval function has locked and stamped in the meantime.
  const patch = captured.find((c) => c.table === "emergency_alert_launches" && c.method === "PATCH");
  assert.equal(patch.url.searchParams.get("id"), "eq.l-1");
  assert.equal(patch.url.searchParams.get("status"), "in.(pending_approval,approved)");

  stubFetch(t, cancelWorld({ "emergency_alert_launches GET": () => [] }));
  assert.equal((await mount().call("POST", path, {})).status, 404);
  stubFetch(t, cancelWorld({ "emergency_alert_launches GET": () => [{ ...PENDING_LAUNCH, status: "launched" }] }));
  assert.equal((await mount().call("POST", path, {})).status, 409);
  // Lost the race: the launch was stamped between the read and the UPDATE (0 rows).
  stubFetch(t, cancelWorld({ "emergency_alert_launches PATCH": () => [] }));
  assert.equal((await mount().call("POST", path, {})).status, 409);
});

test("GET emergency-launches: 403 for a reader, 400 for a bad status, 200 for a publisher; served by the database queue (body + recipient count)", async (t) => {
  const QUEUE_ROW = {
    ...PENDING_LAUNCH,
    messages: { subject: "Severe weather", priority: "emergency", body_text: "Move indoors now" },
    preview: { recipientCount: 42, unresolvedAudiences: 0 },
    contentChanged: false
  };
  const captured = stubFetch(t, world({ "rpc/emergency_launch_queue POST": () => [QUEUE_ROW] }));
  assert.equal((await mount({ memberships: READER }).call("GET", "/facilities/fac-1/emergency-launches")).status, 403);
  assert.equal((await mount().call("GET", "/facilities/fac-1/emergency-launches?status=bogus")).status, 400);
  const ok = await mount().call("GET", "/facilities/fac-1/emergency-launches?status=pending_approval");
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.length, 1);
  assert.equal(ok.payload[0].messages.body_text, "Move indoors now", "the approver is shown the body");
  assert.equal(ok.payload[0].preview.recipientCount, 42, "and the number of people it reaches");
  const call = captured.filter((c) => c.table === "rpc/emergency_launch_queue").at(-1);
  assert.deepEqual(call.body, { p_facility_id: "fac-1", p_status: "pending_approval" });
  assert.ok(!captured.some((c) => c.table === "emergency_alert_launches"), "no direct read of the ledger");

  const all = await mount().call("GET", "/facilities/fac-1/emergency-launches");
  assert.equal(all.status, 200);
  assert.deepEqual(captured.filter((c) => c.table === "rpc/emergency_launch_queue").at(-1).body, { p_facility_id: "fac-1", p_status: null });
});

// --- emergency-response (own response only) -----------------------------------------------

test("emergency-response: 403 for a non-member / non-reader; 400 for a bad response or note", async (t) => {
  stubFetch(t, world({ "messages GET": () => [PUBLISHED_EMERGENCY] }));
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", "/messages/msg-e/emergency-response", { response: "safe" })).status, 403);
  assert.equal((await mount({ memberships: NO_COMMS }).call("POST", "/messages/msg-e/emergency-response", { response: "safe" })).status, 403);
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", { response: "fine" })).status, 400);
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", {})).status, 400);
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", { response: "safe", note: "x".repeat(501) })).status, 400);
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", undefined, { raw: "{" })).status, 400);
});

test("emergency-response: 404 unknown message; 409 when the message is not a published emergency alert; 403 with no employee row", async (t) => {
  stubFetch(t, world({ "messages GET": () => [] }));
  assert.equal((await mount().call("POST", "/messages/nope/emergency-response", { response: "safe" })).status, 404);
  stubFetch(t, world({ "messages GET": () => [DRAFT_EMERGENCY] }));
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", { response: "safe" })).status, 409);
  stubFetch(t, world({ "messages GET": () => [{ ...PUBLISHED_EMERGENCY, priority: "normal" }] }));
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", { response: "safe" })).status, 409);
  stubFetch(t, world({ "messages GET": () => [PUBLISHED_EMERGENCY], "employees GET": () => [] }));
  assert.equal((await mount().call("POST", "/messages/msg-e/emergency-response", { response: "safe" })).status, 403);
});

test("emergency-response: records ONLY the caller's own response -- a body employeeId is ignored", async (t) => {
  const captured = stubFetch(
    t,
    world({
      "messages GET": () => [PUBLISHED_EMERGENCY],
      "emergency_alert_responses POST": () => [{ id: "r-1", employee_id: "emp-me", response: "need_help" }]
    })
  );
  const result = await mount().call("POST", "/messages/msg-e/emergency-response", {
    response: "need_help",
    note: "  twisted ankle at the east gate  ",
    employeeId: "emp-victim",
    employee_id: "emp-victim"
  });
  assert.equal(result.status, 200);
  const lookup = captured.find((c) => c.table === "employees");
  assert.equal(lookup.url.searchParams.get("user_id"), "eq.user-me", "the employee is resolved from the caller's auth user id");
  const upsert = captured.find((c) => c.table === "emergency_alert_responses" && c.method === "POST");
  assert.deepEqual(upsert.body, [
    { facility_id: "fac-1", message_id: "msg-e", employee_id: "emp-me", response: "need_help", note: "twisted ankle at the east gate" }
  ]);
  assert.equal(upsert.url.searchParams.get("on_conflict"), "message_id,employee_id");
});

// --- roll-ups -----------------------------------------------------------------------------

const RESPONSES = [
  { id: "r1", message_id: "msg-e", employee_id: "emp-1", response: "safe", note: null, responded_at: "2026-08-13T12:05:00Z" },
  { id: "r2", message_id: "msg-e", employee_id: "emp-2", response: "need_help", note: "stuck", responded_at: "2026-08-13T12:06:00Z" }
];

function rollupWorld(extra = {}) {
  return world({
    "messages GET": () => [PUBLISHED_EMERGENCY],
    "message_audiences GET": () => AUDIENCES,
    "emergency_alert_responses GET": () => RESPONSES,
    "employees GET": () => [
      { id: "emp-2", first_name: "Sam", last_name: "Ng" },
      { id: "emp-3", first_name: "Alex", last_name: "Ray" }
    ],
    ...extra
  });
}

test("emergency-rollup: 403 for a reader; 400 for a bad limit; 409 for a non-emergency message; 404 unknown", async (t) => {
  stubFetch(t, rollupWorld());
  const path = "/facilities/fac-1/messages/msg-e/emergency-rollup";
  assert.equal((await mount({ memberships: READER }).call("GET", path)).status, 403);
  assert.equal((await mount().call("GET", `${path}?limit=0`)).status, 400);
  stubFetch(t, rollupWorld({ "messages GET": () => [DRAFT_EMERGENCY] }));
  assert.equal((await mount().call("GET", path)).status, 409);
  stubFetch(t, rollupWorld({ "messages GET": () => [] }));
  assert.equal((await mount().call("GET", path)).status, 404);
});

test("emergency-rollup: 200 reports safe / need help / no response with names for the people to chase", async (t) => {
  stubFetch(t, rollupWorld());
  const result = await mount().call("GET", "/facilities/fac-1/messages/msg-e/emergency-rollup");
  assert.equal(result.status, 200);
  assert.equal(result.payload.total, 3);
  assert.equal(result.payload.safe, 1);
  assert.equal(result.payload.needHelp, 1);
  assert.equal(result.payload.noResponse, 1);
  assert.deepEqual(result.payload.needHelpEmployees, [
    { employeeId: "emp-2", name: "Sam Ng", note: "stuck", respondedAt: "2026-08-13T12:06:00Z" }
  ]);
  assert.deepEqual(result.payload.noResponseEmployees, [{ employeeId: "emp-3", name: "Alex Ray" }]);
});

test("GET emergency-alerts: 403, 400 and 200 (facility roll-up across recent alerts)", async (t) => {
  stubFetch(t, rollupWorld());
  assert.equal((await mount({ memberships: READER }).call("GET", "/facilities/fac-1/emergency-alerts")).status, 403);
  assert.equal((await mount().call("GET", "/facilities/fac-1/emergency-alerts?days=0")).status, 400);
  assert.equal((await mount().call("GET", "/facilities/fac-1/emergency-alerts?days=abc")).status, 400);
  const ok = await mount().call("GET", "/facilities/fac-1/emergency-alerts?days=7");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, [
    { messageId: "msg-e", subject: "Severe weather", publishedAt: "2026-08-13T12:00:00Z", total: 3, safe: 1, needHelp: 1, noResponse: 1 }
  ]);
  stubFetch(t, rollupWorld({ "messages GET": () => [] }));
  assert.deepEqual((await mount().call("GET", "/facilities/fac-1/emergency-alerts")).payload, []);
});

// --- CM-16: inbox summary -------------------------------------------------------------------

function inboxWorld(extra = {}) {
  const recent = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  return world({
    "messages GET": () => [
      { id: "m1", subject: "A", priority: "normal", is_required_ack: false, published_at: recent(5) },
      { id: "m2", subject: "B", priority: "normal", is_required_ack: true, ack_due_at: recent(1), published_at: recent(10) },
      { id: "m3", subject: "C", priority: "normal", is_required_ack: true, ack_due_at: recent(-24), published_at: recent(11) },
      { id: "m-em", subject: "Evacuate", body_text: "Now", priority: "emergency", is_required_ack: false, published_at: recent(2) }
    ],
    "message_receipts GET": () => [{ message_id: "m1", read_at: recent(4) }],
    "message_acknowledgements GET": () => [{ message_id: "m3", acknowledged_at: recent(1), ack_state: "acknowledged" }],
    "emergency_alert_responses GET": () => [],
    ...extra
  });
}

test("GET /me/inbox-summary: 400 without facilityId; 403 for a non-member and for a member without communications.read", async (t) => {
  stubFetch(t, inboxWorld());
  assert.equal((await mount().call("GET", "/me/inbox-summary")).status, 400);
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", "/me/inbox-summary?facilityId=fac-1")).status, 403);
  assert.equal((await mount({ memberships: NO_COMMS }).call("GET", "/me/inbox-summary?facilityId=fac-1")).status, 403);
});

test("GET /me/inbox-summary: 200 with unread, pending acks and the latest emergency alert", async (t) => {
  const captured = stubFetch(t, inboxWorld());
  const result = await mount({ memberships: READER }).call("GET", "/me/inbox-summary?facilityId=fac-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.facilityId, "fac-1");
  assert.equal(result.payload.unreadCount, 3); // m2, m3, m-em unread; m1 read
  assert.equal(result.payload.pendingAcks.count, 1); // m2 (m3 acked)
  assert.equal(result.payload.pendingAcks.overdueCount, 1);
  assert.equal(result.payload.latestEmergency.messageId, "m-em");
  assert.equal(result.payload.latestEmergency.myResponse, null);
  assert.ok(result.payload.generatedAt);

  // Every personal query is scoped to the caller's own employee row.
  const receipts = captured.find((c) => c.table === "message_receipts");
  assert.equal(receipts.url.searchParams.get("employee_id"), "eq.emp-me");
});

test("GET /me/inbox-summary: a caller with no employee row gets zero personal counts but still sees an emergency alert", async (t) => {
  stubFetch(t, inboxWorld({ "employees GET": () => [] }));
  const result = await mount({ memberships: READER }).call("GET", "/me/inbox-summary?facilityId=fac-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.unreadCount, 0);
  assert.deepEqual(result.payload.pendingAcks, { count: 0, overdueCount: 0, nextDueAt: null });
  assert.equal(result.payload.latestEmergency.messageId, "m-em");
});

// --- CM-12: audience routes accept shift windows -------------------------------------------------

test("POST /messages/:id/audiences stores a validated shift window rule and rejects a bad one", async (t) => {
  const captured = stubFetch(
    t,
    world({
      "messages GET": () => [{ ...DRAFT_EMERGENCY, priority: "normal" }],
      "departments GET": () => [{ id: "dept-1", facility_id: "fac-1" }],
      "message_audiences POST": () => [{ id: "a-new" }]
    })
  );
  const ok = await mount().call("POST", "/messages/msg-e/audiences", [
    { audienceType: "shift", rule: { window: "current", departmentId: "dept-1", junk: "dropped" } },
    { audienceType: "shift", rule: { window: { from: "2026-08-13T00:00:00Z", to: "2026-08-13T12:00:00Z" } } }
  ]);
  assert.equal(ok.status, 201);
  const insert = captured.find((c) => c.table === "message_audiences" && c.method === "POST");
  assert.deepEqual(insert.body[0].rule_jsonb, { window: "current", departmentId: "dept-1" });
  assert.equal(insert.body[0].audience_ref_id, null);
  assert.deepEqual(insert.body[1].rule_jsonb, {
    window: { kind: "range", from: "2026-08-13T00:00:00.000Z", to: "2026-08-13T12:00:00.000Z" }
  });

  const bad = await mount().call("POST", "/messages/msg-e/audiences", [{ audienceType: "shift", rule: { window: "tomorrow" } }]);
  assert.equal(bad.status, 400);
  const both = await mount().call("POST", "/messages/msg-e/audiences", [
    { audienceType: "shift", audienceRefId: "shift-1", rule: { window: "current" } }
  ]);
  assert.equal(both.status, 400);
  const badPublishWindow = await mount().call("POST", "/facilities/fac-1/messages/msg-e/publish", { shiftWindow: "someday" });
  assert.equal(badPublishWindow.status, 400);
});

// --- publish route: ack due validation (M-5) and shift window persistence (L-4) -----------------

const ORDINARY = {
  id: "msg-o",
  facility_id: "fac-1",
  channel_id: "ch-1",
  author_employee_id: "emp-me",
  subject: "Pool rules",
  body_text: "Read them",
  priority: "normal",
  is_required_ack: true,
  ack_due_at: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
  published_at: null,
  deleted_at: null
};

function publishWorld(extra = {}) {
  return world({
    "messages GET": () => [ORDINARY],
    "messages PATCH": () => [{ ...ORDINARY, published_at: "2026-08-13T12:00:00Z" }],
    "message_audiences GET": () => [{ id: "a-1", message_id: "msg-o", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "emp-1", rule_jsonb: {} }],
    "notification_jobs POST": () => [{ id: "job-1" }],
    ...extra
  });
}

test("M-5: publishing a required-ack message whose due time has passed is a 400 and writes nothing", async (t) => {
  const captured = stubFetch(
    t,
    publishWorld({ "messages GET": () => [{ ...ORDINARY, ack_due_at: new Date(Date.now() - 3600 * 1000).toISOString() }] })
  );
  const result = await mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", {});
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /ackDueAt must be in the future/);
  assert.ok(!captured.some((c) => c.method === "PATCH" || c.table === "notification_jobs"));
});

test("M-5: a message without required acknowledgement is not held to a due time, and a future due time publishes", async (t) => {
  stubFetch(t, publishWorld({ "messages GET": () => [{ ...ORDINARY, is_required_ack: false, ack_due_at: "2020-01-01T00:00:00Z" }] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", {})).status, 200);
  stubFetch(t, publishWorld());
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", {})).status, 200);
});

test("M-5: the create route validates ackDueAt (a bad date, and a past one when publishNow)", async (t) => {
  const captured = stubFetch(t, world({ "messages POST": () => [ORDINARY] }));
  const base = { channelId: "ch-1", subject: "s", bodyText: "b", isRequiredAck: true };
  const bad = await mount().call("POST", "/facilities/fac-1/messages", { ...base, ackDueAt: "not a date" });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.payload), /valid date/);
  const past = await mount().call("POST", "/facilities/fac-1/messages", {
    ...base,
    publishNow: true,
    ackDueAt: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(past.status, 400);
  assert.match(JSON.stringify(past.payload), /in the future/);
  assert.ok(!captured.some((c) => c.table === "messages" && c.method === "POST"));
  // A draft may carry any valid date (the check that matters is at publish), and a future date with publishNow is fine.
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages", { ...base, ackDueAt: "2020-01-01T00:00:00Z" })).status, 201);
  assert.equal(
    (await mount().call("POST", "/facilities/fac-1/messages", { ...base, publishNow: true, ackDueAt: ORDINARY.ack_due_at })).status,
    201
  );
});

test("L-4: the publish-body shiftWindow is written into every ref-less shift audience's rule BEFORE the message goes out", async (t) => {
  const audiences = [
    { id: "a-ref", message_id: "msg-o", facility_id: "fac-1", audience_type: "shift", audience_ref_id: "shift-1", rule_jsonb: {} },
    { id: "a-bare", message_id: "msg-o", facility_id: "fac-1", audience_type: "shift", audience_ref_id: null, rule_jsonb: { departmentId: "dept-1" } },
    { id: "a-own", message_id: "msg-o", facility_id: "fac-1", audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "next" } },
    { id: "a-emp", message_id: "msg-o", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "emp-1", rule_jsonb: {} }
  ];
  const captured = stubFetch(
    t,
    publishWorld({
      "message_audiences GET": () => audiences,
      "message_audiences PATCH": () => [{}],
      "schedule_shifts GET": () => [],
      "shift_assignments GET": () => []
    })
  );
  const result = await mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", { shiftWindow: "current" });
  assert.equal(result.status, 200);
  const audienceWrites = captured.filter((c) => c.table === "message_audiences" && c.method === "PATCH");
  assert.equal(audienceWrites.length, 1, "only the bare ref-less shift audience needs the window");
  assert.equal(audienceWrites[0].url.searchParams.get("id"), "eq.a-bare");
  assert.deepEqual(audienceWrites[0].body, { rule_jsonb: { departmentId: "dept-1", window: { kind: "current" } } });
  const firstAudienceWrite = captured.findIndex((c) => c.table === "message_audiences" && c.method === "PATCH");
  const publish = captured.findIndex((c) => c.table === "messages" && c.method === "PATCH");
  assert.ok(firstAudienceWrite >= 0 && firstAudienceWrite < publish, "the window is persisted before publishing");
});

test("L-4: a range window is stored in its ISO form; no fallback window writes nothing; a failed write aborts the publish", async (t) => {
  const bare = { id: "a-bare", message_id: "msg-o", facility_id: "fac-1", audience_type: "shift", audience_ref_id: null, rule_jsonb: {} };
  const range = { from: "2026-08-10T00:00:00Z", to: "2026-08-12T00:00:00Z" };
  const captured = stubFetch(
    t,
    publishWorld({ "message_audiences GET": () => [{ ...bare }], "message_audiences PATCH": () => [{}], "schedule_shifts GET": () => [] })
  );
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", { shiftWindow: range })).status, 200);
  assert.deepEqual(captured.find((c) => c.table === "message_audiences" && c.method === "PATCH").body.rule_jsonb.window, {
    kind: "range",
    from: "2026-08-10T00:00:00.000Z",
    to: "2026-08-12T00:00:00.000Z"
  });

  const none = stubFetch(t, publishWorld({ "message_audiences GET": () => [{ ...bare }] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", {})).status, 200);
  assert.ok(!none.some((c) => c.table === "message_audiences" && c.method === "PATCH"));

  const failing = stubFetch(
    t,
    publishWorld({ "message_audiences GET": () => [{ ...bare }], "message_audiences PATCH": () => ({ __status: 500 }) })
  );
  await assert.rejects(() => mount().call("POST", "/facilities/fac-1/messages/msg-o/publish", { shiftWindow: "next" }));
  assert.ok(!failing.some((c) => c.table === "messages" && c.method === "PATCH"), "nothing was published");
  assert.ok(!failing.some((c) => c.table === "notification_jobs"));
});

test("L-3: creating an emergency-enabled channel takes admin.manage; an ordinary channel does not", async (t) => {
  const captured = stubFetch(t, world({ "communication_channels POST": () => [{ id: "ch-new" }] }));
  const body = { name: "Weather", type: "emergency" };
  const publisher = await mount().call("POST", "/facilities/fac-1/channels", { ...body, emergencyEnabled: true });
  assert.equal(publisher.status, 403);
  assert.match(publisher.payload.error, /admin\.manage/);
  assert.ok(!captured.some((c) => c.table === "communication_channels" && c.method === "POST"));

  const ordinary = await mount().call("POST", "/facilities/fac-1/channels", { ...body, emergencyEnabled: false });
  assert.equal(ordinary.status, 201);

  const ADMIN = [{ facilityId: "fac-1", status: "active", permissions: ["communications.read", "communications.publish", "admin.manage"] }];
  const admin = await mount({ memberships: ADMIN }).call("POST", "/facilities/fac-1/channels", { ...body, emergencyEnabled: true });
  assert.equal(admin.status, 201);
});
