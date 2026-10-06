import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TYPES,
  buildApprovalItems,
  buildMySchedule,
  canTransitionRequest,
  certificationsHeldOn,
  checkAssignmentEligibility,
  findAvailabilityConflicts,
  findTimeOffConflicts,
  isClaimWindowOpen,
  planSwap,
  resolveClaim,
  summarizeScheduleReadiness,
  validateAvailabilityInput,
  validateDecisionInput,
  validateTimeOffInput,
  weekRangeFor
} from "../src/lib/scheduling.mjs";

const NOW = new Date("2026-08-03T12:00:00Z");

// --- Transition matrix (mirrors the 0062 guard triggers) ---------------------

test("canTransitionRequest: claims move only out of pending", () => {
  for (const to of ["approved", "denied", "withdrawn"]) assert.equal(canTransitionRequest("open_shift_claim", "pending", to), true);
  for (const from of ["approved", "denied", "withdrawn"]) {
    for (const to of ["pending", "approved", "denied", "withdrawn"]) {
      assert.equal(canTransitionRequest("open_shift_claim", from, to), false, `${from} -> ${to}`);
    }
  }
  assert.equal(canTransitionRequest("open_shift_claim", "pending", "pending"), false);
});

test("canTransitionRequest: swaps may also be cancelled or expire, then are terminal", () => {
  for (const to of ["approved", "denied", "cancelled", "expired"]) assert.equal(canTransitionRequest("shift_swap", "pending", to), true);
  for (const from of ["approved", "denied", "cancelled", "expired"]) {
    assert.equal(canTransitionRequest("shift_swap", from, "approved"), false);
    assert.equal(canTransitionRequest("shift_swap", from, "cancelled"), false);
  }
});

test("canTransitionRequest: an approved time-off request can still be cancelled; denied/cancelled cannot move", () => {
  assert.equal(canTransitionRequest("time_off", "pending", "cancelled"), true);
  assert.equal(canTransitionRequest("time_off", "approved", "cancelled"), true);
  assert.equal(canTransitionRequest("time_off", "approved", "denied"), false);
  assert.equal(canTransitionRequest("time_off", "denied", "approved"), false);
  assert.equal(canTransitionRequest("time_off", "cancelled", "pending"), false);
});

test("canTransitionRequest rejects unknown kinds and statuses", () => {
  assert.equal(canTransitionRequest("nope", "pending", "approved"), false);
  assert.equal(canTransitionRequest("shift_swap", "bogus", "approved"), false);
});

// --- Decision input -----------------------------------------------------------

test("validateDecisionInput: approve needs no reason, deny requires one", () => {
  assert.deepEqual(validateDecisionInput({ decision: "approve" }), { valid: true, errors: [], decision: "approve", reason: null });
  assert.equal(validateDecisionInput({ decision: "approve", reason: "  ok  " }).reason, "ok");
  const denyNoReason = validateDecisionInput({ decision: "deny" });
  assert.equal(denyNoReason.valid, false);
  assert.match(denyNoReason.errors.join(" "), /denial requires a reason/);
  assert.equal(validateDecisionInput({ decision: "deny", reason: "   " }).valid, false);
  assert.equal(validateDecisionInput({ decision: "deny", reason: "short staffed" }).valid, true);
});

test("validateDecisionInput: rejects unknown decisions, non-string and oversized reasons", () => {
  assert.equal(validateDecisionInput({ decision: "maybe" }).valid, false);
  assert.equal(validateDecisionInput({}).valid, false);
  assert.equal(validateDecisionInput({ decision: "approve", reason: 5 }).valid, false);
  assert.equal(validateDecisionInput({ decision: "approve", reason: "x".repeat(1001) }).valid, false);
  assert.equal(validateDecisionInput({ decision: "approve", reason: "x".repeat(1000) }).valid, true);
});

// --- Claim window ---------------------------------------------------------------

test("isClaimWindowOpen: inclusive of the boundary, closed after it", () => {
  const openedAt = "2026-08-01T12:00:00Z";
  assert.equal(isClaimWindowOpen({ openedAt, now: new Date("2026-08-03T12:00:00Z"), windowHours: 48 }), true);
  assert.equal(isClaimWindowOpen({ openedAt, now: new Date("2026-08-03T12:00:01Z"), windowHours: 48 }), false);
  assert.equal(isClaimWindowOpen({ openedAt, now: new Date("2026-08-01T13:00:00Z"), windowHours: 1 }), true);
});

test("isClaimWindowOpen: a missing openedAt is open, a nonsensical window is closed", () => {
  assert.equal(isClaimWindowOpen({ openedAt: null, now: NOW, windowHours: 48 }), true);
  assert.equal(isClaimWindowOpen({ openedAt: "2026-08-03T00:00:00Z", now: NOW, windowHours: 0 }), false);
  assert.equal(isClaimWindowOpen({ openedAt: "2026-08-03T00:00:00Z", now: NOW, windowHours: undefined }), false);
});

// --- Certifications held on a date -----------------------------------------------

test("certificationsHeldOn: active + unexpired on the date only", () => {
  const types = [
    { id: "ct-1", code: "BLS" },
    { id: "ct-2", code: "LG" }
  ];
  const rows = [
    { employee_id: "e1", certification_type_id: "ct-1", status: "active", expires_at: "2026-08-10" },
    { employee_id: "e1", certification_type_id: "ct-2", status: "active", expires_at: "2026-08-04" },
    { employee_id: "e1", certification_type_id: "ct-2", status: "revoked", expires_at: null },
    { employee_id: "e2", certification_type_id: "ct-1", status: "active", expires_at: null, deleted_at: "2026-01-01" },
    { employee_id: "e3", certification_type_id: "ct-9", status: "active", expires_at: null }
  ];
  assert.deepEqual(certificationsHeldOn(rows, types, "2026-08-05"), { e1: ["BLS"] });
  assert.deepEqual(certificationsHeldOn(rows, types, "2026-08-04"), { e1: ["BLS", "LG"] });
});

// --- Time-off conflicts ------------------------------------------------------------

const ASSIGNMENT_A = {
  employeeId: "e1",
  shiftId: "s1",
  shiftDate: "2026-08-05",
  startsAt: "2026-08-05T09:00:00Z",
  endsAt: "2026-08-05T17:00:00Z"
};

test("findTimeOffConflicts: approved overlap is a warning by default and blocking in hard-block mode", () => {
  const windows = [{ id: "t1", employeeId: "e1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-06T00:00:00Z", status: "approved" }];
  assert.equal(findTimeOffConflicts([ASSIGNMENT_A], windows)[0].severity, "warning");
  assert.equal(findTimeOffConflicts([ASSIGNMENT_A], windows, { mode: "hard-block" })[0].severity, "blocking");
});

test("findTimeOffConflicts: pending overlap is always only a warning", () => {
  const windows = [{ id: "t1", employee_id: "e1", starts_at: "2026-08-05T10:00:00Z", ends_at: "2026-08-05T11:00:00Z", status: "pending" }];
  const [conflict] = findTimeOffConflicts([ASSIGNMENT_A], windows, { mode: "hard-block" });
  assert.equal(conflict.severity, "warning");
  assert.equal(conflict.status, "pending");
});

test("findTimeOffConflicts: boundaries are exclusive; other employees and dead requests never conflict", () => {
  const touchingEnd = [{ id: "t1", employeeId: "e1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-05T09:00:00Z", status: "approved" }];
  const touchingStart = [{ id: "t2", employeeId: "e1", startsAt: "2026-08-05T17:00:00Z", endsAt: "2026-08-06T00:00:00Z", status: "approved" }];
  const otherEmployee = [{ id: "t3", employeeId: "e2", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-06T00:00:00Z", status: "approved" }];
  const dead = ["denied", "cancelled"].map((status) => ({ id: status, employeeId: "e1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-06T00:00:00Z", status }));
  assert.deepEqual(findTimeOffConflicts([ASSIGNMENT_A], touchingEnd), []);
  assert.deepEqual(findTimeOffConflicts([ASSIGNMENT_A], touchingStart), []);
  assert.deepEqual(findTimeOffConflicts([ASSIGNMENT_A], otherEmployee), []);
  assert.deepEqual(findTimeOffConflicts([ASSIGNMENT_A], dead), []);
});

// --- Availability conflicts -----------------------------------------------------------

// 2026-08-05 is a Wednesday (weekday 3). New York is UTC-4 in August.
function rule(overrides = {}) {
  return {
    employee_id: "e1",
    weekday: 3,
    unavailable: false,
    available_start_local: "08:00:00",
    available_end_local: "18:00:00",
    effective_from: "2026-01-01",
    effective_to: null,
    ...overrides
  };
}

test("findAvailabilityConflicts: a shift inside the local window has no conflict", () => {
  // 09:00Z-17:00Z = 05:00-13:00 New York -> starts before 08:00 -> conflict
  assert.equal(findAvailabilityConflicts([ASSIGNMENT_A], [rule()], "America/New_York").length, 1);
  // in UTC the same shift sits inside 08:00-18:00
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], [rule()], "UTC"), []);
});

test("findAvailabilityConflicts: unavailable and outside_window reasons", () => {
  const unavailable = findAvailabilityConflicts([ASSIGNMENT_A], [rule({ unavailable: true, available_start_local: null, available_end_local: null })], "UTC");
  assert.equal(unavailable[0].reason, "unavailable");
  const outside = findAvailabilityConflicts([ASSIGNMENT_A], [rule({ available_end_local: "15:00" })], "UTC");
  assert.equal(outside[0].reason, "outside_window");
  assert.equal(outside[0].weekday, 3);
});

test("findAvailabilityConflicts: a rule for another weekday, another employee, an expired or deleted rule is ignored", () => {
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], [rule({ weekday: 2, unavailable: true })], "UTC"), []);
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], [rule({ employee_id: "e2", unavailable: true })], "UTC"), []);
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], [rule({ unavailable: true, effective_to: "2026-08-04" })], "UTC"), []);
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], [rule({ unavailable: true, effective_from: "2026-08-06" })], "UTC"), []);
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], [rule({ unavailable: true, deleted_at: "2026-02-01" })], "UTC"), []);
});

test("findAvailabilityConflicts: the latest effective_from rule wins; a rule without times means available all day", () => {
  const rules = [
    rule({ unavailable: true, available_start_local: null, available_end_local: null, effective_from: "2026-01-01" }),
    rule({ available_start_local: null, available_end_local: null, effective_from: "2026-07-01" })
  ];
  assert.deepEqual(findAvailabilityConflicts([ASSIGNMENT_A], rules, "UTC"), []);
});

test("findAvailabilityConflicts: a shift that runs past midnight cannot fit a same-day window", () => {
  const overnight = { ...ASSIGNMENT_A, startsAt: "2026-08-05T20:00:00Z", endsAt: "2026-08-06T04:00:00Z" };
  assert.equal(findAvailabilityConflicts([overnight], [rule({ available_start_local: "08:00", available_end_local: "23:00" })], "UTC").length, 1);
});

// --- checkAssignmentEligibility (wires findMissingCertifications) ------------------------

const SHIFT = {
  id: "s-target",
  shift_date: "2026-08-05",
  starts_at: "2026-08-05T09:00:00Z",
  ends_at: "2026-08-05T17:00:00Z"
};

test("checkAssignmentEligibility: a missing certification blocks by default and only warns in warning mode", () => {
  const base = { employeeId: "e1", shift: SHIFT, requiredCertificationCodes: ["BLS"], certificationsByEmployee: { e1: [] } };
  const hard = checkAssignmentEligibility(base);
  assert.equal(hard.ok, false);
  assert.deepEqual(hard.blocking.map((entry) => entry.code), ["missing_certification"]);
  assert.equal(hard.blocking[0].certificationCode, "BLS");
  const soft = checkAssignmentEligibility({ ...base, config: { "scheduling.certEnforcementMode": "warning" } });
  assert.equal(soft.ok, true);
  assert.equal(soft.warnings[0].code, "missing_certification");
  assert.equal(checkAssignmentEligibility({ ...base, certificationsByEmployee: { e1: ["BLS"] } }).ok, true);
});

test("checkAssignmentEligibility: overlap blocks, adjacent shifts do not, ignored assignments are excluded", () => {
  const overlapping = { assignmentId: "a1", shiftId: "s-other", startsAt: "2026-08-05T15:00:00Z", endsAt: "2026-08-05T20:00:00Z", status: "approved" };
  const adjacent = { assignmentId: "a2", shiftId: "s-adj", startsAt: "2026-08-05T17:00:00Z", endsAt: "2026-08-05T20:00:00Z", status: "approved" };
  assert.deepEqual(
    checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, employeeAssignments: [overlapping] }).blocking.map((entry) => entry.code),
    ["overlap"]
  );
  assert.equal(checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, employeeAssignments: [adjacent] }).ok, true);
  assert.equal(
    checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, employeeAssignments: [overlapping], ignoreAssignmentIds: ["a1"] }).ok,
    true
  );
  assert.equal(
    checkAssignmentEligibility({
      employeeId: "e1",
      shift: SHIFT,
      employeeAssignments: [overlapping],
      config: { "scheduling.conflictCheckEnabled": false }
    }).ok,
    true
  );
  // Cancelled assignments never occupy the calendar.
  assert.equal(checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, employeeAssignments: [{ ...overlapping, status: "cancelled" }] }).ok, true);
});

test("checkAssignmentEligibility: already assigned to the very shift always blocks (even with conflict checks off)", () => {
  const same = { assignmentId: "a1", shiftId: "s-target", startsAt: SHIFT.starts_at, endsAt: SHIFT.ends_at, status: "pending" };
  const result = checkAssignmentEligibility({
    employeeId: "e1",
    shift: SHIFT,
    employeeAssignments: [same],
    config: { "scheduling.conflictCheckEnabled": false }
  });
  assert.deepEqual(result.blocking.map((entry) => entry.code), ["already_assigned"]);
});

test("checkAssignmentEligibility: approved time off warns by default, blocks in hard-block mode; pending only warns; availability only warns", () => {
  const approved = [{ id: "t1", employeeId: "e1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-06T00:00:00Z", status: "approved" }];
  const pending = [{ ...approved[0], status: "pending" }];
  assert.equal(checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, timeOffWindows: approved }).ok, true);
  assert.equal(checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, timeOffWindows: approved }).warnings[0].code, "time_off");
  assert.equal(
    checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, timeOffWindows: approved, config: { "scheduling.timeOffConflictMode": "hard-block" } }).ok,
    false
  );
  assert.equal(
    checkAssignmentEligibility({ employeeId: "e1", shift: SHIFT, timeOffWindows: pending, config: { "scheduling.timeOffConflictMode": "hard-block" } }).warnings[0].code,
    "time_off_pending"
  );
  const unavailable = checkAssignmentEligibility({
    employeeId: "e1",
    shift: SHIFT,
    availabilityRows: [rule({ unavailable: true, available_start_local: null, available_end_local: null })]
  });
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.warnings[0].code, "unavailable");
});

// --- resolveClaim -------------------------------------------------------------------------

const OPEN_SHIFT = { id: "s1", status: "open", starts_at: "2026-08-10T09:00:00Z", deleted_at: null };
const CLAIM_1 = { id: "c1", shift_id: "s1", claimant_employee_id: "e1", claim_status: "pending", created_at: "2026-08-01T10:00:00Z" };
const CLAIM_2 = { id: "c2", shift_id: "s1", claimant_employee_id: "e2", claim_status: "pending", created_at: "2026-08-01T09:00:00Z" };
const CLAIM_3 = { id: "c3", shift_id: "s1", claimant_employee_id: "e3", claim_status: "pending", created_at: "2026-08-01T09:00:00Z" };
const CLAIM_DONE = { id: "c4", shift_id: "s1", claimant_employee_id: "e4", claim_status: "withdrawn", created_at: "2026-07-01T00:00:00Z" };
const CLAIM_OTHER_SHIFT = { id: "c5", shift_id: "s9", claimant_employee_id: "e5", claim_status: "pending", created_at: "2026-07-01T00:00:00Z" };

test("resolveClaim: approving one claim assigns the winner and denies the pending siblings in deterministic order", () => {
  const plan = resolveClaim({
    claim: CLAIM_1,
    siblingClaims: [CLAIM_1, CLAIM_3, CLAIM_2, CLAIM_DONE, CLAIM_OTHER_SHIFT],
    shift: OPEN_SHIFT,
    now: NOW
  });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.assign, { employeeId: "e1", shiftId: "s1", assignmentType: "primary" });
  assert.equal(plan.shiftStatusAfter, "assigned");
  // c2 and c3 share created_at; ids break the tie. The winner, the withdrawn and the other shift's claim are excluded.
  assert.deepEqual(plan.denyClaimIds, ["c2", "c3"]);
});

test("resolveClaim: not allowed when the shift is no longer open, started, missing or the claim already decided", () => {
  assert.deepEqual(resolveClaim({ claim: CLAIM_1, shift: { ...OPEN_SHIFT, status: "assigned" }, now: NOW }).reasons, ["shift_not_open"]);
  assert.deepEqual(resolveClaim({ claim: CLAIM_1, shift: { ...OPEN_SHIFT, starts_at: "2026-08-03T11:00:00Z" }, now: NOW }).reasons, ["shift_started"]);
  assert.deepEqual(resolveClaim({ claim: CLAIM_1, shift: null, now: NOW }).reasons, ["shift_missing"]);
  assert.deepEqual(resolveClaim({ claim: { ...CLAIM_1, claim_status: "approved" }, shift: OPEN_SHIFT, now: NOW }).reasons, ["claim_not_pending"]);
  const denied = resolveClaim({ claim: CLAIM_1, siblingClaims: [CLAIM_2], shift: { ...OPEN_SHIFT, status: "cancelled" }, now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.assign, null);
  assert.deepEqual(denied.denyClaimIds, []);
});

test("resolveClaim: an ineligible claimant blocks approval and carries the blockers", () => {
  const eligibility = checkAssignmentEligibility({
    employeeId: "e1",
    shift: SHIFT,
    requiredCertificationCodes: ["BLS"],
    certificationsByEmployee: {}
  });
  const plan = resolveClaim({ claim: CLAIM_1, shift: OPEN_SHIFT, now: NOW, eligibility });
  assert.equal(plan.allowed, false);
  assert.deepEqual(plan.reasons, ["claimant_ineligible"]);
  assert.equal(plan.blocking[0].code, "missing_certification");
});

// --- planSwap -----------------------------------------------------------------------------

const FUTURE = "2026-08-20T09:00:00Z";
const SWAP_DIRECT = { id: "w1", status: "pending", swap_type: "direct", requester_employee_id: "e1", target_employee_id: "e2" };
const OFFERED = { id: "a1", employee_id: "e1", status: "approved", assignment_type: "primary", shift_id: "s1" };
const REQUESTED = { id: "a2", employee_id: "e2", status: "pending", assignment_type: "cover", shift_id: "s2" };
const SHIFT_1 = { id: "s1", status: "assigned", starts_at: FUTURE };
const SHIFT_2 = { id: "s2", status: "assigned", starts_at: "2026-08-21T09:00:00Z" };
const ELIGIBLE = () => ({ ok: true, blocking: [], warnings: [] });

test("planSwap: a direct swap cancels both legs and assigns each employee to the other's shift", () => {
  const seen = [];
  const plan = planSwap({
    swap: SWAP_DIRECT,
    offeredAssignment: OFFERED,
    offeredShift: SHIFT_1,
    requestedAssignment: REQUESTED,
    requestedShift: SHIFT_2,
    now: NOW,
    checkEligibility: (employeeId, shift, ignore) => {
      seen.push({ employeeId, shiftId: shift.id, ignore });
      return ELIGIBLE();
    }
  });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.cancelAssignmentIds, ["a1", "a2"]);
  assert.deepEqual(plan.assign, [
    { employeeId: "e2", shiftId: "s1", assignmentType: "primary" },
    { employeeId: "e1", shiftId: "s2", assignmentType: "cover" }
  ]);
  assert.equal(plan.reopenShiftId, null);
  // Each incoming employee is checked against the shift they take, ignoring BOTH legs.
  assert.deepEqual(seen, [
    { employeeId: "e2", shiftId: "s1", ignore: ["a1", "a2"] },
    { employeeId: "e1", shiftId: "s2", ignore: ["a1", "a2"] }
  ]);
});

test("planSwap: a stale leg (reassigned, cancelled, started) is stale, never eligible-checked", () => {
  const never = () => assert.fail("eligibility must not run for a stale swap");
  const base = { swap: SWAP_DIRECT, offeredAssignment: OFFERED, offeredShift: SHIFT_1, requestedAssignment: REQUESTED, requestedShift: SHIFT_2, now: NOW, checkEligibility: never };
  const reassigned = planSwap({ ...base, offeredAssignment: { ...OFFERED, employee_id: "e9" } });
  assert.equal(reassigned.stale, true);
  assert.deepEqual(reassigned.reasons, ["offered_assignment_changed"]);
  assert.equal(planSwap({ ...base, requestedAssignment: { ...REQUESTED, status: "cancelled" } }).stale, true);
  assert.equal(planSwap({ ...base, offeredShift: { ...SHIFT_1, status: "cancelled" } }).stale, true);
  assert.equal(planSwap({ ...base, requestedShift: { ...SHIFT_2, starts_at: "2026-08-03T11:00:00Z" } }).stale, true);
  assert.equal(planSwap({ ...base, requestedAssignment: null }).stale, true);
  const decided = planSwap({ ...base, swap: { ...SWAP_DIRECT, status: "approved" } });
  assert.equal(decided.allowed, false);
  assert.deepEqual(decided.reasons, ["swap_not_pending"]);
});

test("planSwap: a cert-ineligible target blocks the swap and surfaces the blockers", () => {
  const plan = planSwap({
    swap: SWAP_DIRECT,
    offeredAssignment: OFFERED,
    offeredShift: SHIFT_1,
    requestedAssignment: REQUESTED,
    requestedShift: SHIFT_2,
    now: NOW,
    checkEligibility: (employeeId) =>
      employeeId === "e2"
        ? { ok: false, blocking: [{ code: "missing_certification", employeeId: "e2" }], warnings: [] }
        : { ok: true, blocking: [], warnings: [{ code: "unavailable", employeeId }] }
  });
  assert.equal(plan.allowed, false);
  assert.equal(plan.stale, false);
  assert.deepEqual(plan.reasons, ["participant_ineligible"]);
  assert.equal(plan.blocking.length, 1);
  assert.equal(plan.warnings.length, 1);
});

test("planSwap: drop_pickup to a named colleague moves the assignment; to nobody it reopens the shift", () => {
  const drop = { id: "w2", status: "pending", swap_type: "drop_pickup", requester_employee_id: "e1", target_employee_id: "e2" };
  const toColleague = planSwap({ swap: drop, offeredAssignment: OFFERED, offeredShift: SHIFT_1, now: NOW, checkEligibility: ELIGIBLE });
  assert.equal(toColleague.allowed, true);
  assert.deepEqual(toColleague.cancelAssignmentIds, ["a1"]);
  assert.deepEqual(toColleague.assign, [{ employeeId: "e2", shiftId: "s1", assignmentType: "primary" }]);
  assert.equal(toColleague.reopenShiftId, null);

  const toNobody = planSwap({
    swap: { ...drop, target_employee_id: null },
    offeredAssignment: OFFERED,
    offeredShift: SHIFT_1,
    now: NOW,
    checkEligibility: () => assert.fail("no incoming employee to check")
  });
  assert.equal(toNobody.allowed, true);
  assert.deepEqual(toNobody.assign, []);
  assert.equal(toNobody.reopenShiftId, "s1");
});

// --- Time-off + availability input ----------------------------------------------------------

test("validateTimeOffInput: accepts a future window and normalises it", () => {
  const result = validateTimeOffInput(
    { startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-03T00:00:00Z", requestType: "vacation", reason: "  trip " },
    { now: NOW }
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-09-03T00:00:00.000Z",
    requestType: "vacation",
    reason: "trip"
  });
  assert.equal(validateTimeOffInput({ startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-03T00:00:00Z" }, { now: NOW }).value.requestType, "other");
});

test("validateTimeOffInput: rejects bad shapes, backwards/oversized/past windows and unknown types", () => {
  const errorsFor = (input) => validateTimeOffInput(input, { now: NOW }).errors.join(" | ");
  assert.match(errorsFor({}), /startsAt must be an ISO date-time/);
  assert.match(errorsFor({ startsAt: "nope", endsAt: "2026-09-03T00:00:00Z" }), /startsAt/);
  assert.match(errorsFor({ startsAt: "2026-09-03T00:00:00Z", endsAt: "2026-09-01T00:00:00Z" }), /before endsAt/);
  assert.match(errorsFor({ startsAt: "2026-09-01T00:00:00Z", endsAt: "2027-12-01T00:00:00Z" }), /at most 366 days/);
  assert.match(errorsFor({ startsAt: "2026-07-01T00:00:00Z", endsAt: "2026-07-02T00:00:00Z" }), /already ended/);
  assert.match(errorsFor({ startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-02T00:00:00Z", requestType: "holiday" }), /requestType/);
  assert.match(errorsFor({ startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-02T00:00:00Z", reason: 5 }), /reason must be a string/);
});

test("validateAvailabilityInput: shapes weekly rows (unavailable day, window, all-day) with a default effective date", () => {
  const result = validateAvailabilityInput(
    {
      days: [
        { weekday: 1, availableStart: "08:00", availableEnd: "16:30" },
        { weekday: 2, unavailable: true },
        { weekday: 3 }
      ]
    },
    { today: "2026-08-03" }
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.rows, [
    { weekday: 1, unavailable: false, available_start_local: "08:00", available_end_local: "16:30", effective_from: "2026-08-03", effective_to: null },
    { weekday: 2, unavailable: true, available_start_local: null, available_end_local: null, effective_from: "2026-08-03", effective_to: null },
    { weekday: 3, unavailable: false, available_start_local: null, available_end_local: null, effective_from: "2026-08-03", effective_to: null }
  ]);
});

test("validateAvailabilityInput: rejects bad weekdays, duplicates, bad/backwards times, times on an unavailable day and bad dates", () => {
  const errorsFor = (input) => validateAvailabilityInput(input, { today: "2026-08-03" }).errors.join(" | ");
  assert.match(errorsFor({}), /days must be a non-empty array/);
  assert.match(errorsFor({ days: [] }), /non-empty/);
  assert.match(errorsFor({ days: Array.from({ length: 8 }, (_, weekday) => ({ weekday: weekday % 7 })) }), /at most 7/);
  assert.match(errorsFor({ days: [{ weekday: 7 }] }), /weekday must be an integer between 0 and 6/);
  assert.match(errorsFor({ days: [{ weekday: "1" }] }), /weekday/);
  assert.match(errorsFor({ days: [{ weekday: 1 }, { weekday: 1 }] }), /appears more than once/);
  assert.match(errorsFor({ days: [{ weekday: 1, availableStart: "25:00", availableEnd: "26:00" }] }), /both be HH:MM/);
  assert.match(errorsFor({ days: [{ weekday: 1, availableStart: "09:00" }] }), /both be HH:MM/);
  assert.match(errorsFor({ days: [{ weekday: 1, availableStart: "17:00", availableEnd: "09:00" }] }), /before availableEnd/);
  assert.match(errorsFor({ days: [{ weekday: 1, unavailable: true, availableStart: "09:00", availableEnd: "17:00" }] }), /carries no times/);
  assert.match(errorsFor({ effectiveFrom: "2026-02-30", days: [{ weekday: 1 }] }), /effectiveFrom/);
  assert.match(errorsFor({ effectiveFrom: "2026-08-03", effectiveTo: "2026-08-01", days: [{ weekday: 1 }] }), /not be before/);
  assert.deepEqual(validateAvailabilityInput({ days: [{ weekday: 9 }] }).rows, []);
});

// --- Week math --------------------------------------------------------------------------------

test("weekRangeFor returns the Monday-start week for any day, including Sunday and month edges", () => {
  assert.deepEqual(weekRangeFor("2026-08-05"), { weekStartDate: "2026-08-03", weekEndDate: "2026-08-09" });
  assert.deepEqual(weekRangeFor("2026-08-09"), { weekStartDate: "2026-08-03", weekEndDate: "2026-08-09" });
  assert.deepEqual(weekRangeFor("2026-08-03"), { weekStartDate: "2026-08-03", weekEndDate: "2026-08-09" });
  assert.deepEqual(weekRangeFor("2026-03-01"), { weekStartDate: "2026-02-23", weekEndDate: "2026-03-01" });
});

// --- buildMySchedule: self-scoping is the key assertion -------------------------------------------

const PERIODS = [
  { id: "p-pub", status: "published" },
  { id: "p-draft", status: "draft" }
];
const WEEK_SHIFTS = [
  { id: "s-mine", schedule_period_id: "p-pub", shift_date: "2026-08-04", starts_at: "2026-08-04T09:00:00Z", status: "assigned" },
  { id: "s-theirs", schedule_period_id: "p-pub", shift_date: "2026-08-04", starts_at: "2026-08-04T10:00:00Z", status: "assigned" },
  { id: "s-draft", schedule_period_id: "p-draft", shift_date: "2026-08-05", starts_at: "2026-08-05T09:00:00Z", status: "assigned" },
  { id: "s-open", schedule_period_id: "p-pub", shift_date: "2026-08-06", starts_at: "2026-08-06T09:00:00Z", status: "open", opened_at: "2026-08-03T00:00:00Z" },
  { id: "s-open-claimed", schedule_period_id: "p-pub", shift_date: "2026-08-07", starts_at: "2026-08-07T09:00:00Z", status: "open", opened_at: "2026-08-03T00:00:00Z" },
  { id: "s-open-stale", schedule_period_id: "p-pub", shift_date: "2026-08-08", starts_at: "2026-08-08T09:00:00Z", status: "open", opened_at: "2026-07-01T00:00:00Z" },
  { id: "s-next-week", schedule_period_id: "p-pub", shift_date: "2026-08-12", starts_at: "2026-08-12T09:00:00Z", status: "assigned" },
  { id: "s-deleted", schedule_period_id: "p-pub", shift_date: "2026-08-04", starts_at: "2026-08-04T11:00:00Z", status: "assigned", deleted_at: "2026-08-01" }
];
const ASSIGNMENTS = [
  { id: "as-mine", shift_id: "s-mine", employee_id: "e1", status: "approved" },
  { id: "as-theirs", shift_id: "s-theirs", employee_id: "e2", status: "approved" },
  { id: "as-draft", shift_id: "s-draft", employee_id: "e1", status: "approved" },
  { id: "as-next", shift_id: "s-next-week", employee_id: "e1", status: "approved" },
  { id: "as-cancelled", shift_id: "s-mine", employee_id: "e1", status: "cancelled" },
  { id: "as-deleted", shift_id: "s-deleted", employee_id: "e1", status: "approved" }
];

test("buildMySchedule only ever returns the employee's own live assignments in published periods inside the week", () => {
  const view = buildMySchedule({
    employeeId: "e1",
    weekStartDate: "2026-08-03",
    periods: PERIODS,
    shifts: WEEK_SHIFTS,
    assignments: ASSIGNMENTS,
    now: NOW
  });
  assert.deepEqual(view.assignments.map((entry) => entry.assignment.id), ["as-mine"]);
  assert.equal(view.weekEndDate, "2026-08-09");
});

test("buildMySchedule: open shifts carry claimable/claimed flags honouring the claim window and the caller's pending claims", () => {
  const view = buildMySchedule({
    employeeId: "e1",
    weekStartDate: "2026-08-03",
    periods: PERIODS,
    shifts: WEEK_SHIFTS,
    assignments: ASSIGNMENTS,
    claims: [
      { id: "c1", shift_id: "s-open-claimed", claimant_employee_id: "e1", claim_status: "pending" },
      { id: "c2", shift_id: "s-open", claimant_employee_id: "e2", claim_status: "pending" }
    ],
    now: NOW,
    claimWindowHours: 48
  });
  const byId = Object.fromEntries(view.openShifts.map((entry) => [entry.shift.id, entry]));
  assert.equal(byId["s-open"].claimable, true);
  assert.equal(byId["s-open"].claimed, false);
  assert.equal(byId["s-open-claimed"].claimed, true);
  assert.equal(byId["s-open-claimed"].claimable, false);
  assert.equal(byId["s-open-stale"].claimable, false);
  assert.equal(view.claims.length, 1);
});

test("buildMySchedule: other employees' requests never leak into the caller's view", () => {
  const view = buildMySchedule({
    employeeId: "e1",
    weekStartDate: "2026-08-03",
    periods: PERIODS,
    shifts: WEEK_SHIFTS,
    swaps: [
      { id: "w-mine", requester_employee_id: "e1" },
      { id: "w-other", requester_employee_id: "e2" }
    ],
    timeOff: [
      { id: "t-mine", employee_id: "e1" },
      { id: "t-other", employee_id: "e2" },
      { id: "t-deleted", employee_id: "e1", deleted_at: "2026-01-01" }
    ],
    claims: [{ id: "c-other", shift_id: "s-open", claimant_employee_id: "e2", claim_status: "pending" }],
    now: NOW
  });
  assert.deepEqual(view.swaps.map((swap) => swap.id), ["w-mine"]);
  assert.deepEqual(view.timeOff.map((request) => request.id), ["t-mine"]);
  assert.deepEqual(view.claims, []);
});

test("buildMySchedule with no employee row returns an empty view", () => {
  const view = buildMySchedule({ employeeId: null, weekStartDate: "2026-08-03" });
  assert.deepEqual(view.assignments, []);
  assert.deepEqual(view.openShifts, []);
});

// --- buildApprovalItems ---------------------------------------------------------------------------------

test("buildApprovalItems normalises the three kinds into one queue, oldest first, with names and shift summaries", () => {
  const items = buildApprovalItems({
    claims: [{ id: "c1", shift_id: "s1", claimant_employee_id: "e1", claim_status: "pending", created_at: "2026-08-02T00:00:00Z" }],
    swaps: [
      {
        id: "w1",
        offered_assignment_id: "a1",
        requested_assignment_id: "a2",
        requester_employee_id: "e1",
        target_employee_id: "e2",
        swap_type: "direct",
        status: "pending",
        reason: "family",
        created_at: "2026-08-01T00:00:00Z"
      }
    ],
    timeOff: [
      {
        id: "t1",
        employee_id: "e2",
        starts_at: "2026-09-01T00:00:00Z",
        ends_at: "2026-09-02T00:00:00Z",
        request_type: "vacation",
        status: "denied",
        decision_notes: "short staffed",
        created_at: "2026-08-03T00:00:00Z"
      }
    ],
    employees: [
      { id: "e1", first_name: "Alex", last_name: "Rivera" },
      { id: "e2", first_name: "Sam", last_name: "Lee" }
    ],
    shifts: [
      { id: "s1", role_code: "guard", shift_date: "2026-08-10", starts_at: "x", ends_at: "y" },
      { id: "s2", role_code: "cashier", shift_date: "2026-08-11", starts_at: "x", ends_at: "y" }
    ],
    assignments: [
      { id: "a1", shift_id: "s1" },
      { id: "a2", shift_id: "s2" }
    ]
  });
  assert.deepEqual(items.map((item) => [item.type, item.id]), [
    ["swaps", "w1"],
    ["claims", "c1"],
    ["time_off", "t1"]
  ]);
  assert.equal(items[0].employeeName, "Alex Rivera");
  assert.equal(items[0].targetEmployeeName, "Sam Lee");
  assert.equal(items[0].shift.roleCode, "guard");
  assert.equal(items[0].requestedShift.roleCode, "cashier");
  assert.equal(items[1].shift.id, "s1");
  assert.equal(items[2].decisionReason, "short staffed");
  assert.deepEqual(APPROVAL_TYPES, ["claims", "swaps", "time_off"]);
});

// --- summarizeScheduleReadiness extension (SC-13/SC-14) --------------------------------------------------

test("summarizeScheduleReadiness: availability conflicts are advisory warnings and never block publishing", () => {
  const summary = summarizeScheduleReadiness(
    [{ ...ASSIGNMENT_A, requiredCertificationCodes: [] }],
    {},
    {},
    { availabilityRows: [rule({ unavailable: true, available_start_local: null, available_end_local: null })], timeZone: "UTC" }
  );
  assert.equal(summary.availabilityConflicts.length, 1);
  assert.equal(summary.canPublish, true);
});

test("summarizeScheduleReadiness: approved time off blocks publishing only in hard-block mode; pending never does", () => {
  const assignments = [{ ...ASSIGNMENT_A, requiredCertificationCodes: [] }];
  const approved = [{ id: "t1", employeeId: "e1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-06T00:00:00Z", status: "approved" }];
  const pending = approved.map((window) => ({ ...window, status: "pending" }));
  const byDefault = summarizeScheduleReadiness(assignments, {}, {}, { timeOffWindows: approved });
  assert.equal(byDefault.timeOffConflicts.length, 1);
  assert.equal(byDefault.canPublish, true);
  const hard = summarizeScheduleReadiness(assignments, {}, { "scheduling.timeOffConflictMode": "hard-block" }, { timeOffWindows: approved });
  assert.equal(hard.canPublish, false);
  assert.equal(hard.timeOffConflicts[0].severity, "blocking");
  const hardPending = summarizeScheduleReadiness(assignments, {}, { "scheduling.timeOffConflictMode": "hard-block" }, { timeOffWindows: pending });
  assert.equal(hardPending.canPublish, true);
});

test("summarizeScheduleReadiness without the new options keeps its prior shape and adds empty arrays", () => {
  const summary = summarizeScheduleReadiness([{ ...ASSIGNMENT_A, requiredCertificationCodes: [] }], {});
  assert.deepEqual(summary.timeOffConflicts, []);
  assert.deepEqual(summary.availabilityConflicts, []);
  assert.equal(summary.canPublish, true);
});

// --- buildMySchedule: requests that name the caller ----------------------------------------------

test("buildMySchedule returns only PENDING, unanswered requests that name the caller as incomingSwaps", () => {
  const base = {
    id: "sw",
    requester_employee_id: "emp-2",
    target_employee_id: "emp-1",
    status: "pending",
    target_accepted_at: null,
    target_declined_at: null,
    deleted_at: null
  };
  const view = buildMySchedule({
    employeeId: "emp-1",
    weekStartDate: "2026-08-03",
    incomingSwaps: [
      { ...base, id: "ok" },
      { ...base, id: "answered", target_accepted_at: "2026-08-01T00:00:00Z" },
      { ...base, id: "declined", target_declined_at: "2026-08-01T00:00:00Z" },
      { ...base, id: "closed", status: "cancelled" },
      { ...base, id: "deleted", deleted_at: "2026-08-01T00:00:00Z" },
      { ...base, id: "someone-else", target_employee_id: "emp-3" },
      { ...base, id: "own", requester_employee_id: "emp-1" }
    ]
  });
  assert.deepEqual(view.incomingSwaps.map((swap) => swap.id), ["ok"]);
  assert.deepEqual(buildMySchedule({ employeeId: "emp-1", weekStartDate: "2026-08-03" }).incomingSwaps, []);
});

test("buildApprovalItems flags a swap that still waits for its named colleague", () => {
  const swap = {
    id: "s1",
    status: "pending",
    swap_type: "direct",
    requester_employee_id: "e1",
    target_employee_id: "e2",
    offered_assignment_id: "a1",
    requested_assignment_id: "a2",
    created_at: "2026-08-01T00:00:00Z"
  };
  const items = buildApprovalItems({
    swaps: [swap, { ...swap, id: "s2", target_accepted_at: "2026-08-02T00:00:00Z" }, { ...swap, id: "s3", target_employee_id: null, swap_type: "drop_pickup", requested_assignment_id: null }]
  });
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.equal(byId.s1.awaitingTarget, true);
  assert.equal(byId.s2.awaitingTarget, false);
  assert.equal(byId.s2.targetAcceptedAt, "2026-08-02T00:00:00Z");
  assert.equal(byId.s3.awaitingTarget, false);
});
