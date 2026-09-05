import test from "node:test";
import assert from "node:assert/strict";
import { resolveInitialFacility } from "../src/public/js/facility-context.mjs";

const facilities = [
  { id: "f1", name: "Pool A" },
  { id: "f2", name: "Pool B" },
  { id: "f3", name: "Pool C" }
];

test("resolveInitialFacility restores the stored facility when it is still in the list", () => {
  assert.equal(resolveInitialFacility("f2", facilities), "f2");
});

test("resolveInitialFacility falls back to the first facility when nothing is stored", () => {
  assert.equal(resolveInitialFacility(null, facilities), "f1");
  assert.equal(resolveInitialFacility(undefined, facilities), "f1");
  assert.equal(resolveInitialFacility("", facilities), "f1");
});

test("resolveInitialFacility falls back to the first facility when the stored id is stale", () => {
  assert.equal(resolveInitialFacility("no-longer-a-member", facilities), "f1");
});

test("resolveInitialFacility returns null when there are no facilities at all", () => {
  assert.equal(resolveInitialFacility("f1", []), null);
  assert.equal(resolveInitialFacility(null, []), null);
  assert.equal(resolveInitialFacility("f1", undefined), null);
  assert.equal(resolveInitialFacility("f1", null), null);
});

test("resolveInitialFacility ignores a non-string stored id", () => {
  assert.equal(resolveInitialFacility(42, facilities), "f1");
  assert.equal(resolveInitialFacility({}, facilities), "f1");
});
