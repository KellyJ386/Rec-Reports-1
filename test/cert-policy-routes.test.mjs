import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerCertPolicyRoutes } from "../src/lib/http/cert-policy-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["training.manage"] }];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["training.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["training.manage"] }];

// Grants the cert_policies entitlement to the facility's org so write guards pass.
function entitled(table, method) {
  if (table === "facilities" && method === "GET") return [{ organization_id: "org-1" }];
  if (table === "tenant_subscriptions" && method === "GET") return [{ id: "sub-1", plan_id: "plan-1" }];
  if (table === "subscription_plans" && method === "GET") {
    return [{ id: "plan-1", feature_entitlements_jsonb: { cert_policies: true } }];
  }
  return null;
}

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null });
    const data = respond(table, method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function withEntitlement(respond) {
  return (table, method, url) => entitled(table, method) ?? respond(table, method, url);
}

function mount({ memberships = MANAGER } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: "user-1" }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerCertPolicyRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET cert-requirements denies a non-member", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/cert-requirements");
  assert.equal(result.status, 403);
});

test("POST cert-requirements validates input before guarding", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/cert-requirements", { roleId: "r1" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST cert-requirements denies a member without training.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/cert-requirements", {
    certificationTypeId: "c1",
    roleId: "r1"
  });
  assert.equal(result.status, 403);
});

test("POST cert-requirements rejects with 402 when the plan lacks cert_policies", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "facilities" && method === "GET") return [{ organization_id: "org-1" }];
    if (table === "tenant_subscriptions" && method === "GET") return []; // no subscription -> fail closed
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/cert-requirements", {
    certificationTypeId: "c1",
    roleId: "r1"
  });
  assert.equal(result.status, 402);
  assert.ok(!captured.some((c) => c.table === "certification_role_requirements" && c.method === "POST"));
});

test("POST cert-requirements happy path inserts the shaped row", async (t) => {
  const captured = stubFetch(
    t,
    withEntitlement((table, method) => {
      if (table === "certification_role_requirements" && method === "POST") return [{ id: "req-1" }];
      return [];
    })
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/cert-requirements", {
    certificationTypeId: "c1",
    roleId: "r1",
    enforcementMode: "warning"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "certification_role_requirements" && c.method === "POST");
  assert.deepEqual(insert.body[0], {
    facility_id: "fac-1",
    certification_type_id: "c1",
    role_id: "r1",
    required_level: "required",
    enforcement_mode: "warning",
    active: true
  });
});

test("POST cert-policies validates the trigger type", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/cert-policies", { triggerType: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("GET cert-gaps requires roleId and returns the report shape", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "certification_role_requirements") {
      return [{ certification_type_id: "cpr", role_id: "r1", enforcement_mode: "hard-block" }];
    }
    if (table === "employee_certifications") {
      return [
        // emp-1 is missing the cpr cert -> a gap.
        { employee_id: "emp-1", certification_type_id: "first_aid", status: "active", expires_at: "2030-01-01" },
        // emp-2 holds cpr, valid -> no gap.
        { employee_id: "emp-2", certification_type_id: "cpr", status: "active", expires_at: "2030-01-01" }
      ];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });

  const missingRole = await call("GET", "/facilities/fac-1/cert-gaps");
  assert.equal(missingRole.status, 400);

  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.roleId, "r1");
  assert.equal(result.payload.requirementCount, 1);
  const emp1 = result.payload.employees.find((e) => e.employeeId === "emp-1");
  assert.ok(emp1, "expected emp-1 in the gaps report");
  assert.equal(emp1.gaps[0].certificationTypeId, "cpr");
  assert.equal(emp1.gaps[0].status, "missing");
  assert.equal(emp1.gaps[0].enforcement, "hard-block");
  // emp-2 has no gap.
  assert.ok(!result.payload.employees.some((e) => e.employeeId === "emp-2"));
  void captured;
});

// --- P-10: additional gap-report branches -----------------------------------

test("GET cert-gaps denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 403);
});

// GET cert-gaps only guards on facility membership (requireMember), not
// training.manage/training.read -- a reader with no training permission at
// all can still read the report as long as they belong to the facility. This
// documents that the report has no read-permission gate beyond membership.
test("GET cert-gaps allows a facility member with no training permission at all", async (t) => {
  const NO_TRAINING_PERMS = [{ facilityId: "fac-1", status: "active", permissions: [] }];
  stubFetch(t, () => []);
  const { call } = mount({ memberships: NO_TRAINING_PERMS });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 200);
});

test("GET cert-gaps with no matching requirement rows reports zero requirements and no employees", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "certification_role_requirements") return [];
    if (table === "employee_certifications") {
      return [{ employee_id: "emp-1", certification_type_id: "first_aid", status: "active", expires_at: "2030-01-01" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.requirementCount, 0);
  assert.deepEqual(result.payload.employees, []);
  void captured;
});

test("GET cert-gaps reports no employees when every held certification is compliant", async (t) => {
  stubFetch(t, (table) => {
    if (table === "certification_role_requirements") {
      return [
        { certification_type_id: "cpr", role_id: "r1", enforcement_mode: "hard-block" },
        { certification_type_id: "first_aid", role_id: "r1", enforcement_mode: "warning" }
      ];
    }
    if (table === "employee_certifications") {
      return [
        // Far-future expiry, well outside any renewal window -- unambiguously
        // "active" regardless of when this test runs.
        { employee_id: "emp-1", certification_type_id: "cpr", status: "active", expires_at: "2099-01-01" },
        { employee_id: "emp-1", certification_type_id: "first_aid", status: "active", expires_at: "2099-01-01" }
      ];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.requirementCount, 2);
  assert.deepEqual(result.payload.employees, []);
});

test("GET cert-gaps flags an expired certification distinctly from a missing one", async (t) => {
  stubFetch(t, (table) => {
    if (table === "certification_role_requirements") {
      return [
        { certification_type_id: "cpr", role_id: "r1", enforcement_mode: "hard-block" },
        { certification_type_id: "first_aid", role_id: "r1", enforcement_mode: "warning" }
      ];
    }
    if (table === "employee_certifications") {
      return [
        // cpr expired long ago -- unambiguous regardless of when this test
        // runs (renewal_window_days is not set, so even with a generous
        // default window this is still expired, not "expiring").
        { employee_id: "emp-1", certification_type_id: "cpr", status: "active", expires_at: "2000-01-01" }
        // first_aid never issued -> "missing".
      ];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.employees.length, 1);
  const emp1 = result.payload.employees[0];
  assert.equal(emp1.employeeId, "emp-1");
  const byType = Object.fromEntries(emp1.gaps.map((g) => [g.certificationTypeId, g]));
  assert.equal(byType.cpr.status, "expired");
  assert.equal(byType.cpr.enforcement, "hard-block");
  assert.equal(byType.first_aid.status, "missing");
  assert.equal(byType.first_aid.enforcement, "warning");
  assert.equal(emp1.gaps.length, 2);
});

test("GET cert-gaps ignores an inactive requirement row entirely", async (t) => {
  stubFetch(t, (table) => {
    if (table === "certification_role_requirements") {
      return [{ certification_type_id: "cpr", role_id: "r1", enforcement_mode: "hard-block", active: false }];
    }
    if (table === "employee_certifications") {
      // emp-1 holds nothing, but the only requirement is inactive.
      return [{ employee_id: "emp-1", certification_type_id: "unrelated", status: "active", expires_at: "2099-01-01" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1");
  assert.equal(result.status, 200);
  // requirementsForRole does not filter on `active` -- requirementCount still
  // counts the row -- but certGaps itself skips inactive requirements, so no
  // employee ends up with a gap for it.
  assert.equal(result.payload.requirementCount, 1);
  assert.deepEqual(result.payload.employees, []);
});

// The route only recognises a `roleId` query parameter (see queryParams(request)
// above) -- there is no departmentId or other filter branch on cert-gaps to
// exercise; an unrelated query parameter is simply ignored.
test("GET cert-gaps ignores unrelated query parameters such as departmentId", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "certification_role_requirements") {
      return [{ certification_type_id: "cpr", role_id: "r1", enforcement_mode: "hard-block" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/cert-gaps?roleId=r1&departmentId=dept-1");
  assert.equal(result.status, 200);
  const requirementsGet = captured.find((c) => c.table === "certification_role_requirements");
  assert.equal(requirementsGet.url.searchParams.get("department_id"), null);
});
