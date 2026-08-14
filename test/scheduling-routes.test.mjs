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

const REVIEW_PERIOD = { ...PERIOD, id: "per-review", status: "review" };
const PUBLISHED_PERIOD = { ...PERIOD, id: "per-published", status: "published" };
const ARCHIVED_PERIOD = { ...PERIOD, id: "per-archived", status: "archived" };

const SHIFT_TEMPLATE = {
  id: "tmpl-1",
  facility_id: "fac-1",
  department_id: null,
  role_code: "lifeguard",
  recurrence_rule: "weekly",
  start_time_local: "08:00",
  end_time_local: "16:00",
  days_of_week: [1, 2, 3, 4, 5],
  required_certification_ids: [],
  active: true
};

const EMPLOYEE_ROW = {
  id: "emp-1",
  facility_id: "fac-1",
  department_id: null,
  user_id: "user-1",
  employee_no: "E-001",
  first_name: "Alex",
  last_name: "Rivera",
  status: "active"
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

const PUBLISHED_SHIFT = { ...SHIFT, id: "shift-pub", schedule_period_id: "per-published" };

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

// A respond() callback normally returns an array/object treated as a 200 body.
// To simulate a PostgREST error response (e.g. a 409 unique-violation), wrap
// the payload with errorResponse() -- stubFetch recognizes the marker and
// answers with ok:false at that status instead.
function errorResponse(status, body = {}) {
  return { __stubStatus: status, __stubBody: body };
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
    if (data && typeof data === "object" && "__stubStatus" in data) {
      return { ok: data.__stubStatus < 400, status: data.__stubStatus, text: async () => JSON.stringify(data.__stubBody) };
    }
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

// =============================================================================
// SC-01 -- Period lifecycle
// =============================================================================

test("POST schedule-periods validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods", { weekStartDate: "2026-08-01" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST schedule-periods rejects weekStartDate after weekEndDate (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods", {
    weekStartDate: "2026-08-10",
    weekEndDate: "2026-08-01"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST schedule-periods denies a reader without schedule.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods", {
    weekStartDate: "2026-08-01",
    weekEndDate: "2026-08-07"
  });
  assert.equal(result.status, 403);
});

test("POST schedule-periods denies an OUTSIDER", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods", {
    weekStartDate: "2026-08-01",
    weekEndDate: "2026-08-07"
  });
  assert.equal(result.status, 403);
});

test("POST schedule-periods happy path inserts a draft period", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods" && method === "POST") return [{ id: "per-new" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods", {
    weekStartDate: "2026-08-01",
    weekEndDate: "2026-08-07"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "schedule_periods" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].week_start_date, "2026-08-01");
  assert.equal(insert.body[0].week_end_date, "2026-08-07");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].publish_version, 0);
});

test("POST schedule-periods surfaces a duplicate-week unique violation as 409", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "schedule_periods" && method === "POST") {
      return errorResponse(409, { message: "duplicate key value violates unique constraint" });
    }
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods", {
    weekStartDate: "2026-07-18",
    weekEndDate: "2026-07-24"
  });
  assert.equal(result.status, 409);
});

test("PATCH schedule-periods validates the status shape before any fetch (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-1", { status: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH schedule-periods returns 404 when the period does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/missing", { status: "review" });
  assert.equal(result.status, 404);
});

test("PATCH schedule-periods returns 403 when the period belongs to a different facility", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [{ ...PERIOD, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-1", { status: "review" });
  assert.equal(result.status, 403);
});

test("PATCH schedule-periods denies a reader without schedule.manage", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [PERIOD] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-1", { status: "review" });
  assert.equal(result.status, 403);
});

test("PATCH schedule-periods denies an OUTSIDER", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [PERIOD] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-1", { status: "review" });
  assert.equal(result.status, 403);
});

test("PATCH schedule-periods rejects an illegal transition with 400", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [PERIOD] : []));
  const { call } = mount({ memberships: MANAGER });
  // draft -> archived is not a legal direct transition.
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-1", { status: "archived" });
  assert.equal(result.status, 400);
});

test("PATCH schedule-periods rejects a terminal archived period moving anywhere", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [ARCHIVED_PERIOD] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-archived", { status: "draft" });
  assert.equal(result.status, 400);
});

test("PATCH schedule-periods allows the legal draft -> review transition", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods" && method === "GET") return [PERIOD];
    if (table === "schedule_periods" && method === "PATCH") return [{ ...PERIOD, status: "review" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-1", { status: "review" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "review");
  const patch = captured.find((c) => c.table === "schedule_periods" && c.method === "PATCH");
  assert.equal(patch.body.status, "review");
  assert.equal(patch.url.searchParams.get("facility_id"), "eq.fac-1");
});

test("PATCH schedule-periods allows review -> published", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "schedule_periods" && method === "GET") return [REVIEW_PERIOD];
    if (table === "schedule_periods" && method === "PATCH") return [{ ...REVIEW_PERIOD, status: "published" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-review", { status: "published" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "published");
});

test("PATCH schedule-periods allows published -> archived", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "schedule_periods" && method === "GET") return [PUBLISHED_PERIOD];
    if (table === "schedule_periods" && method === "PATCH") return [{ ...PUBLISHED_PERIOD, status: "archived" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/schedule-periods/per-published", { status: "archived" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "archived");
});

// =============================================================================
// SC-02 -- Shift template CRUD
// =============================================================================

test("GET shift-templates denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/shift-templates");
  assert.equal(result.status, 403);
});

test("GET shift-templates lists templates for a reader", async (t) => {
  stubFetch(t, (table) => (table === "shift_templates" ? [SHIFT_TEMPLATE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/shift-templates");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "tmpl-1");
});

test("POST shift-templates validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shift-templates", {
    roleCode: "lifeguard",
    startTimeLocal: "16:00",
    endTimeLocal: "08:00",
    daysOfWeek: [1, 2]
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST shift-templates rejects days_of_week outside 0-6 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shift-templates", {
    roleCode: "lifeguard",
    startTimeLocal: "08:00",
    endTimeLocal: "16:00",
    daysOfWeek: [7]
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST shift-templates rejects a malformed cert-id array before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shift-templates", {
    roleCode: "lifeguard",
    startTimeLocal: "08:00",
    endTimeLocal: "16:00",
    daysOfWeek: [1],
    requiredCertificationIds: [123]
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST shift-templates requires schedule.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shift-templates", {
    roleCode: "lifeguard",
    startTimeLocal: "08:00",
    endTimeLocal: "16:00",
    daysOfWeek: [1]
  });
  assert.equal(result.status, 403);
});

test("POST shift-templates denies an OUTSIDER", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/shift-templates", {
    roleCode: "lifeguard",
    startTimeLocal: "08:00",
    endTimeLocal: "16:00",
    daysOfWeek: [1]
  });
  assert.equal(result.status, 403);
});

test("POST shift-templates happy path inserts an active template", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "shift_templates" && method === "POST") return [{ id: "tmpl-new" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shift-templates", {
    roleCode: "lifeguard",
    startTimeLocal: "08:00",
    endTimeLocal: "16:00",
    daysOfWeek: [1, 2, 3]
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "shift_templates" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].active, true);
  assert.deepEqual(insert.body[0].days_of_week, [1, 2, 3]);
});

test("PATCH shift-templates validates the patch shape before any fetch (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shift-templates/tmpl-1", { daysOfWeek: [9] });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH shift-templates returns 404 when the template does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shift-templates/missing", { active: false });
  assert.equal(result.status, 404);
});

test("PATCH shift-templates returns 403 for a cross-facility template", async (t) => {
  stubFetch(t, (table) => (table === "shift_templates" ? [{ ...SHIFT_TEMPLATE, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shift-templates/tmpl-1", { active: false });
  assert.equal(result.status, 403);
});

test("PATCH shift-templates denies an OUTSIDER", async (t) => {
  stubFetch(t, (table) => (table === "shift_templates" ? [SHIFT_TEMPLATE] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("PATCH", "/facilities/fac-1/shift-templates/tmpl-1", { active: false });
  assert.equal(result.status, 403);
});

test("PATCH shift-templates happy path updates fields", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "shift_templates" && method === "GET") return [SHIFT_TEMPLATE];
    if (table === "shift_templates" && method === "PATCH") return [{ ...SHIFT_TEMPLATE, role_code: "cashier" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shift-templates/tmpl-1", { roleCode: "cashier" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.role_code, "cashier");
  const patch = captured.find((c) => c.table === "shift_templates" && c.method === "PATCH");
  assert.equal(patch.body.role_code, "cashier");
  assert.equal(patch.url.searchParams.get("facility_id"), "eq.fac-1");
});

test("DELETE shift-templates requires schedule.manage", async (t) => {
  stubFetch(t, (table) => (table === "shift_templates" ? [SHIFT_TEMPLATE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("DELETE", "/facilities/fac-1/shift-templates/tmpl-1");
  assert.equal(result.status, 403);
});

test("DELETE shift-templates deactivates the template (active=false) instead of hard-deleting", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "shift_templates" && method === "GET") return [SHIFT_TEMPLATE];
    if (table === "shift_templates" && method === "PATCH") return [{ ...SHIFT_TEMPLATE, active: false }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("DELETE", "/facilities/fac-1/shift-templates/tmpl-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.active, false);
  const patch = captured.find((c) => c.table === "shift_templates" && c.method === "PATCH");
  assert.equal(patch.body.active, false);
  assert.ok(!("deleted_at" in patch.body), "must not attempt to set deleted_at directly (blocked by 0026 RLS)");
});

// =============================================================================
// SC-04 -- Shift edit route
// =============================================================================

test("PATCH shifts returns 404 when the shift does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/missing", { notes: "x" });
  assert.equal(result.status, 404);
});

test("PATCH shifts returns 403 for a cross-facility shift", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [{ ...SHIFT, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", { notes: "x" });
  assert.equal(result.status, 403);
});

test("PATCH shifts denies a reader without schedule.manage", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [SHIFT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", { notes: "x" });
  assert.equal(result.status, 403);
});

test("PATCH shifts denies an OUTSIDER", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [SHIFT] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", { notes: "x" });
  assert.equal(result.status, 403);
});

test("PATCH shifts rejects an unknown status value", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [SHIFT] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", { status: "bogus" });
  assert.equal(result.status, 400);
});

test("PATCH shifts rejects an empty patch", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [SHIFT] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", {});
  assert.equal(result.status, 400);
});

test("PATCH shifts happy path updates times/role/notes/status for a shift in a draft period", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts" && method === "GET") return [SHIFT];
    if (table === "schedule_periods" && method === "GET") return [PERIOD];
    if (table === "schedule_shifts" && method === "PATCH") return [{ ...SHIFT, status: "open" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", {
    startsAt: "2026-07-18T09:00:00Z",
    endsAt: "2026-07-18T17:00:00Z",
    roleCode: "cashier",
    notes: "swapped role",
    status: "open"
  });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "schedule_shifts" && c.method === "PATCH");
  assert.equal(patch.body.starts_at, "2026-07-18T09:00:00Z");
  assert.equal(patch.body.ends_at, "2026-07-18T17:00:00Z");
  assert.equal(patch.body.role_code, "cashier");
  assert.equal(patch.body.notes, "swapped role");
  assert.equal(patch.body.status, "open");
  assert.equal(patch.url.searchParams.get("facility_id"), "eq.fac-1");
});

test("PATCH shifts allows setting status to cancelled", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "schedule_periods") return [PERIOD];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1", { status: "cancelled" });
  assert.equal(result.status, 200);
});

test("PATCH shifts in a published period requires a reason (400 without one)", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [PUBLISHED_SHIFT];
    if (table === "schedule_periods") return [PUBLISHED_PERIOD];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-pub", { notes: "changed" });
  assert.equal(result.status, 400);
});

test("PATCH shifts in a published period requires schedule.manage even with a reason", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [PUBLISHED_SHIFT];
    if (table === "schedule_periods") return [PUBLISHED_PERIOD];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-pub", {
    notes: "changed",
    reason: "coverage gap"
  });
  assert.equal(result.status, 403);
});

test("PATCH shifts in a published period succeeds with a reason and records it in notes", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts" && method === "GET") return [PUBLISHED_SHIFT];
    if (table === "schedule_periods" && method === "GET") return [PUBLISHED_PERIOD];
    if (table === "schedule_shifts" && method === "PATCH") return [{ ...PUBLISHED_SHIFT, status: "cancelled" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-pub", {
    status: "cancelled",
    reason: "employee called out sick"
  });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "schedule_shifts" && c.method === "PATCH");
  assert.equal(patch.body.status, "cancelled");
  assert.match(patch.body.notes, /employee called out sick/);
});

test("PATCH shifts in a published period rejects a blank/whitespace-only reason", async (t) => {
  stubFetch(t, (table) => {
    if (table === "schedule_shifts") return [PUBLISHED_SHIFT];
    if (table === "schedule_periods") return [PUBLISHED_PERIOD];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-pub", { notes: "x", reason: "   " });
  assert.equal(result.status, 400);
});

// =============================================================================
// SC-09 -- Employees listing (read-scoped, for the future board's assignee picker)
// =============================================================================

test("GET employees denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/employees");
  assert.equal(result.status, 403);
});

test("GET employees allows a schedule.read-only member", async (t) => {
  stubFetch(t, (table) => (table === "employees" ? [EMPLOYEE_ROW] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/employees");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "emp-1");
});

test("GET employees scopes the query to the URL facility", async (t) => {
  const captured = stubFetch(t, (table) => (table === "employees" ? [EMPLOYEE_ROW] : []));
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/employees");
  const req = captured.find((c) => c.table === "employees" && c.method === "GET");
  assert.ok(req);
  assert.equal(req.url.searchParams.get("facility_id"), "eq.fac-1");
});

// =============================================================================
// SC-03 -- Generate shifts from templates
// =============================================================================

// A Sunday-start period whose week matches SHIFT_TEMPLATE's daysOfWeek [1..5]
// (Mon-Fri): 2026-07-19 through 2026-07-25.
const GEN_PERIOD = {
  ...PERIOD,
  id: "per-gen",
  week_start_date: "2026-07-19",
  week_end_date: "2026-07-25",
  status: "draft"
};

test("POST generate returns 404 when the period does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/missing/generate");
  assert.equal(result.status, 404);
});

test("POST generate returns 403 when the period belongs to a different facility", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [{ ...GEN_PERIOD, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 403);
});

test("POST generate denies a reader without schedule.manage", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [GEN_PERIOD] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 403);
});

test("POST generate denies an OUTSIDER", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [GEN_PERIOD] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 403);
});

test("POST generate returns 409 for a period in 'published' status", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [{ ...GEN_PERIOD, status: "published" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 409);
});

test("POST generate returns 409 for a period in 'archived' status", async (t) => {
  stubFetch(t, (table) => (table === "schedule_periods" ? [{ ...GEN_PERIOD, status: "archived" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 409);
});

test("POST generate allows a period in 'review' status", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods") return [{ ...GEN_PERIOD, status: "review" }];
    if (table === "shift_templates") return [SHIFT_TEMPLATE];
    if (table === "schedule_shifts" && method === "GET") return [];
    if (table === "schedule_shifts" && method === "POST") return [{ id: "gen-shift-1" }];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 201);
});

test("POST generate happy path: inserted shifts carry source='template' and the period's id", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods") return [GEN_PERIOD];
    if (table === "shift_templates") return [SHIFT_TEMPLATE];
    if (table === "schedule_shifts" && method === "GET") return [];
    if (table === "schedule_shifts" && method === "POST") return [{ id: "gen-shift-1" }];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 201);

  const insert = captured.find((c) => c.table === "schedule_shifts" && c.method === "POST");
  assert.ok(insert, "expected a schedule_shifts insert");
  // SHIFT_TEMPLATE has daysOfWeek [1,2,3,4,5] over the Mon-Fri span of the
  // period's week -> 5 generated rows.
  assert.equal(insert.body.length, 5);
  for (const row of insert.body) {
    assert.equal(row.source, "template");
    assert.equal(row.schedule_period_id, "per-gen");
    assert.equal(row.facility_id, "fac-1");
    assert.equal(row.status, "draft");
    assert.equal(row.role_code, "lifeguard");
  }
  assert.deepEqual(
    insert.body.map((r) => r.shift_date),
    ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]
  );
});

test("POST generate skips templates that are not active", async (t) => {
  // active=false is filtered at the query layer by the route's own
  // { active: true } filter, so the stub simulates that by returning [].
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods") return [GEN_PERIOD];
    if (table === "shift_templates") return [];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.inserted, []);
  assert.ok(!captured.some((c) => c.table === "schedule_shifts" && c.method === "POST"));
});

test("POST generate queries shift_templates filtered to active=true", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "schedule_periods") return [GEN_PERIOD];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  const req = captured.find((c) => c.table === "shift_templates" && c.method === "GET");
  assert.ok(req);
  assert.equal(req.url.searchParams.get("active"), "eq.true");
});

test("POST generate is idempotent: re-running inserts nothing for template/date pairs that already have a shift", async (t) => {
  // Simulate that all 5 expected shifts already exist for this period, as
  // source='template' rows with the exact natural-key tuple expandTemplates
  // would produce for SHIFT_TEMPLATE over per-gen's week.
  const existingShifts = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"].map((date, i) => ({
    id: `existing-${i}`,
    facility_id: "fac-1",
    schedule_period_id: "per-gen",
    department_id: null,
    role_code: "lifeguard",
    shift_date: date,
    starts_at: `${date}T12:00:00.000Z`, // 08:00 EDT
    ends_at: `${date}T20:00:00.000Z`, // 16:00 EDT
    source: "template",
    status: "draft",
    required_certification_ids: [],
    notes: null
  }));

  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods") return [GEN_PERIOD];
    if (table === "shift_templates") return [SHIFT_TEMPLATE];
    if (table === "schedule_shifts" && method === "GET") return existingShifts;
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.inserted, []);
  assert.ok(
    !captured.some((c) => c.table === "schedule_shifts" && c.method === "POST"),
    "a re-run must not attempt any insert once every template/date pair already has a shift"
  );
});

test("POST generate re-run only inserts the still-missing template/date pairs", async (t) => {
  // Only Monday (2026-07-20) already exists; the other 4 weekdays should
  // still be generated.
  const existingShifts = [
    {
      id: "existing-mon",
      facility_id: "fac-1",
      schedule_period_id: "per-gen",
      department_id: null,
      role_code: "lifeguard",
      shift_date: "2026-07-20",
      starts_at: "2026-07-20T12:00:00.000Z",
      ends_at: "2026-07-20T20:00:00.000Z",
      source: "template",
      status: "draft",
      required_certification_ids: [],
      notes: null
    }
  ];
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_periods") return [GEN_PERIOD];
    if (table === "shift_templates") return [SHIFT_TEMPLATE];
    if (table === "schedule_shifts" && method === "GET") return existingShifts;
    if (table === "schedule_shifts" && method === "POST") return [{ id: "new" }];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/schedule-periods/per-gen/generate");
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "schedule_shifts" && c.method === "POST");
  assert.equal(insert.body.length, 4);
  assert.deepEqual(
    insert.body.map((r) => r.shift_date),
    ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]
  );
});

// =============================================================================
// SC-05 -- Shift assignments
// =============================================================================

test("POST assignments validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST assignments rejects an invalid assignmentType before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", {
    employeeId: "emp-1",
    assignmentType: "bogus"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST assignments returns 404 when the shift does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/missing/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 404);
});

test("POST assignments returns 403 for a cross-facility shift", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [{ ...SHIFT, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 403);
});

test("POST assignments denies a reader without schedule.manage", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [SHIFT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 403);
});

test("POST assignments denies an OUTSIDER", async (t) => {
  stubFetch(t, (table) => (table === "schedule_shifts" ? [SHIFT] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 403);
});

test("POST assignments happy path assigns an employee (default assignmentType='primary')", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments" && method === "GET") return [];
    if (table === "shift_assignments" && method === "POST") return [{ id: "asg-new" }];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "shift_assignments" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].shift_id, "shift-1");
  assert.equal(insert.body[0].employee_id, "emp-1");
  assert.equal(insert.body[0].assignment_type, "primary");
});

test("POST assignments accepts assignmentType='cover'", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments" && method === "GET") return [];
    if (table === "shift_assignments" && method === "POST") return [{ id: "asg-new" }];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", {
    employeeId: "emp-1",
    assignmentType: "cover"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "shift_assignments" && c.method === "POST");
  assert.equal(insert.body[0].assignment_type, "cover");
});

test("POST assignments blocks an overlapping assignment with 409 and a conflict payload when conflictCheckEnabled (default)", async (t) => {
  const existingAssignment = {
    id: "asg-existing",
    facility_id: "fac-1",
    shift_id: "shift-a",
    employee_id: "emp-1",
    assignment_type: "primary",
    status: "pending",
    assigned_by: null
  };
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "schedule_shifts" && method === "GET") {
      // The target shift (SHIFT_OVERLAP_B, loaded by exact id) and the batch
      // lookup of the employee's other live assignments' shifts (an
      // id=in.(...) filter, which here resolves SHIFT_OVERLAP_A) overlap in
      // time. Discriminate on the actual filter, as PostgREST would, rather
      // than returning both rows for every schedule_shifts GET.
      const idFilter = url.searchParams.get("id");
      if (idFilter === "eq.shift-b") return [SHIFT_OVERLAP_B];
      if (idFilter && idFilter.startsWith("in.")) return [SHIFT_OVERLAP_A, SHIFT_OVERLAP_B];
      return [];
    }
    if (table === "shift_assignments" && method === "GET") return [existingAssignment];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-b/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 409);
  assert.ok(Array.isArray(result.payload.conflicts));
  assert.equal(result.payload.conflicts.length, 1);
  assert.equal(result.payload.conflicts[0].employeeId, "emp-1");
  assert.deepEqual(result.payload.conflicts[0].shiftIds.sort(), ["shift-a", "shift-b"].sort());
  assert.ok(
    !captured.some((c) => c.table === "shift_assignments" && c.method === "POST"),
    "a blocked assignment must never reach the insert"
  );
});

test("POST assignments does not flag a second assignment_type on the SAME shift as a self-conflict", async (t) => {
  const existingAssignment = {
    id: "asg-existing",
    facility_id: "fac-1",
    shift_id: "shift-1",
    employee_id: "emp-1",
    assignment_type: "primary",
    status: "pending",
    assigned_by: null
  };
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments" && method === "GET") return [existingAssignment];
    if (table === "shift_assignments" && method === "POST") return [{ id: "asg-cover" }];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", {
    employeeId: "emp-1",
    assignmentType: "cover"
  });
  assert.equal(result.status, 201);
});

test("POST assignments: conflict suppressed when scheduling.conflictCheckEnabled=false", async (t) => {
  const existingAssignment = {
    id: "asg-existing",
    facility_id: "fac-1",
    shift_id: "shift-a",
    employee_id: "emp-1",
    assignment_type: "primary",
    status: "pending",
    assigned_by: null
  };
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "schedule_shifts" && method === "GET") {
      const idFilter = url.searchParams.get("id");
      if (idFilter === "eq.shift-b") return [SHIFT_OVERLAP_B];
      return [];
    }
    if (table === "shift_assignments" && method === "GET") return [existingAssignment];
    if (table === "shift_assignments" && method === "POST") return [{ id: "asg-new" }];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    if (table === "facility_module_overrides") {
      return [facilityOverride({ "scheduling.conflictCheckEnabled": false })];
    }
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-b/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 201);
  assert.ok(captured.some((c) => c.table === "shift_assignments" && c.method === "POST"));
  // With the check disabled, no overlap lookups should even run.
  assert.ok(!captured.some((c) => c.table === "shift_assignments" && c.method === "GET"));
});

test("POST assignments ignores a declined/cancelled assignment when checking overlaps", async (t) => {
  const declinedAssignment = {
    id: "asg-declined",
    facility_id: "fac-1",
    shift_id: "shift-a",
    employee_id: "emp-1",
    assignment_type: "primary",
    status: "declined",
    assigned_by: null
  };
  const captured = stubFetch(t, (table, method, url) => {
    // The route filters shift_assignments to status in (pending, approved),
    // so a declined assignment would never come back from this query in
    // production -- this stub simulates that filtering behavior.
    if (table === "schedule_shifts" && method === "GET") {
      const idFilter = url.searchParams.get("id");
      if (idFilter === "eq.shift-b") return [SHIFT_OVERLAP_B];
      return [];
    }
    if (table === "shift_assignments" && method === "GET") return [];
    if (table === "shift_assignments" && method === "POST") return [{ id: "asg-new" }];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-b/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 201);
});

test("POST assignments scopes the overlap lookup to active statuses (pending, approved)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments" && method === "GET") return [];
    if (table === "shift_assignments" && method === "POST") return [{ id: "asg-new" }];
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", { employeeId: "emp-1" });
  const req = captured.find((c) => c.table === "shift_assignments" && c.method === "GET");
  assert.ok(req);
  assert.equal(req.url.searchParams.get("status"), "in.(pending,approved)");
});

test("POST assignments maps a DB unique-constraint violation to a clean 409", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "schedule_shifts") return [SHIFT];
    if (table === "shift_assignments" && method === "GET") return [];
    if (table === "shift_assignments" && method === "POST") {
      return errorResponse(409, { message: "duplicate key value violates unique constraint" });
    }
    if (table === "modules") return [MODULE_SCHEDULING];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", "/facilities/fac-1/shifts/shift-1/assignments", { employeeId: "emp-1" });
  assert.equal(result.status, 409);
});

test("PATCH assignments validates the status shape before any fetch (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "bogus" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("PATCH assignments returns 404 when the assignment does not exist", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/missing", { status: "approved" });
  assert.equal(result.status, 404);
});

test("PATCH assignments returns 403 for a cross-facility assignment", async (t) => {
  stubFetch(t, (table) => (table === "shift_assignments" ? [{ ...ASSIGNMENT, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "approved" });
  assert.equal(result.status, 403);
});

test("PATCH assignments returns 404 when the assignment does not belong to the shift in the URL", async (t) => {
  stubFetch(t, (table) => (table === "shift_assignments" ? [{ ...ASSIGNMENT, shift_id: "shift-other" }] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "approved" });
  assert.equal(result.status, 404);
});

test("PATCH assignments denies a reader without schedule.manage", async (t) => {
  stubFetch(t, (table) => (table === "shift_assignments" ? [ASSIGNMENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "approved" });
  assert.equal(result.status, 403);
});

test("PATCH assignments denies an OUTSIDER", async (t) => {
  stubFetch(t, (table) => (table === "shift_assignments" ? [ASSIGNMENT] : []));
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "approved" });
  assert.equal(result.status, 403);
});

test("PATCH assignments allows pending -> approved", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "shift_assignments" && method === "GET") return [ASSIGNMENT];
    if (table === "shift_assignments" && method === "PATCH") return [{ ...ASSIGNMENT, status: "approved" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "approved" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "approved");
  const patch = captured.find((c) => c.table === "shift_assignments" && c.method === "PATCH");
  assert.equal(patch.body.status, "approved");
  assert.equal(patch.url.searchParams.get("facility_id"), "eq.fac-1");
});

test("PATCH assignments allows pending -> declined", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "shift_assignments" && method === "GET") return [ASSIGNMENT];
    if (table === "shift_assignments" && method === "PATCH") return [{ ...ASSIGNMENT, status: "declined" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "declined" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "declined");
});

test("PATCH assignments allows pending -> cancelled", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "shift_assignments" && method === "GET") return [ASSIGNMENT];
    if (table === "shift_assignments" && method === "PATCH") return [{ ...ASSIGNMENT, status: "cancelled" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "cancelled" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "cancelled");
});

test("PATCH assignments allows approved -> cancelled (unassign)", async (t) => {
  const approved = { ...ASSIGNMENT, status: "approved" };
  stubFetch(t, (table, method) => {
    if (table === "shift_assignments" && method === "GET") return [approved];
    if (table === "shift_assignments" && method === "PATCH") return [{ ...approved, status: "cancelled" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "cancelled" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "cancelled");
});

test("PATCH assignments allows declined -> cancelled", async (t) => {
  const declined = { ...ASSIGNMENT, status: "declined" };
  stubFetch(t, (table, method) => {
    if (table === "shift_assignments" && method === "GET") return [declined];
    if (table === "shift_assignments" && method === "PATCH") return [{ ...declined, status: "cancelled" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "cancelled" });
  assert.equal(result.status, 200);
});

test("PATCH assignments rejects approved -> declined as an illegal transition", async (t) => {
  const approved = { ...ASSIGNMENT, status: "approved" };
  stubFetch(t, (table) => (table === "shift_assignments" ? [approved] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "declined" });
  assert.equal(result.status, 400);
});

test("PATCH assignments rejects a terminal cancelled assignment moving anywhere", async (t) => {
  const cancelled = { ...ASSIGNMENT, status: "cancelled" };
  stubFetch(t, (table) => (table === "shift_assignments" ? [cancelled] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("PATCH", "/facilities/fac-1/shifts/shift-1/assignments/asg-1", { status: "pending" });
  assert.equal(result.status, 400);
});
