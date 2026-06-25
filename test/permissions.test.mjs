import test from "node:test";
import assert from "node:assert/strict";
import { canAccessFacility, hasPermission } from "../src/lib/permissions.mjs";

const memberships = [
  {
    facilityId: "north-arena",
    role: "Supervisor",
    permissions: ["reports.read", "reports.submit", "schedule.read"]
  }
];

test("tenant helpers allow access to a member facility", () => {
  assert.equal(canAccessFacility(memberships, "north-arena"), true);
});

test("tenant helpers block cross-facility access", () => {
  assert.equal(canAccessFacility(memberships, "riverfront-aquatics"), false);
  assert.equal(hasPermission(memberships, "riverfront-aquatics", "reports.read"), false);
});

test("tenant helpers require the exact permission in the active facility", () => {
  assert.equal(hasPermission(memberships, "north-arena", "reports.submit"), true);
  assert.equal(hasPermission(memberships, "north-arena", "admin.manage"), false);
});
