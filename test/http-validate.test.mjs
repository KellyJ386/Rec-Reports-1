import test from "node:test";
import assert from "node:assert/strict";
import {
  validateModuleTogglePayload,
  validateMembershipInput,
  validateMembershipPatch
} from "../src/lib/http/validate.mjs";

test("validateModuleTogglePayload accepts enabled with no configPatch", () => {
  assert.deepEqual(validateModuleTogglePayload({ enabled: true }), { valid: true, errors: [] });
});

test("validateModuleTogglePayload accepts enabled with a plain-object configPatch", () => {
  assert.deepEqual(validateModuleTogglePayload({ enabled: false, configPatch: { dueHour: 18 } }), {
    valid: true,
    errors: []
  });
});

test("validateModuleTogglePayload rejects a missing enabled field", () => {
  const result = validateModuleTogglePayload({ configPatch: {} });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("enabled")));
});

test("validateModuleTogglePayload rejects a non-boolean enabled field", () => {
  const result = validateModuleTogglePayload({ enabled: "true" });
  assert.equal(result.valid, false);
});

test("validateModuleTogglePayload rejects a non-object configPatch", () => {
  const arrayResult = validateModuleTogglePayload({ enabled: true, configPatch: ["a"] });
  assert.equal(arrayResult.valid, false);
  const stringResult = validateModuleTogglePayload({ enabled: true, configPatch: "nope" });
  assert.equal(stringResult.valid, false);
  const nullResult = validateModuleTogglePayload({ enabled: true, configPatch: null });
  assert.equal(nullResult.valid, false);
});

test("validateModuleTogglePayload rejects a non-object payload", () => {
  assert.equal(validateModuleTogglePayload(null).valid, false);
  assert.equal(validateModuleTogglePayload("nope").valid, false);
  assert.equal(validateModuleTogglePayload([]).valid, false);
});

// --- Membership department scope (0023) -------------------------------------

test("validateMembershipInput accepts an optional departmentId", () => {
  const base = { userId: "user-1", roleId: "role-1" };
  assert.equal(validateMembershipInput(base).valid, true);
  assert.equal(validateMembershipInput({ ...base, departmentId: "dept-1" }).valid, true);
  assert.equal(validateMembershipInput({ ...base, departmentId: null }).valid, true);
});

test("validateMembershipInput rejects a non-string departmentId", () => {
  const result = validateMembershipInput({ userId: "user-1", roleId: "role-1", departmentId: 7 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /departmentId/.test(error)));
});

test("validateMembershipPatch accepts a departmentId-only patch, including explicit null", () => {
  assert.equal(validateMembershipPatch({ departmentId: "dept-1" }).valid, true);
  assert.equal(validateMembershipPatch({ departmentId: null }).valid, true);
});

test("validateMembershipPatch still rejects an empty patch", () => {
  const result = validateMembershipPatch({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /at least one/.test(error)));
});
