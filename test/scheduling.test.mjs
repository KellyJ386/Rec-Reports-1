import test from "node:test";
import assert from "node:assert/strict";
import { findDoubleBookings, findMissingCertifications, summarizeScheduleReadiness } from "../src/lib/scheduling.mjs";

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
