import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEffectivePermissions,
  validateRoleGrant,
  diffRolePermissions,
  simulateAccess
} from "../src/lib/admin/rbac.mjs";
import { permissions, hasPermission } from "../src/lib/permissions.mjs";

const MEMBERSHIPS = [
  { facilityId: "fac-1", status: "active", permissions: ["reports.read", "reports.create"] },
  { facilityId: "fac-1", status: "active", permissions: ["reports.read", "admin.manage"] },
  { facilityId: "fac-1", status: "disabled", permissions: ["work_orders.manage"] },
  { facilityId: "fac-2", status: "active", permissions: ["incidents.manage"] }
];

test("computeEffectivePermissions unions active memberships for the facility", () => {
  const effective = computeEffectivePermissions(MEMBERSHIPS, "fac-1").sort();
  assert.deepEqual(effective, ["admin.manage", "reports.create", "reports.read"]);
});

test("computeEffectivePermissions ignores inactive memberships", () => {
  // work_orders.manage lives only on a disabled membership -> excluded.
  assert.ok(!computeEffectivePermissions(MEMBERSHIPS, "fac-1").includes("work_orders.manage"));
});

test("computeEffectivePermissions scopes strictly to the facility", () => {
  assert.deepEqual(computeEffectivePermissions(MEMBERSHIPS, "fac-2"), ["incidents.manage"]);
});

test("computeEffectivePermissions returns empty for an unknown facility", () => {
  assert.deepEqual(computeEffectivePermissions(MEMBERSHIPS, "fac-none"), []);
});

test("validateRoleGrant accepts a named role with catalog codes", () => {
  const result = validateRoleGrant({ name: "Ops" }, ["reports.read", "admin.manage"]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateRoleGrant rejects an unknown permission code", () => {
  const result = validateRoleGrant({ name: "Ops" }, ["reports.read", "reports.destroy"]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("reports.destroy")));
});

test("validateRoleGrant rejects an empty name", () => {
  const result = validateRoleGrant({ name: "   " }, ["reports.read"]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("validateRoleGrant accepts a bare-string role name", () => {
  assert.equal(validateRoleGrant("Auditor", []).valid, true);
});

test("validateRoleGrant rejects a non-array permission list", () => {
  const result = validateRoleGrant({ name: "Ops" }, "reports.read");
  assert.equal(result.valid, false);
});

test("diffRolePermissions splits into granted and revoked", () => {
  const { granted, revoked } = diffRolePermissions(
    ["reports.read", "reports.create"],
    ["reports.read", "admin.manage"]
  );
  assert.deepEqual(granted, ["admin.manage"]);
  assert.deepEqual(revoked, ["reports.create"]);
});

test("diffRolePermissions handles missing sides", () => {
  assert.deepEqual(diffRolePermissions(undefined, ["a"]), { granted: ["a"], revoked: [] });
  assert.deepEqual(diffRolePermissions(["a"], undefined), { granted: [], revoked: ["a"] });
});

test("simulateAccess returns granted for an active membership with the code", () => {
  assert.deepEqual(simulateAccess(MEMBERSHIPS, "fac-1", "admin.manage"), {
    allowed: true,
    reason: "granted"
  });
});

test("simulateAccess returns permission-missing when active but ungranted", () => {
  assert.deepEqual(simulateAccess(MEMBERSHIPS, "fac-1", "training.manage"), {
    allowed: false,
    reason: "permission-missing"
  });
});

test("simulateAccess returns membership-inactive when only inactive memberships exist", () => {
  const memberships = [{ facilityId: "fac-x", status: "disabled", permissions: ["reports.read"] }];
  assert.deepEqual(simulateAccess(memberships, "fac-x", "reports.read"), {
    allowed: false,
    reason: "membership-inactive"
  });
});

test("simulateAccess returns no-membership when the user has none in the facility", () => {
  assert.deepEqual(simulateAccess(MEMBERSHIPS, "fac-none", "reports.read"), {
    allowed: false,
    reason: "no-membership"
  });
});

test("simulateAccess.allowed equals hasPermission for every catalog code and fixture", () => {
  const fixtures = [
    { memberships: MEMBERSHIPS, facilityId: "fac-1" },
    { memberships: MEMBERSHIPS, facilityId: "fac-2" },
    { memberships: MEMBERSHIPS, facilityId: "fac-none" },
    { memberships: [{ facilityId: "fac-1", status: "disabled", permissions: ["admin.manage"] }], facilityId: "fac-1" },
    { memberships: [], facilityId: "fac-1" }
  ];
  for (const { memberships, facilityId } of fixtures) {
    for (const code of permissions) {
      const simulated = simulateAccess(memberships, facilityId, code).allowed;
      const server = hasPermission(memberships, facilityId, code);
      assert.equal(
        simulated,
        server,
        `mismatch for ${facilityId} / ${code}: simulator=${simulated} hasPermission=${server}`
      );
    }
  }
});
