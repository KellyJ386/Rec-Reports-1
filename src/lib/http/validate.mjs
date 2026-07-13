import { getDefinition, validateSettingValue } from "../settings-registry.mjs";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// memberships.status enum (0001:48). Kept in sync with the DB check constraint.
const MEMBERSHIP_STATUSES = ["invited", "active", "disabled"];

// A membership assignment: which user, in which role, at what status. facility
// comes from the route, not the body. departmentId (0023) is optional: absent
// or null means facility-wide; a non-empty id narrows the membership's
// permissions to that department.
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
  if (payload.departmentId !== undefined && payload.departmentId !== null && !isNonEmptyString(payload.departmentId)) {
    errors.push("departmentId must be a non-empty string or null");
  }
  return { valid: errors.length === 0, errors };
}

// A membership patch: change the role, the status, and/or the department
// scope. At least one is required so a PATCH is never a no-op. departmentId
// accepts an explicit null to widen a department-scoped membership back to
// facility-wide (0023).
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
  if (payload.departmentId !== undefined && payload.departmentId !== null && !isNonEmptyString(payload.departmentId)) {
    errors.push("departmentId must be a non-empty string or null");
  }
  const hasRole = isNonEmptyString(payload.roleId);
  const hasStatus = MEMBERSHIP_STATUSES.includes(payload.status);
  const hasDepartment = payload.departmentId !== undefined;
  if (!hasRole && !hasStatus && !hasDepartment) {
    errors.push("at least one of roleId, status, or departmentId is required");
  }
  return { valid: errors.length === 0, errors };
}

// Validate a per-module config patch ({ key: value, ... }) against the Setting
// Registry: every key must be a known setting belonging to `moduleCode`, and
// every value must pass its setting's dataType/validation. Unknown key and
// invalid value both surface as errors (the caller returns 400 for either).
export function validateModuleSettingsPatch(moduleCode, settings) {
  if (!isPlainObject(settings)) {
    return { valid: false, errors: ["settings must be an object of key/value pairs"] };
  }
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return { valid: false, errors: ["settings must contain at least one key"] };
  }
  const errors = [];
  for (const [key, value] of entries) {
    const definition = getDefinition(key);
    if (!definition || definition.module !== moduleCode) {
      errors.push(`unknown setting for module ${moduleCode}: ${key}`);
      continue;
    }
    const result = validateSettingValue(key, value);
    if (!result.valid) errors.push(...result.errors);
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
