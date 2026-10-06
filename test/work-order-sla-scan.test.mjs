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
  assert.deepEqual(summary, { scanned: 0, breached: 0, enqueued: 0, deduped: 0, noRoute: 0, errors: [] });
});

// N-4 (security re-verification): the revert itself is a network call. If
// it fails, the pass must record that too and carry on with the remaining
// candidates rather than throwing out of the drain.
test("scanWorkOrderSla records a failed revert and still processes the remaining candidates", async (t) => {
  const wo1 = workOrder({ id: "wo-1" });
  const wo2 = workOrder({ id: "wo-2", sla_due_at: "2026-08-13T09:00:00.000Z" });
  stubFetch(t, (table, method, url, body) => {
    if (table === "work_orders" && method === "GET") return [wo1, wo2];
    if (table === "work_orders" && method === "PATCH") {
      if (body.sla_breached_at === null) throw new Error("simulated revert failure");
      const wo = url.searchParams.get("id") === "eq.wo-1" ? wo1 : wo2;
      return [{ ...wo, ...body }];
    }
    if (table === "notification_routes" && method === "GET") return [ROUTE];
    if (table === "distribution_lists" && method === "GET") return [{ id: "list-1", facility_id: "fac-1", active: true }];
    if (table === "distribution_list_members" && method === "GET") {
      return [{ id: "m-1", facility_id: "fac-1", distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-1" }];
    if (table === "notification_jobs" && method === "GET") return [];
    if (table === "notification_jobs" && method === "POST") {
      if (body[0].payload_jsonb.work_order_id === "wo-1") throw new Error("simulated notification_jobs insert failure");
      return [{ id: "job-2" }];
    }
    return [];
  });

  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });

  assert.equal(summary.scanned, 2);
  assert.equal(summary.enqueued, 1, "wo-2 must still be enqueued after wo-1's revert failed");
  assert.deepEqual(
    summary.errors.map((e) => [e.workOrderId, e.stage]),
    [
      ["wo-1", "notify"],
      ["wo-1", "revert"]
    ]
  );
});

// M-3 (security review, wave3-slice-3c): a post-claim failure on one
// candidate must revert its sla_breached_at stamp and be recorded in
// summary.errors, without throwing out of scanWorkOrderSla and without
// aborting any other candidate in the same pass (see
// probes-3c/p7_sla_lost_alert.mjs for the pre-fix reproduction -- a 503 mid-
// pass left the claimed row permanently stamped with nothing enqueued, and
// the second candidate was never even scanned).
test("scanWorkOrderSla reverts the claim and records an error when a post-claim step fails, without aborting the rest of the pass", async (t) => {
  const wo1 = workOrder({ id: "wo-1" });
  const wo2 = workOrder({ id: "wo-2", sla_due_at: "2026-08-13T09:00:00.000Z" });
  const captured = stubFetch(t, (table, method, url, body) => {
    if (table === "work_orders" && method === "GET") return [wo1, wo2];
    if (table === "work_orders" && method === "PATCH") {
      const wo = url.searchParams.get("id") === "eq.wo-1" ? wo1 : wo2;
      return [{ ...wo, ...body }];
    }
    if (table === "notification_routes" && method === "GET") return [ROUTE];
    if (table === "distribution_lists" && method === "GET") return [{ id: "list-1", facility_id: "fac-1", active: true }];
    if (table === "distribution_list_members" && method === "GET") {
      return [{ id: "m-1", facility_id: "fac-1", distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-1" }];
    if (table === "notification_jobs" && method === "GET") return [];
    if (table === "notification_jobs" && method === "POST") {
      // Simulate a downstream failure (e.g. a transient PostgREST outage)
      // for wo-1's enqueue specifically -- wo-2's must be unaffected.
      if (body[0].payload_jsonb.work_order_id === "wo-1") {
        throw new Error("simulated notification_jobs insert failure");
      }
      return [{ id: "job-2" }];
    }
    return [];
  });

  const summary = await scanWorkOrderSla(client(), { now: NOON, limit: 25 });

  // Both were scanned and claimed at the DB level; wo-1's claim is reverted
  // by the time this returns, so the net breached count only counts wo-2.
  assert.equal(summary.scanned, 2);
  assert.equal(summary.breached, 1);
  assert.equal(summary.enqueued, 1);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].workOrderId, "wo-1");
  assert.match(summary.errors[0].error, /simulated notification_jobs insert failure/);

  // wo-1's stamp was reverted -- a CAS'd PATCH setting sla_breached_at back
  // to null, guarded on the exact value this call had just claimed with.
  const revertPatch = captured.find(
    (c) => c.table === "work_orders" && c.method === "PATCH" && c.url.searchParams.get("id") === "eq.wo-1" && c.body.sla_breached_at === null
  );
  assert.ok(revertPatch, "expected a revert PATCH clearing wo-1's sla_breached_at");
  assert.match(revertPatch.url.search, /sla_breached_at=eq\./);

  // wo-2 was completely unaffected by wo-1's failure.
  const wo2Insert = captured.find(
    (c) => c.table === "notification_jobs" && c.method === "POST" && c.body[0].payload_jsonb.work_order_id === "wo-2"
  );
  assert.ok(wo2Insert, "wo-2's notification should still have been enqueued");
});
