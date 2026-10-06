// Shared audience-resolution context loader (CM-03/CM-10/CM-11/CM-12).
//
// Expands a batch of message_audiences rows into the employees /
// roleAssignments / shiftAssignments / shifts context resolveMessageAudience
// (communications.mjs) needs. Used by the publish route, the compliance
// routes, the emergency roll-up and the CM-10 escalation sweep, so all of
// them resolve a message's audience identically. Works with any PostgREST
// client: a caller's own RLS-scoped client in routes, the service-role client
// in the sweep (every query below is facility-scoped by hand either way).
//
// The underlying employees/memberships/schedule_shifts/shift_assignments
// queries each run at most once no matter how many audience rows -- including
// rows spanning MULTIPLE messages -- are passed in, which is what lets the
// facility-wide compliance-summary route and the sweep batch their audience
// resolution into one call instead of one query set per message.
import { pgSelect } from "./supabase-rest.mjs";
import {
  audienceShiftDepartmentId,
  audienceShiftWindow,
  normalizeShiftWindow,
  selectShiftsInWindow,
  shiftQueryBounds
} from "./communications.mjs";

const SHIFT_QUERY_LIMIT = 2000;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// `shiftWindow`: fallback window (the publish body's) for ref-less shift
// audiences that carry no window of their own. `anchors`: the instants those
// windows will be evaluated at (default: just `now`); a caller resolving many
// messages at once passes each message's published_at so the one shifts query
// covers all of them.
export async function loadAudienceResolutionContext(
  client,
  facilityId,
  audiences,
  { shiftWindow = null, now = new Date(), anchors = null } = {}
) {
  const fallbackWindow = normalizeShiftWindow(shiftWindow);
  const resolvableAudiences = [];
  const unresolvedAudiences = [];
  for (const audience of audiences) {
    if (
      audience.audience_type === "shift" &&
      (audience.audience_ref_id === null || audience.audience_ref_id === undefined) &&
      !audienceShiftWindow(audience, fallbackWindow)
    ) {
      unresolvedAudiences.push({
        id: audience.id,
        audienceType: audience.audience_type,
        audienceRefId: audience.audience_ref_id,
        reason: "shift audience needs a shift id or a window (rule.window, or shiftWindow on publish)"
      });
      continue;
    }
    resolvableAudiences.push(audience);
  }

  const needsEmployees = resolvableAudiences.some(
    (audience) => audience.audience_type === "department" || audience.audience_type === "role"
  );
  const roleRefIds = [
    ...new Set(
      resolvableAudiences.filter((audience) => audience.audience_type === "role").map((audience) => audience.audience_ref_id)
    )
  ];
  const shiftAudiences = resolvableAudiences.filter((audience) => audience.audience_type === "shift");
  const explicitShiftIds = shiftAudiences.map((audience) => audience.audience_ref_id).filter((id) => id !== null && id !== undefined);
  const windowAudiences = shiftAudiences.filter((audience) => audience.audience_ref_id === null || audience.audience_ref_id === undefined);

  const employees = needsEmployees
    ? (await pgSelect(client, "employees", {
        filters: { facility_id: facilityId },
        select: "id,department_id,user_id"
      })) ?? []
    : [];

  let roleAssignments = [];
  if (roleRefIds.length > 0) {
    const memberships =
      (await pgSelect(client, "memberships", {
        filters: { facility_id: facilityId, role_id: { in: roleRefIds }, status: "active" },
        select: "user_id,role_id"
      })) ?? [];
    const employeeIdByUserId = new Map(employees.map((employee) => [employee.user_id, employee.id]));
    roleAssignments = memberships
      .map((membership) => ({
        role_id: membership.role_id,
        employee_id: employeeIdByUserId.get(membership.user_id) ?? null
      }))
      .filter((assignment) => assignment.employee_id);
  }

  // CM-12: window audiences need the facility's live shifts around the
  // anchor(s); the pure selection then picks which ones the window means.
  let shifts = [];
  const windowShiftIds = new Set();
  const anchorList = (anchors && anchors.length > 0 ? anchors : [now]).map((anchor) => new Date(anchor));
  if (windowAudiences.length > 0) {
    const windows = windowAudiences.map((audience) => audienceShiftWindow(audience, fallbackWindow));
    let endsAfter = null;
    let startsBefore = null;
    for (const anchor of anchorList) {
      const bounds = shiftQueryBounds(windows, anchor);
      if (!bounds) continue;
      if (endsAfter === null || bounds.endsAfter < endsAfter) endsAfter = bounds.endsAfter;
      if (startsBefore === null || bounds.startsBefore > startsBefore) startsBefore = bounds.startsBefore;
    }
    if (endsAfter !== null && startsBefore !== null) {
      shifts =
        (await pgSelect(client, "schedule_shifts", {
          filters: { facility_id: facilityId, status: { neq: "cancelled" } },
          select: "id,department_id,starts_at,ends_at,status",
          limit: SHIFT_QUERY_LIMIT,
          extra: { ends_at: `gt.${toIso(endsAfter)}`, starts_at: `lt.${toIso(startsBefore)}`, deleted_at: "is.null" }
        })) ?? [];
    }
    for (const audience of windowAudiences) {
      const window = audienceShiftWindow(audience, fallbackWindow);
      for (const anchor of anchorList) {
        for (const id of selectShiftsInWindow(shifts, window, anchor, { departmentId: audienceShiftDepartmentId(audience) })) {
          windowShiftIds.add(id);
        }
      }
    }
  }

  const shiftIdsToFetch = [...new Set([...explicitShiftIds, ...windowShiftIds])];
  let shiftAssignments = [];
  if (shiftIdsToFetch.length > 0) {
    shiftAssignments =
      (await pgSelect(client, "shift_assignments", {
        filters: { facility_id: facilityId, shift_id: { in: shiftIdsToFetch }, status: { in: ["pending", "approved"] } },
        select: "shift_id,employee_id",
        extra: { deleted_at: "is.null" }
      })) ?? [];
  }

  return {
    resolvableAudiences,
    unresolvedAudiences,
    employees,
    roleAssignments,
    shiftAssignments,
    shifts,
    shiftWindow: fallbackWindow,
    now
  };
}

// The context object resolveMessageAudience takes, from a loader result;
// `at` overrides the window-evaluation instant for one message (its
// published_at, so a re-resolution agrees with what the publish snapshot saw).
export function resolutionContextFrom(loaded, at = null) {
  return {
    employees: loaded.employees,
    roleAssignments: loaded.roleAssignments,
    shiftAssignments: loaded.shiftAssignments,
    shifts: loaded.shifts,
    shiftWindow: loaded.shiftWindow,
    now: at ?? loaded.now
  };
}
