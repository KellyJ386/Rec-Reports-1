import { hasPermission } from "../permissions.mjs";

export function requirePermission(memberships, facilityId, code) {
  if (!code) return { allowed: false, reason: "permission code is required" };
  if (!facilityId) return { allowed: false, reason: "facility id is required" };
  if (hasPermission(memberships ?? [], facilityId, code)) return { allowed: true, reason: null };
  return { allowed: false, reason: `missing permission: ${code}` };
}

export function requireOrgAdmin(memberships, orgFacilities) {
  const facilityIds = orgFacilities ?? [];
  if (facilityIds.length === 0) {
    return { allowed: false, reason: "organization has no facilities" };
  }
  const isAdmin = facilityIds.some((facilityId) =>
    hasPermission(memberships ?? [], facilityId, "admin.manage")
  );
  if (isAdmin) return { allowed: true, reason: null };
  return { allowed: false, reason: "missing permission: admin.manage" };
}
