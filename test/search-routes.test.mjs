import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerSearchRoutes, sanitizeSearchQuery } from "../src/lib/http/search-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const ALL_ACCESS = [
  {
    facilityId: "fac-1",
    status: "active",
    permissions: ["incidents.read", "work_orders.read", "schedule.read", "communications.read"]
  }
];
const INCIDENTS_ONLY = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];
const NO_MODULE_PERMS = [{ facilityId: "fac-1", status: "active", permissions: [] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["incidents.read"] }];

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method, url: parsed });
    const outcome = respond(table, method, parsed);
    if (outcome && outcome.error) {
      return {
        ok: false,
        status: outcome.status ?? 500,
        text: async () => JSON.stringify(outcome.body ?? { message: "boom" })
      };
    }
    const data = outcome ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = ALL_ACCESS, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerSearchRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

// --- sanitizeSearchQuery (pure) --------------------------------------------

test("sanitizeSearchQuery trims, strips reserved/unsafe characters, and enforces length after stripping", () => {
  assert.equal(sanitizeSearchQuery("  fire  "), "fire");
  assert.equal(sanitizeSearchQuery("a,b(c).d*e"), "abcde");
  assert.equal(sanitizeSearchQuery("ab"), "ab"); // exactly the minimum
  assert.equal(sanitizeSearchQuery("a"), null); // 1 char: too short
  assert.equal(sanitizeSearchQuery(",,"), null); // strips to "": too short
  assert.equal(sanitizeSearchQuery("x".repeat(64)), "x".repeat(64)); // exactly the maximum
  assert.equal(sanitizeSearchQuery("x".repeat(65)), null); // over the maximum
  assert.equal(sanitizeSearchQuery(""), null);
  assert.equal(sanitizeSearchQuery(null), null);
  assert.equal(sanitizeSearchQuery(undefined), null);
  assert.equal(sanitizeSearchQuery("smith-jones 12"), "smith-jones 12"); // hyphen/space/digits allowed
});

// --- Route: membership / facilityId -----------------------------------------

test("GET /search requires a facilityId query parameter", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/search?q=fire");
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /facilityId/);
});

test("GET /search denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/search?facilityId=fac-1&q=fire");
  assert.equal(result.status, 403);
});

// --- Route: q validation -----------------------------------------------------

test("GET /search rejects a missing q with 400", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/search?facilityId=fac-1");
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /2-64 characters/);
});

test("GET /search rejects a too-short q (1 char) with 400, no fetch issued", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/search?facilityId=fac-1&q=a");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET /search rejects a q that sanitizes down to nothing (all reserved characters) with 400", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/search?facilityId=fac-1&q=" + encodeURIComponent(",.()*"));
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET /search rejects a too-long q (65 sanitized chars) with 400", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/search?facilityId=fac-1&q=" + "x".repeat(65));
  assert.equal(result.status, 400);
});

// --- Route: permission-gated legs --------------------------------------------

test("GET /search omits a leg entirely (not present-but-empty) when the caller lacks that module's read permission", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [{ id: "inc-1", incident_no: "2026-001" }] : []));
  const { call } = mount({ memberships: INCIDENTS_ONLY });
  const result = await call("GET", "/search?facilityId=fac-1&q=fire");
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.payload.results), ["incidents"]);
  assert.equal(result.payload.results.incidents.length, 1);
  assert.equal("workOrders" in result.payload.results, false);
  assert.equal("employees" in result.payload.results, false);
  assert.equal("messages" in result.payload.results, false);
});

test("GET /search returns an empty results object (200, no legs) for a member with no module read permissions", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: NO_MODULE_PERMS });
  const result = await call("GET", "/search?facilityId=fac-1&q=fire");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.results, {});
  assert.equal(captured.length, 0);
});

test("GET /search with full access queries all four legs and echoes q", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ALL_ACCESS });
  const result = await call("GET", "/search?facilityId=fac-1&q=fire");
  assert.equal(result.status, 200);
  assert.equal(result.payload.q, "fire");
  assert.deepEqual(Object.keys(result.payload.results), ["incidents", "workOrders", "employees", "messages"]);
  const tablesQueried = captured.map((c) => c.table).sort();
  assert.deepEqual(tablesQueried, ["employees", "incident_reports", "messages", "work_orders"].sort());
});

// --- Route: per-leg filter/limit shape ---------------------------------------

test("GET /search's incidents leg filters facility_id, ors incident_no/summary/location_text, and limits 10", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ALL_ACCESS });
  await call("GET", "/search?facilityId=fac-1&q=fire");
  const leg = captured.find((c) => c.table === "incident_reports");
  assert.ok(leg, "incident_reports leg was not queried");
  assert.match(leg.url.search, /facility_id=eq\.fac-1/);
  assert.match(
    leg.url.searchParams.get("or"),
    /^\(incident_no\.ilike\.\*fire\*,summary\.ilike\.\*fire\*,location_text\.ilike\.\*fire\*\)$/
  );
  assert.equal(leg.url.searchParams.get("limit"), "10");
});

test("GET /search's work orders leg ors title/description", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ALL_ACCESS });
  await call("GET", "/search?facilityId=fac-1&q=leak");
  const leg = captured.find((c) => c.table === "work_orders");
  assert.equal(leg.url.searchParams.get("or"), "(title.ilike.*leak*,description.ilike.*leak*)");
  assert.equal(leg.url.searchParams.get("limit"), "10");
});

test("GET /search's employees leg ors first_name/last_name/employee_no", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ALL_ACCESS });
  await call("GET", "/search?facilityId=fac-1&q=smith");
  const leg = captured.find((c) => c.table === "employees");
  assert.equal(
    leg.url.searchParams.get("or"),
    "(first_name.ilike.*smith*,last_name.ilike.*smith*,employee_no.ilike.*smith*)"
  );
  assert.equal(leg.url.searchParams.get("limit"), "10");
});

test("GET /search's messages leg ors subject/body_text", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ALL_ACCESS });
  await call("GET", "/search?facilityId=fac-1&q=briefing");
  const leg = captured.find((c) => c.table === "messages");
  assert.equal(leg.url.searchParams.get("or"), "(subject.ilike.*briefing*,body_text.ilike.*briefing*)");
  assert.equal(leg.url.searchParams.get("limit"), "10");
});

test("GET /search strips reserved characters out of q before it reaches any leg's or filter", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: ALL_ACCESS });
  const result = await call("GET", "/search?facilityId=fac-1&q=" + encodeURIComponent("fi,re.(x)*"));
  assert.equal(result.status, 200);
  assert.equal(result.payload.q, "firex");
  const leg = captured.find((c) => c.table === "work_orders");
  assert.equal(leg.url.searchParams.get("or"), "(title.ilike.*firex*,description.ilike.*firex*)");
});

// --- Route: partial failure ---------------------------------------------------

test("GET /search still returns 200 with the other legs' results when one leg's query fails", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "work_orders") return { error: true, status: 500, body: { message: "db down" } };
    if (table === "incident_reports") return [{ id: "inc-1", incident_no: "2026-001" }];
    return [];
  });
  const { call } = mount({ memberships: ALL_ACCESS });
  const result = await call("GET", "/search?facilityId=fac-1&q=fire");
  assert.equal(result.status, 200);
  assert.equal(result.payload.results.incidents.length, 1);
  assert.deepEqual(result.payload.results.workOrders, []);
  assert.ok(Array.isArray(result.payload.errors));
  assert.equal(result.payload.errors.length, 1);
  assert.equal(result.payload.errors[0].leg, "workOrders");
  // employees/messages, unaffected, still queried and present.
  assert.ok("employees" in result.payload.results);
  assert.ok("messages" in result.payload.results);
  assert.equal(captured.filter((c) => c.table === "work_orders").length, 1);
});
