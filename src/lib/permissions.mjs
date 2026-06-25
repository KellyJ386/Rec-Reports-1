export const permissions = Object.freeze([
  "reports.read",
  "reports.create",
  "reports.submit",
  "reports.export",
  "schedule.read",
  "schedule.manage",
  "incidents.read",
  "incidents.manage",
  "work_orders.read",
  "work_orders.manage",
  "communications.publish",
  "training.manage",
  "admin.manage"
]);

export function canAccessFacility(memberships, facilityId) {
  return memberships.some((membership) => membership.facilityId === facilityId);
}

export function hasPermission(memberships, facilityId, permission) {
  return memberships.some(
    (membership) =>
      membership.facilityId === facilityId && membership.permissions.includes(permission)
  );
}
