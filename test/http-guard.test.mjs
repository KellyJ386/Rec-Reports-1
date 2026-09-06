import test from "node:test";
import assert from "node:assert/strict";
import {
  requirePermission,
  requireOrgAdmin,
  requireAuthPermission,
  authCanAccessFacility,
  requireAuthOrgAdmin,
  requireAuthOrgAdminRow,
  makeGuards,
  parseListLimitOffset
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

// --- makeGuards (P-12) -------------------------------------------------
// Every route module used to hand-roll withAuth/requirePerm/requireRead/
// requireMember/parseJsonBody/queryParams over the same three injected
// primitives; these exercise the shared factory directly rather than
// through any one route module.

function sinkSendJson() {
  const sent = [];
  const sendJson = (response, status, payload) => {
    sent.push({ status, payload });
    return sent[sent.length - 1];
  };
  return { sent, sendJson };
}

test("makeGuards().withAuth sends the auth error and never calls the handler on a 401", async () => {
  const { sent, sendJson } = sinkSendJson();
  const authenticate = async () => ({ error: { status: 401, body: { error: "invalid or expired token" } } });
  const { withAuth } = makeGuards({ authenticate, sendJson, readBody: async () => "{}" });
  let handlerCalled = false;
  await withAuth({}, {}, {}, async () => {
    handlerCalled = true;
  });
  assert.equal(handlerCalled, false);
  assert.deepEqual(sent, [{ status: 401, payload: { error: "invalid or expired token" } }]);
});

test("makeGuards().withAuth calls the handler with the resolved auth on success", async () => {
  const { sendJson } = sinkSendJson();
  const auth = { claims: { sub: "user-1" }, memberships: [], error: null };
  const authenticate = async () => auth;
  const { withAuth } = makeGuards({ authenticate, sendJson, readBody: async () => "{}" });
  let received;
  const result = await withAuth({}, {}, {}, async (a) => {
    received = a;
    return "handler-result";
  });
  assert.equal(received, auth);
  assert.equal(result, "handler-result");
});

test("makeGuards().requirePerm denies with 403 {error: reason} when the permission is missing", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requirePerm } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const auth = { memberships: [{ facilityId: "fac-1", status: "active", permissions: [] }] };
  const allowed = requirePerm(auth, "fac-1", "reports.read", {});
  assert.equal(allowed, false);
  assert.equal(sent[0].status, 403);
  assert.match(sent[0].payload.error, /reports\.read/);
});

test("makeGuards().requirePerm allows and sends nothing when the permission is held", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requirePerm } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const auth = { memberships: [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }] };
  const allowed = requirePerm(auth, "fac-1", "reports.read", {});
  assert.equal(allowed, true);
  assert.equal(sent.length, 0);
});

test("makeGuards().requirePerm honors notFoundOnDeny/notFoundMessage (attachments-routes.mjs's option)", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requirePerm } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const auth = { memberships: [] };
  const allowed = requirePerm(auth, "fac-1", "attachments.read", {}, {
    notFoundOnDeny: true,
    notFoundMessage: "attachment not found"
  });
  assert.equal(allowed, false);
  assert.deepEqual(sent, [{ status: 404, payload: { error: "attachment not found" } }]);
});

test("makeGuards().requirePerm defaults notFoundMessage to 'not found' when notFoundOnDeny is set without one", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requirePerm } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const allowed = requirePerm({ memberships: [] }, "fac-1", "x.read", {}, { notFoundOnDeny: true });
  assert.equal(allowed, false);
  assert.deepEqual(sent, [{ status: 404, payload: { error: "not found" } }]);
});

test("makeGuards().requireRead(code) bakes the permission code into a requirePerm-shaped guard", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requireRead } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const communicationsRead = requireRead("communications.read");
  const denied = { memberships: [] };
  const allowed = { memberships: [{ facilityId: "fac-1", status: "active", permissions: ["communications.read"] }] };
  assert.equal(communicationsRead(denied, "fac-1", {}), false);
  assert.equal(sent[0].status, 403);
  assert.match(sent[0].payload.error, /communications\.read/);
  assert.equal(communicationsRead(allowed, "fac-1", {}), true);
});

test("makeGuards().requireMember denies with 403 for a non-member of the facility", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requireMember } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const auth = { memberships: [{ facilityId: "fac-2", status: "active", permissions: [] }] };
  assert.equal(requireMember(auth, "fac-1", {}), false);
  assert.deepEqual(sent, [{ status: 403, payload: { error: "not a member of this facility" } }]);
});

test("makeGuards().requireMember allows a member of the facility", () => {
  const { sent, sendJson } = sinkSendJson();
  const { requireMember } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const auth = { memberships: [{ facilityId: "fac-1", status: "active", permissions: [] }] };
  assert.equal(requireMember(auth, "fac-1", {}), true);
  assert.equal(sent.length, 0);
});

test("makeGuards().parseJsonBody returns 400-shaped {ok:false} on invalid JSON", async () => {
  const { sendJson } = sinkSendJson();
  const { parseJsonBody } = makeGuards({ authenticate: null, sendJson, readBody: async () => "not json" });
  const result = await parseJsonBody({});
  assert.deepEqual(result, { ok: false });
});

test("makeGuards().parseJsonBody parses a valid JSON body", async () => {
  const { sendJson } = sinkSendJson();
  const { parseJsonBody } = makeGuards({
    authenticate: null,
    sendJson,
    readBody: async () => JSON.stringify({ name: "x" })
  });
  const result = await parseJsonBody({});
  assert.deepEqual(result, { ok: true, payload: { name: "x" } });
});

test("makeGuards().parseJsonBody defaults an empty body to {}", async () => {
  const { sendJson } = sinkSendJson();
  const { parseJsonBody } = makeGuards({ authenticate: null, sendJson, readBody: async () => "" });
  const result = await parseJsonBody({});
  assert.deepEqual(result, { ok: true, payload: {} });
});

test("makeGuards().queryParams parses the request URL's search params", () => {
  const { sendJson } = sinkSendJson();
  const { queryParams } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const qp = queryParams({ url: "/facilities/fac-1/reports?status=submitted&limit=10" });
  assert.equal(qp.get("status"), "submitted");
  assert.equal(qp.get("limit"), "10");
});

test("makeGuards().queryParams falls back to '/' when the request has no url", () => {
  const { sendJson } = sinkSendJson();
  const { queryParams } = makeGuards({ authenticate: null, sendJson, readBody: null });
  const qp = queryParams({});
  assert.equal(qp.toString(), "");
});

// --- parseListLimitOffset (P-12) ----------------------------------------

test("parseListLimitOffset defaults limit and offset when neither is given", () => {
  const qp = new URLSearchParams("");
  assert.deepEqual(parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 }), {
    ok: true,
    limit: 50,
    offset: 0
  });
});

test("parseListLimitOffset passes a limit under the cap through unchanged", () => {
  const qp = new URLSearchParams("limit=10");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.deepEqual(result, { ok: true, limit: 10, offset: 0 });
});

test("parseListLimitOffset clamps a limit above the cap down to maxLimit", () => {
  const qp = new URLSearchParams("limit=9000");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.deepEqual(result, { ok: true, limit: 200, offset: 0 });
});

test("parseListLimitOffset accepts a limit exactly at the cap", () => {
  const qp = new URLSearchParams("limit=200");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.limit, 200);
});

test("parseListLimitOffset rejects limit=0 with the reconciled single-field error shape", () => {
  const qp = new URLSearchParams("limit=0");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.deepEqual(result, { ok: false, error: "limit must be a positive integer" });
});

test("parseListLimitOffset rejects a negative limit", () => {
  const qp = new URLSearchParams("limit=-5");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "limit must be a positive integer");
});

test("parseListLimitOffset rejects a non-integer limit", () => {
  const qp = new URLSearchParams("limit=abc");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "limit must be a positive integer");
});

test("parseListLimitOffset accepts offset=0 explicitly", () => {
  const qp = new URLSearchParams("offset=0");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.deepEqual(result, { ok: true, limit: 50, offset: 0 });
});

test("parseListLimitOffset passes a positive offset through", () => {
  const qp = new URLSearchParams("offset=40");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.deepEqual(result, { ok: true, limit: 50, offset: 40 });
});

test("parseListLimitOffset rejects a negative offset", () => {
  const qp = new URLSearchParams("offset=-1");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.deepEqual(result, { ok: false, error: "offset must be a non-negative integer" });
});

test("parseListLimitOffset rejects a non-integer offset", () => {
  const qp = new URLSearchParams("offset=abc");
  const result = parseListLimitOffset(qp, { defaultLimit: 50, maxLimit: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "offset must be a non-negative integer");
});

test("parseListLimitOffset uses the caller-supplied defaultLimit/maxLimit", () => {
  const qp = new URLSearchParams("limit=500");
  const result = parseListLimitOffset(qp, { defaultLimit: 20, maxLimit: 100 });
  assert.deepEqual(result, { ok: true, limit: 100, offset: 0 });
  const unspecified = parseListLimitOffset(new URLSearchParams(""), { defaultLimit: 20, maxLimit: 100 });
  assert.equal(unspecified.limit, 20);
});
