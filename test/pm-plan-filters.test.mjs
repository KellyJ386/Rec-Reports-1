import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSeasonMonths,
  formatSeasonMonths,
  monthAbbrev,
  validatePmPlanCreate,
  buildPmPlanPayload,
  occurrenceStatusLabel,
  formatOccurrenceDate,
  upcomingOccurrences
} from "../src/public/js/pm-plan-filters.mjs";

// --- parseSeasonMonths / formatSeasonMonths ---------------------------

test("parseSeasonMonths parses a comma-separated list", () => {
  assert.deepEqual(parseSeasonMonths("3, 6, 9"), [3, 6, 9]);
});

test("parseSeasonMonths drops blanks and out-of-range values", () => {
  assert.deepEqual(parseSeasonMonths("3,,13,0,7"), [3, 7]);
});

test("parseSeasonMonths on empty input returns an empty array", () => {
  assert.deepEqual(parseSeasonMonths(""), []);
  assert.deepEqual(parseSeasonMonths(), []);
});

test("formatSeasonMonths formats an array back into a comma-separated string", () => {
  assert.equal(formatSeasonMonths([3, 6, 9]), "3, 6, 9");
});

test("formatSeasonMonths on a non-array returns an empty string", () => {
  assert.equal(formatSeasonMonths(null), "");
  assert.equal(formatSeasonMonths(undefined), "");
});

test("monthAbbrev maps 1-12 to Jan-Dec", () => {
  assert.equal(monthAbbrev(1), "Jan");
  assert.equal(monthAbbrev(12), "Dec");
  assert.equal(monthAbbrev(3), "Mar");
});

// --- validatePmPlanCreate ------------------------------------------------

test("validatePmPlanCreate requires a title", () => {
  const result = validatePmPlanCreate({ cadenceType: "interval", intervalDays: "30", anchorDate: "2026-01-01" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.title);
});

test("validatePmPlanCreate requires a cadenceType", () => {
  const result = validatePmPlanCreate({ title: "Filter", anchorDate: "2026-01-01" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.cadenceType);
});

test("validatePmPlanCreate requires intervalDays >= 1 for an interval plan", () => {
  const result = validatePmPlanCreate({
    title: "Filter",
    cadenceType: "interval",
    intervalDays: "0",
    anchorDate: "2026-01-01"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.intervalDays);
});

test("validatePmPlanCreate requires at least one season month for a seasonal plan", () => {
  const result = validatePmPlanCreate({
    title: "Filter",
    cadenceType: "seasonal",
    seasonMonthsText: "",
    anchorDate: "2026-01-01"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.seasonMonthsText);
});

test("validatePmPlanCreate requires an anchorDate", () => {
  const result = validatePmPlanCreate({ title: "Filter", cadenceType: "interval", intervalDays: "30" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.anchorDate);
});

test("validatePmPlanCreate rejects a negative lead time", () => {
  const result = validatePmPlanCreate({
    title: "Filter",
    cadenceType: "interval",
    intervalDays: "30",
    anchorDate: "2026-01-01",
    leadTimeDays: "-1"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.leadTimeDays);
});

test("validatePmPlanCreate accepts a fully valid interval plan", () => {
  const result = validatePmPlanCreate({
    title: "Filter change",
    cadenceType: "interval",
    intervalDays: "30",
    anchorDate: "2026-01-01",
    leadTimeDays: "5",
    priority: "high"
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
});

test("validatePmPlanCreate accepts a fully valid seasonal plan", () => {
  const result = validatePmPlanCreate({
    title: "HVAC filter",
    cadenceType: "seasonal",
    seasonMonthsText: "3, 9",
    anchorDate: "2026-01-15"
  });
  assert.equal(result.valid, true);
});

// --- buildPmPlanPayload --------------------------------------------------

test("buildPmPlanPayload shapes an interval plan's payload", () => {
  const payload = buildPmPlanPayload({
    title: "  Filter change  ",
    description: "Quarterly",
    cadenceType: "interval",
    intervalDays: "30",
    anchorDate: "2026-01-01",
    leadTimeDays: "5",
    priority: "high",
    assetId: "asset-1",
    defaultAssigneeEmployeeId: "emp-1"
  });
  assert.deepEqual(payload, {
    title: "Filter change",
    cadence_type: "interval",
    anchor_date: "2026-01-01",
    description: "Quarterly",
    interval_days: 30,
    lead_time_days: 5,
    priority: "high",
    asset_id: "asset-1",
    default_assignee_employee_id: "emp-1"
  });
});

test("buildPmPlanPayload shapes a seasonal plan's payload", () => {
  const payload = buildPmPlanPayload({
    title: "HVAC filter",
    cadenceType: "seasonal",
    seasonMonthsText: "3, 9",
    anchorDate: "2026-01-15"
  });
  assert.equal(payload.cadence_type, "seasonal");
  assert.deepEqual(payload.season_months, [3, 9]);
  assert.equal(payload.interval_days, undefined);
});

test("buildPmPlanPayload omits unset optional fields entirely", () => {
  const payload = buildPmPlanPayload({
    title: "Filter change",
    cadenceType: "interval",
    intervalDays: "30",
    anchorDate: "2026-01-01"
  });
  assert.ok(!("description" in payload));
  assert.ok(!("priority" in payload));
  assert.ok(!("asset_id" in payload));
  assert.ok(!("default_assignee_employee_id" in payload));
  assert.ok(!("lead_time_days" in payload));
});

// --- occurrence strip helpers ----------------------------------------

test("occurrenceStatusLabel: preview entries are labeled Upcoming", () => {
  assert.equal(occurrenceStatusLabel({ preview: true, scheduledFor: "2026-03-01" }), "Upcoming");
});

test("occurrenceStatusLabel: a stored entry without a linked work order is Scheduled", () => {
  assert.equal(occurrenceStatusLabel({ preview: false, scheduledFor: "2026-03-01", workOrderId: null }), "Scheduled");
});

test("occurrenceStatusLabel: a stored entry with a linked work order is Work order created", () => {
  assert.equal(occurrenceStatusLabel({ preview: false, scheduledFor: "2026-03-01", workOrderId: "wo-1" }), "Work order created");
});

test("occurrenceStatusLabel on a nullish input returns an empty string", () => {
  assert.equal(occurrenceStatusLabel(null), "");
});

test("formatOccurrenceDate formats a plain date string without timezone drift", () => {
  assert.equal(formatOccurrenceDate("2026-01-05"), "Jan 5");
  assert.equal(formatOccurrenceDate("2026-12-31"), "Dec 31");
});

test("formatOccurrenceDate passes through an unparsable value", () => {
  assert.equal(formatOccurrenceDate("bogus"), "bogus");
});

test("upcomingOccurrences filters out past dates and sorts ascending", () => {
  const occurrences = [
    { scheduledFor: "2026-03-10" },
    { scheduledFor: "2026-01-01" }, // in the past relative to today
    { scheduledFor: "2026-03-01" }
  ];
  const result = upcomingOccurrences(occurrences, "2026-02-01");
  assert.deepEqual(result.map((o) => o.scheduledFor), ["2026-03-01", "2026-03-10"]);
});

test("upcomingOccurrences bounds the strip to `limit` items", () => {
  const occurrences = Array.from({ length: 20 }, (_, i) => ({
    scheduledFor: `2026-03-${String(i + 1).padStart(2, "0")}`
  }));
  const result = upcomingOccurrences(occurrences, "2026-01-01", 5);
  assert.equal(result.length, 5);
});
