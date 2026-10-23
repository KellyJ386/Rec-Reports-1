import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TAB_DEFS,
  approvalDecisionPath,
  approvalTabsFor,
  availabilityRowsFromApi,
  buildAvailabilityPayload,
  buildSwapPayload,
  buildTimeOffPayload,
  canCancelRequest,
  claimActionState,
  describeApprovalItem,
  describeIncomingSwap,
  describeIssue,
  describeShift,
  deriveWorkforceBadges,
  describeShiftSummary,
  emptyAvailabilityRows,
  groupAssignmentsByDay,
  requestStatusBadge,
  shiftWeek,
  summarizeDecisionResult,
  summarizeSwapAnswer,
  swapAnswerPath,
  validateAvailabilityForm,
  validateDenial,
  validateSwapForm,
  validateTimeOffForm
} from "../src/public/js/schedule-self-service.mjs";

// --- weeks + shift lines -------------------------------------------------------

test("shiftWeek returns the Monday of the containing week moved by whole weeks", () => {
  assert.equal(shiftWeek("2026-08-05"), "2026-08-03");
  assert.equal(shiftWeek("2026-08-09"), "2026-08-03");
  assert.equal(shiftWeek("2026-08-05", 1), "2026-08-10");
  assert.equal(shiftWeek("2026-08-05", -2), "2026-07-20");
  assert.equal(shiftWeek("2026-01-01", 0), "2025-12-29");
});

test("describeShift renders weekday, date, role and the shift times in the injected zone", () => {
  const shift = { shift_date: "2026-08-05", role_code: "guard", starts_at: "2026-08-05T13:00:00Z", ends_at: "2026-08-05T21:30:00Z" };
  assert.equal(describeShift(shift, { timeZone: "UTC" }), "Wed 2026-08-05 · guard · 13:00–21:30");
  assert.equal(describeShift(shift, { timeZone: "America/New_York" }), "Wed 2026-08-05 · guard · 09:00–17:30");
  assert.equal(describeShift(null), "");
  assert.equal(
    describeShiftSummary({ shiftDate: "2026-08-05", roleCode: "guard", startsAt: shift.starts_at, endsAt: shift.ends_at }, { timeZone: "UTC" }),
    "Wed 2026-08-05 · guard · 13:00–21:30"
  );
  assert.equal(describeShiftSummary(null), "");
});

test("groupAssignmentsByDay buckets into 7 days and sorts each day by start time", () => {
  const entry = (id, date, start) => ({ assignment: { id }, shift: { shift_date: date, starts_at: start } });
  const days = groupAssignmentsByDay(
    [entry("late", "2026-08-04", "2026-08-04T15:00:00Z"), entry("early", "2026-08-04", "2026-08-04T08:00:00Z"), entry("out", "2026-08-20", "x")],
    "2026-08-03"
  );
  assert.equal(days.length, 7);
  assert.equal(days[0].date, "2026-08-03");
  assert.equal(days[1].weekday, "Tuesday");
  assert.deepEqual(days[1].entries.map((e) => e.assignment.id), ["early", "late"]);
  assert.equal(days.flatMap((day) => day.entries).length, 2);
});

// --- badges + actions --------------------------------------------------------------

test("requestStatusBadge maps every status to a variant and tolerates unknown ones", () => {
  assert.deepEqual(requestStatusBadge("pending"), { text: "Pending", variant: "warning" });
  assert.equal(requestStatusBadge("approved").variant, "success");
  assert.equal(requestStatusBadge("denied").variant, "danger");
  assert.equal(requestStatusBadge("mystery").text, "mystery");
});

test("claimActionState disables the button once claimed or when the window has closed", () => {
  assert.deepEqual(claimActionState({ claimable: true, claimed: false }), { label: "Claim shift", disabled: false, reason: null });
  assert.equal(claimActionState({ claimable: true, claimed: true }).disabled, true);
  assert.equal(claimActionState({ claimable: false, claimed: false }).reason, "window_closed_or_held");
  assert.equal(claimActionState(null).disabled, true);
});

test("canCancelRequest: pending always; approved only for time off", () => {
  assert.equal(canCancelRequest("claim", "pending"), true);
  assert.equal(canCancelRequest("claim", "approved"), false);
  assert.equal(canCancelRequest("swap", "denied"), false);
  assert.equal(canCancelRequest("time_off", "approved"), true);
  assert.equal(canCancelRequest("time_off", "denied"), false);
});

// --- time-off form -----------------------------------------------------------------------

test("validateTimeOffForm flags missing/backwards dates and unknown types", () => {
  assert.equal(validateTimeOffForm({ startDate: "2026-09-01", endDate: "2026-09-03", requestType: "vacation" }).valid, true);
  assert.equal(validateTimeOffForm({ startDate: "2026-09-01", endDate: "2026-09-01" }).valid, true);
  assert.ok(validateTimeOffForm({}).errors.startDate);
  assert.ok(validateTimeOffForm({ startDate: "2026-09-01" }).errors.endDate);
  assert.match(validateTimeOffForm({ startDate: "2026-09-05", endDate: "2026-09-01" }).errors.endDate, /before the start/);
  assert.ok(validateTimeOffForm({ startDate: "2026-02-30", endDate: "2026-03-01" }).errors.startDate);
  assert.ok(validateTimeOffForm({ startDate: "2026-09-01", endDate: "2026-09-02", requestType: "holiday" }).errors.requestType);
  assert.ok(validateTimeOffForm({ startDate: "2026-09-01", endDate: "2026-09-02", reason: "x".repeat(1001) }).errors.reason);
});

test("buildTimeOffPayload turns inclusive dates into a [start, start-of-day-after-end) window", () => {
  const toInstant = (dateStr, offset) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + offset)).toISOString();
  };
  assert.deepEqual(
    buildTimeOffPayload({ startDate: "2026-09-01", endDate: "2026-09-03", requestType: "vacation", reason: "  trip " }, { toInstant }),
    { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-04T00:00:00.000Z", requestType: "vacation", reason: "trip" }
  );
  const oneDay = buildTimeOffPayload({ startDate: "2026-12-31", endDate: "2026-12-31" }, { toInstant });
  assert.equal(oneDay.endsAt, "2027-01-01T00:00:00.000Z");
  assert.equal(oneDay.requestType, "other");
  assert.equal("reason" in oneDay, false);
});

// --- swap form ------------------------------------------------------------------------------

test("validateSwapForm: a direct swap needs the colleague's shift, a drop only needs the offered one", () => {
  assert.equal(validateSwapForm({ mode: "drop", offeredAssignmentId: "a1" }).valid, true);
  assert.equal(validateSwapForm({ mode: "direct", offeredAssignmentId: "a1", requestedAssignmentId: "a2" }).valid, true);
  assert.ok(validateSwapForm({ mode: "direct", offeredAssignmentId: "a1" }).errors.requestedAssignmentId);
  assert.ok(validateSwapForm({ mode: "drop" }).errors.offeredAssignmentId);
  assert.ok(validateSwapForm({ offeredAssignmentId: "a1" }).errors.mode);
});

test("buildSwapPayload maps the form modes onto the API's swapType and omits empty fields", () => {
  assert.deepEqual(buildSwapPayload({ mode: "direct", offeredAssignmentId: "a1", requestedAssignmentId: "a2", reason: " family " }), {
    swapType: "direct",
    offeredAssignmentId: "a1",
    requestedAssignmentId: "a2",
    reason: "family"
  });
  assert.deepEqual(buildSwapPayload({ mode: "drop", offeredAssignmentId: "a1", targetEmployeeId: "e2" }), {
    swapType: "drop_pickup",
    offeredAssignmentId: "a1",
    targetEmployeeId: "e2"
  });
  assert.deepEqual(buildSwapPayload({ mode: "drop", offeredAssignmentId: "a1", targetEmployeeId: "" }), {
    swapType: "drop_pickup",
    offeredAssignmentId: "a1"
  });
});

// --- availability editor ------------------------------------------------------------------------

test("emptyAvailabilityRows is Monday-first with no constraints", () => {
  const rows = emptyAvailabilityRows();
  assert.deepEqual(rows.map((row) => row.weekday), [1, 2, 3, 4, 5, 6, 0]);
  assert.ok(rows.every((row) => row.mode === "any"));
});

test("availabilityRowsFromApi picks the latest rule per weekday and trims seconds", () => {
  const rows = availabilityRowsFromApi([
    { weekday: 1, unavailable: true, effective_from: "2026-01-01" },
    { weekday: 1, unavailable: false, available_start_local: "08:00:00", available_end_local: "16:30:00", effective_from: "2026-06-01" },
    { weekday: 0, unavailable: true, effective_from: "2026-01-01" },
    { weekday: 2, unavailable: false, available_start_local: null, available_end_local: null, effective_from: "2026-01-01" }
  ]);
  const byDay = Object.fromEntries(rows.map((row) => [row.weekday, row]));
  assert.deepEqual(byDay[1], { weekday: 1, mode: "window", start: "08:00", end: "16:30" });
  assert.equal(byDay[0].mode, "unavailable");
  assert.equal(byDay[2].mode, "any");
  assert.equal(byDay[3].mode, "any");
});

test("validateAvailabilityForm requires both times, start before end, only for window rows", () => {
  assert.equal(validateAvailabilityForm(emptyAvailabilityRows()).valid, true);
  const rows = emptyAvailabilityRows();
  rows[0] = { weekday: 1, mode: "window", start: "17:00", end: "09:00" };
  rows[1] = { weekday: 2, mode: "window", start: "", end: "10:00" };
  const result = validateAvailabilityForm(rows);
  assert.equal(result.valid, false);
  assert.match(result.errors[1], /Monday: the start time must be before/);
  assert.match(result.errors[2], /Tuesday: enter both/);
});

test("buildAvailabilityPayload sends every weekday so a cleared rule overwrites the old one", () => {
  const rows = emptyAvailabilityRows();
  rows[0] = { weekday: 1, mode: "window", start: "08:00", end: "16:00" };
  rows[1] = { weekday: 2, mode: "unavailable", start: "", end: "" };
  const payload = buildAvailabilityPayload(rows, "2026-08-03");
  assert.equal(payload.effectiveFrom, "2026-08-03");
  assert.equal(payload.days.length, 7);
  assert.deepEqual(payload.days[0], { weekday: 1, availableStart: "08:00", availableEnd: "16:00" });
  assert.deepEqual(payload.days[1], { weekday: 2, unavailable: true });
  assert.deepEqual(payload.days[2], { weekday: 3 });
  assert.equal("effectiveFrom" in buildAvailabilityPayload(rows), false);
});

// --- approvals --------------------------------------------------------------------------------------

test("approvalTabsFor mirrors the server: manage covers claims+swaps, time off needs its own code", () => {
  const types = (permissions, options) => approvalTabsFor(permissions, options).map((tab) => tab.type);
  assert.deepEqual(types([]), []);
  assert.deepEqual(types(["schedule.read"]), []);
  assert.deepEqual(types(["schedule.manage"]), ["claims", "swaps"]);
  assert.deepEqual(types(["schedule.approve.time_off"]), ["time_off"]);
  assert.deepEqual(types(["schedule.approve.swaps"]), ["swaps"]);
  assert.deepEqual(types(["schedule.manage.open_shifts"]), ["claims"]);
  assert.deepEqual(types(["schedule.manage", "schedule.approve.time_off"]), ["claims", "swaps", "time_off"]);
  assert.deepEqual(types([], { isPlatformAdmin: true }), ["claims", "swaps", "time_off"]);
  assert.equal(APPROVAL_TAB_DEFS.length, 3);
});

test("approvalDecisionPath builds the per-kind decision route and refuses unknown input", () => {
  assert.equal(approvalDecisionPath("fac-1", { type: "claims", id: "r1" }, "approve"), "/facilities/fac-1/open-shift-claims/r1/approve");
  assert.equal(approvalDecisionPath("fac-1", { type: "swaps", id: "r1" }, "deny"), "/facilities/fac-1/shift-swaps/r1/deny");
  assert.equal(approvalDecisionPath("fac-1", { type: "time_off", id: "r1" }, "approve"), "/facilities/fac-1/time-off-requests/r1/approve");
  assert.equal(approvalDecisionPath("fac-1", { type: "other", id: "r1" }, "approve"), null);
  assert.equal(approvalDecisionPath("fac-1", { type: "claims", id: "r1" }, "delete"), null);
  assert.equal(approvalDecisionPath("a/b", { type: "claims", id: "x y" }, "approve"), "/facilities/a%2Fb/open-shift-claims/x%20y/approve");
});

test("validateDenial requires a non-blank reason and trims it", () => {
  assert.deepEqual(validateDenial("  short staffed "), { valid: true, error: null, reason: "short staffed" });
  assert.equal(validateDenial("").valid, false);
  assert.equal(validateDenial("   ").valid, false);
  assert.equal(validateDenial(undefined).valid, false);
  assert.equal(validateDenial("x".repeat(1001)).valid, false);
});

test("describeApprovalItem writes a title and detail lines per kind", () => {
  const options = { timeZone: "UTC" };
  const shift = { shiftDate: "2026-08-05", roleCode: "guard", startsAt: "2026-08-05T09:00:00Z", endsAt: "2026-08-05T17:00:00Z" };
  const claim = describeApprovalItem({ type: "claims", employeeName: "Alex Rivera", shift }, options);
  assert.equal(claim.title, "Alex Rivera wants to claim an open shift");
  assert.deepEqual(claim.details, ["Wed 2026-08-05 · guard · 09:00–17:00"]);

  const direct = describeApprovalItem(
    { type: "swaps", swapType: "direct", employeeName: "Alex", targetEmployeeName: "Sam", shift, requestedShift: { ...shift, shiftDate: "2026-08-06" }, reason: "family" },
    options
  );
  assert.equal(direct.title, "Alex wants to swap with Sam");
  assert.equal(direct.details.length, 3);
  assert.match(direct.details[1], /^Takes: Thu 2026-08-06/);
  assert.equal(direct.details[2], "Note: family");

  assert.equal(describeApprovalItem({ type: "swaps", swapType: "drop_pickup", employeeName: "Alex", shift }, options).title, "Alex wants to drop a shift");
  assert.equal(
    describeApprovalItem({ type: "swaps", swapType: "drop_pickup", employeeName: "Alex", targetEmployeeName: "Sam", shift }, options).title,
    "Alex wants Sam to take a shift"
  );
  const off = describeApprovalItem({ type: "time_off", employeeName: "Sam", requestType: "sick", startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-03T00:00:00Z" });
  assert.equal(off.title, "Sam requests sick time off");
  assert.deepEqual(off.details, ["2026-09-01 to 2026-09-03"]);
  assert.equal(describeApprovalItem({ type: "claims", shift: null }, options).title, "An employee wants to claim an open shift");
});

test("summarizeDecisionResult reports replays, decisions, auto-denied siblings and warnings", () => {
  assert.equal(summarizeDecisionResult({ replay: true }, "approve"), "That request was already decided; nothing changed.");
  assert.equal(summarizeDecisionResult({ replay: false }, "deny"), "Request denied.");
  assert.equal(
    summarizeDecisionResult({ replay: false, denied_claim_ids: ["a", "b"], warnings: [{}] }, "approve"),
    "Request approved. 2 competing claims denied. 1 warning noted."
  );
  assert.equal(summarizeDecisionResult({ replay: false, denied_claim_ids: ["a"] }, "approve"), "Request approved. 1 competing claim denied.");
  assert.equal(summarizeDecisionResult(null, "approve"), "");
});

test("describeIssue words the known blocker codes and degrades gracefully", () => {
  assert.match(describeIssue({ code: "missing_certification" }), /certification/);
  assert.match(describeIssue({ code: "overlap" }), /overlapping/);
  assert.equal(describeIssue({ code: "something_new" }), "something new");
  assert.equal(describeIssue(null), "unknown issue");
});

test("deriveWorkforceBadges flags time off (blocking beats warning) and availability per shift", () => {
  const readiness = {
    timeOffConflicts: [
      { shiftId: "s1", severity: "warning" },
      { shiftId: "s1", severity: "blocking" },
      { shiftId: "s2", severity: "warning" }
    ],
    availabilityConflicts: [{ shiftId: "s2" }]
  };
  assert.deepEqual(deriveWorkforceBadges("s1", readiness), { timeOff: "blocking", unavailable: false });
  assert.deepEqual(deriveWorkforceBadges("s2", readiness), { timeOff: "warning", unavailable: true });
  assert.deepEqual(deriveWorkforceBadges("s3", readiness), { timeOff: null, unavailable: false });
  assert.deepEqual(deriveWorkforceBadges("s1"), { timeOff: null, unavailable: false });
});

// --- the colleague's answer to a swap / named pickup -----------------------------

test("swapAnswerPath builds the accept/decline path and refuses anything else", () => {
  assert.equal(swapAnswerPath("fac 1", { id: "sw/1" }, "accept"), "/facilities/fac%201/shift-swaps/sw%2F1/accept");
  assert.equal(swapAnswerPath("fac-1", { id: "sw-1" }, "decline"), "/facilities/fac-1/shift-swaps/sw-1/decline");
  assert.equal(swapAnswerPath("fac-1", { id: "sw-1" }, "approve"), null);
  assert.equal(swapAnswerPath("fac-1", {}, "accept"), null);
  assert.equal(swapAnswerPath("fac-1", null, "accept"), null);
});

test("describeIncomingSwap names the requester and distinguishes a swap from a pickup", () => {
  assert.equal(
    describeIncomingSwap({ swap_type: "direct", requester_name: "Sam Lee", reason: "family event" }),
    "Sam Lee asks to swap shifts with you. Note: family event"
  );
  assert.equal(describeIncomingSwap({ swap_type: "drop_pickup", requester_name: "Sam Lee" }), "Sam Lee asks you to take over a shift.");
  assert.equal(describeIncomingSwap({ swap_type: "drop_pickup" }), "A colleague asks you to take over a shift.");
});

test("summarizeSwapAnswer says what happens next and flags a replay", () => {
  assert.match(summarizeSwapAnswer({ replay: false }, "accept"), /manager still has to approve/);
  assert.match(summarizeSwapAnswer({ replay: false }, "decline"), /closed/);
  assert.match(summarizeSwapAnswer({ replay: true }, "accept"), /already answered/);
  assert.equal(summarizeSwapAnswer(null, "accept"), "");
});

test("describeApprovalItem tells a manager when a swap still waits for the named colleague", () => {
  const item = {
    type: "swaps",
    swapType: "direct",
    employeeName: "Alex Rivera",
    targetEmployeeName: "Sam Lee",
    awaitingTarget: true,
    shift: null,
    requestedShift: null,
    reason: null
  };
  assert.ok(describeApprovalItem(item).details.some((line) => /Waiting for Sam Lee to accept/.test(line)));
  assert.ok(!describeApprovalItem({ ...item, awaitingTarget: false }).details.some((line) => /Waiting for/.test(line)));
});
