import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerPmPlanRoutes } from "../src/lib/http/pm-plans-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["work_orders.read", "work_orders.manage"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["work_orders.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["work_orders.read", "work_orders.manage"] }];

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

function mount({ memberships = MANAGER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerPmPlanRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

function planFixture(overrides = {}) {
  return {
    id: "plan-1",
    facility_id: "fac-1",
    asset_id: null,
    title: "Pool pump service",
    description: "Quarterly service",
    cadence_type: "interval",
    interval_days: 30,
    anchor_date: "2026-01-01",
    season_months: null,
    lead_time_days: 0,
    priority: "medium",
    default_assignee_employee_id: null,
    active: true,
    last_generated_at: null,
    created_at: "2025-12-01T00:00:00.000Z",
    updated_at: "2025-12-01T00:00:00.000Z",
    ...overrides
  };
}

// --- GET list ---------------------------------------------------------

test("GET pm-plans denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/pm-plans");
  assert.equal(result.status, 403);
});

test("GET pm-plans returns plans for a reader", async (t) => {
  const captured = stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/pm-plans");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  const get = captured.find((c) => c.table === "pm_plans");
  assert.match(get.url.search, /facility_id=eq\.fac-1/);
  assert.match(get.url.search, /deleted_at=is\.null/);
});

test("GET pm-plans?active=bogus 400s before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/pm-plans?active=bogus");
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

// --- POST create --------------------------------------------------------

test("POST pm-plans validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/pm-plans", { title: "Filter change" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST pm-plans denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    cadence_type: "interval",
    interval_days: 30,
    anchor_date: "2026-01-01"
  });
  assert.equal(result.status, 403);
});

test("POST pm-plans rejects interval_days < 1", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    cadence_type: "interval",
    interval_days: 0,
    anchor_date: "2026-01-01"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST pm-plans rejects an out-of-range season month", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    cadence_type: "seasonal",
    season_months: [0, 13],
    anchor_date: "2026-01-01"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST pm-plans rejects a missing anchor_date", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    cadence_type: "interval",
    interval_days: 30
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST pm-plans happy path inserts a shaped interval plan row (active=true, no backfill)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "POST") return [{ id: "plan-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    description: "Change the pool filter",
    cadence_type: "interval",
    interval_days: 30,
    anchor_date: "2020-01-01", // a past anchor -- must not trigger any generation/backfill call
    priority: "high"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "pm_plans" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].title, "Filter change");
  assert.equal(insert.body[0].cadence_type, "interval");
  assert.equal(insert.body[0].interval_days, 30);
  assert.equal(insert.body[0].season_months, null);
  assert.equal(insert.body[0].anchor_date, "2020-01-01");
  assert.equal(insert.body[0].priority, "high");
  assert.equal(insert.body[0].active, true);
  assert.equal(insert.body[0].created_by, "user-9");
  // No occurrence/work-order writes -- creation never backfills.
  assert.ok(!captured.some((c) => c.table === "pm_plan_occurrences"));
  assert.ok(!captured.some((c) => c.table === "work_orders"));
});

test("POST pm-plans ignores a body-supplied facility_id, always using the path facility", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "POST") return [{ id: "plan-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    cadence_type: "interval",
    interval_days: 30,
    anchor_date: "2026-01-01",
    facility_id: "fac-evil"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "pm_plans" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
});

test("POST pm-plans rejects a cross-facility asset_id with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "assets" && method === "GET") return [{ id: "asset-1", facility_id: "fac-2" }];
    if (table === "pm_plans" && method === "POST") return [{ id: "plan-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/pm-plans", {
    title: "Filter change",
    cadence_type: "interval",
    interval_days: 30,
    anchor_date: "2026-01-01",
    asset_id: "asset-1"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /asset_id/);
  assert.ok(!captured.some((c) => c.table === "pm_plans"), "must not attempt the insert");
});

// --- GET/PATCH by id -----------------------------------------------------

test("GET pm-plan by id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/pm-plans/nope");
  assert.equal(result.status, 404);
});

test("GET pm-plan by id denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/pm-plans/plan-1");
  assert.equal(result.status, 403);
});

test("GET pm-plan by id returns the plan for a reader", async (t) => {
  stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.id, "plan-1");
});

test("PATCH pm-plan 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/pm-plans/nope", { title: "New title" });
  assert.equal(result.status, 404);
});

test("PATCH pm-plan denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/pm-plans/plan-1", { title: "New title" });
  assert.equal(result.status, 403);
});

test("PATCH pm-plan updates a single field, leaving the rest merged from the existing row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [planFixture()];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1", title: "New title" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/pm-plans/plan-1", { title: "New title" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "pm_plans" && c.method === "PATCH");
  assert.equal(patch.body.title, "New title");
  assert.equal(patch.body.interval_days, 30); // carried over from the existing row
  assert.equal(patch.body.cadence_type, "interval");
});

test("PATCH pm-plan switching cadence_type to seasonal without season_months is rejected (400, no write)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [planFixture()];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/pm-plans/plan-1", { cadence_type: "seasonal" });
  assert.equal(result.status, 400);
  assert.ok(!captured.some((c) => c.table === "pm_plans" && c.method === "PATCH"));
});

test("PATCH pm-plan switching cadence_type to seasonal with season_months clears interval_days", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [planFixture()];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/pm-plans/plan-1", { cadence_type: "seasonal", season_months: [3, 9] });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "pm_plans" && c.method === "PATCH");
  assert.equal(patch.body.cadence_type, "seasonal");
  assert.deepEqual(patch.body.season_months, [3, 9]);
  assert.equal(patch.body.interval_days, null);
});

test("PATCH pm-plan rejects a cross-facility asset_id with 400, not a 500", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [planFixture()];
    if (table === "assets" && method === "GET") return [{ id: "asset-1", facility_id: "fac-2" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/pm-plans/plan-1", { asset_id: "asset-1" });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /asset_id/);
  assert.ok(!captured.some((c) => c.table === "pm_plans" && c.method === "PATCH"));
});

// --- Deactivate -----------------------------------------------------------

test("POST pm-plan deactivate 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/pm-plans/nope/deactivate");
  assert.equal(result.status, 404);
});

test("POST pm-plan deactivate denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/pm-plans/plan-1/deactivate");
  assert.equal(result.status, 403);
});

test("POST pm-plan deactivate sets active=false and touches nothing else", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [planFixture()];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1", active: false }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/pm-plans/plan-1/deactivate");
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "pm_plans" && c.method === "PATCH");
  assert.equal(patch.body.active, false);
  assert.equal(Object.keys(patch.body).length, 2); // active + updated_at only
  assert.ok(!captured.some((c) => c.table === "work_orders"), "deactivate must not touch generated work orders");
});

// --- Occurrences ------------------------------------------------------

test("GET pm-plan occurrences 404s when the plan is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/pm-plans/nope/occurrences");
  assert.equal(result.status, 404);
});

test("GET pm-plan occurrences denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences");
  assert.equal(result.status, 403);
});

test("GET pm-plan occurrences rejects a malformed ?from", async (t) => {
  stubFetch(t, (table) => (table === "pm_plans" ? [planFixture()] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences?from=not-a-date");
  assert.equal(result.status, 400);
});

test("GET pm-plan occurrences merges stored ledger rows with a computed preview", async (t) => {
  const plan = planFixture({ anchor_date: "2026-01-01", interval_days: 30 });
  stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "GET") {
      return [{ id: "occ-1", pm_plan_id: "plan-1", scheduled_for: "2026-01-01", work_order_id: "wo-1", generated_at: "2026-01-01T00:00:00.000Z" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences?from=2026-01-01&to=2026-02-05");
  assert.equal(result.status, 200);
  const stored = result.payload.find((o) => o.scheduledFor === "2026-01-01");
  assert.equal(stored.preview, false);
  assert.equal(stored.workOrderId, "wo-1");
  const preview = result.payload.find((o) => o.scheduledFor === "2026-01-31");
  assert.ok(preview, "the not-yet-generated occurrence should appear as a preview entry");
  assert.equal(preview.preview, true);
  // No duplicate entry for the already-stored date.
  assert.equal(result.payload.filter((o) => o.scheduledFor === "2026-01-01").length, 1);
});

test("GET pm-plan occurrences defaults to an 8-week window from today when from/to are omitted", async (t) => {
  const plan = planFixture();
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences");
  assert.equal(result.status, 200);
  const occGet = captured.find((c) => c.table === "pm_plan_occurrences" && c.method === "GET");
  const today = new Date().toISOString().slice(0, 10);
  assert.match(occGet.url.search, new RegExp(`scheduled_for=gte\\.${today}`));
});

// H-2 (security review, wave3-slice-3c): an unbounded ?from=/?to= window
// used to let occurrencesInWindow materialize millions of dates in-process
// (see probes-3c/p6_occurrence_dos.mjs -- interval_days=1,
// 2026-09-07..9999-12-31 produced 2.9M+ entries before this fix). The route
// now rejects an over-wide window with 400 before ever calling
// occurrencesInWindow, ahead of even the permission guard's DB read below
// mattering for THIS check -- the date-shape/span validation runs after the
// plan load+guard in this route (see the file's own comment), so the guard
// still runs first, but no occurrence computation ever happens for a
// rejected window.
test("GET pm-plan occurrences rejects a window wider than the maximum span with 400, before any occurrence computation", async (t) => {
  const plan = planFixture({ cadence_type: "interval", interval_days: 1, anchor_date: "2020-01-01" });
  stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences?from=2026-09-07&to=9999-12-31");
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /must not exceed/);
});

// N-3 (security re-verification): the YYYY-MM-DD pattern alone admits
// 9999-99-99, which parses to NaN and slipped past the window cap.
test("GET pm-plan occurrences rejects a well-formed but impossible calendar date", async (t) => {
  const plan = planFixture({ cadence_type: "interval", interval_days: 1, anchor_date: "2020-01-01" });
  stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    return [];
  });
  const { call } = mount({ memberships: READER });
  for (const query of ["from=2026-09-07&to=9999-99-99", "from=2026-02-30&to=2026-03-01", "from=2026-13-01"]) {
    const result = await call("GET", `/pm-plans/plan-1/occurrences?${query}`);
    assert.equal(result.status, 400, query);
    assert.match(result.payload.error, /valid YYYY-MM-DD/, query);
  }
});

test("GET pm-plan occurrences accepts a window right at the maximum span", async (t) => {
  const plan = planFixture({ cadence_type: "interval", interval_days: 30, anchor_date: "2026-01-01" });
  stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences?from=2026-01-01&to=2027-02-05"); // exactly 400 days
  assert.equal(result.status, 200);
});

test("GET pm-plan occurrences rejects a window one day past the maximum span", async (t) => {
  const plan = planFixture({ cadence_type: "interval", interval_days: 30, anchor_date: "2026-01-01" });
  stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/pm-plans/plan-1/occurrences?from=2026-01-01&to=2027-02-06"); // 401 days
  assert.equal(result.status, 400);
});
