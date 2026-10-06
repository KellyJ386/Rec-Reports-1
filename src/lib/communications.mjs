import { configValue } from "./settings-registry.mjs";

// --- Field accessors -----------------------------------------------------
// resolveMessageAudience accepts two audience-item shapes interchangeably:
//   pure-fn/test shape:   { type, id }
//   live PostgREST shape: message_audiences rows { audience_type, audience_ref_id }
// and, correspondingly, snake_case or camelCase context rows (employees,
// shiftAssignments, roleAssignments). Each accessor below tries the
// camelCase key first, then falls back to the snake_case column name, so
// existing camelCase callers/tests are unaffected while a route can pass
// live rows straight through with no manual remapping (an "adapter" without
// a separate function).
function audienceType(audience) {
  return audience?.type ?? audience?.audience_type ?? null;
}

function audienceRefId(audience) {
  // A live message_audiences row carries BOTH `id` (the row's own primary
  // key) and `audience_ref_id` (the department/role/shift/employee it
  // targets). Prefer the explicit ref column, so a live row is never
  // resolved against its own id -- doing so silently targets nobody for
  // department/role/shift audiences and the audience row itself for
  // employee ones. `id` is only the ref in the pure { type, id } shape the
  // domain tests use, which has no audience_ref_id key at all.
  //
  // M3 fix: the prior version fell back to `audience.id` whenever
  // `audience_ref_id` was undefined OR null -- for a LIVE row, a null
  // audience_ref_id is a real, meaningful value (0047's policy/trigger
  // allow it for department/shift/role), not "this key is missing", and
  // falling back silently resolved the audience row's own id as the target
  // instead. The presence of the `audience_ref_id` key at all is what
  // distinguishes a live row from the pure { type, id } test shape, so that
  // is what gates the fallback now -- a live row's own null is returned as
  // null, never `audience.id`.
  if (audience && Object.prototype.hasOwnProperty.call(audience, "audience_ref_id")) {
    return audience.audience_ref_id ?? null;
  }
  return audience?.id ?? null;
}

function employeeDepartmentId(employee) {
  return employee?.departmentId ?? employee?.department_id ?? null;
}

function assignmentShiftId(assignment) {
  return assignment?.shiftId ?? assignment?.shift_id ?? null;
}

function assignmentEmployeeId(assignment) {
  return assignment?.employeeId ?? assignment?.employee_id ?? null;
}

function roleAssignmentRoleId(assignment) {
  return assignment?.roleId ?? assignment?.role_id ?? null;
}

function roleAssignmentEmployeeId(assignment) {
  return assignment?.employeeId ?? assignment?.employee_id ?? null;
}

// --- CM-12: shift windows ----------------------------------------------------
// A `shift` audience targets employees assigned to schedule_shifts. Two
// shapes, both keeping audience_ref_id exactly as 0047/0048's
// fn_assert_same_facility dispatch expects (null, or a schedule_shifts.id of
// the same facility -- nothing about the column's meaning changed):
//   - audience_ref_id = <schedule_shifts.id>: that one shift's assignees.
//   - audience_ref_id = null + rule_jsonb.window: every live shift matching
//     the window -- 'current' (in progress now), 'next' (the earliest
//     upcoming start), or an explicit { from, to } range (any shift that
//     overlaps it). rule_jsonb.departmentId optionally narrows the window to
//     one department's shifts.
// Windows are evaluated on the shifts' own starts_at/ends_at timestamps, never
// on shift_date, so an overnight shift (22:00 -> 06:00) is "current" at 02:00
// the next calendar day and midnight rollover needs no special casing.
export const NEXT_SHIFT_LOOKAHEAD_DAYS = 7;
export const MAX_SHIFT_WINDOW_DAYS = 31;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Normalizes a window spec into { kind: 'current' } | { kind: 'next' } |
// { kind: 'range', from: Date, to: Date }, or null when the spec is absent or
// malformed (a bad window resolves to nobody rather than to everybody).
// Accepts "current"/"next", { kind }, and { from, to } / { start, end }
// (the legacy publish-body shape) with from < to and a span of at most
// MAX_SHIFT_WINDOW_DAYS.
export function normalizeShiftWindow(spec) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec === "string") {
    const kind = spec.trim().toLowerCase();
    return kind === "current" || kind === "next" ? { kind } : null;
  }
  if (typeof spec !== "object" || Array.isArray(spec)) return null;
  if (typeof spec.kind === "string") {
    const kind = spec.kind.trim().toLowerCase();
    if (kind === "current" || kind === "next") return { kind };
    if (kind !== "range") return null;
  }
  const from = toDate(spec.from ?? spec.start);
  const to = toDate(spec.to ?? spec.end);
  if (!from || !to || from.getTime() >= to.getTime()) return null;
  if (to.getTime() - from.getTime() > MAX_SHIFT_WINDOW_DAYS * MS_PER_DAY) return null;
  return { kind: "range", from, to };
}

function shiftStart(shift) {
  return toDate(shift?.startsAt ?? shift?.starts_at);
}

function shiftEnd(shift) {
  return toDate(shift?.endsAt ?? shift?.ends_at);
}

function shiftDepartmentId(shift) {
  return shift?.departmentId ?? shift?.department_id ?? null;
}

function isLiveShift(shift) {
  if (!shift || shift.status === "cancelled") return false;
  return !(shift.deletedAt ?? shift.deleted_at);
}

// Returns the sorted ids of the live shifts a window selects at `now`.
//   current -- start <= now < end (every overlapping shift qualifies).
//   next    -- every shift that starts at the earliest start strictly after
//              now (simultaneous shifts are one "next shift" wave).
//   range   -- any shift overlapping [from, to).
export function selectShiftsInWindow(shifts = [], window, now = new Date(), { departmentId = null } = {}) {
  const normalized = normalizeShiftWindow(window);
  if (!normalized) return [];
  const at = toDate(now) ?? new Date();
  const candidates = (shifts ?? []).filter((shift) => {
    if (!isLiveShift(shift) || !shift.id) return false;
    if (departmentId && shiftDepartmentId(shift) !== departmentId) return false;
    return shiftStart(shift) !== null && shiftEnd(shift) !== null;
  });

  let selected = [];
  if (normalized.kind === "current") {
    selected = candidates.filter((shift) => shiftStart(shift) <= at && at < shiftEnd(shift));
  } else if (normalized.kind === "next") {
    const upcoming = candidates.filter((shift) => shiftStart(shift) > at);
    if (upcoming.length > 0) {
      const earliest = Math.min(...upcoming.map((shift) => shiftStart(shift).getTime()));
      selected = upcoming.filter((shift) => shiftStart(shift).getTime() === earliest);
    }
  } else {
    selected = candidates.filter((shift) => shiftStart(shift) < normalized.to && shiftEnd(shift) > normalized.from);
  }
  return [...new Set(selected.map((shift) => shift.id))].sort();
}

// The [endsAfter, startsBefore) interval a shifts query must cover so
// selectShiftsInWindow sees every shift a set of windows could pick at `now`
// (the loader fetches live shifts in this interval, then lets the pure
// selection above do the actual choosing).
export function shiftQueryBounds(windows = [], now = new Date()) {
  const at = toDate(now) ?? new Date();
  let endsAfter = null;
  let startsBefore = null;
  for (const raw of windows ?? []) {
    const window = normalizeShiftWindow(raw);
    if (!window) continue;
    let lo = at;
    let hi = at;
    if (window.kind === "next") hi = new Date(at.getTime() + NEXT_SHIFT_LOOKAHEAD_DAYS * MS_PER_DAY);
    if (window.kind === "range") {
      lo = window.from;
      hi = window.to;
    }
    if (endsAfter === null || lo < endsAfter) endsAfter = lo;
    if (startsBefore === null || hi > startsBefore) startsBefore = hi;
  }
  if (endsAfter === null || startsBefore === null) return null;
  // `current` needs start <= now, i.e. start < now + epsilon.
  return { endsAfter, startsBefore: new Date(startsBefore.getTime() + 1) };
}

function audienceRule(audience) {
  const rule = audience?.rule ?? audience?.rule_jsonb ?? null;
  return rule && typeof rule === "object" && !Array.isArray(rule) ? rule : {};
}

// The window a shift audience is evaluated against: its own rule's window if
// any, else the caller-supplied fallback (the publish body's `shiftWindow`).
// Only meaningful for a ref-less audience; a specific shift id needs none.
export function audienceShiftWindow(audience, fallback = null) {
  const rule = audienceRule(audience);
  return normalizeShiftWindow(rule.window ?? rule.shiftWindow ?? null) ?? normalizeShiftWindow(fallback);
}

export function audienceShiftDepartmentId(audience) {
  const value = audienceRule(audience).departmentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assignmentIsLive(assignment) {
  if (!assignment) return false;
  if (assignment.status === "declined" || assignment.status === "cancelled") return false;
  return !(assignment.deletedAt ?? assignment.deleted_at);
}

// Resolves a message's audience list into a deduped, sorted array of
// employee ids. `message.audiences` and every list in `context` accept
// either the camelCase pure-fn shape or live snake_case PostgREST rows (see
// accessors above), so the same function serves both the unit tests and a
// real publish route without a separate adapter.
//
// context:
//   employees        -- [{ id, departmentId|department_id }]
//   shiftAssignments -- [{ shiftId|shift_id, employeeId|employee_id }]
//   roleAssignments  -- [{ roleId|role_id, employeeId|employee_id }]
//                        (already joined from memberships.user_id ->
//                        employees.id by the caller -- this function does
//                        no user-id lookups of its own)
//   shifts           -- [{ id, startsAt|starts_at, endsAt|ends_at,
//                        departmentId|department_id, status }] (CM-12:
//                        needed only by ref-less shift-window audiences)
//   shiftWindow      -- fallback window for a ref-less shift audience that
//                        carries no window of its own (the publish body's)
//   now              -- the instant windows are evaluated at (defaults to
//                        the current time; callers snapshotting a message
//                        pass its published_at so 'current'/'next' mean what
//                        they meant when the message went out)
export function resolveMessageAudience(message, context = {}) {
  const employees = context.employees ?? [];
  const shiftAssignments = (context.shiftAssignments ?? []).filter(assignmentIsLive);
  const roleAssignments = context.roleAssignments ?? [];
  const shifts = context.shifts ?? [];
  const now = toDate(context.now) ?? new Date();
  const recipients = new Set();
  for (const audience of message.audiences ?? []) {
    const type = audienceType(audience);
    const refId = audienceRefId(audience);
    // M3: a null refId for an employee audience must resolve to zero
    // recipients (the DB now rejects audience_type='employee' with a null
    // audience_ref_id outright, 0048, but this stays defensive against any
    // row written before that guard existed).
    if (type === "employee" && refId != null) recipients.add(refId);
    if (type === "department") {
      for (const employee of employees.filter((item) => employeeDepartmentId(item) === refId)) {
        recipients.add(employee.id);
      }
    }
    if (type === "shift") {
      let shiftIds = null;
      if (refId != null) {
        shiftIds = new Set([refId]);
      } else {
        // CM-12: a ref-less shift audience targets a window of shifts.
        const window = audienceShiftWindow(audience, context.shiftWindow);
        if (window) {
          shiftIds = new Set(
            selectShiftsInWindow(shifts, window, now, { departmentId: audienceShiftDepartmentId(audience) })
          );
        }
      }
      if (shiftIds && shiftIds.size > 0) {
        for (const assignment of shiftAssignments.filter((item) => shiftIds.has(assignmentShiftId(item)))) {
          const employeeId = assignmentEmployeeId(assignment);
          if (employeeId) recipients.add(employeeId);
        }
      }
    }
    if (type === "role") {
      for (const assignment of roleAssignments.filter((item) => roleAssignmentRoleId(item) === refId)) {
        recipients.add(roleAssignmentEmployeeId(assignment));
      }
    }
  }
  return [...recipients].sort();
}

// Priority -> notification channel list, used by the publish route to shape
// a job's payload_jsonb.channels. Values are restricted to the channels the
// 0006 notification_deliveries CHECK constraint allows ('in_app', 'email',
// 'sms', 'push'); channels beyond 'in_app' are safe to enqueue today even
// before their adapters (CM-07/CM-14) exist -- the worker already writes
// non-in_app deliveries as 'queued' rather than 'sent'.
const PRIORITY_CHANNELS = {
  low: ["in_app"],
  normal: ["in_app"],
  urgent: ["in_app", "push"],
  emergency: ["in_app", "push", "sms"]
};

export function channelsForPriority(priority) {
  return PRIORITY_CHANNELS[priority] ?? PRIORITY_CHANNELS.normal;
}

// `config` optional. When a message does not specify isRequiredAck, fall back to
// communications.requireAckDefault (shipped default false, so a message with no
// explicit flag stays not_required exactly as before).
export function acknowledgementState(message, receipts, now = new Date(), config = {}) {
  const requiredAck =
    message.isRequiredAck === undefined || message.isRequiredAck === null
      ? configValue(config, "communications.requireAckDefault")
      : message.isRequiredAck;
  if (!requiredAck) return "not_required";
  const acknowledgedCount = receipts.filter((receipt) => receipt.acknowledgedAt).length;
  if (acknowledgedCount >= message.requiredRecipientCount) return "complete";
  if (message.ackDueAt && new Date(message.ackDueAt) < now) return "overdue";
  return "pending";
}

export function shouldBypassQuietHours(message) {
  return message.priority === "emergency" || message.priority === "urgent";
}

// --- P-1 (CM-09/CM-11): ack/read compliance rollup -------------------------

// Hours after a message's published_at before an unacknowledged recipient
// counts as overdue. There is no settings-registry key for this yet (checked
// against src/lib/settings-registry.mjs's communications module -- only
// communications.requireAckDefault exists there today), so this is a plain
// module default rather than a per-facility override; summarizeAckCompliance
// accepts an `ackDueHours` option so a caller can still override it once one
// exists, without this function changing shape.
export const DEFAULT_ACK_DUE_HOURS = 48;

// Same camelCase-first/snake_case-fallback accessor pattern as the
// resolveMessageAudience helpers above, so summarizeAckCompliance serves
// both hand-built test fixtures and live message_receipts/
// message_acknowledgements rows unchanged.
function receiptEmployeeId(receipt) {
  return receipt?.employeeId ?? receipt?.employee_id ?? null;
}

function receiptDeliveredAt(receipt) {
  return receipt?.deliveredAt ?? receipt?.delivered_at ?? null;
}

function receiptReadAt(receipt) {
  return receipt?.readAt ?? receipt?.read_at ?? null;
}

function ackEmployeeId(ack) {
  return ack?.employeeId ?? ack?.employee_id ?? null;
}

function ackAcknowledgedAt(ack) {
  return ack?.acknowledgedAt ?? ack?.acknowledged_at ?? null;
}

// Rolls a message's resolved audience up against its receipts/acknowledgements
// into `{delivered, read, acknowledged, pending, overdue, total}` (CM-11).
//
// - `audienceEmployeeIds` -- the deduped employee id list resolveMessageAudience
//   produces for the message (or the facility-wide rollup route's per-message
//   grouping of the same).
// - `receipts`/`acks` -- that message's message_receipts/message_acknowledgements
//   rows. Only rows whose employee is IN the audience are counted -- a stray
//   receipt/ack from someone the audience no longer includes (e.g. a
//   transferred employee) is ignored rather than inflating the totals.
// - `pending`/`overdue` are only ever nonzero when `isRequiredAck` is true --
//   for a message that does not require acknowledgement, a voluntary ack still
//   counts toward `acknowledged`, but there is no compliance obligation to be
//   "pending" or "overdue" against.
// - `overdue` is the subset of `pending` recipients for whom
//   `now > publishedAt + ackDueHours`; `publishedAt` is required for that
//   window to ever open (a draft, or a rollup caller that omits it, is never
//   overdue).
export function summarizeAckCompliance(
  audienceEmployeeIds = [],
  receipts = [],
  acks = [],
  now = new Date(),
  { ackDueHours = DEFAULT_ACK_DUE_HOURS, isRequiredAck = false, publishedAt = null } = {}
) {
  const audience = new Set((audienceEmployeeIds ?? []).filter((id) => id != null));
  const total = audience.size;

  const deliveredSet = new Set();
  const readSet = new Set();
  for (const receipt of receipts ?? []) {
    const employeeId = receiptEmployeeId(receipt);
    if (employeeId == null || !audience.has(employeeId)) continue;
    if (receiptDeliveredAt(receipt)) deliveredSet.add(employeeId);
    if (receiptReadAt(receipt)) readSet.add(employeeId);
  }

  const ackedSet = new Set();
  for (const ack of acks ?? []) {
    const employeeId = ackEmployeeId(ack);
    if (employeeId == null || !audience.has(employeeId)) continue;
    if (ackAcknowledgedAt(ack)) ackedSet.add(employeeId);
  }

  const delivered = deliveredSet.size;
  const read = readSet.size;
  const acknowledged = ackedSet.size;

  let pending = 0;
  let overdue = 0;
  if (isRequiredAck) {
    const dueAt = publishedAt != null ? new Date(new Date(publishedAt).getTime() + ackDueHours * 3_600_000) : null;
    const overdueWindowOpen = dueAt !== null && now > dueAt;
    for (const employeeId of audience) {
      if (ackedSet.has(employeeId)) continue;
      pending += 1;
      if (overdueWindowOpen) overdue += 1;
    }
  }

  return { delivered, read, acknowledged, pending, overdue, total };
}

// --- CM-10: required-acknowledgement escalation ladder ----------------------
// Three tiers, each anchored on the message's ack_due_at plus a configured
// offset (communications.ack*AfterHours; the design's T+X reminder -> T+Y
// supervisor alert -> T+Z manager escalation). The sweep walks one tier per
// message per pass; messages.ack_escalation_level records the last tier
// completed, and message_escalation_events (unique per message + level) is the
// permanent record.
export const MAX_ACK_ESCALATION_LEVEL = 3;

export const ACK_ESCALATION_TIERS = Object.freeze([
  Object.freeze({
    level: 1,
    tier: "reminder",
    eventCode: "message.ack_overdue",
    settingKey: "communications.ackReminderAfterHours"
  }),
  Object.freeze({
    level: 2,
    tier: "supervisor",
    eventCode: "message.ack_escalated_supervisor",
    settingKey: "communications.ackSupervisorAfterHours"
  }),
  Object.freeze({
    level: 3,
    tier: "manager",
    eventCode: "message.ack_escalated_manager",
    settingKey: "communications.ackManagerAfterHours"
  })
]);

// Resolves the ladder for one facility's effective config. Offsets are
// clamped to be non-decreasing (a supervisor alert never fires before the
// reminder, a manager escalation never before the supervisor alert), and a
// malformed value falls back to the registry default rather than disabling
// or reordering a tier.
export function buildAckEscalationLadder(config = {}) {
  let floor = 0;
  return ACK_ESCALATION_TIERS.map((tier) => {
    const raw = Number(configValue(config, tier.settingKey));
    const hours = Number.isFinite(raw) && raw >= 0 ? raw : Number(configValue({}, tier.settingKey));
    const afterHours = Math.max(hours, floor);
    floor = afterHours;
    return { ...tier, afterHours };
  });
}

function messageIsRequiredAck(message) {
  return !!(message?.isRequiredAck ?? message?.is_required_ack);
}

function messageAckDueAt(message) {
  return toDate(message?.ackDueAt ?? message?.ack_due_at);
}

function messagePublishedAt(message) {
  return toDate(message?.publishedAt ?? message?.published_at);
}

function messageEscalationLevel(message) {
  const raw = Number(message?.ackEscalationLevel ?? message?.ack_escalation_level ?? 0);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

// Highest tier whose threshold (ack_due_at + afterHours) has passed at `now`.
// 0 for a message that is not required-ack, unpublished, has no due time, or
// is not yet past its first threshold.
export function ackEscalationDueLevel(message, now = new Date(), ladder = buildAckEscalationLadder()) {
  if (!messageIsRequiredAck(message) || !messagePublishedAt(message)) return 0;
  const due = messageAckDueAt(message);
  const at = toDate(now);
  if (!due || !at) return 0;
  let level = 0;
  for (const tier of ladder) {
    if (at.getTime() >= due.getTime() + tier.afterHours * 3_600_000) level = tier.level;
  }
  return level;
}

// The one tier a sweep should process next for this message, or null. Always
// the tier immediately after the recorded level (never skipping one), so every
// level gets its own event and recipients even after a long outage -- the
// following passes catch the message up one level at a time.
export function nextAckEscalationStep(message, now = new Date(), ladder = buildAckEscalationLadder()) {
  const current = messageEscalationLevel(message);
  if (current >= MAX_ACK_ESCALATION_LEVEL) return null;
  if (ackEscalationDueLevel(message, now, ladder) <= current) return null;
  return ladder.find((tier) => tier.level === current + 1) ?? null;
}

// Audience employees who have not acknowledged (a waived acknowledgement
// counts as settled, same as an acknowledged one).
export function outstandingAckEmployeeIds(audienceEmployeeIds = [], acks = []) {
  const settled = new Set();
  for (const ack of acks ?? []) {
    const employeeId = ackEmployeeId(ack);
    const state = ack?.ackState ?? ack?.ack_state ?? null;
    if (employeeId != null && (ackAcknowledgedAt(ack) || state === "waived" || state === "acknowledged")) {
      settled.add(employeeId);
    }
  }
  return [...new Set((audienceEmployeeIds ?? []).filter((id) => id != null))].filter((id) => !settled.has(id)).sort();
}

// --- CM-13: emergency mode ----------------------------------------------------
export const EMERGENCY_RESPONSES = Object.freeze(["safe", "need_help"]);
export const EMERGENCY_CHANNELS = Object.freeze(["in_app", "push", "sms", "email"]);

export function isEmergencyResponse(value) {
  return EMERGENCY_RESPONSES.includes(value);
}

// Rolls an emergency message's audience up against the responses recorded for
// it. Only responses from employees in the audience count towards the three
// buckets (a responder outside the snapshot is reported separately so it is
// never silently dropped or inflating the totals).
export function summarizeEmergencyResponses(audienceEmployeeIds = [], responses = []) {
  const audience = new Set((audienceEmployeeIds ?? []).filter((id) => id != null));
  const byEmployee = new Map();
  let outsideAudience = 0;
  for (const row of responses ?? []) {
    const employeeId = row?.employeeId ?? row?.employee_id ?? null;
    const response = row?.response ?? null;
    if (employeeId == null || !isEmergencyResponse(response)) continue;
    if (!audience.has(employeeId)) {
      outsideAudience += 1;
      continue;
    }
    byEmployee.set(employeeId, response);
  }
  const needHelpEmployeeIds = [];
  let safe = 0;
  for (const [employeeId, response] of byEmployee) {
    if (response === "safe") safe += 1;
    else needHelpEmployeeIds.push(employeeId);
  }
  const noResponseEmployeeIds = [...audience].filter((id) => !byEmployee.has(id)).sort();
  return {
    total: audience.size,
    safe,
    needHelp: needHelpEmployeeIds.length,
    noResponse: noResponseEmployeeIds.length,
    needHelpEmployeeIds: needHelpEmployeeIds.sort(),
    noResponseEmployeeIds,
    outsideAudience
  };
}

// --- CM-16: lightweight inbox summary ----------------------------------------
// Backs GET /me/inbox-summary (the 30 s polled alternative to a realtime
// channel). Inputs are already scoped to the caller and facility by the route.
export const INBOX_WINDOW_DAYS = 30;
export const EMERGENCY_ALERT_WINDOW_HOURS = 72;

export function summarizeInbox(
  {
    messages = [],
    readMessageIds = [],
    ackedMessageIds = [],
    emergencyResponses = []
  } = {},
  now = new Date()
) {
  const at = toDate(now) ?? new Date();
  const read = new Set(readMessageIds ?? []);
  const acked = new Set(ackedMessageIds ?? []);
  const published = (messages ?? []).filter((message) => messagePublishedAt(message) && message.id);

  const unreadCount = published.filter((message) => !read.has(message.id)).length;

  const pending = published.filter((message) => messageIsRequiredAck(message) && !acked.has(message.id));
  const overdue = pending.filter((message) => {
    const due = messageAckDueAt(message);
    return due !== null && due.getTime() < at.getTime();
  });
  const dueTimes = pending.map((message) => messageAckDueAt(message)).filter(Boolean).sort((a, b) => a - b);

  const emergencyCutoff = at.getTime() - EMERGENCY_ALERT_WINDOW_HOURS * 3_600_000;
  const emergencies = published
    .filter((message) => message.priority === "emergency" && messagePublishedAt(message).getTime() >= emergencyCutoff)
    .sort((a, b) => messagePublishedAt(b) - messagePublishedAt(a));
  const latest = emergencies[0] ?? null;
  let latestEmergency = null;
  if (latest) {
    const mine = (emergencyResponses ?? []).find((row) => (row?.messageId ?? row?.message_id) === latest.id);
    latestEmergency = {
      messageId: latest.id,
      subject: latest.subject ?? "",
      bodyText: latest.body_text ?? latest.bodyText ?? "",
      publishedAt: messagePublishedAt(latest).toISOString(),
      myResponse: mine?.response ?? null
    };
  }

  return {
    unreadCount,
    pendingAcks: {
      count: pending.length,
      overdueCount: overdue.length,
      nextDueAt: dueTimes.length > 0 ? dueTimes[0].toISOString() : null
    },
    latestEmergency
  };
}
