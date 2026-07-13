import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canAccessFacility, hasPermission, hasDepartmentPermission, permissions } from "../src/lib/permissions.mjs";

const memberships = [
  {
    facilityId: "north-arena",
    role: "Supervisor",
    status: "active",
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

test("hasPermission returns false for a membership that is not active", () => {
  const invited = [
    {
      facilityId: "north-arena",
      role: "Supervisor",
      status: "invited",
      permissions: ["reports.read", "reports.submit", "schedule.read"]
    }
  ];
  const disabled = [
    {
      facilityId: "north-arena",
      role: "Supervisor",
      status: "disabled",
      permissions: ["reports.read", "reports.submit", "schedule.read"]
    }
  ];
  assert.equal(hasPermission(invited, "north-arena", "reports.read"), false);
  assert.equal(hasPermission(disabled, "north-arena", "reports.read"), false);
});

test("canAccessFacility returns false for a membership that is not active", () => {
  const invited = [{ facilityId: "north-arena", role: "Supervisor", status: "invited", permissions: [] }];
  assert.equal(canAccessFacility(invited, "north-arena"), false);
});

test("permissions array matches the permission codes seeded in supabase/seed.sql", () => {
  const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  const insertMatch = seedSql.match(/insert into permissions \(code, description\) values([\s\S]*?)\non conflict \(code\) do nothing;/);
  assert.ok(insertMatch, "expected a permissions insert block in seed.sql");
  const codeMatches = [...insertMatch[1].matchAll(/\(\s*'([^']+)'\s*,/g)].map((match) => match[1]);
  const seedCodes = [...new Set(codeMatches)].sort();
  const libCodes = [...permissions].sort();
  assert.deepEqual(libCodes, seedCodes);
});

// --- Department scoping (0023) ---------------------------------------------

const deptScoped = [
  {
    facilityId: "north-arena",
    departmentId: "dept-aquatics",
    status: "active",
    permissions: ["admin.manage"]
  }
];

test("hasPermission excludes department-scoped memberships at facility scope", () => {
  assert.equal(hasPermission(deptScoped, "north-arena", "admin.manage"), false);
});

test("hasPermission still passes facility-wide memberships (null or absent departmentId)", () => {
  const explicitNull = [
    { facilityId: "north-arena", departmentId: null, status: "active", permissions: ["admin.manage"] }
  ];
  assert.equal(hasPermission(explicitNull, "north-arena", "admin.manage"), true);
});

test("hasDepartmentPermission grants a department-scoped membership its own department only", () => {
  assert.equal(hasDepartmentPermission(deptScoped, "north-arena", "dept-aquatics", "admin.manage"), true);
  assert.equal(hasDepartmentPermission(deptScoped, "north-arena", "dept-fitness", "admin.manage"), false);
  assert.equal(hasDepartmentPermission(deptScoped, "south-arena", "dept-aquatics", "admin.manage"), false);
});

test("hasDepartmentPermission grants facility-wide memberships every department", () => {
  const facilityWide = [
    { facilityId: "north-arena", status: "active", permissions: ["admin.manage"] }
  ];
  assert.equal(hasDepartmentPermission(facilityWide, "north-arena", "dept-aquatics", "admin.manage"), true);
  assert.equal(hasDepartmentPermission(facilityWide, "north-arena", "dept-fitness", "admin.manage"), true);
});

test("canAccessFacility treats department-scoped members as facility members", () => {
  assert.equal(canAccessFacility(deptScoped, "north-arena"), true);
});
