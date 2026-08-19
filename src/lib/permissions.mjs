export const permissions = Object.freeze([
  "reports.read",
  "reports.create",
  "reports.submit",
  "reports.export",
  "schedule.read",
  "schedule.manage",
  // schedule.manage alone can build/edit a period's shifts and assignments
  // but cannot push them live -- publishing is its own governance surface
  // (SC-07), gated separately so a facility can grant day-to-day scheduling
  // without also granting the ability to publish.
  "schedule.publish",
  "training.read",
  "training.manage",
  "incidents.read",
  "incidents.manage",
  // Fine-grained incident governance codes (IN-01). Not implied by
  // incidents.manage: a supervisor may review/escalate/create tasks without
  // holding full incidents.manage, and legal_hold/export.pdf/audit.view are
  // restricted to facility/ops admin roles even where incidents.manage is held.
  "incidents.review",
  "incidents.escalate",
  "incidents.tasks.create",
  "incidents.legal_hold.manage",
  "incidents.export.pdf",
  "incidents.audit.view",
  "work_orders.read",
  "work_orders.manage",
  "admin.manage",
  "reports.template.manage",
  // Reports governance codes (DR-05). reports.template.manage alone can author
  // a template but cannot publish it, manage its workflow automation, or
  // manage its distribution lists -- each is its own governance surface.
  "reports.publish",
  "reports.workflow.manage",
  "reports.distribution.manage",
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
