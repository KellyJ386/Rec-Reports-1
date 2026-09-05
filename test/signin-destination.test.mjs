import test from "node:test";
import assert from "node:assert/strict";
import { chooseDestination, isSafeNextPath } from "../src/public/signin/destination.js";

test("isSafeNextPath accepts only same-origin, path-only values", () => {
  assert.equal(isSafeNextPath("/admin/facilities"), true);
  assert.equal(isSafeNextPath("/"), true);

  assert.equal(isSafeNextPath(null), false);
  assert.equal(isSafeNextPath(undefined), false);
  assert.equal(isSafeNextPath(""), false);
  assert.equal(isSafeNextPath("admin"), false, "relative path without a leading slash");
  assert.equal(isSafeNextPath("//evil.example.com/"), false, "protocol-relative URL");
  assert.equal(isSafeNextPath("https://evil.example.com/"), false, "absolute URL");
});

test("chooseDestination honours a valid next param over everything else", () => {
  const meResponse = { facilities: [{ id: "f1", permissions: ["reports.read"] }] };
  assert.equal(chooseDestination("/admin/facilities", meResponse), "/admin/facilities");
  assert.equal(chooseDestination("/admin/facilities", null), "/admin/facilities");
});

test("chooseDestination ignores an unsafe next param and falls through to /me", () => {
  const meResponse = { facilities: [{ id: "f1", permissions: ["reports.read"] }] };
  assert.equal(chooseDestination("https://evil.example.com/", meResponse), "/");
  assert.equal(chooseDestination("//evil.example.com/", meResponse), "/");
});

test("chooseDestination sends an operational user to the ops app", () => {
  const meResponse = {
    platformAdmin: false,
    facilities: [{ id: "f1", name: "Pool A", permissions: ["reports.read", "reports.create"] }]
  };
  assert.equal(chooseDestination(null, meResponse), "/");
});

test("chooseDestination sends a user with only admin permissions to the admin console", () => {
  const meResponse = {
    platformAdmin: false,
    facilities: [{ id: "f1", name: "Pool A", permissions: ["admin.manage"] }]
  };
  assert.equal(chooseDestination(null, meResponse), "/admin/");
});

test("chooseDestination sends a user with no facilities at all to the admin console", () => {
  const meResponse = { platformAdmin: false, facilities: [] };
  assert.equal(chooseDestination(undefined, meResponse), "/admin/");
});

test("chooseDestination sends a platform admin with no operational permissions to the admin console", () => {
  // A platform admin sees every facility (me-route.mjs) but only has real
  // permissions where they hold an actual membership -- facilities with no
  // membership come back with an empty permissions array.
  const meResponse = {
    platformAdmin: true,
    facilities: [
      { id: "f1", name: "Pool A", permissions: [] },
      { id: "f2", name: "Pool B", permissions: ["admin.manage"] }
    ]
  };
  assert.equal(chooseDestination(null, meResponse), "/admin/");
});

test("chooseDestination sends a platform admin who also holds operational permissions to the ops app", () => {
  const meResponse = {
    platformAdmin: true,
    facilities: [{ id: "f1", name: "Pool A", permissions: ["admin.manage", "reports.read"] }]
  };
  assert.equal(chooseDestination(null, meResponse), "/");
});

test("chooseDestination checks across all facilities, not just the first", () => {
  const meResponse = {
    facilities: [
      { id: "f1", permissions: ["admin.manage"] },
      { id: "f2", permissions: ["work_orders.read"] }
    ]
  };
  assert.equal(chooseDestination(null, meResponse), "/");
});

test("chooseDestination falls back to the ops app when the /me lookup failed", () => {
  assert.equal(chooseDestination(null, null), "/");
  assert.equal(chooseDestination(undefined, undefined), "/");
});

test("chooseDestination tolerates a malformed /me response", () => {
  assert.equal(chooseDestination(null, {}), "/admin/");
  assert.equal(chooseDestination(null, { facilities: "not-an-array" }), "/admin/");
  assert.equal(
    chooseDestination(null, { facilities: [{ id: "f1", permissions: "not-an-array" }] }),
    "/admin/"
  );
});
