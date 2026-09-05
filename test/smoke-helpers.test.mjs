import { test } from "node:test";
import assert from "node:assert";
import { assertStep } from "../scripts/smoke.mjs";

test("assertStep returns true when condition is true", () => {
  const result = assertStep("test name", true, "");
  assert.strictEqual(result, true);
});

test("assertStep returns false when condition is false", () => {
  const result = assertStep("test name", false, "error detail");
  assert.strictEqual(result, false);
});

test("assertStep handles falsy conditions correctly", () => {
  assert.strictEqual(assertStep("test 1", 0, "zero"), false);
  assert.strictEqual(assertStep("test 2", "", "empty string"), false);
  assert.strictEqual(assertStep("test 3", null, "null"), false);
  assert.strictEqual(assertStep("test 4", undefined, "undefined"), false);
});

test("assertStep handles truthy conditions correctly", () => {
  assert.strictEqual(assertStep("test 1", 1, ""), true);
  assert.strictEqual(assertStep("test 2", "message", ""), true);
  assert.strictEqual(assertStep("test 3", true, ""), true);
  assert.strictEqual(assertStep("test 4", {}, ""), true);
});
