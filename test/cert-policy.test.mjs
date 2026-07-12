import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRequirementInput,
  validatePolicyInput,
  requirementsForRole,
  effectiveEnforcementMode,
  certGaps
} from "../src/lib/admin/cert-policy.mjs";

test("validateRequirementInput requires certificationTypeId and roleId", () => {
  assert.equal(validateRequirementInput({ certificationTypeId: "c1", roleId: "r1" }).valid, true);
  const missing = validateRequirementInput({});
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => /certificationTypeId/.test(e)));
  assert.ok(missing.errors.some((e) => /roleId/.test(e)));
});

test("validateRequirementInput rejects a bad enforcementMode but allows null", () => {
  assert.equal(validateRequirementInput({ certificationTypeId: "c", roleId: "r", enforcementMode: null }).valid, true);
  assert.equal(validateRequirementInput({ certificationTypeId: "c", roleId: "r", enforcementMode: "warning" }).valid, true);
  assert.equal(validateRequirementInput({ certificationTypeId: "c", roleId: "r", enforcementMode: "soft" }).valid, false);
});

test("validatePolicyInput enforces the trigger_type enum and object shapes", () => {
  assert.equal(validatePolicyInput({ triggerType: "expiry" }).valid, true);
  assert.equal(validatePolicyInput({ triggerType: "nope" }).valid, false);
  assert.equal(validatePolicyInput({ triggerType: "expiry", cadenceRule: [] }).valid, false);
  assert.equal(validatePolicyInput({ triggerType: "expiry", action: "x" }).valid, false);
  assert.equal(validatePolicyInput({ triggerType: "schedule", cadenceRule: { daysBefore: [30] } }).valid, true);
});

test("requirementsForRole filters by role_id (snake or camel)", () => {
  const reqs = [
    { role_id: "r1", certification_type_id: "c1" },
    { roleId: "r1", certification_type_id: "c2" },
    { role_id: "r2", certification_type_id: "c3" }
  ];
  assert.equal(requirementsForRole(reqs, "r1").length, 2);
  assert.equal(requirementsForRole(reqs, "r2").length, 1);
});

test("effectiveEnforcementMode: requirement override wins, else registry setting", () => {
  // Requirement names its own mode -> that wins regardless of config.
  assert.equal(
    effectiveEnforcementMode({ enforcement_mode: "warning" }, { "scheduling.certEnforcementMode": "hard-block" }),
    "warning"
  );
  // Requirement silent -> the facility registry mode applies.
  assert.equal(
    effectiveEnforcementMode({ enforcement_mode: null }, { "scheduling.certEnforcementMode": "warning" }),
    "warning"
  );
  // Requirement silent, config unset -> the registry default (hard-block).
  assert.equal(effectiveEnforcementMode({}, {}), "hard-block");
});

test("certGaps reports missing, expired, and expiring statuses", () => {
  const today = new Date("2026-07-12T00:00:00Z");
  const requirements = [
    { certification_type_id: "cpr", role_id: "r1", enforcement_mode: "hard-block" },
    { certification_type_id: "lifeguard", role_id: "r1", enforcement_mode: "warning" },
    { certification_type_id: "first_aid", role_id: "r1" },
    { certification_type_id: "swim", role_id: "r1" }
  ];
  const employeeCerts = [
    // cpr: not held -> missing
    // lifeguard: expired last month
    { certification_type_id: "lifeguard", status: "active", expires_at: "2026-06-01" },
    // first_aid: expiring within the default 30-day window (training.mjs)
    { certification_type_id: "first_aid", status: "active", expires_at: "2026-07-20" },
    // swim: valid far in the future -> no gap
    { certification_type_id: "swim", status: "active", expires_at: "2027-01-01" }
  ];
  const gaps = certGaps(employeeCerts, requirements, today);
  const byType = Object.fromEntries(gaps.map((g) => [g.certificationTypeId, g]));

  assert.equal(byType.cpr.status, "missing");
  assert.equal(byType.cpr.enforcement, "hard-block");
  assert.equal(byType.lifeguard.status, "expired");
  assert.equal(byType.lifeguard.enforcement, "warning");
  assert.equal(byType.first_aid.status, "expiring");
  // swim is valid -> not present.
  assert.equal(byType.swim, undefined);
  assert.equal(gaps.length, 3);
});

test("certGaps skips inactive requirements and treats revoked as expired", () => {
  const today = new Date("2026-07-12T00:00:00Z");
  const requirements = [
    { certification_type_id: "cpr", role_id: "r1", active: false },
    { certification_type_id: "aed", role_id: "r1" }
  ];
  const employeeCerts = [{ certification_type_id: "aed", status: "revoked", expires_at: "2028-01-01" }];
  const gaps = certGaps(employeeCerts, requirements, today);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].certificationTypeId, "aed");
  assert.equal(gaps[0].status, "expired");
});
