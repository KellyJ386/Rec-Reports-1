import test from "node:test";
import assert from "node:assert/strict";
import { nextOccurrence, occurrencesInWindow, workOrderFromPlan } from "../src/lib/preventive-maintenance.mjs";

function intervalPlan(overrides = {}) {
  return {
    id: "plan-1",
    facilityId: "fac-1",
    assetId: null,
    title: "Pool pump service",
    description: "Quarterly service",
    cadenceType: "interval",
    intervalDays: 30,
    anchorDate: "2026-01-01",
    leadTimeDays: 0,
    priority: "medium",
    active: true,
    ...overrides
  };
}

function seasonalPlan(overrides = {}) {
  return {
    id: "plan-2",
    facilityId: "fac-1",
    assetId: null,
    title: "HVAC filter change",
    description: "Seasonal filter change",
    cadenceType: "seasonal",
    anchorDate: "2026-01-31",
    seasonMonths: [2, 4, 6],
    leadTimeDays: 0,
    priority: "low",
    active: true,
    ...overrides
  };
}

// --- interval cadence --------------------------------------------------

test("interval: occurrencesInWindow returns anchor + n*intervalDays within the window", () => {
  const plan = intervalPlan();
  const dates = occurrencesInWindow(plan, "2026-01-01", "2026-04-01").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-01-01", "2026-01-31", "2026-03-02", "2026-04-01"]);
});

test("interval: occurrencesInWindow with a from strictly after the anchor starts at the next multiple", () => {
  const plan = intervalPlan();
  const dates = occurrencesInWindow(plan, "2026-01-15", "2026-03-15").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-01-31", "2026-03-02"]);
});

test("interval: occurrencesInWindow returns nothing before the anchor date", () => {
  const plan = intervalPlan();
  const dates = occurrencesInWindow(plan, "2025-01-01", "2025-12-31");
  assert.deepEqual(dates, []);
});

test("interval: nextOccurrence before the anchor returns the anchor itself", () => {
  const plan = intervalPlan();
  assert.equal(nextOccurrence(plan, "2025-06-01"), "2026-01-01");
});

test("interval: nextOccurrence exactly on an occurrence date returns the following one (strict)", () => {
  const plan = intervalPlan();
  assert.equal(nextOccurrence(plan, "2026-01-01"), "2026-01-31");
});

test("interval: nextOccurrence mid-cycle rounds up to the next occurrence", () => {
  const plan = intervalPlan();
  assert.equal(nextOccurrence(plan, "2026-01-15"), "2026-01-31");
});

test("interval: leap day anchor -- 365-day interval lands on Feb 28 the following (non-leap) year", () => {
  const plan = intervalPlan({ anchorDate: "2024-02-29", intervalDays: 365 });
  assert.equal(nextOccurrence(plan, "2024-02-29"), "2025-02-28");
});

test("interval: DST spring-forward boundary does not shift the occurrence date (UTC day arithmetic)", () => {
  // US DST spring-forward in 2026 is 2026-03-08. A 7-day interval anchored
  // just before it must still land exactly 7 calendar days later, not 7
  // days +/- an hour's worth of drift.
  const plan = intervalPlan({ anchorDate: "2026-03-01", intervalDays: 7 });
  const dates = occurrencesInWindow(plan, "2026-03-01", "2026-03-31").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22", "2026-03-29"]);
});

test("interval: DST fall-back boundary does not shift the occurrence date", () => {
  // US DST fall-back in 2026 is 2026-11-01.
  const plan = intervalPlan({ anchorDate: "2026-10-25", intervalDays: 7 });
  const dates = occurrencesInWindow(plan, "2026-10-25", "2026-11-15").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-10-25", "2026-11-01", "2026-11-08", "2026-11-15"]);
});

// --- seasonal cadence ----------------------------------------------------

test("seasonal: month-end anchor clamps to each listed month's actual last day", () => {
  const plan = seasonalPlan(); // anchor day-of-month 31, months [2, 4, 6], 2026 (non-leap)
  const dates = occurrencesInWindow(plan, "2026-01-01", "2026-12-31").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-02-28", "2026-04-30", "2026-06-30"]);
});

test("seasonal: leap year Feb clamp lands on the 29th", () => {
  const plan = seasonalPlan({ anchorDate: "2024-01-31", seasonMonths: [2] });
  const dates = occurrencesInWindow(plan, "2024-01-01", "2024-12-31").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2024-02-29"]);
});

test("seasonal: occurrencesInWindow spans multiple years in order", () => {
  const plan = seasonalPlan({ anchorDate: "2026-01-15", seasonMonths: [1, 7] });
  const dates = occurrencesInWindow(plan, "2026-06-01", "2027-02-01").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-07-15", "2027-01-15"]);
});

test("seasonal: nextOccurrence wraps forward into the next year", () => {
  const plan = seasonalPlan({ anchorDate: "2026-01-15", seasonMonths: [1, 7] });
  assert.equal(nextOccurrence(plan, "2026-08-01"), "2027-01-15");
});

test("seasonal: occurrencesInWindow never returns a date before the anchor", () => {
  const plan = seasonalPlan({ anchorDate: "2026-05-01", seasonMonths: [1, 6] });
  const dates = occurrencesInWindow(plan, "2026-01-01", "2026-12-31").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-06-01"]);
});

// --- lead time -------------------------------------------------------------

test("lead time shifts the generation date, never the scheduled/due date", () => {
  const plan = intervalPlan({ leadTimeDays: 5 });
  const [occurrence] = occurrencesInWindow(plan, "2026-01-01", "2026-01-01");
  assert.equal(occurrence.scheduledFor, "2026-01-01");
  assert.equal(occurrence.generationDate, "2025-12-27");
});

test("zero lead time (default) makes generationDate equal scheduledFor", () => {
  const plan = intervalPlan();
  const [occurrence] = occurrencesInWindow(plan, "2026-01-01", "2026-01-01");
  assert.equal(occurrence.generationDate, occurrence.scheduledFor);
});

// --- H-2 (security review, wave3-slice-3c): hard cap on materialized dates -

test("interval: an unbounded window against a daily cadence is capped at MAX_OCCURRENCES, not materialized in full", () => {
  // Same shape as the review's probe (probes-3c/p6_occurrence_dos.mjs):
  // interval_days=1, anchored years in the past, window open out to
  // 9999-12-31 -- pre-fix this produced 2.9M+ entries.
  const plan = intervalPlan({ anchorDate: "2020-01-01", intervalDays: 1 });
  const dates = occurrencesInWindow(plan, "2026-09-07", "9999-12-31").map((o) => o.scheduledFor);
  assert.equal(dates.length, 1000);
  // Still correct within the cap: starts at the first on/after-`from` date
  // and each entry is exactly one day after the last.
  assert.equal(dates[0], "2026-09-07");
  assert.equal(dates[1], "2026-09-08");
});

test("seasonal: an unbounded window is capped at MAX_OCCURRENCES across years", () => {
  const plan = seasonalPlan({ anchorDate: "1900-01-01", seasonMonths: [1, 4, 7, 10] });
  const dates = occurrencesInWindow(plan, "2026-01-01", "9999-12-31").map((o) => o.scheduledFor);
  assert.equal(dates.length, 1000);
});

test("a window that legitimately yields fewer than MAX_OCCURRENCES is unaffected by the cap", () => {
  const plan = intervalPlan();
  const dates = occurrencesInWindow(plan, "2026-01-01", "2026-04-01").map((o) => o.scheduledFor);
  assert.deepEqual(dates, ["2026-01-01", "2026-01-31", "2026-03-02", "2026-04-01"]);
});

// --- inactive plans ----------------------------------------------------

test("inactive plan: nextOccurrence returns null", () => {
  const plan = intervalPlan({ active: false });
  assert.equal(nextOccurrence(plan, "2026-01-01"), null);
});

test("inactive plan: occurrencesInWindow returns an empty array", () => {
  const plan = seasonalPlan({ active: false });
  assert.deepEqual(occurrencesInWindow(plan, "2026-01-01", "2026-12-31"), []);
});

// --- workOrderFromPlan ------------------------------------------------

test("workOrderFromPlan shapes a pm-sourced work order row with due_at = scheduled_for", () => {
  const plan = intervalPlan({ id: "plan-9", assetId: "asset-1", defaultAssigneeEmployeeId: "emp-1", priority: "high" });
  const occurrence = { scheduledFor: "2026-03-01", generationDate: "2026-02-15" };
  const row = workOrderFromPlan(plan, occurrence, {});
  assert.equal(row.facilityId, "fac-1");
  assert.equal(row.assetId, "asset-1");
  assert.equal(row.sourceType, "pm");
  assert.equal(row.sourcePmPlanId, "plan-9");
  assert.equal(row.title, "Pool pump service");
  assert.equal(row.priority, "high");
  assert.equal(row.status, "open");
  assert.equal(row.assignedToEmployeeId, "emp-1");
  assert.equal(row.dueAt, "2026-03-01T00:00:00.000Z");
});

test("workOrderFromPlan falls back to workOrders.defaultPriority when the plan has no priority", () => {
  const plan = intervalPlan({ priority: undefined });
  const occurrence = { scheduledFor: "2026-03-01", generationDate: "2026-03-01" };
  const row = workOrderFromPlan(plan, occurrence, {});
  assert.equal(row.priority, "medium"); // registry default
});

test("workOrderFromPlan falls back to the plan title when description is unset", () => {
  const plan = intervalPlan({ description: "" });
  const occurrence = { scheduledFor: "2026-03-01", generationDate: "2026-03-01" };
  const row = workOrderFromPlan(plan, occurrence, {});
  assert.equal(row.description, plan.title);
});
