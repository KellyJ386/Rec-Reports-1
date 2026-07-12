import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerNotificationRoutes } from "../src/lib/http/notification-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const PUBLISHER = [{ facilityId: "fac-1", status: "active", permissions: ["communications.publish"] }];
const MEMBER = [{ facilityId: "fac-1", status: "active", permissions: ["communications.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["communications.publish"] }];

// Grants the notification_routing entitlement to the facility's org so the write
// handlers' 402 guard passes. Returns null for any table it does not own, so the
// per-test responder can supply the rest.
function entitled(table, method) {
  if (table === "facilities" && method === "GET") return [{ organization_id: "org-1" }];
  if (table === "tenant_subscriptions" && method === "GET") return [{ id: "sub-1", plan_id: "plan-1" }];
  if (table === "subscription_plans" && method === "GET") {
    return [{ id: "plan-1", feature_entitlements_jsonb: { notification_routing: true } }];
  }
  return null;
}

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

// Wraps a per-test responder so entitlement lookups always succeed.
function withEntitlement(respond) {
  return (table, method, url) => entitled(table, method) ?? respond(table, method, url);
}

function mount({ memberships = PUBLISHER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerNotificationRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET /notification-events returns the catalog to any authenticated caller", async (t) => {
  stubFetch(t, () => [{ code: "incident.escalated" }]);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("GET", "/notification-events");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].code, "incident.escalated");
});

test("GET distribution-lists denies a non-member of the facility", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/distribution-lists");
  assert.equal(result.status, 403);
});

test("POST distribution-lists denies a member without communications.publish", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/distribution-lists", { name: "Managers" });
  assert.equal(result.status, 403);
});

test("POST distribution-lists validates name before guarding", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/distribution-lists", { name: "" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST distribution-lists rejects with 402 when the plan lacks notification_routing", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "facilities" && method === "GET") return [{ organization_id: "org-1" }];
    // No subscription -> loadEntitlements returns empty entitlements (fail closed).
    if (table === "tenant_subscriptions" && method === "GET") return [];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/distribution-lists", { name: "Managers" });
  assert.equal(result.status, 402);
  // Never reached the insert.
  assert.ok(!captured.some((c) => c.table === "distribution_lists" && c.method === "POST"));
});

test("POST distribution list member validates member_type", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/distribution-lists/list-1/members", {
    memberType: "vendor",
    memberRefId: "x"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST distribution list member happy path inserts the shaped row", async (t) => {
  const captured = stubFetch(
    t,
    withEntitlement((table, method) => {
      if (table === "distribution_list_members" && method === "POST") return [{ id: "m-1" }];
      return [];
    })
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/distribution-lists/list-1/members", {
    memberType: "role",
    memberRefId: "role-a"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "distribution_list_members" && c.method === "POST");
  assert.deepEqual(insert.body[0], {
    facility_id: "fac-1",
    distribution_list_id: "list-1",
    member_type: "role",
    member_ref_id: "role-a"
  });
});

test("POST notification-routes denies a member without communications.publish", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/notification-routes", {
    eventCode: "incident.escalated",
    priority: 5
  });
  assert.equal(result.status, 403);
});

test("POST notification-routes happy path inserts the shaped row", async (t) => {
  const captured = stubFetch(
    t,
    withEntitlement((table, method) => {
      if (table === "notification_routes" && method === "POST") return [{ id: "route-1" }];
      return [];
    })
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/notification-routes", {
    eventCode: "incident.escalated",
    priority: 5,
    route: { channels: ["in_app", "email"] }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "notification_routes" && c.method === "POST");
  assert.equal(insert.body[0].event_code, "incident.escalated");
  assert.equal(insert.body[0].priority, 5);
  assert.deepEqual(insert.body[0].route_jsonb, { channels: ["in_app", "email"] });
});

test("POST route test inserts a notification_jobs row with a test marker", async (t) => {
  const captured = stubFetch(
    t,
    withEntitlement((table, method) => {
      if (table === "notification_routes" && method === "GET") {
        return [
          {
            id: "route-1",
            facility_id: "fac-1",
            event_code: "incident.escalated",
            priority: 5,
            route_jsonb: { channels: ["in_app"] }
          }
        ];
      }
      if (table === "notification_jobs" && method === "POST") return [{ id: "job-1" }];
      return [];
    })
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/notification-routes/route-1/test");
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].event_type, "incident.escalated");
  assert.equal(insert.body[0].payload_jsonb.test, true);
  assert.deepEqual(insert.body[0].payload_jsonb.channels, ["in_app"]);
});

test("POST route test 404s for an unknown route", async (t) => {
  stubFetch(t, withEntitlement(() => []));
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/notification-routes/missing/test");
  assert.equal(result.status, 404);
});

test("POST route test denies a non-publisher with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/notification-routes/route-1/test");
  assert.equal(result.status, 403);
});
