import test from "node:test";
import assert from "node:assert/strict";
import {
  requirePermission,
  requireOrgAdmin,
  requireAuthPermission,
  authCanAccessFacility,
  requireAuthOrgAdmin
} from "../src/lib/http/guard.mjs";

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

test("requireAuthPermission honors the platform super-admin bypass", () => {
  const auth = { memberships: [], platformAdmin: true };
  const result = requireAuthPermission(auth, "facility-z", "admin.manage");
  assert.deepEqual(result, { allowed: true, reason: null });
});

test("requireAuthPermission falls back to membership scoping without the flag", () => {
  const auth = { memberships: activeAdmin };
  assert.equal(requireAuthPermission(auth, "facility-a", "admin.manage").allowed, true);
  assert.equal(requireAuthPermission(auth, "facility-b", "admin.manage").allowed, false);
  assert.equal(requireAuthPermission({ memberships: [] }, "facility-a", "admin.manage").allowed, false);
});

test("requireAuthPermission still requires a facility id and code for platform admins", () => {
  const auth = { memberships: [], platformAdmin: true };
  assert.equal(requireAuthPermission(auth, null, "admin.manage").allowed, false);
  assert.equal(requireAuthPermission(auth, "facility-a", null).allowed, false);
});

test("requireAuthPermission ignores a non-boolean platformAdmin value", () => {
  const auth = { memberships: [], platformAdmin: "yes" };
  assert.equal(requireAuthPermission(auth, "facility-a", "admin.manage").allowed, false);
});

test("authCanAccessFacility honors the bypass and falls back to memberships", () => {
  assert.equal(authCanAccessFacility({ memberships: [], platformAdmin: true }, "facility-z"), true);
  assert.equal(authCanAccessFacility({ memberships: activeAdmin }, "facility-a"), true);
  assert.equal(authCanAccessFacility({ memberships: activeAdmin }, "facility-b"), false);
});

test("requireAuthOrgAdmin honors the bypass even with no facilities", () => {
  assert.equal(requireAuthOrgAdmin({ memberships: [], platformAdmin: true }, []).allowed, true);
  assert.equal(requireAuthOrgAdmin({ memberships: activeAdmin }, ["facility-a"]).allowed, true);
  assert.equal(requireAuthOrgAdmin({ memberships: activeAdmin }, ["facility-b"]).allowed, false);
});
