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
