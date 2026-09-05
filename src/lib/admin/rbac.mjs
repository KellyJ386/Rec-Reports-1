// Pure RBAC helpers for the Identity & Permissions surface. These mirror the
// database has_permission() semantics (0001:67) so the effective-access
// simulator and the server agree bit-for-bit, and so grant validation refuses
// anything outside the frozen permissions catalog before it reaches the DB.

import { permissions } from "../permissions.mjs";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// True when the membership is not narrowed to a department (0023).
function isFacilityWide(membership) {
  return membership.departmentId === null || membership.departmentId === undefined;
}

// Union of permission codes across a user's ACTIVE, FACILITY-WIDE memberships
// for one facility. Inactive (invited/disabled) memberships contribute
// nothing, matching how has_permission and canAccessFacility gate on
// status = 'active'; department-scoped memberships (0023) contribute nothing
// at facility scope, matching the 3-arg has_permission.
export function computeEffectivePermissions(memberships, facilityId) {
  const effective = new Set();
  for (const membership of memberships ?? []) {
    if (membership.facilityId === facilityId && membership.status === "active" && isFacilityWide(membership)) {
      for (const code of membership.permissions ?? []) {
        effective.add(code);
      }
    }
  }
  return [...effective];
}

// Boundary check for a role grant: a non-empty name and only catalog codes.
// `role` may be the role object ({ name }) or a bare name string. Returns the
// { valid, errors[] } shape the API layer maps to a 400.
export function validateRoleGrant(role, permissionCodes) {
  const errors = [];
  const name = role && typeof role === "object" ? role.name : role;
  if (!isNonEmptyString(name)) {
    errors.push("role name is required");
  }
  if (!Array.isArray(permissionCodes)) {
    errors.push("permissionCodes must be an array");
  } else {
    for (const code of permissionCodes) {
      if (!permissions.includes(code)) {
        errors.push(`unknown permission code: ${code}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// Diffs two permission-code lists into the grants/revokes an audit payload needs.
export function diffRolePermissions(before, after) {
  const beforeSet = new Set(before ?? []);
  const afterSet = new Set(after ?? []);
  const granted = [...afterSet].filter((code) => !beforeSet.has(code));
  const revoked = [...beforeSet].filter((code) => !afterSet.has(code));
  return { granted, revoked };
}

// Resolves whether a user would be allowed a single permission in a facility,
// returning a reason code that matches has_permission's decision tree:
//   * no-membership       -> the user has no membership in that facility
//   * membership-inactive -> memberships exist but none are active
//   * department-scoped   -> only department-scoped memberships hold the code
//                            (they narrow to their department, 0023)
//   * permission-missing  -> an active membership exists but lacks the code
//   * granted             -> an active facility-wide membership grants the code
// `allowed` equals hasPermission(memberships, facilityId, code) for every code.
export function simulateAccess(memberships, facilityId, code) {
  const forFacility = (memberships ?? []).filter(
    (membership) => membership.facilityId === facilityId
  );
  if (forFacility.length === 0) {
    return { allowed: false, reason: "no-membership" };
  }
  const active = forFacility.filter((membership) => membership.status === "active");
  if (active.length === 0) {
    return { allowed: false, reason: "membership-inactive" };
  }
  const holding = active.filter((membership) => (membership.permissions ?? []).includes(code));
  if (holding.length === 0) {
    return { allowed: false, reason: "permission-missing" };
  }
  const granted = holding.some((membership) => isFacilityWide(membership));
  if (!granted) {
    return { allowed: false, reason: "department-scoped" };
  }
  return { allowed: true, reason: "granted" };
}
