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
export function resolveMessageAudience(message, context = {}) {
  const employees = context.employees ?? [];
  const shiftAssignments = context.shiftAssignments ?? [];
  const roleAssignments = context.roleAssignments ?? [];
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
      for (const assignment of shiftAssignments.filter((item) => assignmentShiftId(item) === refId)) {
        recipients.add(assignmentEmployeeId(assignment));
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
