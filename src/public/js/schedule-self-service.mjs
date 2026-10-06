// Pure, DOM-free helpers behind the scheduling self-service views (Wave 3
// Slice 3D, SC-14/SC-15/SC-16): the "My schedule" panel (own assignments,
// open shifts, claim/swap/time-off actions, weekly availability) and the
// manager approvals panel. No `document`, no fetch -- every input is plain
// data, every function deterministic (time zones and "now" are injected), so
// node:test can exercise all of it. DOM construction stays in app.js behind
// the el() helper.
//
// The approval permission mapping below mirrors the server (0062's approver
// policies and scheduling-self-service-routes.mjs's KINDS table): the SERVER
// is the authority -- this only decides which tabs/actions to RENDER.

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const TIME_OFF_TYPES = ["vacation", "sick", "unpaid", "other"];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

function isCalendarDate(value) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The Monday-start week containing `dateStr`, moved by `weeks` whole weeks.
export function shiftWeek(dateStr, weeks = 0) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const monday = addDays(dateStr, weekday === 0 ? -6 : 1 - weekday);
  return addDays(monday, weeks * 7);
}

// "Mon 2035-03-05 · guard · 09:00–17:00" in the given IANA zone (the browser's
// by default). `timeZone` is injectable so the output is deterministic.
export function describeShift(shift, { timeZone, locale = "en-US" } = {}) {
  if (!shift) return "";
  const time = (value) =>
    new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const weekday = WEEKDAY_NAMES[new Date(`${shift.shift_date}T00:00:00.000Z`).getUTCDay()]?.slice(0, 3) ?? "";
  return `${weekday} ${shift.shift_date} · ${shift.role_code} · ${time(shift.starts_at)}–${time(shift.ends_at)}`;
}

// Same one-line summary for the approvals queue, whose shift summaries use
// the API's camelCase shape ({ roleCode, shiftDate, startsAt, endsAt }).
export function describeShiftSummary(summary, options) {
  if (!summary) return "";
  return describeShift(
    { shift_date: summary.shiftDate, role_code: summary.roleCode, starts_at: summary.startsAt, ends_at: summary.endsAt },
    options
  );
}

// Buckets the caller's assignments ([{ assignment, shift }], the shape
// GET /me/schedule returns) into the 7 days of the week, soonest first.
export function groupAssignmentsByDay(entries, weekStartDate) {
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(weekStartDate, offset);
    return { date, weekday: WEEKDAY_NAMES[new Date(`${date}T00:00:00.000Z`).getUTCDay()], entries: [] };
  });
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const entry of entries ?? []) {
    byDate.get(entry.shift?.shift_date)?.entries.push(entry);
  }
  for (const day of days) day.entries.sort((a, b) => new Date(a.shift.starts_at) - new Date(b.shift.starts_at));
  return days;
}

// --- Board badges (SC-13/SC-14) -------------------------------------------------

// Time-off / availability badges for one shift card, from the validate
// payload's timeOffConflicts ([{ shiftId, severity }]) and
// availabilityConflicts ([{ shiftId }]). Separate from schedule-board.mjs's
// deriveShiftBadges so that function's pinned shape is untouched.
export function deriveWorkforceBadges(shiftId, readiness = {}) {
  const timeOff = (readiness.timeOffConflicts ?? []).filter((conflict) => conflict.shiftId === shiftId);
  return {
    timeOff: timeOff.length === 0 ? null : timeOff.some((conflict) => conflict.severity === "blocking") ? "blocking" : "warning",
    unavailable: (readiness.availabilityConflicts ?? []).some((conflict) => conflict.shiftId === shiftId)
  };
}

// --- Badges ------------------------------------------------------------------

const STATUS_BADGES = {
  pending: { text: "Pending", variant: "warning" },
  approved: { text: "Approved", variant: "success" },
  denied: { text: "Denied", variant: "danger" },
  withdrawn: { text: "Withdrawn", variant: "info" },
  cancelled: { text: "Cancelled", variant: "info" },
  expired: { text: "Expired", variant: "info" }
};

export function requestStatusBadge(status) {
  return STATUS_BADGES[status] ?? { text: String(status ?? "Unknown"), variant: "info" };
}

// What the "claim" button on an open shift should do/say.
export function claimActionState(openShift) {
  if (!openShift) return { label: "Claim shift", disabled: true, reason: "unavailable" };
  if (openShift.claimed) return { label: "Claim pending", disabled: true, reason: "already_claimed" };
  if (!openShift.claimable) return { label: "Claim closed", disabled: true, reason: "window_closed_or_held" };
  return { label: "Claim shift", disabled: false, reason: null };
}

// Cancel/withdraw is offered only while the server would still accept it.
export function canCancelRequest(kind, status) {
  if (kind === "time_off") return status === "pending" || status === "approved";
  return status === "pending";
}

// --- Forms -------------------------------------------------------------------

function defaultLocalInstant(dateStr, dayOffset) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day + dayOffset).toISOString();
}

// Time-off form: whole days. `startDate`/`endDate` (inclusive, YYYY-MM-DD) are
// turned into instants by `toInstant(dateStr, dayOffset)` -- local midnight in
// the browser by default, injected in tests. endsAt is the START of the day
// after endDate, so a one-day request is a 24 hour window.
export function validateTimeOffForm(fields = {}) {
  const errors = {};
  if (!isCalendarDate(fields.startDate)) errors.startDate = "Pick a start date.";
  if (!isCalendarDate(fields.endDate)) errors.endDate = "Pick an end date.";
  if (!errors.startDate && !errors.endDate && fields.endDate < fields.startDate) {
    errors.endDate = "The end date cannot be before the start date.";
  }
  if (!TIME_OFF_TYPES.includes(fields.requestType ?? "other")) errors.requestType = "Choose a request type.";
  if (typeof fields.reason === "string" && fields.reason.length > 1000) errors.reason = "Keep the note under 1000 characters.";
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildTimeOffPayload(fields, { toInstant = defaultLocalInstant } = {}) {
  const reason = typeof fields.reason === "string" ? fields.reason.trim() : "";
  return {
    startsAt: toInstant(fields.startDate, 0),
    endsAt: toInstant(fields.endDate, 1),
    requestType: fields.requestType ?? "other",
    ...(reason ? { reason } : {})
  };
}

// Swap form. mode 'drop' offers the assignment up for pickup (optionally to a
// named colleague); 'direct' trades it for a colleague's assignment.
export function validateSwapForm(fields = {}) {
  const errors = {};
  if (!fields.offeredAssignmentId) errors.offeredAssignmentId = "Choose the shift you want to give up.";
  if (fields.mode !== "drop" && fields.mode !== "direct") errors.mode = "Choose how you want to swap.";
  if (fields.mode === "direct" && !fields.requestedAssignmentId) {
    errors.requestedAssignmentId = "Choose the colleague's shift you want in return.";
  }
  if (typeof fields.reason === "string" && fields.reason.length > 1000) errors.reason = "Keep the note under 1000 characters.";
  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildSwapPayload(fields) {
  const reason = typeof fields.reason === "string" ? fields.reason.trim() : "";
  const payload =
    fields.mode === "direct"
      ? { swapType: "direct", offeredAssignmentId: fields.offeredAssignmentId, requestedAssignmentId: fields.requestedAssignmentId }
      : {
          swapType: "drop_pickup",
          offeredAssignmentId: fields.offeredAssignmentId,
          ...(fields.targetEmployeeId ? { targetEmployeeId: fields.targetEmployeeId } : {})
        };
  if (reason) payload.reason = reason;
  return payload;
}

// --- Availability editor -----------------------------------------------------

// One row per weekday, Monday first. mode: 'any' (no constraint),
// 'unavailable', or 'window' (start/end HH:MM).
export const AVAILABILITY_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function emptyAvailabilityRows() {
  return AVAILABILITY_WEEKDAY_ORDER.map((weekday) => ({ weekday, mode: "any", start: "", end: "" }));
}

// Folds the API's rows (GET /me/availability) into editor rows: for each
// weekday the rule with the latest effective_from.
export function availabilityRowsFromApi(rows) {
  const latest = new Map();
  for (const row of rows ?? []) {
    const current = latest.get(row.weekday);
    if (!current || String(row.effective_from) > String(current.effective_from)) latest.set(row.weekday, row);
  }
  return emptyAvailabilityRows().map((blank) => {
    const rule = latest.get(blank.weekday);
    if (!rule) return blank;
    if (rule.unavailable) return { ...blank, mode: "unavailable" };
    if (rule.available_start_local && rule.available_end_local) {
      return { ...blank, mode: "window", start: String(rule.available_start_local).slice(0, 5), end: String(rule.available_end_local).slice(0, 5) };
    }
    return blank;
  });
}

export function validateAvailabilityForm(rows) {
  const errors = {};
  for (const row of rows ?? []) {
    if (row.mode !== "window") continue;
    if (!TIME_OF_DAY.test(row.start ?? "") || !TIME_OF_DAY.test(row.end ?? "")) {
      errors[row.weekday] = `${WEEKDAY_NAMES[row.weekday]}: enter both a start and an end time.`;
    } else if (!(row.start < row.end)) {
      errors[row.weekday] = `${WEEKDAY_NAMES[row.weekday]}: the start time must be before the end time.`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// PUT /me/availability body: every weekday is sent, so "available" rows
// overwrite an earlier restriction instead of leaving it in force.
export function buildAvailabilityPayload(rows, effectiveFrom) {
  return {
    ...(effectiveFrom ? { effectiveFrom } : {}),
    days: (rows ?? []).map((row) => {
      if (row.mode === "unavailable") return { weekday: row.weekday, unavailable: true };
      if (row.mode === "window") return { weekday: row.weekday, availableStart: row.start, availableEnd: row.end };
      return { weekday: row.weekday };
    })
  };
}

// --- The colleague's answer (swap / named pickup) ------------------------------

export const SWAP_ANSWERS = Object.freeze(["accept", "decline"]);

// POST path for answering a request that NAMES the caller:
// /facilities/:id/shift-swaps/:requestId/<accept|decline>.
export function swapAnswerPath(facilityId, swap, answer) {
  if (!swap?.id || !SWAP_ANSWERS.includes(answer)) return null;
  return `/facilities/${encodeURIComponent(facilityId)}/shift-swaps/${encodeURIComponent(swap.id)}/${answer}`;
}

// One line for a request waiting on the caller (GET /me/schedule's
// incomingSwaps rows, which carry requester_name).
export function describeIncomingSwap(swap) {
  const who = swap?.requester_name ?? "A colleague";
  const note = swap?.reason ? ` Note: ${swap.reason}` : "";
  if (swap?.swap_type === "direct") return `${who} asks to swap shifts with you.${note}`;
  return `${who} asks you to take over a shift.${note}`;
}

// Status line after answering.
export function summarizeSwapAnswer(result, answer) {
  if (!result) return "";
  if (result.replay) return "You already answered this request; nothing changed.";
  return answer === "accept"
    ? "Accepted. A manager still has to approve the change."
    : "Declined. The request has been closed.";
}

// --- Approvals (manager) --------------------------------------------------------

export const APPROVAL_TAB_DEFS = Object.freeze([
  { type: "claims", label: "Open-shift claims", anyOf: ["schedule.manage.open_shifts", "schedule.manage"] },
  { type: "swaps", label: "Shift swaps", anyOf: ["schedule.approve.swaps", "schedule.manage"] },
  { type: "time_off", label: "Time off", anyOf: ["schedule.approve.time_off"] }
]);

// Which tabs to render for a caller's permission codes. `isPlatformAdmin`
// mirrors app.js's hasPerm() bypass.
export function approvalTabsFor(permissions, { isPlatformAdmin = false } = {}) {
  const held = new Set(permissions ?? []);
  return APPROVAL_TAB_DEFS.filter((tab) => isPlatformAdmin || tab.anyOf.some((code) => held.has(code)));
}

const APPROVAL_PATHS = { claims: "open-shift-claims", swaps: "shift-swaps", time_off: "time-off-requests" };

// POST path for deciding an item: /facilities/:id/<kind>/:requestId/<approve|deny>.
export function approvalDecisionPath(facilityId, item, action) {
  const segment = APPROVAL_PATHS[item?.type];
  if (!segment || (action !== "approve" && action !== "deny")) return null;
  return `/facilities/${encodeURIComponent(facilityId)}/${segment}/${encodeURIComponent(item.id)}/${action}`;
}

export function validateDenial(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return { valid: false, error: "A reason is required to deny a request.", reason: null };
  if (text.length > 1000) return { valid: false, error: "Keep the reason under 1000 characters.", reason: null };
  return { valid: true, error: null, reason: text };
}

// Title + detail lines for one queue item (the API's buildApprovalItems shape).
export function describeApprovalItem(item, options) {
  const who = item.employeeName ?? "An employee";
  if (item.type === "claims") {
    return { title: `${who} wants to claim an open shift`, details: [describeShiftSummary(item.shift, options)].filter(Boolean) };
  }
  if (item.type === "swaps") {
    const details = [`Gives up: ${describeShiftSummary(item.shift, options)}`];
    if (item.awaitingTarget) {
      details.push(`Waiting for ${item.targetEmployeeName ?? "the colleague"} to accept before it can be approved.`);
    }
    if (item.swapType === "direct") {
      details.push(`Takes: ${describeShiftSummary(item.requestedShift, options)}`);
      return { title: `${who} wants to swap with ${item.targetEmployeeName ?? "a colleague"}`, details: withReason(details, item.reason) };
    }
    return {
      title: item.targetEmployeeName ? `${who} wants ${item.targetEmployeeName} to take a shift` : `${who} wants to drop a shift`,
      details: withReason(details, item.reason)
    };
  }
  const range = `${String(item.startsAt).slice(0, 10)} to ${String(item.endsAt).slice(0, 10)}`;
  return { title: `${who} requests ${item.requestType ?? "time"} time off`, details: withReason([range], item.reason) };
}

function withReason(details, reason) {
  return reason ? [...details, `Note: ${reason}`] : details;
}

// Shapes the server's decision result into one status line for the aria-live
// region: a replay, a normal decision, and any non-blocking warnings.
export function summarizeDecisionResult(result, action) {
  if (!result) return "";
  if (result.replay) return "That request was already decided; nothing changed.";
  const base = action === "approve" ? "Request approved." : "Request denied.";
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
  const denied = Array.isArray(result.denied_claim_ids) ? result.denied_claim_ids.length : 0;
  const parts = [base];
  if (denied > 0) parts.push(`${denied} competing claim${denied === 1 ? "" : "s"} denied.`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"} noted.`);
  return parts.join(" ");
}

// Plain-language line for one blocking/warning entry from a 409.
const ISSUE_TEXT = {
  missing_certification: "is missing a required certification",
  overlap: "already works an overlapping shift",
  already_assigned: "is already assigned to this shift",
  time_off: "has approved time off then",
  time_off_pending: "has pending time off then",
  unavailable: "marked themselves unavailable",
  outside_availability: "is outside their stated availability",
  shift_not_found: "the shift no longer exists",
  employee_ineligible: "is no longer an active employee here"
};

export function describeIssue(issue) {
  return ISSUE_TEXT[issue?.code] ?? String(issue?.code ?? "unknown issue").replace(/_/g, " ");
}
