import test from "node:test";
import assert from "node:assert/strict";
import { requirePermission, requireOrgAdmin } from "../src/lib/http/guard.mjs";

const activeAdmin = [
  { facilityId: "facility-a", status: "active", permissions: ["admin.manage", "reports.read"] }
];

test("requirePermission denies when the membership is missing the code", () => {
  const result = requirePermission(activeAdmin, "facility-a", "schedule.manage");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /schedule\.manage/);
});

test("requirePermission denies an inactive membership even with the code", () => {
  const invited = [
    { facilityId: "facility-a", status: "invited", permissions: ["admin.manage"] }
  ];
  const result = requirePermission(invited, "facility-a", "admin.manage");
  assert.equal(result.allowed, false);
});

test("requirePermission allows an active membership holding the code", () => {
  const result = requirePermission(activeAdmin, "facility-a", "admin.manage");
  assert.deepEqual(result, { allowed: true, reason: null });
});

test("requirePermission denies when facilityId or code is missing", () => {
  assert.equal(requirePermission(activeAdmin, null, "admin.manage").allowed, false);
  assert.equal(requirePermission(activeAdmin, "facility-a", null).allowed, false);
});

test("requireOrgAdmin denies when no facility in the org grants admin.manage", () => {
  const result = requireOrgAdmin(activeAdmin, ["facility-b", "facility-c"]);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /admin\.manage/);
});

test("requireOrgAdmin denies an inactive membership", () => {
  const invited = [
    { facilityId: "facility-a", status: "invited", permissions: ["admin.manage"] }
  ];
  assert.equal(requireOrgAdmin(invited, ["facility-a"]).allowed, false);
});

test("requireOrgAdmin allows a membership holding admin.manage in any org facility", () => {
  const result = requireOrgAdmin(activeAdmin, ["facility-x", "facility-a"]);
  assert.deepEqual(result, { allowed: true, reason: null });
});

test("requireOrgAdmin denies an organization with no facilities", () => {
  assert.equal(requireOrgAdmin(activeAdmin, []).allowed, false);
});
