// Pure, DOM-free helpers behind the weekly Schedule board (SC-08): week-range
// math, day-column bucketing of a facility's shifts, per-shift conflict/cert
// badge derivation from a readiness payload, and shift-create-form
// validation/payload shaping. No `document`, no fetch, no Date-dependent
// globals beyond the standard Date object -- all inputs are plain data.

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

// The Monday-start week (Mon..Sun) containing `dateStr` ("YYYY-MM-DD"),
// returned as { weekStartDate, weekEndDate } -- the exact shape
// POST /facilities/:facilityId/schedule-periods expects for
// weekStartDate/weekEndDate. Parsed/computed entirely in UTC so the result
// never depends on the host's local timezone (a calendar date's weekday is
// timezone-independent by definition, mirroring src/lib/scheduling.mjs's
// weekdayOfDateOnly convention).
export function weekBoundsFor(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay(); // 0 Sun - 6 Sat
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { weekStartDate: toDateOnly(monday), weekEndDate: toDateOnly(sunday) };
}

// Buckets `shifts` (schedule_shifts rows -- snake_case shift_date/starts_at)
// into 7 day columns spanning [weekStartDate, weekStartDate+6], each sorted
// by start time. A shift whose shift_date falls outside the range is simply
// dropped (the board always requests one period's shifts at a time, but this
// keeps bucketing safe against a broader list).
export function bucketShiftsByDay(shifts, weekStartDate) {
  const [year, month, day] = weekStartDate.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));

  const days = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    const dateOnly = toDateOnly(date);
    days.push({ date: dateOnly, weekday: WEEKDAY_LABELS[date.getUTCDay()], shifts: [] });
  }

  const byDate = new Map(days.map((entry) => [entry.date, entry]));
  for (const shift of shifts ?? []) {
    const bucket = byDate.get(shift.shift_date);
    if (bucket) bucket.shifts.push(shift);
  }
  for (const entry of days) {
    entry.shifts.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  }
  return days;
}

// Derives one shift's badge set from a schedule-readiness payload
// (POST .../schedule/validate | .../publish response shape:
// { doubleBookings: [{ shiftIds }], missingCertifications: [{ shiftId }],
//   warnings: [{ shiftId }] } -- see summarizeScheduleReadiness in
// src/lib/scheduling.mjs). `conflict` covers a double-booking involving this
// shift; `certBlocking` a hard-enforced missing certification; `certWarning`
// a downgraded (warning-mode) missing certification. A shift can carry more
// than one badge at once (e.g. a conflict AND a cert gap).
export function deriveShiftBadges(shiftId, readiness = {}) {
  const doubleBookings = readiness.doubleBookings ?? [];
  const missingCertifications = readiness.missingCertifications ?? [];
  const warnings = readiness.warnings ?? [];

  return {
    conflict: doubleBookings.some((entry) => (entry.shiftIds ?? []).includes(shiftId)),
    certBlocking: missingCertifications.some((entry) => entry.shiftId === shiftId),
    certWarning: warnings.some((entry) => entry.shiftId === shiftId)
  };
}

// Assignment statuses that still occupy the shift's calendar slot -- mirrors
// scheduling-routes.mjs's server-side ACTIVE_ASSIGNMENT_STATUSES
// (0003_scheduling.sql shift_assignments.status: pending/approved/declined/
// cancelled). Duplicated here rather than imported: src/public/js is a
// separate, unbundled static tree that never imports from src/lib
// (server-only) -- see this file's header comment.
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["pending", "approved"]);

// Indexes a flat shift_assignments row list (the shape
// GET /facilities/:facilityId/shift-assignments?period_id=|shift_id=
// returns, P-2) by shift_id, so the board can look up every assignment for a
// given shift in O(1) instead of scanning the full list per card. Within
// each shift's array, active assignments (pending/approved) sort before
// inactive ones (declined/cancelled); ties broken by created_at ascending --
// this does not rely on the input already being sorted.
export function indexAssignmentsByShift(assignments) {
  const byShift = new Map();
  for (const assignment of assignments ?? []) {
    const list = byShift.get(assignment.shift_id) ?? [];
    list.push(assignment);
    byShift.set(assignment.shift_id, list);
  }
  for (const list of byShift.values()) {
    list.sort((a, b) => {
      const aActive = ACTIVE_ASSIGNMENT_STATUSES.has(a.status) ? 0 : 1;
      const bActive = ACTIVE_ASSIGNMENT_STATUSES.has(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(a.created_at) - new Date(b.created_at);
    });
  }
  return byShift;
}

export function validateShiftCreate(fields = {}) {
  const errors = {};
  if (!fields.roleCode || !fields.roleCode.trim()) errors.roleCode = "Role is required.";
  if (!fields.shiftDate) errors.shiftDate = "Date is required.";
  if (!fields.startsAt) errors.startsAt = "Start time is required.";
  if (!fields.endsAt) errors.endsAt = "End time is required.";
  if (fields.startsAt && fields.endsAt && !(fields.startsAt < fields.endsAt)) {
    errors.endsAt = "End time must be after start time.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Shapes the create-shift form's field state into the JSON body
// POST /facilities/:facilityId/shifts expects. `startsAt`/`endsAt` are
// expected to already be ISO instants -- converting a <input
// type="datetime-local"> value to one depends on the browser's local
// timezone (via `new Date(value).toISOString()`), which is environment-
// dependent and deliberately left to the DOM layer in app.js rather than
// done here, so this function stays a pure, deterministic string mapping.
export function buildShiftCreatePayload(fields = {}) {
  return {
    schedulePeriodId: fields.schedulePeriodId,
    roleCode: fields.roleCode.trim(),
    shiftDate: fields.shiftDate,
    startsAt: fields.startsAt,
    endsAt: fields.endsAt
  };
}
