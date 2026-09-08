import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { generatePmWorkOrders } from "../src/lib/pm-generation.mjs";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const CONFLICT = Symbol("conflict");

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

// Mocked-PostgREST stub, same style as test/report-workflow-executor.test.mjs
// and test/work-orders-routes.test.mjs, extended to let `respond` return the
// CONFLICT sentinel to simulate a unique_violation (PostgREST 409).
function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body });
    const result = respond(table, method, parsed, body);
    if (result === CONFLICT) {
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" })
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// Default shape: anchored exactly on NOW's date with a wide interval, so
// exactly ONE occurrence is due within the default 30-day horizon --
// keeps every test that doesn't care about cadence math itself dealing with
// a single, unambiguous occurrence.
function intervalPlanRow(overrides = {}) {
  return {
    id: "plan-1",
    facility_id: "fac-1",
    asset_id: null,
    title: "Pool pump service",
    description: "Quarterly service",
    cadence_type: "interval",
    interval_days: 90,
    anchor_date: "2026-03-15",
    season_months: null,
    lead_time_days: 0,
    priority: "medium",
    default_assignee_employee_id: null,
    active: true,
    last_generated_at: null,
    created_at: "2025-12-01T00:00:00.000Z",
    ...overrides
  };
}

test("generates a work order + linked occurrence for a due interval occurrence", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "pm_plans" && method === "GET") return [intervalPlanRow()];
    if (table === "pm_plan_occurrences" && method === "POST") return [{ id: "occ-1" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    if (table === "pm_plan_occurrences" && method === "PATCH") return [{ id: "occ-1", work_order_id: "wo-1" }];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });

  const summary = await generatePmWorkOrders(client(), { now: NOW, config: {} });
  assert.equal(summary.plansScanned, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.repaired, 0);
  assert.deepEqual(summary.errors, []);

  const occInsert = captured.find((c) => c.table === "pm_plan_occurrences" && c.method === "POST");
  assert.equal(occInsert.body[0].pm_plan_id, "plan-1");
  assert.equal(occInsert.body[0].scheduled_for, "2026-03-15");
  assert.equal(occInsert.body[0].work_order_id, null);

  const woInsert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(woInsert.body[0].source_type, "pm");
  assert.equal(woInsert.body[0].source_pm_plan_id, "plan-1");
  assert.equal(woInsert.body[0].source_pm_occurrence_id, "occ-1");
  assert.equal(woInsert.body[0].due_at, "2026-03-15T00:00:00.000Z");

  // M-4: the generation-slot CAS claim runs BEFORE minting, gated on
  // generated_at is.null (extra passthrough), and stamps generated_at --
  // separate from the post-mint link PATCH, which only sets work_order_id.
  const genClaim = captured.find(
    (c) => c.table === "pm_plan_occurrences" && c.method === "PATCH" && c.url.searchParams.get("generated_at") === "is.null"
  );
  assert.ok(genClaim, "expected a CAS'd generated_at claim PATCH before minting");
  assert.ok(genClaim.body.generated_at);
  assert.equal(genClaim.body.work_order_id, undefined);

  const occLink = captured.find(
    (c) => c.table === "pm_plan_occurrences" && c.method === "PATCH" && c.body.work_order_id !== undefined
  );
  assert.ok(occLink, "expected a link PATCH setting work_order_id");
  assert.equal(occLink.body.work_order_id, "wo-1");
  assert.equal(occLink.body.generated_at, undefined);

  const planPatch = captured.find((c) => c.table === "pm_plans" && c.method === "PATCH");
  assert.ok(planPatch, "last_generated_at should be updated when a work order was created");
  assert.ok(planPatch.body.last_generated_at);
});

test("only scans active, non-deleted plans", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [];
    return [];
  });
  await generatePmWorkOrders(client(), { now: NOW, config: {} });
  const get = captured.find((c) => c.table === "pm_plans" && c.method === "GET");
  assert.match(get.url.search, /active=eq\.true/);
  assert.match(get.url.search, /deleted_at=is\.null/);
});

test("idempotency: running generation twice creates exactly one work order", async (t) => {
  // Pass 1: the occurrence slot is unclaimed.
  let occurrenceClaimed = false;
  let workOrderCount = 0;
  const plan = intervalPlanRow();

  function respond(table, method) {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "POST") {
      if (occurrenceClaimed) return CONFLICT;
      occurrenceClaimed = true;
      return [{ id: "occ-1" }];
    }
    if (table === "pm_plan_occurrences" && method === "GET") {
      // Second pass's conflict-recovery lookup: fully generated already.
      return [{ id: "occ-1", work_order_id: workOrderCount > 0 ? "wo-1" : null }];
    }
    if (table === "work_orders" && method === "POST") {
      workOrderCount += 1;
      return [{ id: "wo-1" }];
    }
    if (table === "pm_plan_occurrences" && method === "PATCH") return [{ id: "occ-1", work_order_id: "wo-1" }];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  }

  stubFetch(t, respond);
  const first = await generatePmWorkOrders(client(), { now: NOW, config: {} });
  const second = await generatePmWorkOrders(client(), { now: NOW, config: {} });

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);
  assert.equal(workOrderCount, 1, "exactly one work order should have been minted across both passes");
});

test("conflict repair: an occurrence claimed but never linked to a work order is repaired", async (t) => {
  const plan = intervalPlanRow();
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    // The occurrence was already claimed by a previous, interrupted pass.
    if (table === "pm_plan_occurrences" && method === "POST") return CONFLICT;
    if (table === "pm_plan_occurrences" && method === "GET") return [{ id: "occ-existing", work_order_id: null }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-repaired" }];
    if (table === "pm_plan_occurrences" && method === "PATCH") return [{ id: "occ-existing", work_order_id: "wo-repaired" }];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });

  const summary = await generatePmWorkOrders(client(), { now: NOW, config: {} });
  assert.equal(summary.created, 1);
  assert.equal(summary.repaired, 1);
  assert.equal(summary.skipped, 0);

  const woInsert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(woInsert.body[0].source_pm_occurrence_id, "occ-existing");

  // M-4: the repair path also goes through the generated_at CAS claim
  // before minting -- not just the fresh-insert path.
  const genClaim = captured.find(
    (c) => c.table === "pm_plan_occurrences" && c.method === "PATCH" && c.url.searchParams.get("generated_at") === "is.null"
  );
  assert.ok(genClaim, "expected a CAS'd generated_at claim PATCH on the repair path too");

  const occLink = captured.find(
    (c) => c.table === "pm_plan_occurrences" && c.method === "PATCH" && c.body.work_order_id !== undefined
  );
  assert.equal(occLink.body.work_order_id, "wo-repaired");
});

// M-4 (security review, wave3-slice-3c): two concurrent passes both
// legitimately reaching the repair branch for the SAME occurrence id (both
// see work_order_id still null) must still mint exactly ONE work order --
// the generated_at CAS claim, not the occurrence-row conflict alone, is
// what decides the single winner. See probes reference in
// preventive-maintenance's/pm-generation's own module header for the race
// this closes.
test("conflict repair: two concurrent passes racing the SAME unlinked occurrence mint exactly one work order", async (t) => {
  const plan = intervalPlanRow();
  let generationSlotClaimed = false;
  let workOrderCount = 0;
  stubFetch(t, (table, method, url) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    // Both passes see the occurrence already claimed by an earlier,
    // interrupted run (work_order_id still null) -- via the conflict path.
    if (table === "pm_plan_occurrences" && method === "POST") return CONFLICT;
    if (table === "pm_plan_occurrences" && method === "GET") return [{ id: "occ-existing", work_order_id: null }];
    if (table === "pm_plan_occurrences" && method === "PATCH") {
      if (url.searchParams.get("generated_at") === "is.null") {
        // Only the FIRST caller wins the CAS -- the second gets zero rows
        // back, exactly like a real is.null-guarded UPDATE racing another
        // writer.
        if (generationSlotClaimed) return [];
        generationSlotClaimed = true;
        return [{ id: "occ-existing", generated_at: NOW.toISOString() }];
      }
      return [{ id: "occ-existing", work_order_id: "wo-repaired" }];
    }
    if (table === "work_orders" && method === "POST") {
      workOrderCount += 1;
      return [{ id: "wo-repaired" }];
    }
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });

  const first = await generatePmWorkOrders(client(), { now: NOW, config: {} });
  const second = await generatePmWorkOrders(client(), { now: NOW, config: {} });

  assert.equal(first.created + second.created, 1, "exactly one pass should report a mint");
  assert.equal(first.skipped + second.skipped, 1, "the losing pass should skip, not double-mint");
  assert.equal(workOrderCount, 1, "exactly one work order should have been minted across both passes");
});

// N-2 (security re-verification): claimGenerationSlot takes a durable claim
// before the mint. If the mint fails, the claim must be given back (CAS on
// the exact stamped value, only where no work order got linked) so the next
// pass retries instead of skipping a half-claimed row forever.
test("a failed mint reverts the generation claim and records the error instead of stranding the occurrence", async (t) => {
  const plan = intervalPlanRow();
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "POST") return [{ id: "occ-new", work_order_id: null }];
    if (table === "pm_plan_occurrences" && method === "PATCH") {
      if (url.searchParams.get("generated_at") === "is.null") return [{ id: "occ-new", generated_at: NOW.toISOString() }];
      return [{ id: "occ-new" }];
    }
    if (table === "work_orders" && method === "POST") throw new Error("simulated work_orders insert failure");
    return [];
  });

  const summary = await generatePmWorkOrders(client(), { now: NOW, config: {} });

  assert.equal(summary.created, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].error, /simulated work_orders insert failure/);
  const revert = captured.find(
    (c) =>
      c.table === "pm_plan_occurrences" &&
      c.method === "PATCH" &&
      c.url.searchParams.get("work_order_id") === "is.null" &&
      c.body?.generated_at === null
  );
  assert.ok(revert, "the generation claim should be CAS-reverted to null after a failed mint");
  assert.equal(revert.url.searchParams.get("generated_at"), `eq.${NOW.toISOString()}`);
  assert.ok(!captured.some((c) => c.table === "pm_plans" && c.method === "PATCH"), "last_generated_at must not advance on a failed mint");
});

test("horizon: an occurrence past the horizon is never generated, even when its lead time would otherwise make it due", async (t) => {
  // scheduled_for = NOW+17d (2026-04-01). lead_time_days=60 means
  // generationDate = scheduled_for - 60d = 2026-01-31, well before NOW --
  // the "generation date <= now" gate alone WOULD admit it. But
  // pmHorizonDays=10 caps occurrencesInWindow's own upper bound at NOW+10d
  // (2026-03-25), which is before the occurrence's scheduled_for -- so
  // occurrencesInWindow never returns it in the first place, and it must
  // never be generated regardless of lead time.
  const plan = intervalPlanRow({
    anchor_date: "2026-04-01",
    interval_days: 365,
    lead_time_days: 60,
    created_at: "2026-01-01T00:00:00.000Z"
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    return [];
  });

  const summary = await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 10 } });
  assert.equal(summary.created, 0);
  assert.equal(captured.filter((c) => c.table === "pm_plan_occurrences" && c.method === "POST").length, 0);
  assert.equal(captured.filter((c) => c.table === "work_orders" && c.method === "POST").length, 0);
});

test("horizon: nothing is generated when every due occurrence is outside the horizon window", async (t) => {
  const plan = intervalPlanRow({
    anchor_date: "2027-01-01",
    interval_days: 365,
    created_at: "2026-01-01T00:00:00.000Z"
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    return [];
  });
  // Horizon of 30 days from NOW (2026-03-15) does not reach the plan's next
  // occurrence (2027-01-01).
  const summary = await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 30 } });
  assert.equal(summary.created, 0);
  assert.equal(captured.filter((c) => c.table === "work_orders" && c.method === "POST").length, 0);
});

test("never backfills occurrences before the plan's created_at even when the anchor is much older", async (t) => {
  const plan = intervalPlanRow({
    anchor_date: "2020-01-01",
    interval_days: 30,
    created_at: "2026-03-01T00:00:00.000Z"
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "POST") return [{ id: "occ-1" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    if (table === "pm_plan_occurrences" && method === "PATCH") return [{ id: "occ-1" }];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });

  await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 60 } });
  const occInserts = captured.filter((c) => c.table === "pm_plan_occurrences" && c.method === "POST");
  for (const insert of occInserts) {
    assert.ok(
      insert.body[0].scheduled_for >= "2026-03-01",
      `occurrence ${insert.body[0].scheduled_for} predates the plan's created_at`
    );
  }
});

test("inactive plans generate nothing (excluded by the active=eq.true query filter)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    // The query itself filters active=true, so a correctly-behaving job
    // never even sees an inactive plan row in the first place.
    if (table === "pm_plans" && method === "GET") return [];
    return [];
  });
  const summary = await generatePmWorkOrders(client(), { now: NOW, config: {} });
  assert.equal(summary.plansScanned, 0);
  assert.equal(summary.created, 0);
  assert.equal(captured.filter((c) => c.table === "work_orders").length, 0);
});

test("a plan with zero due occurrences leaves last_generated_at untouched", async (t) => {
  const plan = intervalPlanRow({ anchor_date: "2030-01-01", created_at: "2026-01-01T00:00:00.000Z" });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    return [];
  });
  const summary = await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 30 } });
  assert.equal(summary.created, 0);
  assert.equal(captured.filter((c) => c.table === "pm_plans" && c.method === "PATCH").length, 0);
});

test("lead time: an occurrence whose generation date is still in the future is not generated yet", async (t) => {
  // Anchor 20 days after NOW with a 5-day lead time -> generationDate is 15
  // days from now, still in the future -> not due yet.
  const plan = intervalPlanRow({
    anchor_date: "2026-04-04", // NOW + 20 days
    lead_time_days: 5,
    interval_days: 30,
    created_at: "2026-01-01T00:00:00.000Z"
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    return [];
  });
  const summary = await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 60 } });
  assert.equal(summary.created, 0);
  assert.equal(captured.filter((c) => c.table === "work_orders").length, 0);
});

test("lead time: an occurrence whose generation date has arrived is generated even though scheduled_for is later", async (t) => {
  // Anchor 3 days after NOW with a 5-day lead time -> generationDate is 2
  // days BEFORE now -> due.
  const plan = intervalPlanRow({
    anchor_date: "2026-03-18", // NOW + 3 days
    lead_time_days: 5,
    interval_days: 30,
    created_at: "2026-01-01T00:00:00.000Z"
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "POST") return [{ id: "occ-1" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    if (table === "pm_plan_occurrences" && method === "PATCH") return [{ id: "occ-1" }];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });
  const summary = await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 60 } });
  assert.equal(summary.created, 1);
  const woInsert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(woInsert.body[0].due_at, "2026-03-18T00:00:00.000Z"); // due date is unaffected by lead time
});

test("seasonal plans generate through the same code path", async (t) => {
  const plan = intervalPlanRow({
    cadence_type: "seasonal",
    interval_days: null,
    season_months: [3],
    anchor_date: "2026-01-15",
    created_at: "2026-01-01T00:00:00.000Z"
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "pm_plans" && method === "GET") return [plan];
    if (table === "pm_plan_occurrences" && method === "POST") return [{ id: "occ-1" }];
    if (table === "work_orders" && method === "POST") return [{ id: "wo-1" }];
    if (table === "pm_plan_occurrences" && method === "PATCH") return [{ id: "occ-1" }];
    if (table === "pm_plans" && method === "PATCH") return [{ id: "plan-1" }];
    return [];
  });
  const summary = await generatePmWorkOrders(client(), { now: NOW, config: { "workOrders.pmHorizonDays": 30 } });
  assert.equal(summary.created, 1);
  const woInsert = captured.find((c) => c.table === "work_orders" && c.method === "POST");
  assert.equal(woInsert.body[0].due_at, "2026-03-15T00:00:00.000Z");
});
