import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerBillingRoutes } from "../src/lib/http/billing-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const ORG_ADMIN = [{ facilityId: "fac-1", status: "active", permissions: ["admin.manage"] }];
const ORG_MEMBER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const OUTSIDER = [{ facilityId: "fac-9", status: "active", permissions: ["admin.manage"] }];

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

// Every org endpoint first resolves the org's facilities to authorize membership.
function orgFacilities(table, method) {
  if (table === "facilities" && method === "GET") return [{ id: "fac-1" }];
  return null;
}

function mount({ memberships = ORG_ADMIN } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: "user-1" }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerBillingRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET subscription returns plan + resolved entitlements to an org member", async (t) => {
  stubFetch(t, (table, method) => {
    const of = orgFacilities(table, method);
    if (of) return of;
    if (table === "tenant_subscriptions") return [{ id: "sub-1", plan_id: "plan-1", status: "active" }];
    if (table === "subscription_plans") {
      return [{ id: "plan-1", name: "Enterprise", feature_entitlements_jsonb: { cert_policies: true } }];
    }
    return [];
  });
  const { call } = mount({ memberships: ORG_MEMBER });
  const result = await call("GET", "/org/org-1/subscription");
  assert.equal(result.status, 200);
  assert.equal(result.payload.plan.name, "Enterprise");
  assert.deepEqual(result.payload.entitlements, { cert_policies: true });
});

test("GET subscription denies a non-member of the org", async (t) => {
  stubFetch(t, (table, method) => orgFacilities(table, method) ?? []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/org/org-1/subscription");
  assert.equal(result.status, 403);
});

test("GET usage attaches soft-limit status from usage_limits_jsonb", async (t) => {
  stubFetch(t, (table, method) => {
    const of = orgFacilities(table, method);
    if (of) return of;
    if (table === "tenant_subscriptions") return [{ usage_limits_jsonb: { active_employees: 100 } }];
    if (table === "usage_counters") {
      return [{ id: "u1", metric_code: "active_employees", value: 95, period_start: "2026-07-01", period_end: "2026-07-31" }];
    }
    return [];
  });
  const { call } = mount({ memberships: ORG_MEMBER });
  const result = await call("GET", "/org/org-1/usage");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].limit, 100);
  assert.equal(result.payload[0].pct, 95);
  assert.equal(result.payload[0].level, "warn90");
});

test("GET feature-flags computes an effective state per scope", async (t) => {
  stubFetch(t, (table, method) => {
    const of = orgFacilities(table, method);
    if (of) return of;
    if (table === "feature_flags") return [{ id: "flag-1", key: "admin.new_dashboard", rollout_type: "boolean", default_state: false }];
    if (table === "feature_flag_rules") {
      return [{ id: "rule-1", feature_flag_id: "flag-1", scope_type: "organization", scope_id: "org-1", state: true, rollout_percentage: null }];
    }
    return [];
  });
  const { call } = mount({ memberships: ORG_MEMBER });
  const result = await call("GET", "/org/org-1/feature-flags");
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].effectiveState, true);
});

test("POST feature-flag-rules (org scope) denies a non-admin org member", async (t) => {
  stubFetch(t, (table, method) => orgFacilities(table, method) ?? []);
  const { call } = mount({ memberships: ORG_MEMBER });
  const result = await call("POST", "/org/org-1/feature-flag-rules", {
    featureFlagId: "flag-1",
    scopeType: "organization",
    scopeId: "org-1",
    state: true
  });
  assert.equal(result.status, 403);
});

test("POST feature-flag-rules happy path inserts the shaped row for an org admin", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    const of = orgFacilities(table, method);
    if (of) return of;
    if (table === "feature_flag_rules" && method === "POST") return [{ id: "rule-1" }];
    return [];
  });
  const { call } = mount({ memberships: ORG_ADMIN });
  const result = await call("POST", "/org/org-1/feature-flag-rules", {
    featureFlagId: "flag-1",
    scopeType: "organization",
    scopeId: "org-1",
    state: false,
    rolloutPercentage: 25
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "feature_flag_rules" && c.method === "POST");
  assert.equal(insert.body[0].feature_flag_id, "flag-1");
  assert.equal(insert.body[0].scope_type, "organization");
  assert.equal(insert.body[0].scope_id, "org-1");
  assert.equal(insert.body[0].state, false);
  assert.equal(insert.body[0].rollout_percentage, 25);
});

test("POST feature-flag-rules rejects an out-of-range rollout percentage", async (t) => {
  stubFetch(t, (table, method) => orgFacilities(table, method) ?? []);
  const { call } = mount({ memberships: ORG_ADMIN });
  const result = await call("POST", "/org/org-1/feature-flag-rules", {
    featureFlagId: "flag-1",
    scopeType: "organization",
    scopeId: "org-1",
    rolloutPercentage: 150
  });
  assert.equal(result.status, 400);
});

test("POST feature-flag-rules rejects an org-scoped rule targeting a different org than the path", async (t) => {
  stubFetch(t, (table, method) => orgFacilities(table, method) ?? []);
  const { call } = mount({ memberships: ORG_ADMIN });
  const result = await call("POST", "/org/org-1/feature-flag-rules", {
    featureFlagId: "flag-1",
    scopeType: "organization",
    scopeId: "org-2"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.errors[0], /must target the organization in the path/);
});

test("POST feature-flag-rules rejects a facility-scoped rule whose facility belongs to another org", async (t) => {
  stubFetch(t, (table, method, parsed) => {
    if (table === "facilities" && method === "GET") {
      if ((parsed.searchParams.get("id") ?? "").includes("fac-9")) {
        return [{ id: "fac-9", organization_id: "org-2" }];
      }
      return [{ id: "fac-1", organization_id: "org-1" }];
    }
    return [];
  });
  const { call } = mount({ memberships: ORG_ADMIN });
  const result = await call("POST", "/org/org-1/feature-flag-rules", {
    featureFlagId: "flag-1",
    scopeType: "facility",
    scopeId: "fac-9"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.errors[0], /facility of the organization in the path/);
});

test("PATCH feature-flag-rules authorizes against the rule's actual org, not the path org", async (t) => {
  stubFetch(t, (table, method, parsed) => {
    if (table === "feature_flag_rules" && method === "GET") {
      return [{ id: "rule-9", scope_type: "organization", scope_id: "org-2" }];
    }
    if (table === "facilities" && method === "GET") {
      const orgFilter = parsed.searchParams.get("organization_id") ?? "";
      if (orgFilter.includes("org-2")) return [{ id: "fac-2" }];
      return [{ id: "fac-1" }];
    }
    return [];
  });
  const { call } = mount({ memberships: ORG_ADMIN });
  const result = await call("PATCH", "/org/org-1/feature-flag-rules/rule-9", { state: false });
  assert.equal(result.status, 403);
});
