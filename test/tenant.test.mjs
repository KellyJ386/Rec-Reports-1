import test from "node:test";
import assert from "node:assert/strict";
import { sameFacility } from "../src/lib/tenant.mjs";

test("sameFacility returns true when every ref shares the facility", () => {
  assert.equal(sameFacility([{ facilityId: "facility-a" }, { facilityId: "facility-a" }], "facility-a"), true);
});

test("sameFacility returns false when one ref belongs to another facility", () => {
  assert.equal(sameFacility([{ facilityId: "facility-a" }, { facilityId: "facility-b" }], "facility-a"), false);
});

test("sameFacility allows null and undefined refs", () => {
  assert.equal(sameFacility([null, { facilityId: "facility-a" }, undefined], "facility-a"), true);
});

test("sameFacility returns true for an empty ref list", () => {
  assert.equal(sameFacility([], "facility-a"), true);
});
