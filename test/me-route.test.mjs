import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerMeRoute } from "../src/lib/http/me-route.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    captured.push({ table, url: parsed });
    return { ok: true, status: 200, text: async () => JSON.stringify(respond(table, parsed) ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount(auth) {
  const router = createRouter();
  const sent = [];
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const authenticate = async () => auth;
  registerMeRoute(router, { authenticate, sendJson });
  async function call() {
    const { handler, params } = router.match({ method: "GET", url: "/me" });
    assert.ok(handler);
    await handler({ url: "/me" }, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

const client = createClient({ url: "https://example.supabase.co", key: "k" });

test("me returns 401 when authentication fails", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ error: { status: 401, body: { error: "missing bearer token" } } });
  const result = await call();
  assert.equal(result.status, 401);
});

test("me returns the member's facilities with permissions", async (t) => {
  const captured = stubFetch(t, (table) =>
    table === "facilities"
      ? [{ id: "fac-1", name: "North Arena", organization_id: "org-1" }]
      : []
  );
  const { call } = mount({
    claims: { sub: "user-1", email: "a@b.com" },
    client,
    platformAdmin: false,
    memberships: [{ facilityId: "fac-1", permissions: ["reports.read", "incidents.read"] }],
    error: null
  });
  const result = await call();
  assert.equal(result.status, 200);
  assert.equal(result.payload.user.email, "a@b.com");
  assert.equal(result.payload.platformAdmin, false);
  assert.equal(result.payload.facilities.length, 1);
  assert.deepEqual(result.payload.facilities[0].permissions.sort(), ["incidents.read", "reports.read"]);
  // Non-admin path filters facilities to the member's ids via an in-list.
  const facilitiesCall = captured.find((c) => c.table === "facilities");
  assert.equal(facilitiesCall.url.searchParams.get("id"), "in.(fac-1)");
});

test("me lists every facility for a platform admin", async (t) => {
  const captured = stubFetch(t, (table) =>
    table === "facilities"
      ? [
          { id: "fac-1", name: "North Arena", organization_id: "org-1" },
          { id: "fac-2", name: "Riverfront Aquatics", organization_id: "org-1" }
        ]
      : []
  );
  const { call } = mount({
    claims: { sub: "admin-1", email: "admin@b.com" },
    client,
    platformAdmin: true,
    memberships: [],
    error: null
  });
  const result = await call();
  assert.equal(result.status, 200);
  assert.equal(result.payload.platformAdmin, true);
  assert.equal(result.payload.facilities.length, 2);
  // Admin path lists all facilities (no id in-list filter).
  const facilitiesCall = captured.find((c) => c.table === "facilities");
  assert.doesNotMatch(facilitiesCall.url.search, /id=in/);
});
