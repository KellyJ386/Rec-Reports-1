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

export function canAccessFacility(memberships, facilityId) {
  return memberships.some(
    (membership) => membership.facilityId === facilityId && membership.status === "active"
  );
}

export function hasPermission(memberships, facilityId, permission) {
  return memberships.some(
    (membership) =>
      membership.facilityId === facilityId &&
      membership.status === "active" &&
      membership.permissions.includes(permission)
  );
}
