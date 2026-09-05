import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerInternalRoutes } from "../src/lib/http/internal-routes.mjs";
import { computeDbRowHash } from "../src/lib/audit.mjs";

// Routes both PostgREST calls (to https://example.supabase.co) and
// observability reports (to https://observability.example/report) through
// one global fetch stub, recording every call so assertions can inspect
// exactly what each subsystem sent -- same programmable-stub style as
// test/audit-routes.test.mjs and test/notifications-worker.test.mjs.
function stubFetch(t, { facilities = [], chains = {} } = {}) {
  const captured = { postgrest: [], observability: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "observability.example") {
      const entry = { url: parsed.toString(), body: init.body ? JSON.parse(init.body) : null, headers: init.headers };
      captured.observability.push(entry);
      return { ok: true, status: 200, text: async () => "" };
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.postgrest.push({ table, method, url: parsed });
    let data = [];
    if (table === "facilities" && method === "GET") data = facilities;
    else if (table === "audit_events" && method === "GET") {
      const facilityId = parsed.searchParams.get("facility_id")?.replace("eq.", "");
      data = chains[facilityId] ?? [];
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount() {
  const router = createRouter();
  const sent = [];
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  registerInternalRoutes(router, { sendJson });

  async function call(method, path, { headers = {}, env = {} } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    await handler({ url: path, headers }, {}, { env, params });
    return sent[sent.length - 1];
  }

  return { call };
}

const BASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  CRON_SECRET: "correct-cron-secret",
  OBSERVABILITY_DSN: "https://observability.example/report"
};

// A clean, well-formed two-row hash chain for one facility.
function cleanChain(facilityId) {
  const rowA = {
    id: "a",
    chain_seq: 1,
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: null, after: { locale: "en-US" } },
    facility_id: facilityId,
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
    facility_id: facilityId,
    organization_id: null,
    created_at: "2026-01-01T00:00:01Z",
    prev_hash: rowA.row_hash
  };
  rowB.row_hash = computeDbRowHash(rowB);
  return [rowA, rowB];
}

// A deliberately tampered chain: rowB's payload was mutated after hashing,
// so its stored row_hash no longer matches a recomputation.
function tamperedChain(facilityId) {
  const [rowA, rowB] = cleanChain(facilityId);
  return [rowA, { ...rowB, event_payload: { before: { locale: "en-US" }, after: { locale: "TAMPERED" } } }];
}

test("POST /internal/audit/verify-all: 503 when CRON_SECRET is unset", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: { ...BASE_ENV, CRON_SECRET: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /CRON_SECRET is not configured/);
  assert.equal(captured.postgrest.length, 0, "must reject before any DB work");
});

test("POST /internal/audit/verify-all: 401 on missing bearer token", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", { env: BASE_ENV, headers: {} });
  assert.equal(result.status, 401);
  assert.equal(captured.postgrest.length, 0);
});

test("POST /internal/audit/verify-all: 401 on wrong bearer token", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer totally-wrong-secret" }
  });
  assert.equal(result.status, 401);
  assert.match(result.payload.error, /invalid or missing cron secret/);
  assert.equal(captured.postgrest.length, 0, "must reject before any DB work");
});

test("POST /internal/audit/verify-all: 503 when SUPABASE_SERVICE_ROLE_KEY is unset", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /SUPABASE_SERVICE_ROLE_KEY is not configured/);
  assert.equal(captured.postgrest.length, 0);
});

test("GET /internal/audit/verify-all also accepts the cron secret (Vercel Cron fires GET)", async (t) => {
  stubFetch(t, { facilities: [{ id: "fac-1" }], chains: { "fac-1": cleanChain("fac-1") } });
  const { call } = mount();
  const result = await call("GET", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.facilitiesChecked, 1);
  assert.deepEqual(result.payload.broken, []);
});

test("a clean chain across multiple facilities reports nothing broken and no observability POST", async (t) => {
  const captured = stubFetch(t, {
    facilities: [{ id: "fac-1" }, { id: "fac-2" }],
    chains: { "fac-1": cleanChain("fac-1"), "fac-2": cleanChain("fac-2") }
  });
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.facilitiesChecked, 2);
  assert.deepEqual(result.payload.broken, []);
  assert.equal(typeof result.payload.durationMs, "number");
  assert.ok(result.payload.durationMs >= 0);

  assert.equal(captured.observability.length, 0, "a clean chain must never trigger an error report");
});

test("a tampered chain fixture produces a broken entry AND a fire-and-forget observability report", async (t) => {
  const captured = stubFetch(t, {
    facilities: [{ id: "fac-1" }, { id: "fac-2" }],
    chains: { "fac-1": cleanChain("fac-1"), "fac-2": tamperedChain("fac-2") }
  });
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.facilitiesChecked, 2);
  assert.equal(result.payload.broken.length, 1);
  assert.equal(result.payload.broken[0].facilityId, "fac-2");
  assert.equal(result.payload.broken[0].brokenAt, 1);
  assert.equal(result.payload.broken[0].checked, 2);

  // reportError is fire-and-forget (never awaited by the route handler), so
  // give its microtask/timer queue a tick to land before asserting on it.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(captured.observability.length, 1, "the broken chain must produce exactly one error report");
  const report = captured.observability[0];
  assert.match(report.body.message, /fac-2/);
  assert.equal(report.body.route, "internal.audit.verify-all");
  assert.equal(report.body.status, "broken_chain");
  assert.equal(report.body.requestId, "fac-2");
  // No secrets/tokens on the wire -- the CRON_SECRET used to authenticate
  // this very request must never appear in the report payload.
  const wire = JSON.stringify(report.body);
  assert.equal(wire.includes("correct-cron-secret"), false);
  assert.equal(wire.includes("service-key"), false);
});

test("when OBSERVABILITY_DSN is unset, a broken chain is still reported in the response but no fetch fires", async (t) => {
  const captured = stubFetch(t, {
    facilities: [{ id: "fac-1" }],
    chains: { "fac-1": tamperedChain("fac-1") }
  });
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: { ...BASE_ENV, OBSERVABILITY_DSN: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.broken.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(captured.observability.length, 0, "DSN unset must stay a silent no-op even for a broken chain");
});
