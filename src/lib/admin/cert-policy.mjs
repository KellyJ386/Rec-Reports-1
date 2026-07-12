// Pure helpers for the Certification policy admin surface
// (certification_role_requirements, certification_policies; 0017). No I/O here:
// the route layer loads rows and passes them in, so every function is a
// deterministic transform that node:test can exercise directly. Expiry logic is
// NOT re-implemented -- it is imported from training.mjs so the admin surface and
// the scheduling/training runtime agree on when a cert is expiring/expired.

import { certificationStatus } from "../training.mjs";
import { configValue } from "../settings-registry.mjs";

const ENFORCEMENT_MODES = ["hard-block", "warning"];
const TRIGGER_TYPES = ["expiry", "assignment", "schedule"];

// Validate a candidate certification_role_requirements payload. Returns
// { valid, errors } in the same shape as the http/validate.mjs and
// settings-registry helpers.
export function validateRequirementInput(input = {}) {
  const errors = [];
  if (typeof input.certificationTypeId !== "string" || input.certificationTypeId.trim().length === 0) {
    errors.push("certificationTypeId is required");
  }
  if (typeof input.roleId !== "string" || input.roleId.trim().length === 0) {
    errors.push("roleId is required");
  }
  if (input.requiredLevel !== undefined && (typeof input.requiredLevel !== "string" || input.requiredLevel.trim().length === 0)) {
    errors.push("requiredLevel must be a non-empty string");
  }
  if (
    input.enforcementMode !== undefined &&
    input.enforcementMode !== null &&
    !ENFORCEMENT_MODES.includes(input.enforcementMode)
  ) {
    errors.push(`enforcementMode must be one of: ${ENFORCEMENT_MODES.join(", ")}`);
  }
  if (input.active !== undefined && typeof input.active !== "boolean") {
    errors.push("active must be a boolean");
  }
  return { valid: errors.length === 0, errors };
}

// Validate a candidate certification_policies payload.
export function validatePolicyInput(input = {}) {
  const errors = [];
  if (!TRIGGER_TYPES.includes(input.triggerType)) {
    errors.push(`triggerType must be one of: ${TRIGGER_TYPES.join(", ")}`);
  }
  if (input.cadenceRule !== undefined && !isPlainObject(input.cadenceRule)) {
    errors.push("cadenceRule must be an object");
  }
  if (input.action !== undefined && !isPlainObject(input.action)) {
    errors.push("action must be an object");
  }
  if (input.active !== undefined && typeof input.active !== "boolean") {
    errors.push("active must be a boolean");
  }
  return { valid: errors.length === 0, errors };
}

// Filter a set of requirement rows to those that apply to one role. Accepts both
// snake_case DB rows (role_id) and camelCase (roleId).
export function requirementsForRole(requirements = [], roleId) {
  return (requirements ?? []).filter((requirement) => (requirement?.role_id ?? requirement?.roleId) === roleId);
}

// Precedence for a requirement's effective enforcement mode:
//   1. the requirement's own enforcement_mode when it names one
//      ('hard-block' | 'warning') -- the per-requirement override always wins;
//   2. otherwise the facility's scheduling.certEnforcementMode registry setting
//      (falling back to its shipped default, 'hard-block', when unset).
// This is the single place both scheduling.mjs and certGaps below consult, so a
// requirement that is silent transparently inherits the facility-wide mode.
export function effectiveEnforcementMode(requirement = {}, facilityConfig = {}) {
  const own = requirement?.enforcement_mode ?? requirement?.enforcementMode ?? null;
  if (ENFORCEMENT_MODES.includes(own)) return own;
  return configValue(facilityConfig, "scheduling.certEnforcementMode");
}

// Compute the certification gaps for an employee against a set of requirements
// (typically requirementsForRole output). Returns one entry per requirement the
// employee does not satisfy:
//   { certificationTypeId, status: 'missing'|'expired'|'expiring', enforcement }
// A held-and-active cert produces no gap. Expiry classification is delegated to
// training.mjs certificationStatus so the window (recert / renewal) matches the
// runtime exactly; `config` is threaded through for the recert-window fallback.
export function certGaps(employeeCerts = [], requirements = [], today = new Date(), config = {}) {
  const byType = new Map();
  for (const cert of employeeCerts ?? []) {
    const typeId = cert?.certification_type_id ?? cert?.certificationTypeId;
    if (typeId) byType.set(typeId, cert);
  }

  const gaps = [];
  for (const requirement of requirements ?? []) {
    if (requirement?.active === false) continue;
    const typeId = requirement?.certification_type_id ?? requirement?.certificationTypeId;
    if (!typeId) continue;
    const enforcement = effectiveEnforcementMode(requirement, config);
    const held = byType.get(typeId);
    if (!held) {
      gaps.push({ certificationTypeId: typeId, status: "missing", enforcement });
      continue;
    }
    const status = certificationStatus(normalizeCert(held), today, config);
    if (status === "expiring") {
      gaps.push({ certificationTypeId: typeId, status: "expiring", enforcement });
    } else if (status === "expired" || status === "revoked") {
      gaps.push({ certificationTypeId: typeId, status: "expired", enforcement });
    }
    // 'active' -> no gap.
  }
  return gaps;
}

// Adapt an employee_certifications row (snake_case, DB shape) to the object
// certificationStatus expects.
function normalizeCert(cert) {
  return {
    status: cert?.status,
    expiresAt: cert?.expires_at ?? cert?.expiresAt ?? null,
    renewalWindowDays: cert?.renewal_window_days ?? cert?.renewalWindowDays
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
