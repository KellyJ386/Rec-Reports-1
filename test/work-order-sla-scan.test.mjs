import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { scanWorkOrderSla } from "../src/lib/work-order-sla-scan.mjs";

// Same mocked-PostgREST stub-fetch style as test/notifications-worker.test.mjs.
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
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

// A time clear of the default 22:00-06:00 quiet-hours window (matches
// notifications-worker.test.mjs's NOON/QUIET convention).
const NOON = new Date("2026-08-13T15:00:00.000Z");
const QUIET = new Date("2026-08-13T23:00:00.000Z");

function workOrder(overrides = {}) {
  return {
    id: "wo-1",
    facility_id: "fac-1",
    title: "Fix pump",
    priority: "medium",
    status: "open",
    sla_due_at: "2026-08-13T10:00:00.000Z",
    sla_breached_at: null,
    ...overrides
  };
}

const ROUTE = {
  id: "route-1",
  facility_id: "fac-1",
  event_code: "work_order.overdue",
  priority: 1,
  route_jsonb: { distributionListId: "list-1", channels: ["in_app"] },
  active: true
};

// Stubs the full happy-path chain: candidates -> claim -> route -> list ->
// members -> employees -> dedupe check (none) -> insert. `over` lets a test
// override any table/method's response.
function stubScan(t, wo, over = {}) {
  return stubFetch(t, (table, method, url, body) => {
    if (over[table]) {
      const result = over[table](method, url, body);
      if (result !== undefined) return result;
    }
    if (table === "work_orders" && method === "GET") return [wo];
    if (table === "work_orders" && method === "PATCH") return [{ ...wo, sla_breached_at: new Date().toISOString() }];
    if (table === "notification_routes" && method === "GET") return [ROUTE];
    if (table === "distribution_lists" && method === "GET") return [{ id: "list-1", facility_id: "fac-1", active: true }];
    if (table === "distribution_list_members" && method === "GET") {
      return [{ id: "m-1", facility_id: "fac-1", distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-1" }];
    if (table === "notification_jobs" && method === "GET") return [];
    if (table === "notification_jobs" && method === "POST") return [{ id: "job-1" }];
    return [];
  });
}

test("scanWorkOrderSla stamps sla_breached_at on an open work order past its deadline", async (t) => {
  const captured = stubScan(t, workOrder(), {});
  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.breached, 1);
  const claim = captured.find((c) => c.table === "work_orders" && c.method === "PATCH");
  assert.ok(claim.body.sla_breached_at);
  assert.equal(claim.url.searchParams.get("sla_breached_at"), "is.null"); // CAS guard
});

test("scanWorkOrderSla only selects open, unbreached, overdue work orders", async (t) => {
  const captured = stubScan(t, workOrder(), {});
  await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  const select = captured.find((c) => c.table === "work_orders" && c.method === "GET");
  assert.match(select.url.search, /status=in\.%28open%2Cin_progress%2Con_hold%29|status=in\.\(open,in_progress,on_hold\)/);
  assert.equal(select.url.searchParams.get("sla_breached_at"), "is.null");
  assert.match(select.url.searchParams.get("sla_due_at"), /^lt\./);
});

test("scanWorkOrderSla enqueues one notification_jobs row per recipient with a dedupeKey", async (t) => {
  const wo = workOrder();
  const captured = stubScan(t, wo, {});
  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  assert.equal(summary.enqueued, 1);
  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.ok(insert, "expected a notification_jobs insert");
  assert.deepEqual(insert.body[0].payload_jsonb.recipients, ["emp-1"]);
  assert.equal(insert.body[0].payload_jsonb.dedupeKey, `${wo.id}:overdue:${wo.sla_due_at}:emp-1`);
  assert.equal(insert.body[0].payload_jsonb.work_order_id, wo.id);
});

test("scanWorkOrderSla dedupes against an existing job carrying the same dedupeKey", async (t) => {
  const captured = stubScan(t, workOrder(), {
    notification_jobs: (method) => (method === "GET" ? [{ id: "existing-job" }] : undefined)
  });
  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  assert.equal(summary.deduped, 1);
  assert.equal(summary.enqueued, 0);
  assert.ok(!captured.some((c) => c.table === "notification_jobs" && c.method === "POST"));
});

test("scanWorkOrderSla defers scheduled_for to the quiet-hours window end for a non-urgent work order", async (t) => {
  const captured = stubScan(t, workOrder({ priority: "medium" }), {});
  await scanWorkOrderSla(client(), { now: QUIET, limit: 25 });
  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.notEqual(insert.body[0].scheduled_for, QUIET.toISOString());
  assert.equal(insert.body[0].payload_jsonb.quietHoursBypass, false);
});

test("scanWorkOrderSla bypasses quiet hours for an urgent work order", async (t) => {
  const captured = stubScan(t, workOrder({ priority: "urgent" }), {});
  await scanWorkOrderSla(client(), { now: QUIET, limit: 25 });
  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.equal(insert.body[0].scheduled_for, QUIET.toISOString());
  assert.equal(insert.body[0].payload_jsonb.quietHoursBypass, true);
});

test("scanWorkOrderSla still runs outside quiet hours with scheduled_for = now", async (t) => {
  const captured = stubScan(t, workOrder({ priority: "medium" }), {});
  await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.equal(insert.body[0].scheduled_for, NOON.toISOString());
});

test("scanWorkOrderSla still stamps the breach when the facility has no active route, enqueuing nothing", async (t) => {
  const captured = stubScan(t, workOrder(), {
    notification_routes: () => []
  });
  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  assert.equal(summary.breached, 1);
  assert.equal(summary.noRoute, 1);
  assert.equal(summary.enqueued, 0);
  assert.ok(!captured.some((c) => c.table === "notification_jobs" && c.method === "POST"));
});

test("scanWorkOrderSla skips a row it loses the claim race on", async (t) => {
  const captured = stubScan(t, workOrder(), {
    work_orders: (method) => (method === "PATCH" ? [] : undefined) // lost the race
  });
  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.breached, 0);
  assert.ok(!captured.some((c) => c.table === "notification_routes"));
});

test("scanWorkOrderSla returns an all-zero summary when there is nothing to scan", async (t) => {
  stubFetch(t, () => []);
  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });
  assert.deepEqual(summary, { scanned: 0, breached: 0, enqueued: 0, deduped: 0, noRoute: 0 });
});
