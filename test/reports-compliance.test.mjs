import test from "node:test";
import assert from "node:assert/strict";
import { computeCompliance, dateRange } from "../src/lib/reports-compliance.mjs";

const TEMPLATE = {
  id: "tpl-1",
  code: "opening",
  name: "Opening Checklist",
  department_id: null,
  status: "published",
  created_at: "2026-01-01T00:00:00.000Z"
};

test("dateRange enumerates every calendar date in [from, to] inclusive", () => {
  assert.deepEqual(dateRange("2026-08-01", "2026-08-03"), ["2026-08-01", "2026-08-02", "2026-08-03"]);
});

test("dateRange returns a single-day range when from equals to", () => {
  assert.deepEqual(dateRange("2026-08-01", "2026-08-01"), ["2026-08-01"]);
});

test("dateRange returns [] for malformed or inverted input", () => {
  assert.deepEqual(dateRange("not-a-date", "2026-08-01"), []);
  assert.deepEqual(dateRange("2026-08-01", "not-a-date"), []);
  assert.deepEqual(dateRange("2026-08-05", "2026-08-01"), []);
});

test("computeCompliance excludes non-published templates entirely", () => {
  const result = computeCompliance({
    templates: [{ ...TEMPLATE, status: "draft" }],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01"
  });
  assert.deepEqual(result.templates, []);
});

test("computeCompliance: a submitted report counts as filed, a draft does not", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [{ template_id: "tpl-1", report_date: "2026-08-01", status: "draft" }],
    from: "2026-08-01",
    to: "2026-08-01",
    now: new Date("2026-08-01T00:00:00.000Z")
  });
  const day = result.templates[0].days[0];
  assert.equal(day.expected, 1);
  assert.equal(day.submitted, 0);
  assert.equal(day.missing, 1);
});

for (const status of ["submitted", "locked", "revised"]) {
  test(`computeCompliance: a '${status}' report counts as filed`, () => {
    const result = computeCompliance({
      templates: [TEMPLATE],
      submissions: [{ template_id: "tpl-1", report_date: "2026-08-01", status }],
      from: "2026-08-01",
      to: "2026-08-01",
      now: new Date("2026-08-01T00:00:00.000Z")
    });
    const day = result.templates[0].days[0];
    assert.equal(day.submitted, 1);
    assert.equal(day.missing, 0);
  });
}

// --- Due-hour boundary (UTC wall-clock; see module header) -----------------

test("computeCompliance: missing-but-not-yet-due before the due hour on today", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01",
    config: { "reports.dailyReportDueHour": 18 },
    now: new Date("2026-08-01T17:59:59.999Z")
  });
  const day = result.templates[0].days[0];
  assert.equal(day.missing, 1);
  assert.equal(day.overdue, 0);
});

test("computeCompliance: overdue exactly at the due-hour boundary (inclusive)", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01",
    config: { "reports.dailyReportDueHour": 18 },
    now: new Date("2026-08-01T18:00:00.000Z")
  });
  const day = result.templates[0].days[0];
  assert.equal(day.missing, 1);
  assert.equal(day.overdue, 1);
});

test("computeCompliance: one millisecond before the due hour is not yet overdue", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01",
    config: { "reports.dailyReportDueHour": 18 },
    now: new Date("2026-08-01T17:59:59.999Z")
  });
  assert.equal(result.templates[0].days[0].overdue, 0);
});

test("computeCompliance: a past date with no submission is always overdue regardless of due hour", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-07-30",
    to: "2026-07-30",
    config: { "reports.dailyReportDueHour": 23 },
    now: new Date("2026-08-01T00:00:00.000Z")
  });
  assert.equal(result.templates[0].days[0].overdue, 1);
});

test("computeCompliance: a future date is missing but never overdue", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-08-10",
    to: "2026-08-10",
    config: { "reports.dailyReportDueHour": 0 },
    now: new Date("2026-08-01T00:00:00.000Z")
  });
  const day = result.templates[0].days[0];
  assert.equal(day.missing, 1);
  assert.equal(day.overdue, 0);
});

test("computeCompliance: a filed report is never overdue even past the due hour", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [{ template_id: "tpl-1", report_date: "2026-08-01", status: "submitted" }],
    from: "2026-08-01",
    to: "2026-08-01",
    config: { "reports.dailyReportDueHour": 0 },
    now: new Date("2026-08-01T23:00:00.000Z")
  });
  const day = result.templates[0].days[0];
  assert.equal(day.missing, 0);
  assert.equal(day.overdue, 0);
});

test("computeCompliance: dueHour falls back to the settings-registry default (18) when unset", () => {
  const beforeDefault = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01",
    now: new Date("2026-08-01T17:00:00.000Z")
  });
  const afterDefault = computeCompliance({
    templates: [TEMPLATE],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01",
    now: new Date("2026-08-01T18:00:00.000Z")
  });
  assert.equal(beforeDefault.dueHour, 18);
  assert.equal(beforeDefault.templates[0].days[0].overdue, 0);
  assert.equal(afterDefault.templates[0].days[0].overdue, 1);
});

// --- Template published mid-range -------------------------------------------

test("computeCompliance: dates before a template's created_at are not expected", () => {
  const template = { ...TEMPLATE, created_at: "2026-08-03T12:00:00.000Z" };
  const result = computeCompliance({
    templates: [template],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-05",
    config: { "reports.dailyReportDueHour": 0 },
    now: new Date("2026-08-10T00:00:00.000Z")
  });
  const byDate = Object.fromEntries(result.templates[0].days.map((day) => [day.date, day]));
  assert.equal(byDate["2026-08-01"].expected, 0);
  assert.equal(byDate["2026-08-01"].missing, 0);
  assert.equal(byDate["2026-08-01"].overdue, 0);
  assert.equal(byDate["2026-08-02"].expected, 0);
  // created_at's own calendar date is the first eligible day.
  assert.equal(byDate["2026-08-03"].expected, 1);
  assert.equal(byDate["2026-08-03"].missing, 1);
  assert.equal(byDate["2026-08-03"].overdue, 1);
  assert.equal(byDate["2026-08-04"].expected, 1);
  assert.equal(byDate["2026-08-05"].expected, 1);
});

test("computeCompliance: a template with no created_at is expected for every date in range", () => {
  const template = { ...TEMPLATE, created_at: null };
  const result = computeCompliance({
    templates: [template],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-02",
    now: new Date("2026-08-10T00:00:00.000Z")
  });
  assert.ok(result.templates[0].days.every((day) => day.expected === 1));
});

// --- Totals + shape ----------------------------------------------------------

test("computeCompliance sums per-day counters into template-level totals", () => {
  const result = computeCompliance({
    templates: [TEMPLATE],
    submissions: [{ template_id: "tpl-1", report_date: "2026-08-02", status: "submitted" }],
    from: "2026-08-01",
    to: "2026-08-03",
    config: { "reports.dailyReportDueHour": 0 },
    now: new Date("2026-08-10T00:00:00.000Z")
  });
  const summary = result.templates[0];
  assert.equal(summary.expected, 3);
  assert.equal(summary.submitted, 1);
  assert.equal(summary.missing, 2);
  assert.equal(summary.overdue, 2);
});

test("computeCompliance carries templateId/code/name/departmentId through", () => {
  const template = { ...TEMPLATE, department_id: "dept-1" };
  const result = computeCompliance({
    templates: [template],
    submissions: [],
    from: "2026-08-01",
    to: "2026-08-01"
  });
  const summary = result.templates[0];
  assert.equal(summary.templateId, "tpl-1");
  assert.equal(summary.code, "opening");
  assert.equal(summary.name, "Opening Checklist");
  assert.equal(summary.departmentId, "dept-1");
});

test("computeCompliance handles multiple templates independently", () => {
  const templateB = { ...TEMPLATE, id: "tpl-2", code: "closing", name: "Closing Checklist" };
  const result = computeCompliance({
    templates: [TEMPLATE, templateB],
    submissions: [{ template_id: "tpl-1", report_date: "2026-08-01", status: "submitted" }],
    from: "2026-08-01",
    to: "2026-08-01",
    now: new Date("2026-08-01T00:00:00.000Z")
  });
  assert.equal(result.templates.length, 2);
  const byId = Object.fromEntries(result.templates.map((t) => [t.templateId, t]));
  assert.equal(byId["tpl-1"].submitted, 1);
  assert.equal(byId["tpl-2"].submitted, 0);
});
