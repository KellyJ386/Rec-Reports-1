export const permissions = Object.freeze([
  "reports.read",
  "reports.create",
  "reports.submit",
  "reports.export",
  "schedule.read",
  "schedule.manage",
  "training.read",
  "training.manage",
  "incidents.read",
  "incidents.manage",
  "work_orders.read",
  "work_orders.manage",
  "admin.manage",
  "reports.template.manage",
  "communications.read",
  "communications.publish"
]);

// True when the membership is not narrowed to a department (0023): a null or
// absent departmentId is the facility-wide, pre-0023 shape.
function isFacilityWide(membership) {
  return membership.departmentId === null || membership.departmentId === undefined;
}

export function canAccessFacility(memberships, facilityId) {
  return memberships.some(
    (membership) => membership.facilityId === facilityId && membership.status === "active"
  );
}

// Mirrors the 3-arg SQL has_permission (0023): facility-scope checks pass only
// via FACILITY-WIDE memberships. A department-scoped membership narrows its
// permissions to that department and contributes nothing at facility scope.
export function hasPermission(memberships, facilityId, permission) {
  return memberships.some(
    (membership) =>
      membership.facilityId === facilityId &&
      membership.status === "active" &&
      isFacilityWide(membership) &&
      membership.permissions.includes(permission)
  );
}

// Mirrors the 4-arg SQL has_permission overload (0023): a department-scoped
// check passes via a facility-wide membership or a membership scoped to
// exactly that department.
export function hasDepartmentPermission(memberships, facilityId, departmentId, permission) {
  return memberships.some(
    (membership) =>
      membership.facilityId === facilityId &&
      membership.status === "active" &&
      (isFacilityWide(membership) || membership.departmentId === departmentId) &&
      membership.permissions.includes(permission)
  );
}
