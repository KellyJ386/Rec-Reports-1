import { hasPermission, canAccessFacility } from "../permissions.mjs";

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

// --- Auth-level variants (platform super-admin aware, 0022) -----------------
// These take the whole authenticate() result instead of bare memberships and
// honor auth.platformAdmin the same way the SQL helpers do: is_platform_admin
// short-circuits has_permission and current_facility_ids, so the JS guards
// short-circuit here. Auth stubs without the flag behave exactly like the
// membership-only guards (the bypass is opt-in by construction).

export function requireAuthPermission(auth, facilityId, code) {
  if (!code) return { allowed: false, reason: "permission code is required" };
  if (!facilityId) return { allowed: false, reason: "facility id is required" };
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  return requirePermission(auth?.memberships, facilityId, code);
}

export function authCanAccessFacility(auth, facilityId) {
  if (auth?.platformAdmin === true) return true;
  return canAccessFacility(auth?.memberships ?? [], facilityId);
}

export function requireAuthOrgAdmin(auth, orgFacilities) {
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  return requireOrgAdmin(auth?.memberships, orgFacilities);
}
