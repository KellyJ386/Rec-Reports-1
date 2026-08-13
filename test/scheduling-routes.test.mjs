import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerSchedulingRoutes } from "../src/lib/http/scheduling-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const READER = [{ facilityId: "fac-1", status: "active", permissions: ["schedule.read"] }];
const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["schedule.read", "schedule.manage"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["schedule.read", "schedule.manage"] }];

const PERIOD = {
  id: "per-1",
  facility_id: "fac-1",
  department_id: null,
  week_start_date: "2026-07-18",
  week_end_date: "2026-07-24",
  status: "draft",
  publish_version: 0,
  metadata: {}
};

const SHIFT = {
  id: "shift-1",
  facility_id: "fac-1",
  schedule_period_id: "per-1",
  department_id: null,
  role_code: "nurse",
  shift_date: "2026-07-18",
  starts_at: "2026-07-18T08:00:00Z",
  ends_at: "2026-07-18T16:00:00Z",
  source: "manual",
  status: "draft",
  required_certification_ids: [],
  notes: null
};

const ASSIGNMENT = {
  id: "asg-1",
  facility_id: "fac-1",
  shift_id: "shift-1",
  employee_id: "emp-1",
  assignment_type: "primary",
  status: "pending",
  assigned_by: null
};

const CERT_TYPE = {
  id: "ct-1",
  facility_id: "fac-1",
  code: "BLS",
  name: "Basic Life Support",
  renewal_window_days: 30
};

const EMPLOYEE_CERT = {
  id: "ec-1",
  facility_id: "fac-1",
  employee_id: "emp-1",
  certification_type_id: "ct-1",
  issued_at: "2025-01-01",
  expires_at: "2027-01-01",
  evidence_path: null,
  status: "active"
};

// --- Fixtures for the effective-config lookup (mirrors admin-routes.mjs'
// modules / organization_module_settings / facility_module_overrides shape).
const MODULE_SCHEDULING = { id: "mod-scheduling", code: "scheduling" };
const FACILITY_ROW = { id: "fac-1", organization_id: "org-1" };

function facilityOverride(configPatch) {
  return { config_patch_jsonb: configPatch };
}

// A shift that requires the BLS cert, assigned to an employee who holds no
// certifications -- used by the cert-enforcement-mode tests below.
const SHIFT_REQUIRES_CERT = {
  ...SHIFT,
  id: "shift-2",
  required_certification_ids: ["ct-1"]
};
const ASSIGNMENT_MISSING_CERT = {
  id: "asg-2",
  facility_id: "fac-1",
  shift_id: "shift-2",
  employee_id: "emp-2",
  assignment_type: "primary",
  status: "pending",
  assigned_by: null
};

// Two overlapping shifts assigned to the same employee -- used by the
// conflict-check-enabled tests below.
const SHIFT_OVERLAP_A = { ...SHIFT, id: "shift-a", starts_at: "2026-07-18T08:00:00Z", ends_at: "2026-07-18T16:00:00Z" };
const SHIFT_OVERLAP_B = { ...SHIFT, id: "shift-b", starts_at: "2026-07-18T12:00:00Z", ends_at: "2026-07-18T20:00:00Z" };
const ASSIGNMENT_OVERLAP_A = {
  id: "asg-a",
  facility_id: "fac-1",
  shift_id: "shift-a",
  employee_id: "emp-1",
  assignment_type: "primary",
  status: "pending",
  assigned_by: null
};
const ASSIGNMENT_OVERLAP_B = {
  id: "asg-b",
  facility_id: "fac-1",
  shift_id: "shift-b",
  employee_id: "emp-1",
  assignment_type: "primary",
  status: "pending",
  assigned_by: null
};

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

function mount({ memberships = MANAGER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerSchedulingRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET schedule-periods denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/schedule-periods");
  assert.equal(result.status, 403);
});

test("GET schedule-periods returns an empty list for a reader", async (t) => {
  const captured = stubFetch(t, (table) => (table === "schedule_periods" ? [PERIOD] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/schedule-periods");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "per-1");
});

test("POST shifts validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shifts", { roleCode: "nurse" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST shifts denies a reader without schedule.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shifts", {
    schedulePeriodId: "per-1",
    roleCode: "nurse",
    shiftDate: "2026-07-18",
    startsAt: "2026-07-18T08:00:00Z",
    endsAt: "2026-07-18T16:00:00Z"
  });
  assert.equal(result.status, 403);
});

test("POST shifts happy path inserts a draft shift with shaped row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts" && method === "POST") return [{ id: "shift-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/shifts", {
    schedulePeriodId: "per-1",
    roleCode: "nurse",
    shiftDate: "2026-07-18",
    startsAt: "2026-07-18T08:00:00Z",
    endsAt: "2026-07-18T16:00:00Z",
    notes: "test shift"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "schedule_shifts" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].schedule_period_id, "per-1");
  assert.equal(insert.body[0].role_code, "nurse");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].notes, "test shift");
});

test("POST schedule/validate returns 200 with readiness result", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments") return [ASSIGNMENT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "employee_certifications") return [EMPLOYEE_CERT];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.ok("canPublish" in result.payload);
  assert.ok("doubleBookings" in result.payload);
  assert.ok("missingCertifications" in result.payload);
  assert.ok("warnings" in result.payload);
  assert.ok("certEnforcementMode" in result.payload);
  assert.equal(result.payload.canPublish, true);
  assert.equal(result.payload.doubleBookings.length, 0);
});

test("POST schedule/validate blocks on a missing cert by default (hard-block)", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT_REQUIRES_CERT];
    if (table === "shift_assignments") return [ASSIGNMENT_MISSING_CERT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.equal(result.payload.certEnforcementMode, "hard-block");
  assert.equal(result.payload.missingCertifications.length, 1);
  assert.equal(result.payload.warnings.length, 0);
  assert.equal(result.payload.canPublish, false);
});

test("POST schedule/validate: facility certEnforcementMode='warning' downgrades missing certs to warnings, not blocks", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT_REQUIRES_CERT];
    if (table === "shift_assignments") return [ASSIGNMENT_MISSING_CERT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    if (table === "facility_module_overrides") {
      return [facilityOverride({ "scheduling.certEnforcementMode": "warning" })];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.equal(result.payload.certEnforcementMode, "warning");
  assert.equal(result.payload.missingCertifications.length, 1);
  assert.equal(result.payload.warnings.length, 1);
  assert.equal(result.payload.warnings[0].severity, "warning");
  assert.equal(result.payload.canPublish, true);
});

test("POST schedule/validate: default conflictCheckEnabled blocks on overlapping assignments", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT_OVERLAP_A, SHIFT_OVERLAP_B];
    if (table === "shift_assignments") return [ASSIGNMENT_OVERLAP_A, ASSIGNMENT_OVERLAP_B];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.equal(result.payload.doubleBookings.length, 1);
  assert.equal(result.payload.canPublish, false);
});

test("POST schedule/validate: facility conflictCheckEnabled=false suppresses double-booking conflicts", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT_OVERLAP_A, SHIFT_OVERLAP_B];
    if (table === "shift_assignments") return [ASSIGNMENT_OVERLAP_A, ASSIGNMENT_OVERLAP_B];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    if (table === "facility_module_overrides") {
      return [facilityOverride({ "scheduling.conflictCheckEnabled": false })];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.equal(result.payload.doubleBookings.length, 0);
  assert.equal(result.payload.canPublish, true);
});

test("POST schedule/validate scopes the shifts query to period_id when provided", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments") return [ASSIGNMENT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "employee_certifications") return [EMPLOYEE_CERT];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate?period_id=per-1");
  assert.equal(result.status, 200);
  const shiftsCall = captured.find((c) => c.table === "schedule_shifts" && c.method === "GET");
  assert.ok(shiftsCall, "expected a schedule_shifts GET request");
  assert.equal(shiftsCall.url.searchParams.get("schedule_period_id"), "eq.per-1");
});

test("POST schedule/validate omits period scoping when no period_id is given", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT];
    return [];
  });
  const { call } = mount({ memberships: READER });
  await call("POST", "/facilities/fac-1/schedule/validate");
  const shiftsCall = captured.find((c) => c.table === "schedule_shifts" && c.method === "GET");
  assert.ok(shiftsCall);
  assert.equal(shiftsCall.url.searchParams.get("schedule_period_id"), null);
});

test("POST schedule/validate: a certification_role_requirements override to 'warning' beats the facility's default 'hard-block' mode", async (t) => {
  const requirementOverride = {
    id: "req-1",
    facility_id: "fac-1",
    certification_type_id: "ct-1",
    role_id: "role-1",
    required_level: "required",
    enforcement_mode: "warning",
    active: true
  };
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT_REQUIRES_CERT];
    if (table === "shift_assignments") return [ASSIGNMENT_MISSING_CERT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "certification_role_requirements") return [requirementOverride];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    // No facility_module_overrides row -> facility-wide mode stays the
    // registry default ('hard-block'); only the per-requirement override
    // should downgrade this specific missing cert.
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.equal(result.payload.certEnforcementMode, "hard-block");
  assert.equal(result.payload.missingCertifications.length, 1);
  assert.equal(result.payload.warnings.length, 1);
  assert.equal(result.payload.warnings[0].certificationCode, "BLS");
  assert.equal(result.payload.canPublish, true);
});

test("POST schedule/validate: an inactive certification_role_requirements row is ignored, falling back to the facility mode", async (t) => {
  const inactiveOverride = {
    id: "req-2",
    facility_id: "fac-1",
    certification_type_id: "ct-1",
    role_id: "role-1",
    required_level: "required",
    enforcement_mode: "warning",
    active: false
  };
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT_REQUIRES_CERT];
    if (table === "shift_assignments") return [ASSIGNMENT_MISSING_CERT];
    if (table === "certification_types") return [CERT_TYPE];
    if (table === "certification_role_requirements") return [inactiveOverride];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule/validate");
  assert.equal(result.status, 200);
  assert.equal(result.payload.warnings.length, 0);
  assert.equal(result.payload.canPublish, false);
});
