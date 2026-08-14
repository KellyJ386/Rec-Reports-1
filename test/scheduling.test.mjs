import test from "node:test";
import assert from "node:assert/strict";
import {
  findDoubleBookings,
  findMissingCertifications,
  summarizeScheduleReadiness,
  canTransitionPeriod,
  validateTemplateInput,
  expandTemplates,
  shiftNaturalKey,
  canTransitionAssignment,
  ASSIGNMENT_STATUSES
} from "../src/lib/scheduling.mjs";

const assignments = [
  {
    employeeId: "employee-1",
    shiftId: "morning-lifeguard",
    startsAt: "2026-07-06T09:00:00-04:00",
    endsAt: "2026-07-06T13:00:00-04:00",
    requiredCertificationCodes: ["lifeguard", "cpr"]
  },
  {
    employeeId: "employee-1",
    shiftId: "overlap-cashier",
    startsAt: "2026-07-06T12:00:00-04:00",
    endsAt: "2026-07-06T16:00:00-04:00",
    requiredCertificationCodes: []
  }
];

test("findDoubleBookings returns overlapping assignments for the same employee", () => {
  assert.deepEqual(findDoubleBookings(assignments), [
    { employeeId: "employee-1", shiftIds: ["morning-lifeguard", "overlap-cashier"] }
  ]);
});

test("findMissingCertifications reports missing shift requirements", () => {
  assert.deepEqual(findMissingCertifications(assignments, { "employee-1": ["lifeguard"] }), [
    { employeeId: "employee-1", shiftId: "morning-lifeguard", certificationCode: "cpr" }
  ]);
});

test("summarizeScheduleReadiness blocks publishing while conflicts exist", () => {
  assert.equal(summarizeScheduleReadiness(assignments, { "employee-1": ["lifeguard", "cpr"] }).canPublish, false);
});

const singleShiftMissingCert = [
  {
    employeeId: "employee-2",
    shiftId: "solo-lifeguard",
    startsAt: "2026-07-06T09:00:00-04:00",
    endsAt: "2026-07-06T13:00:00-04:00",
    requiredCertificationCodes: ["lifeguard"]
  }
];

test("certEnforcementMode 'hard-block' (default) blocks publish on a missing cert", () => {
  const summary = summarizeScheduleReadiness(singleShiftMissingCert, { "employee-2": [] });
  assert.equal(summary.canPublish, false);
  assert.equal(summary.missingCertifications.length, 1);
  assert.deepEqual(summary.warnings, []);
});

test("certEnforcementMode 'warning' downgrades a missing cert to a non-blocking warning", () => {
  const summary = summarizeScheduleReadiness(
    singleShiftMissingCert,
    { "employee-2": [] },
    { "scheduling.certEnforcementMode": "warning" }
  );
  assert.equal(summary.canPublish, true);
  assert.equal(summary.missingCertifications.length, 1);
  assert.equal(summary.warnings.length, 1);
  assert.equal(summary.warnings[0].severity, "warning");
});

test("conflictCheckEnabled=false stops double-bookings from blocking publish", () => {
  const withCheck = summarizeScheduleReadiness(assignments, { "employee-1": ["lifeguard", "cpr"] });
  assert.equal(withCheck.canPublish, false);
  const withoutCheck = summarizeScheduleReadiness(
    assignments,
    { "employee-1": ["lifeguard", "cpr"] },
    { "scheduling.conflictCheckEnabled": false }
  );
  assert.equal(withoutCheck.canPublish, true);
  assert.deepEqual(withoutCheck.doubleBookings, []);
});

// --- canTransitionPeriod (SC-01) --------------------------------------------

const LEGAL_TRANSITIONS = [
  ["draft", "review"],
  ["draft", "published"],
  ["review", "published"],
  ["review", "draft"],
  ["published", "archived"]
];

const ILLEGAL_TRANSITIONS = [
  ["draft", "draft"],
  ["draft", "archived"],
  ["review", "review"],
  ["review", "archived"],
  ["published", "draft"],
  ["published", "review"],
  ["published", "published"],
  ["archived", "draft"],
  ["archived", "review"],
  ["archived", "published"],
  ["archived", "archived"]
];

for (const [from, to] of LEGAL_TRANSITIONS) {
  test(`canTransitionPeriod allows ${from} -> ${to}`, () => {
    assert.equal(canTransitionPeriod(from, to), true);
  });
}

for (const [from, to] of ILLEGAL_TRANSITIONS) {
  test(`canTransitionPeriod rejects ${from} -> ${to}`, () => {
    assert.equal(canTransitionPeriod(from, to), false);
  });
}

test("canTransitionPeriod rejects unknown statuses", () => {
  assert.equal(canTransitionPeriod("bogus", "draft"), false);
  assert.equal(canTransitionPeriod("draft", "bogus"), false);
  assert.equal(canTransitionPeriod(undefined, "draft"), false);
  assert.equal(canTransitionPeriod("draft", undefined), false);
});

// --- validateTemplateInput (SC-02) ------------------------------------------

const VALID_TEMPLATE = {
  roleCode: "lifeguard",
  startTimeLocal: "08:00",
  endTimeLocal: "16:00",
  daysOfWeek: [1, 2, 3, 4, 5],
  requiredCertificationIds: ["11111111-1111-1111-1111-111111111111"]
};

test("validateTemplateInput accepts a fully-shaped template", () => {
  const result = validateTemplateInput(VALID_TEMPLATE);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateTemplateInput requires roleCode", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, roleCode: undefined });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("roleCode is required"));
});

test("validateTemplateInput rejects start >= end", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, startTimeLocal: "16:00", endTimeLocal: "08:00" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("startTimeLocal must be before endTimeLocal"));
});

test("validateTemplateInput rejects equal start/end", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, startTimeLocal: "08:00", endTimeLocal: "08:00" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("startTimeLocal must be before endTimeLocal"));
});

test("validateTemplateInput requires a non-empty daysOfWeek array", () => {
  assert.equal(validateTemplateInput({ ...VALID_TEMPLATE, daysOfWeek: [] }).valid, false);
  assert.equal(validateTemplateInput({ ...VALID_TEMPLATE, daysOfWeek: undefined }).valid, false);
});

test("validateTemplateInput rejects daysOfWeek entries outside 0-6", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, daysOfWeek: [0, 7] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("daysOfWeek entries must be integers between 0 and 6"));
});

test("validateTemplateInput rejects non-integer daysOfWeek entries", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, daysOfWeek: [1, 2.5] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("daysOfWeek entries must be integers between 0 and 6"));
});

test("validateTemplateInput accepts days 0 and 6 (Sunday/Saturday) as valid boundaries", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, daysOfWeek: [0, 6] });
  assert.equal(result.valid, true);
});

test("validateTemplateInput rejects a non-array requiredCertificationIds", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, requiredCertificationIds: "not-an-array" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("requiredCertificationIds must be an array"));
});

test("validateTemplateInput rejects requiredCertificationIds entries that aren't non-empty strings", () => {
  const result = validateTemplateInput({ ...VALID_TEMPLATE, requiredCertificationIds: ["ok", "", 5] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("requiredCertificationIds entries must be non-empty strings"));
});

test("validateTemplateInput requiredCertificationIds is optional", () => {
  const { requiredCertificationIds, ...rest } = VALID_TEMPLATE;
  const result = validateTemplateInput(rest);
  assert.equal(result.valid, true);
});

test("validateTemplateInput partial mode only validates fields present in the patch", () => {
  assert.equal(validateTemplateInput({ notes: "irrelevant" }, { partial: true }).valid, true);
  assert.equal(validateTemplateInput({ daysOfWeek: [1, 2] }, { partial: true }).valid, true);
  assert.equal(validateTemplateInput({ daysOfWeek: [9] }, { partial: true }).valid, false);
});

test("validateTemplateInput partial mode still rejects an invalid roleCode when roleCode is present", () => {
  const result = validateTemplateInput({ roleCode: "" }, { partial: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("roleCode is required"));
});

test("validateTemplateInput partial mode requires both start and end when only one is sent", () => {
  const result = validateTemplateInput({ startTimeLocal: "09:00" }, { partial: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("endTimeLocal is required"));
});

// =============================================================================
// expandTemplates (SC-03)
// =============================================================================

// 2026-07-05 is a Sunday (weekday 0); the week runs through 2026-07-11 (Saturday).
const WEEK_START = "2026-07-05";

const MON_WED_TEMPLATE = {
  id: "tmpl-mon-wed",
  active: true,
  daysOfWeek: [1, 3],
  startTimeLocal: "08:00",
  endTimeLocal: "16:00",
  roleCode: "lifeguard",
  departmentId: "dept-1",
  requiredCertificationIds: ["cert-1"]
};

test("expandTemplates emits one shift per matching weekday within the week", () => {
  const rows = expandTemplates([MON_WED_TEMPLATE], WEEK_START, "America/New_York");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.shiftDate),
    ["2026-07-06", "2026-07-08"]
  );
  for (const row of rows) {
    assert.equal(row.templateId, "tmpl-mon-wed");
    assert.equal(row.departmentId, "dept-1");
    assert.equal(row.roleCode, "lifeguard");
    assert.deepEqual(row.requiredCertificationIds, ["cert-1"]);
    assert.equal(row.source, "template");
  }
});

test("expandTemplates emits a shift for every day when daysOfWeek covers the full week", () => {
  const rows = expandTemplates(
    [{ ...MON_WED_TEMPLATE, id: "tmpl-all", daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }],
    WEEK_START,
    "America/New_York"
  );
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map((r) => r.shiftDate),
    ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11"]
  );
});

test("expandTemplates emits one shift per active template per matching weekday (weekday matrix across templates)", () => {
  const secondTemplate = {
    id: "tmpl-fri",
    active: true,
    daysOfWeek: [5],
    startTimeLocal: "12:00",
    endTimeLocal: "20:00",
    roleCode: "cashier",
    departmentId: null,
    requiredCertificationIds: []
  };
  const rows = expandTemplates([MON_WED_TEMPLATE, secondTemplate], WEEK_START, "America/New_York");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.templateId, r.shiftDate]),
    [
      ["tmpl-mon-wed", "2026-07-06"],
      ["tmpl-mon-wed", "2026-07-08"],
      ["tmpl-fri", "2026-07-10"]
    ]
  );
});

test("expandTemplates excludes inactive templates", () => {
  const rows = expandTemplates([{ ...MON_WED_TEMPLATE, active: false }], WEEK_START, "America/New_York");
  assert.deepEqual(rows, []);
});

test("expandTemplates excludes an inactive template while still expanding an active one in the same call", () => {
  const rows = expandTemplates(
    [{ ...MON_WED_TEMPLATE, active: false }, { ...MON_WED_TEMPLATE, id: "tmpl-active", daysOfWeek: [1] }],
    WEEK_START,
    "America/New_York"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].templateId, "tmpl-active");
});

test("expandTemplates accepts raw snake_case shift_templates row shape from PostgREST", () => {
  const snakeCaseRow = {
    id: "tmpl-snake",
    active: true,
    days_of_week: [1],
    start_time_local: "08:00",
    end_time_local: "16:00",
    role_code: "lifeguard",
    department_id: "dept-2",
    required_certification_ids: ["cert-9"]
  };
  const rows = expandTemplates([snakeCaseRow], WEEK_START, "America/New_York");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shiftDate, "2026-07-06");
  assert.equal(rows[0].departmentId, "dept-2");
  assert.equal(rows[0].roleCode, "lifeguard");
  assert.deepEqual(rows[0].requiredCertificationIds, ["cert-9"]);
});

test("expandTemplates returns [] for no templates", () => {
  assert.deepEqual(expandTemplates([], WEEK_START, "America/New_York"), []);
  assert.deepEqual(expandTemplates(undefined, WEEK_START, "America/New_York"), []);
});

test("expandTemplates converts local times to correct UTC instants outside any DST transition", () => {
  // Non-DST week (America/New_York is EST, UTC-5, in January).
  const winterRows = expandTemplates(
    [{ ...MON_WED_TEMPLATE, daysOfWeek: [1] }],
    "2026-01-04", // Sunday
    "America/New_York"
  );
  assert.equal(winterRows[0].startsAt, "2026-01-05T13:00:00.000Z"); // 08:00 EST = 13:00 UTC
  assert.equal(winterRows[0].endsAt, "2026-01-05T21:00:00.000Z"); // 16:00 EST = 21:00 UTC

  // DST week (America/New_York is EDT, UTC-4, in July).
  const summerRows = expandTemplates([{ ...MON_WED_TEMPLATE, daysOfWeek: [1] }], WEEK_START, "America/New_York");
  assert.equal(summerRows[0].startsAt, "2026-07-06T12:00:00.000Z"); // 08:00 EDT = 12:00 UTC
  assert.equal(summerRows[0].endsAt, "2026-07-06T20:00:00.000Z"); // 16:00 EDT = 20:00 UTC
});

// --- DST spring-forward (gap) week --------------------------------------
// America/New_York springs forward on 2026-03-08: local clocks jump from
// 02:00 EST straight to 03:00 EDT, so 02:00-02:59 never occurs that day.
// The week starting 2026-03-08 (a Sunday) is the spring-forward week.

test("expandTemplates: a template whose start time falls in the spring-forward gap resolves DST-safely (pinned instant)", () => {
  const gapTemplate = {
    id: "tmpl-gap",
    active: true,
    daysOfWeek: [0], // Sunday, the transition day itself
    startTimeLocal: "02:30", // nonexistent local time on 2026-03-08
    endTimeLocal: "05:00",
    roleCode: "nurse",
    departmentId: null,
    requiredCertificationIds: []
  };
  const rows = expandTemplates([gapTemplate], "2026-03-08", "America/New_York");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shiftDate, "2026-03-08");
  // Documented policy: the nonexistent local time resolves "as if the old
  // (pre-transition) offset still applied" -- 02:30 + 5h (EST) = 07:30 UTC,
  // which displays as 03:30 EDT (pushed forward across the gap by exactly
  // its one-hour size).
  assert.equal(rows[0].startsAt, "2026-03-08T07:30:00.000Z");
  // endTimeLocal (05:00) is unambiguous, ordinary EDT conversion: 05:00 + 4h.
  assert.equal(rows[0].endsAt, "2026-03-08T09:00:00.000Z");
});

test("expandTemplates: the rest of the spring-forward week (non-transition days) still converts at ordinary EDT offset", () => {
  const rows = expandTemplates(
    [{ ...MON_WED_TEMPLATE, daysOfWeek: [1] }], // Monday 2026-03-09, the day after the transition
    "2026-03-08",
    "America/New_York"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shiftDate, "2026-03-09");
  assert.equal(rows[0].startsAt, "2026-03-09T12:00:00.000Z"); // 08:00 EDT = 12:00 UTC
  assert.equal(rows[0].endsAt, "2026-03-09T20:00:00.000Z"); // 16:00 EDT = 20:00 UTC
});

// --- DST fall-back (fold) week -------------------------------------------
// America/New_York falls back on 2026-11-01: local clocks jump from 02:00
// EDT back to 01:00 EST, so 01:00-01:59 occurs twice that day. The week
// starting 2026-11-01 (a Sunday) is the fall-back week.

test("expandTemplates: a template whose start time falls in the fall-back fold resolves to the first (pre-transition) occurrence (pinned instant)", () => {
  const foldTemplate = {
    id: "tmpl-fold",
    active: true,
    daysOfWeek: [0], // Sunday, the transition day itself
    startTimeLocal: "01:30", // ambiguous local time on 2026-11-01, occurs twice
    endTimeLocal: "04:00",
    roleCode: "nurse",
    departmentId: null,
    requiredCertificationIds: []
  };
  const rows = expandTemplates([foldTemplate], "2026-11-01", "America/New_York");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shiftDate, "2026-11-01");
  // Documented policy: a fold resolves to the FIRST (pre-transition,
  // still-daylight) occurrence -- 01:30 EDT = 05:30 UTC, not the second
  // occurrence an hour later at 01:30 EST = 06:30 UTC.
  assert.equal(rows[0].startsAt, "2026-11-01T05:30:00.000Z");
  // endTimeLocal (04:00) is unambiguous, past the fold, ordinary EST: 04:00 + 5h.
  assert.equal(rows[0].endsAt, "2026-11-01T09:00:00.000Z");
});

test("expandTemplates: the rest of the fall-back week (non-transition days) still converts at ordinary EST offset", () => {
  const rows = expandTemplates(
    [{ ...MON_WED_TEMPLATE, daysOfWeek: [1] }], // Monday 2026-11-02, the day after the transition
    "2026-11-01",
    "America/New_York"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shiftDate, "2026-11-02");
  assert.equal(rows[0].startsAt, "2026-11-02T13:00:00.000Z"); // 08:00 EST = 13:00 UTC
  assert.equal(rows[0].endsAt, "2026-11-02T21:00:00.000Z"); // 16:00 EST = 21:00 UTC
});

// =============================================================================
// shiftNaturalKey (SC-03 idempotency)
// =============================================================================

test("shiftNaturalKey is stable across ISO string formatting differences for the same instant", () => {
  const keyA = shiftNaturalKey("dept-1", "lifeguard", "2026-07-06", "2026-07-06T12:00:00.000Z", "2026-07-06T20:00:00.000Z");
  const keyB = shiftNaturalKey("dept-1", "lifeguard", "2026-07-06", "2026-07-06T12:00:00+00:00", "2026-07-06T20:00:00+00:00");
  assert.equal(keyA, keyB);
});

test("shiftNaturalKey differs when department, role, date, or times differ", () => {
  const base = shiftNaturalKey("dept-1", "lifeguard", "2026-07-06", "2026-07-06T12:00:00Z", "2026-07-06T20:00:00Z");
  assert.notEqual(shiftNaturalKey("dept-2", "lifeguard", "2026-07-06", "2026-07-06T12:00:00Z", "2026-07-06T20:00:00Z"), base);
  assert.notEqual(shiftNaturalKey("dept-1", "cashier", "2026-07-06", "2026-07-06T12:00:00Z", "2026-07-06T20:00:00Z"), base);
  assert.notEqual(shiftNaturalKey("dept-1", "lifeguard", "2026-07-07", "2026-07-06T12:00:00Z", "2026-07-06T20:00:00Z"), base);
  assert.notEqual(shiftNaturalKey("dept-1", "lifeguard", "2026-07-06", "2026-07-06T13:00:00Z", "2026-07-06T20:00:00Z"), base);
});

test("shiftNaturalKey normalizes a null/undefined departmentId consistently", () => {
  const keyA = shiftNaturalKey(null, "lifeguard", "2026-07-06", "2026-07-06T12:00:00Z", "2026-07-06T20:00:00Z");
  const keyB = shiftNaturalKey(undefined, "lifeguard", "2026-07-06", "2026-07-06T12:00:00Z", "2026-07-06T20:00:00Z");
  assert.equal(keyA, keyB);
});

// =============================================================================
// canTransitionAssignment (SC-05)
// =============================================================================

test("ASSIGNMENT_STATUSES matches the 0003_scheduling.sql check constraint", () => {
  assert.deepEqual(ASSIGNMENT_STATUSES, ["pending", "approved", "declined", "cancelled"]);
});

const LEGAL_ASSIGNMENT_TRANSITIONS = [
  ["pending", "approved"],
  ["pending", "declined"],
  ["pending", "cancelled"],
  ["approved", "cancelled"],
  ["declined", "cancelled"]
];

const ILLEGAL_ASSIGNMENT_TRANSITIONS = [
  ["pending", "pending"],
  ["approved", "pending"],
  ["approved", "declined"],
  ["approved", "approved"],
  ["declined", "pending"],
  ["declined", "approved"],
  ["declined", "declined"],
  ["cancelled", "pending"],
  ["cancelled", "approved"],
  ["cancelled", "declined"],
  ["cancelled", "cancelled"]
];

for (const [from, to] of LEGAL_ASSIGNMENT_TRANSITIONS) {
  test(`canTransitionAssignment allows ${from} -> ${to}`, () => {
    assert.equal(canTransitionAssignment(from, to), true);
  });
}

for (const [from, to] of ILLEGAL_ASSIGNMENT_TRANSITIONS) {
  test(`canTransitionAssignment rejects ${from} -> ${to}`, () => {
    assert.equal(canTransitionAssignment(from, to), false);
  });
}

test("canTransitionAssignment rejects unknown statuses", () => {
  assert.equal(canTransitionAssignment("bogus", "pending"), false);
  assert.equal(canTransitionAssignment("pending", "bogus"), false);
  assert.equal(canTransitionAssignment(undefined, "pending"), false);
});
