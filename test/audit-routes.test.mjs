import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAuditRoutes } from "../src/lib/http/audit-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { computeDbRowHash } from "../src/lib/audit.mjs";

const ADMIN_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["admin.manage"] }];
const READER_ON_FAC1 = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];

// Programmable fetch stub, matching the style of test/admin-routes.test.mjs.
function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method, url: parsed });
    const data = respond(table, method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// Respond helper for export tests: audit_events yields the given rows, and the
// facility -> org -> subscription -> plan lookup chain resolves to a plan that
// includes (or omits) the audit_export entitlement.
function exportRespond(auditRows, { entitled = true } = {}) {
  return (table) => {
    if (table === "audit_events") return auditRows;
    if (table === "facilities") return [{ organization_id: "org-1" }];
    if (table === "tenant_subscriptions") return [{ status: "active", plan_id: "plan-1" }];
    if (table === "subscription_plans") {
      return [{ feature_entitlements_jsonb: entitled ? { audit_export: true } : {} }];
    }
    return [];
  };
}

function mount({ memberships = ADMIN_ON_FAC1 } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: "user-1" }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async () => "{}";
  registerAuditRoutes(router, { authenticate, sendJson, readBody });

  async function call(method, path) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    await handler({ url: path }, {}, { env: {}, params });
    return sent[sent.length - 1];
  }

  return { call };
}

test("GET .../audit denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/audit");
  assert.equal(result.status, 403);
  assert.match(result.payload.error, /admin\.manage/);
});

test("GET .../audit builds facility/entityTable/eventType/limit PostgREST filters", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  await call(
    "GET",
    "/facilities/fac-1/audit?entityTable=facility_settings&eventType=config.changed&limit=5"
  );
  const read = captured.find((c) => c.table === "audit_events" && c.method === "GET");
  assert.ok(read, "expected a GET against audit_events");
  assert.equal(read.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(read.url.searchParams.get("entity_table"), "eq.facility_settings");
  assert.equal(read.url.searchParams.get("event_type"), "eq.config.changed");
  assert.equal(read.url.searchParams.get("limit"), "5");
  assert.equal(read.url.searchParams.get("order"), "created_at.desc");
});

test("GET .../audit ignores a non-positive limit and falls back to the default", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  await call("GET", "/facilities/fac-1/audit?limit=not-a-number");
  const read = captured.find((c) => c.table === "audit_events" && c.method === "GET");
  assert.equal(read.url.searchParams.get("limit"), "100");
});

test("GET .../audit denies a non-admin before any DB call", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  await call("GET", "/facilities/fac-1/audit/verify");
  assert.equal(captured.length, 0);
});

test("GET .../audit/verify returns valid:true for a clean stubbed chain", async (t) => {
  const rowA = {
    id: "a",
    chain_seq: 1,
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: null, after: { locale: "en-US" } },
    facility_id: "fac-1",
    organization_id: null,
    created_at: "2026-01-01T00:00:00Z",
    prev_hash: null
  };
  rowA.row_hash = computeDbRowHash(rowA);
  const rowB = {
    id: "b",
    chain_seq: 2,
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: { locale: "en-US" }, after: { locale: "fr-FR" } },
    facility_id: "fac-1",
    organization_id: null,
    created_at: "2026-01-01T00:00:01Z",
    prev_hash: rowA.row_hash
  };
  rowB.row_hash = computeDbRowHash(rowB);

  const captured = stubFetch(t, () => [rowA, rowB]);
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/audit/verify");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { valid: true, brokenAt: null, checked: 2 });
  const read = captured.find((c) => c.table === "audit_events" && c.method === "GET");
  assert.equal(read.url.searchParams.get("order"), "chain_seq.asc");
});

test("GET .../audit/verify returns valid:false with brokenAt for a tampered chain", async (t) => {
  const rowA = {
    id: "a",
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: null, after: { locale: "en-US" } },
    facility_id: "fac-1",
    organization_id: null,
    created_at: "2026-01-01T00:00:00Z",
    prev_hash: null
  };
  rowA.row_hash = computeDbRowHash(rowA);
  const rowB = {
    ...rowA,
    id: "b",
    event_payload: { before: null, after: { locale: "TAMPERED" } },
    created_at: "2026-01-01T00:00:01Z",
    prev_hash: rowA.row_hash,
    row_hash: "not-a-real-hash"
  };

  stubFetch(t, () => [rowA, rowB]);
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/audit/verify");
  assert.equal(result.status, 200);
  assert.equal(result.payload.valid, false);
  assert.equal(result.payload.brokenAt, 1);
  assert.equal(result.payload.checked, 2);
});

test("GET .../audit/export defaults to csv with a Content-Disposition-ready filename", async (t) => {
  const row = {
    id: "a",
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: null, after: { locale: "en-US" } },
    facility_id: "fac-1",
    organization_id: null,
    created_at: "2026-01-01T00:00:00Z",
    prev_hash: null,
    row_hash: "hash-a"
  };
  stubFetch(t, exportRespond([row]));
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/audit/export");
  assert.equal(result.status, 200);
  assert.equal(result.payload.contentType, "text/csv");
  assert.match(result.payload.filename, /^audit-export-.+\.csv$/);
  assert.match(result.payload.contentDisposition, /^attachment; filename="audit-export-.+\.csv"$/);
  assert.match(result.payload.body, /config\.changed/);
});

test("GET .../audit/export honors format=json", async (t) => {
  const row = { id: "a", event_type: "config.changed" };
  stubFetch(t, exportRespond([row]));
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/audit/export?format=json");
  assert.equal(result.payload.contentType, "application/json");
  assert.match(result.payload.filename, /\.json$/);
  assert.deepEqual(JSON.parse(result.payload.body), [row]);
});

test("GET .../audit/export denies a non-admin with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER_ON_FAC1 });
  const result = await call("GET", "/facilities/fac-1/audit/export");
  assert.equal(result.status, 403);
});

test("GET .../audit/export returns 402 when the plan lacks audit_export", async (t) => {
  const row = { id: "a", event_type: "config.changed" };
  stubFetch(t, exportRespond([row], { entitled: false }));
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/audit/export");
  assert.equal(result.status, 402);
  assert.match(result.payload.error, /audit_export/);
});
