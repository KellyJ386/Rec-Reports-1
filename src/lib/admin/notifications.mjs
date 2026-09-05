// Pure routing/resolution helpers for the Notifications admin surface
// (notification_events, distribution_lists, distribution_list_members,
// notification_routes; 0016) that wire into the existing notification_jobs
// fan-out table (0006). No I/O here -- the route layer loads rows and passes
// them in, so every function is a deterministic transform that node:test can
// exercise directly.

import { configValue } from "../settings-registry.mjs";

// Resolves the effective route for an event: the highest-priority ACTIVE route
// whose event_code matches. Ties break toward the first-seen route. Returns
// null when no active route targets the event.
export function resolveRoute(eventCode, routes = []) {
  let best = null;
  for (const route of routes ?? []) {
    if (!route || route.active === false) continue;
    if (route.event_code !== eventCode) continue;
    const priority = Number(route.priority ?? 0);
    if (best === null || priority > Number(best.priority ?? 0)) {
      best = route;
    }
  }
  return best;
}

function normalizeRoleAssignment(assignment) {
  const roleId = assignment?.role_id ?? assignment?.roleId ?? null;
  const employeeId = assignment?.employee_id ?? assignment?.employeeId ?? null;
  return { roleId, employeeId };
}

// Expands a distribution list into a deduped array of employee ids. 'employee'
// members contribute their ref directly; 'role' members expand through
// roleAssignments (role -> employee). When a non-empty `employees` roster is
// supplied, the result is filtered to ids present in it (so stale references
// drop out); with no roster, ids pass through unfiltered.
export function expandDistributionList(list, members = [], { employees = [], roleAssignments = [] } = {}) {
  const listId = list?.id ?? null;
  const knownEmployeeIds = new Set((employees ?? []).map((employee) => employee?.id ?? employee));
  const roleToEmployees = new Map();
  for (const raw of roleAssignments ?? []) {
    const { roleId, employeeId } = normalizeRoleAssignment(raw);
    if (!roleId || !employeeId) continue;
    if (!roleToEmployees.has(roleId)) roleToEmployees.set(roleId, []);
    roleToEmployees.get(roleId).push(employeeId);
  }

  const result = [];
  const seen = new Set();
  const push = (employeeId) => {
    if (!employeeId || seen.has(employeeId)) return;
    if (knownEmployeeIds.size > 0 && !knownEmployeeIds.has(employeeId)) return;
    seen.add(employeeId);
    result.push(employeeId);
  };

  for (const member of members ?? []) {
    if (!member) continue;
    if (listId !== null && member.distribution_list_id !== undefined && member.distribution_list_id !== listId) {
      continue;
    }
    if (member.member_type === "employee") {
      push(member.member_ref_id);
    } else if (member.member_type === "role") {
      for (const employeeId of roleToEmployees.get(member.member_ref_id) ?? []) push(employeeId);
    }
  }
  return result;
}

function toMinutes(time) {
  if (typeof time !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// True when `time` ("HH:MM") falls inside the quiet-hours window. Handles
// overnight ranges (e.g. 22:00-06:00 spans midnight). Defaults come from the
// setting registry's quiet-hours keys so callers that pass nothing get the
// shipped facility defaults. An empty/equal window (start === end) is treated
// as "no quiet hours" and always returns false.
export function isWithinQuietHours(
  time,
  quietStart = configValue({}, "reports.quietHoursStart"),
  quietEnd = configValue({}, "reports.quietHoursEnd")
) {
  const t = toMinutes(time);
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  if (t === null || start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) {
    return t >= start && t < end;
  }
  // Overnight window: inside if at/after start OR before end.
  return t >= start || t < end;
}

// Shapes a row for the existing notification_jobs table (0006:
// facility_id, event_type, payload_jsonb, scheduled_for, status, attempts).
// recipients is an array of employee ids; the route context is captured in the
// payload so downstream fan-out has everything it needs.
export function buildNotificationJob(eventCode, route, recipients = []) {
  const channels = Array.isArray(route?.route_jsonb?.channels) ? route.route_jsonb.channels : [];
  return {
    facility_id: route?.facility_id ?? null,
    event_type: eventCode,
    status: "pending",
    payload_jsonb: {
      route_id: route?.id ?? null,
      priority: route?.priority ?? null,
      channels,
      recipients: [...recipients]
    }
  };
}
