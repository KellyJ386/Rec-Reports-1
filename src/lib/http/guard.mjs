import { hasPermission, canAccessFacility } from "../permissions.mjs";
import { pgSelect } from "../supabase-rest.mjs";

export function requirePermission(memberships, facilityId, code) {
  if (!code) return { allowed: false, reason: "permission code is required" };
  if (!facilityId) return { allowed: false, reason: "facility id is required" };
  if (hasPermission(memberships ?? [], facilityId, code)) return { allowed: true, reason: null };
  return { allowed: false, reason: `missing permission: ${code}` };
}

// deprecated (S-6, 0045_read_and_audit_policies.sql): this implements the
// pre-0019 rule -- admin.manage on ANY single facility of the org promotes
// the caller to org-wide admin authority. 0019_review_hardening.sql removed
// that rule from is_organization_admin (SQL now requires an explicit
// organization_admins row), but these two JS guards were never updated to
// match, so every admin/billing org-admin route was enforcing a stricter SQL
// rule underneath a looser JS gate. Use requireAuthOrgAdminRow below instead.
// Kept exported only because test/http-guard.test.mjs still exercises the
// membership-shape directly; no route should call these anymore.
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

// deprecated (S-6): see requireOrgAdmin above -- same pre-0019 rule, still
// exported only for its existing test coverage. Use requireAuthOrgAdminRow.
export function requireAuthOrgAdmin(auth, orgFacilities) {
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  return requireOrgAdmin(auth?.memberships, orgFacilities);
}

// Org-admin check matching the actual SQL rule (0019: is_organization_admin
// requires an explicit organization_admins row -- admin.manage on a member
// facility no longer implies org-wide authority). Queries with the caller's
// own client (RLS "org members can read org admins", 0009:73-77, lets any
// member of the org read that org's organization_admins rows), filtered to
// the caller's own row, so a non-member simply gets zero rows back rather
// than an RLS error -- same "deny by empty result" shape as every other
// permission check in this file.
export async function requireAuthOrgAdminRow(auth, organizationId) {
  if (!organizationId) return { allowed: false, reason: "organization id is required" };
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  const rows = await pgSelect(auth?.client, "organization_admins", {
    filters: { organization_id: organizationId, user_id: auth?.claims?.sub },
    select: "id",
    limit: 1
  });
  if ((rows ?? []).length > 0) return { allowed: true, reason: null };
  return { allowed: false, reason: "missing organization_admins row" };
}
