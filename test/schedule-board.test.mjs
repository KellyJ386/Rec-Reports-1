import test from "node:test";
import assert from "node:assert/strict";
import {
  weekBoundsFor,
  bucketShiftsByDay,
  deriveShiftBadges,
  validateShiftCreate,
  buildShiftCreatePayload,
  indexAssignmentsByShift
} from "../src/public/js/schedule-board.mjs";

// 2024-01-01 is a real-world Monday, used as a pinned anchor for every case
// below instead of deriving the expectation from the same code under test.
test("weekBoundsFor returns the same Mon-Sun week regardless of which day inside it is passed", () => {
  assert.deepEqual(weekBoundsFor("2024-01-01"), { weekStartDate: "2024-01-01", weekEndDate: "2024-01-07" });
  assert.deepEqual(weekBoundsFor("2024-01-03"), { weekStartDate: "2024-01-01", weekEndDate: "2024-01-07" });
  assert.deepEqual(weekBoundsFor("2024-01-07"), { weekStartDate: "2024-01-01", weekEndDate: "2024-01-07" });
});

test("weekBoundsFor rolls forward correctly into the next week", () => {
  assert.deepEqual(weekBoundsFor("2024-01-08"), { weekStartDate: "2024-01-08", weekEndDate: "2024-01-14" });
});

test("bucketShiftsByDay produces 7 day buckets with correct weekday labels", () => {
  const days = bucketShiftsByDay([], "2024-01-01");
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06", "2024-01-07"]
  );
  assert.deepEqual(
    days.map((d) => d.weekday),
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  );
});

test("bucketShiftsByDay groups shifts onto their date and sorts by start time", () => {
  const shifts = [
    { id: "b", shift_date: "2024-01-02", starts_at: "2024-01-02T14:00:00Z" },
    { id: "a", shift_date: "2024-01-02", starts_at: "2024-01-02T06:00:00Z" },
    { id: "c", shift_date: "2024-01-05", starts_at: "2024-01-05T09:00:00Z" }
  ];
  const days = bucketShiftsByDay(shifts, "2024-01-01");
  const tuesday = days.find((d) => d.date === "2024-01-02");
  assert.deepEqual(
    tuesday.shifts.map((s) => s.id),
    ["a", "b"]
  );
  const friday = days.find((d) => d.date === "2024-01-05");
  assert.equal(friday.shifts.length, 1);
  const monday = days.find((d) => d.date === "2024-01-01");
  assert.equal(monday.shifts.length, 0);
});

test("bucketShiftsByDay drops a shift whose date falls outside the week", () => {
  const shifts = [{ id: "x", shift_date: "2024-02-01", starts_at: "2024-02-01T10:00:00Z" }];
  const days = bucketShiftsByDay(shifts, "2024-01-01");
  const total = days.reduce((sum, d) => sum + d.shifts.length, 0);
  assert.equal(total, 0);
});

test("deriveShiftBadges flags a conflict when the shift appears in a doubleBooking", () => {
  const readiness = { doubleBookings: [{ employeeId: "e1", shiftIds: ["shift-1", "shift-2"] }] };
  assert.deepEqual(deriveShiftBadges("shift-1", readiness), {
    conflict: true,
    certBlocking: false,
    certWarning: false
  });
  assert.deepEqual(deriveShiftBadges("shift-9", readiness), {
    conflict: false,
    certBlocking: false,
    certWarning: false
  });
});

test("deriveShiftBadges separates blocking missing certs from warning-mode ones", () => {
  const readiness = {
    missingCertifications: [{ shiftId: "shift-1", certificationCode: "CPR" }],
    warnings: [{ shiftId: "shift-2", certificationCode: "FIRST_AID", severity: "warning" }]
  };
  assert.deepEqual(deriveShiftBadges("shift-1", readiness), {
    conflict: false,
    certBlocking: true,
    certWarning: false
  });
  assert.deepEqual(deriveShiftBadges("shift-2", readiness), {
    conflict: false,
    certBlocking: false,
    certWarning: true
  });
});

test("deriveShiftBadges tolerates a missing/empty readiness payload", () => {
  assert.deepEqual(deriveShiftBadges("shift-1", {}), { conflict: false, certBlocking: false, certWarning: false });
  assert.deepEqual(deriveShiftBadges("shift-1"), { conflict: false, certBlocking: false, certWarning: false });
});

test("validateShiftCreate requires role/date/start/end and start<end", () => {
  const missing = validateShiftCreate({});
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.roleCode);
  assert.ok(missing.errors.shiftDate);
  assert.ok(missing.errors.startsAt);
  assert.ok(missing.errors.endsAt);

  const backwards = validateShiftCreate({
    roleCode: "lifeguard",
    shiftDate: "2024-01-02",
    startsAt: "2024-01-02T18:00:00.000Z",
    endsAt: "2024-01-02T09:00:00.000Z"
  });
  assert.equal(backwards.valid, false);
  assert.ok(backwards.errors.endsAt);

  const good = validateShiftCreate({
    roleCode: "lifeguard",
    shiftDate: "2024-01-02",
    startsAt: "2024-01-02T09:00:00.000Z",
    endsAt: "2024-01-02T18:00:00.000Z"
  });
  assert.equal(good.valid, true);
});

test("buildShiftCreatePayload trims roleCode and passes ISO instants through", () => {
  const payload = buildShiftCreatePayload({
    schedulePeriodId: "period-1",
    roleCode: "  lifeguard  ",
    shiftDate: "2024-01-02",
    startsAt: "2024-01-02T09:00:00.000Z",
    endsAt: "2024-01-02T18:00:00.000Z"
  });
  assert.deepEqual(payload, {
    schedulePeriodId: "period-1",
    roleCode: "lifeguard",
    shiftDate: "2024-01-02",
    startsAt: "2024-01-02T09:00:00.000Z",
    endsAt: "2024-01-02T18:00:00.000Z"
  });
});

test("indexAssignmentsByShift groups assignments by shift_id", () => {
  const assignments = [
    { id: "a1", shift_id: "shift-1", employee_id: "emp-1", status: "approved", created_at: "2024-01-01T00:00:00Z" },
    { id: "a2", shift_id: "shift-2", employee_id: "emp-2", status: "pending", created_at: "2024-01-01T00:00:00Z" },
    { id: "a3", shift_id: "shift-1", employee_id: "emp-3", status: "pending", created_at: "2024-01-02T00:00:00Z" }
  ];
  const byShift = indexAssignmentsByShift(assignments);
  assert.equal(byShift.size, 2);
  assert.deepEqual(
    byShift.get("shift-1").map((a) => a.id),
    ["a1", "a3"]
  );
  assert.deepEqual(
    byShift.get("shift-2").map((a) => a.id),
    ["a2"]
  );
  assert.equal(byShift.get("shift-9"), undefined);
});

test("indexAssignmentsByShift sorts active (pending/approved) assignments before declined/cancelled", () => {
  const assignments = [
    { id: "cancelled-1", shift_id: "shift-1", status: "cancelled", created_at: "2024-01-01T00:00:00Z" },
    { id: "approved-1", shift_id: "shift-1", status: "approved", created_at: "2024-01-02T00:00:00Z" },
    { id: "declined-1", shift_id: "shift-1", status: "declined", created_at: "2024-01-03T00:00:00Z" },
    { id: "pending-1", shift_id: "shift-1", status: "pending", created_at: "2024-01-04T00:00:00Z" }
  ];
  const byShift = indexAssignmentsByShift(assignments);
  assert.deepEqual(
    byShift.get("shift-1").map((a) => a.id),
    ["approved-1", "pending-1", "cancelled-1", "declined-1"]
  );
});

test("indexAssignmentsByShift orders same-activeness assignments by created_at ascending, independent of input order", () => {
  const assignments = [
    { id: "later", shift_id: "shift-1", status: "pending", created_at: "2024-01-05T00:00:00Z" },
    { id: "earlier", shift_id: "shift-1", status: "approved", created_at: "2024-01-01T00:00:00Z" }
  ];
  const byShift = indexAssignmentsByShift(assignments);
  assert.deepEqual(
    byShift.get("shift-1").map((a) => a.id),
    ["earlier", "later"]
  );
});

test("indexAssignmentsByShift tolerates an empty/missing list", () => {
  assert.equal(indexAssignmentsByShift([]).size, 0);
  assert.equal(indexAssignmentsByShift(undefined).size, 0);
});
