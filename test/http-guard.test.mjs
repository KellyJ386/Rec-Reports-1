import test from "node:test";
import assert from "node:assert/strict";
import {
  requirePermission,
  requireOrgAdmin,
  requireAuthPermission,
  authCanAccessFacility,
  requireAuthOrgAdmin,
  requireAuthOrgAdminRow
} from "../src/lib/http/guard.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

// requireAuthOrgAdminRow queries organization_admins over PostgREST via
// auth.client; stub global.fetch the same way the route tests do, keyed by
// table + method so a test can hand back a row (allowed) or none (denied).
function stubOrgAdminsFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    captured.push({ table, method: init.method, url: parsed });
    const data = respond(table, init.method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function fakeAuth(userId) {
  return {
    claims: { sub: userId },
    client: createClient({ url: "https://example.supabase.co", key: "service-key" })
  };
}

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

// --- requireAuthOrgAdminRow (S-6, matches the actual SQL rule: 0019 requires
// an explicit organization_admins row, not admin.manage on any org facility) -

test("requireAuthOrgAdminRow honors the platform super-admin bypass without querying the DB", async (t) => {
  const captured = stubOrgAdminsFetch(t, () => {
    throw new Error("must not query organization_admins for a platform admin");
  });
  const auth = { ...fakeAuth("user-1"), platformAdmin: true };
  const result = await requireAuthOrgAdminRow(auth, "org-1");
  assert.deepEqual(result, { allowed: true, reason: null });
  assert.equal(captured.length, 0);
});

test("requireAuthOrgAdminRow denies when organization id is missing", async (t) => {
  stubOrgAdminsFetch(t, () => []);
  const result = await requireAuthOrgAdminRow(fakeAuth("user-1"), null);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /organization id/);
});

test("requireAuthOrgAdminRow allows a caller with an organization_admins row", async (t) => {
  const captured = stubOrgAdminsFetch(t, (table, method, url) => {
    if (table === "organization_admins" && method === "GET") {
      assert.equal(url.searchParams.get("organization_id"), "eq.org-1");
      assert.equal(url.searchParams.get("user_id"), "eq.user-1");
      return [{ id: "oa-1" }];
    }
    return [];
  });
  const result = await requireAuthOrgAdminRow(fakeAuth("user-1"), "org-1");
  assert.deepEqual(result, { allowed: true, reason: null });
  assert.equal(captured.length, 1);
});

test("requireAuthOrgAdminRow denies a member with admin.manage but no organization_admins row", async (t) => {
  stubOrgAdminsFetch(t, () => []);
  const result = await requireAuthOrgAdminRow(fakeAuth("user-1"), "org-1");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /organization_admins/);
});
