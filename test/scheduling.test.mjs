import test from "node:test";
import assert from "node:assert/strict";
import {
  findDoubleBookings,
  findMissingCertifications,
  summarizeScheduleReadiness,
  canTransitionPeriod,
  validateTemplateInput
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
