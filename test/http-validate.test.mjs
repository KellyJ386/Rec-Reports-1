import test from "node:test";
import assert from "node:assert/strict";
import { validateModuleTogglePayload } from "../src/lib/http/validate.mjs";

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
