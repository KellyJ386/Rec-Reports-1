function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// memberships.status enum (0001:48). Kept in sync with the DB check constraint.
const MEMBERSHIP_STATUSES = ["invited", "active", "disabled"];

// A membership assignment: which user, in which role, at what status. facility
// comes from the route, not the body.
export function validateMembershipInput(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (!isNonEmptyString(payload.userId)) {
    errors.push("userId is required");
  }
  if (!isNonEmptyString(payload.roleId)) {
    errors.push("roleId is required");
  }
  if (payload.status !== undefined && payload.status !== null) {
    if (!MEMBERSHIP_STATUSES.includes(payload.status)) {
      errors.push(`status must be one of ${MEMBERSHIP_STATUSES.join(", ")}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// A membership patch: change the role and/or the status. At least one is
// required so a PATCH is never a no-op.
export function validateMembershipPatch(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (payload.roleId !== undefined && payload.roleId !== null && !isNonEmptyString(payload.roleId)) {
    errors.push("roleId must be a non-empty string");
  }
  if (payload.status !== undefined && payload.status !== null) {
    if (!MEMBERSHIP_STATUSES.includes(payload.status)) {
      errors.push(`status must be one of ${MEMBERSHIP_STATUSES.join(", ")}`);
    }
  }
  const hasRole = isNonEmptyString(payload.roleId);
  const hasStatus = MEMBERSHIP_STATUSES.includes(payload.status);
  if (!hasRole && !hasStatus) {
    errors.push("at least one of roleId or status is required");
  }
  return { valid: errors.length === 0, errors };
}

export function validateModuleTogglePayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (typeof payload.enabled !== "boolean") {
    errors.push("enabled is required and must be a boolean");
  }
  if (payload.configPatch !== undefined && !isPlainObject(payload.configPatch)) {
    errors.push("configPatch must be a plain object");
  }
  return { valid: errors.length === 0, errors };
}
