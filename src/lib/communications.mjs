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
  if (audience?.audience_ref_id !== undefined && audience.audience_ref_id !== null) {
    return audience.audience_ref_id;
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
    if (type === "employee") recipients.add(refId);
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
