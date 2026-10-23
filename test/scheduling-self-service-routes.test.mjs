import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerSchedulingSelfServiceRoutes } from "../src/lib/http/scheduling-self-service-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const member = (permissions) => [{ facilityId: "fac-1", status: "active", permissions }];
const STAFF = member([]);
const READER = member(["schedule.read"]);
const CLAIM_APPROVER = member(["schedule.manage.open_shifts"]);
const SWAP_APPROVER = member(["schedule.approve.swaps"]);
const TIME_OFF_APPROVER = member(["schedule.approve.time_off"]);
const MANAGER = member(["schedule.read", "schedule.manage"]);
const FULL = member([
  "schedule.read",
  "schedule.manage",
  "schedule.manage.open_shifts",
  "schedule.approve.swaps",
  "schedule.approve.time_off"
]);
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: FULL[0].permissions }];

const FUTURE_DAY = "2035-03-05";
const OPEN_SHIFT = {
  id: "shift-1",
  facility_id: "fac-1",
  schedule_period_id: "per-1",
  department_id: null,
  role_code: "guard",
  shift_date: FUTURE_DAY,
  starts_at: `${FUTURE_DAY}T09:00:00Z`,
  ends_at: `${FUTURE_DAY}T17:00:00Z`,
  source: "manual",
  status: "open",
  required_certification_ids: [],
  notes: null,
  opened_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null
};
const SHIFT_2 = {
  ...OPEN_SHIFT,
  id: "shift-2",
  status: "assigned",
  shift_date: "2035-03-06",
  starts_at: "2035-03-06T09:00:00Z",
  ends_at: "2035-03-06T17:00:00Z"
};
const SHIFT_1_ASSIGNED = { ...OPEN_SHIFT, status: "assigned", opened_at: null };

const ASSIGNMENT_1 = {
  id: "asg-1",
  facility_id: "fac-1",
  shift_id: "shift-1",
  employee_id: "emp-1",
  assignment_type: "primary",
  status: "approved",
  deleted_at: null
};
const ASSIGNMENT_2 = { ...ASSIGNMENT_1, id: "asg-2", shift_id: "shift-2", employee_id: "emp-2" };

function http(status, body) {
  return { __http: { status, body } };
}

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body });
    // The settings tables are admin.manage-only (an ordinary caller's direct
    // read returns ZERO rows); the BFF resolves them through the
    // get_scheduling_config_layers definer RPC, emulated here from the
    // fixtures a test registers under those table names.
    let data;
    if (table === "rpc/get_scheduling_config_layers") {
      const onlyScheduling = (layer) =>
        Object.fromEntries(Object.entries(layer ?? {}).filter(([key]) => key.startsWith("scheduling.")));
      const orgRows = respond("organization_module_settings", "GET", parsed, null) ?? [];
      const facilityRows = respond("facility_module_overrides", "GET", parsed, null) ?? [];
      data = {
        orgLayer: onlyScheduling(orgRows[0]?.config_jsonb),
        facilityLayer: onlyScheduling(facilityRows[0]?.config_patch_jsonb)
      };
    } else if (table === "organization_module_settings" || table === "facility_module_overrides") {
      data = [];
    } else {
      data = respond(table, method, parsed, body) ?? [];
    }
    if (data && data.__http) {
      return { ok: false, status: data.__http.status, text: async () => JSON.stringify(data.__http.body) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = STAFF, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerSchedulingSelfServiceRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call, sent };
}

const idOf = (url) => (url.searchParams.get("id") ?? "").replace(/^eq\./, "");

// A world where the caller is employee emp-1 and everything else is empty.
// `tables` overrides per table; a function value receives (method, url, body).
function world(tables = {}) {
  return (table, method, url, body) => {
    const override = tables[table];
    if (override !== undefined) return typeof override === "function" ? override(method, url, body) : override;
    if (table === "employees") return [{ id: "emp-1", status: "active", first_name: "Alex", last_name: "Rivera" }];
    return [];
  };
}

// get_scheduling_config_layers is a read-only definer RPC (a POST on the wire).
const writes = (captured) =>
  captured.filter((entry) => entry.method !== "GET" && entry.table !== "rpc/get_scheduling_config_layers");

// ============================================================================
// GET /me/schedule
// ============================================================================

test("GET /me/schedule needs facilityId (400) and a valid week_start (400) before any fetch", async (t) => {
  const captured = stubFetch(t, world());
  const { call } = mount();
  assert.equal((await call("GET", "/me/schedule")).status, 400);
  assert.equal((await call("GET", "/me/schedule?facilityId=fac-1&week_start=2026-13-40")).status, 400);
  assert.equal(captured.length, 0);
});

test("GET /me/schedule denies a non-member with 403", async (t) => {
  stubFetch(t, world());
  const { call } = mount({ memberships: OUTSIDER });
  assert.equal((await call("GET", "/me/schedule?facilityId=fac-1")).status, 403);
});

test("GET /me/schedule returns an empty view for a member with no employee record", async (t) => {
  stubFetch(t, world({ employees: [] }));
  const { call } = mount();
  const result = await call("GET", "/me/schedule?facilityId=fac-1&week_start=2035-03-05");
  assert.equal(result.status, 200);
  assert.equal(result.payload.employeeId, null);
  assert.deepEqual(result.payload.assignments, []);
});

test("GET /me/schedule is self-scoped: the query is keyed on the caller's own employee and a colleague's row is never returned", async (t) => {
  const captured = stubFetch(
    t,
    world({
      schedule_periods: [{ id: "per-1", facility_id: "fac-1", status: "published", week_start_date: "2035-03-05", week_end_date: "2035-03-11" }],
      schedule_shifts: [SHIFT_1_ASSIGNED, SHIFT_2],
      // The stub deliberately returns a colleague's assignment too -- a
      // schedule.read holder's real query would; the route must still drop it.
      shift_assignments: [ASSIGNMENT_1, ASSIGNMENT_2]
    })
  );
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/me/schedule?facilityId=fac-1&week_start=2035-03-07");
  assert.equal(result.status, 200);
  assert.equal(result.payload.weekStartDate, "2035-03-05");
  assert.deepEqual(result.payload.assignments.map((entry) => entry.assignment.id), ["asg-1"]);

  const employeeLookup = captured.find((entry) => entry.table === "employees");
  assert.equal(employeeLookup.url.searchParams.get("user_id"), "eq.user-1");
  assert.equal(employeeLookup.url.searchParams.get("facility_id"), "eq.fac-1");
  const assignmentQuery = captured.find((entry) => entry.table === "shift_assignments");
  assert.equal(assignmentQuery.url.searchParams.get("employee_id"), "eq.emp-1");
  assert.equal(captured.find((entry) => entry.table === "schedule_periods").url.searchParams.get("status"), "eq.published");
  for (const table of ["open_shift_claims", "shift_swap_requests", "time_off_requests"]) {
    const query = captured.find((entry) => entry.table === table);
    assert.ok(query, `${table} requested`);
    assert.match(query.url.search, /(claimant_employee_id|requester_employee_id|employee_id)=eq\.emp-1/);
  }
  assert.deepEqual(writes(captured), []);
});

// ============================================================================
// Availability
// ============================================================================

test("GET /me/availability: 400 without facilityId, 403 non-member, 403 without an employee record, 200 own rows", async (t) => {
  const captured = stubFetch(t, world({ employee_availability: [{ id: "av-1", weekday: 1 }] }));
  assert.equal((await mount().call("GET", "/me/availability")).status, 400);
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", "/me/availability?facilityId=fac-1")).status, 403);
  const ok = await mount().call("GET", "/me/availability?facilityId=fac-1");
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.length, 1);
  assert.equal(captured.find((entry) => entry.table === "employee_availability").url.searchParams.get("employee_id"), "eq.emp-1");
  stubFetch(t, world({ employees: [] }));
  assert.equal((await mount().call("GET", "/me/availability?facilityId=fac-1")).status, 403);
});

test("PUT /me/availability validates the body (400) before any fetch", async (t) => {
  const captured = stubFetch(t, world());
  const { call } = mount();
  assert.equal((await call("PUT", "/me/availability?facilityId=fac-1", { days: [{ weekday: 9 }] })).status, 400);
  assert.equal((await call("PUT", "/me/availability?facilityId=fac-1", {})).status, 400);
  assert.equal((await call("PUT", "/me/availability", { days: [{ weekday: 1 }] })).status, 400);
  assert.equal(captured.length, 0);
});

test("PUT /me/availability denies a non-member (403) and a member with no employee record (403)", async (t) => {
  stubFetch(t, world());
  assert.equal(
    (await mount({ memberships: OUTSIDER }).call("PUT", "/me/availability?facilityId=fac-1", { days: [{ weekday: 1 }] })).status,
    403
  );
  stubFetch(t, world({ employees: [] }));
  assert.equal((await mount().call("PUT", "/me/availability?facilityId=fac-1", { days: [{ weekday: 1 }] })).status, 403);
});

test("PUT /me/availability upserts server-derived rows: facility and employee never come from the body", async (t) => {
  const captured = stubFetch(t, world({ employee_availability: (method, url, body) => (method === "POST" ? body : []) }));
  const { call } = mount();
  const result = await call("PUT", "/me/availability?facilityId=fac-1", {
    employeeId: "emp-evil",
    facilityId: "fac-2",
    effectiveFrom: "2035-01-01",
    days: [
      { weekday: 1, availableStart: "08:00", availableEnd: "16:00", employee_id: "emp-evil" },
      { weekday: 2, unavailable: true }
    ]
  });
  assert.equal(result.status, 200);
  const post = captured.find((entry) => entry.method === "POST");
  assert.equal(post.url.searchParams.get("on_conflict"), "employee_id,weekday,effective_from");
  assert.deepEqual(post.body, [
    {
      weekday: 1,
      unavailable: false,
      available_start_local: "08:00",
      available_end_local: "16:00",
      effective_from: "2035-01-01",
      effective_to: null,
      facility_id: "fac-1",
      employee_id: "emp-1",
      deleted_at: null
    },
    {
      weekday: 2,
      unavailable: true,
      available_start_local: null,
      available_end_local: null,
      effective_from: "2035-01-01",
      effective_to: null,
      facility_id: "fac-1",
      employee_id: "emp-1",
      deleted_at: null
    }
  ]);
});

// ============================================================================
// Open shifts + claims
// ============================================================================

test("GET open-shifts denies a non-member and flags the claim window + the caller's own pending claims", async (t) => {
  const captured = stubFetch(
    t,
    world({
      schedule_periods: [{ id: "per-1" }],
      schedule_shifts: [OPEN_SHIFT, { ...OPEN_SHIFT, id: "shift-old", opened_at: "2020-01-01T00:00:00Z" }],
      open_shift_claims: [{ shift_id: "shift-1" }]
    })
  );
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", "/facilities/fac-1/open-shifts")).status, 403);
  const result = await mount().call("GET", "/facilities/fac-1/open-shifts");
  assert.equal(result.status, 200);
  const byId = Object.fromEntries(result.payload.map((shift) => [shift.id, shift]));
  assert.equal(byId["shift-1"].claim_window_open, true);
  assert.equal(byId["shift-1"].claimed_by_me, true);
  assert.equal(byId["shift-old"].claim_window_open, false);
  const shiftQuery = captured.find((entry) => entry.table === "schedule_shifts");
  assert.equal(shiftQuery.url.searchParams.get("status"), "eq.open");
  assert.equal(captured.find((entry) => entry.table === "schedule_periods").url.searchParams.get("status"), "eq.published");
});

test("POST open-shift-claims: 400 shape, 403 non-member, 403 without an employee record, 404 unknown shift", async (t) => {
  stubFetch(t, world());
  assert.equal((await mount().call("POST", "/facilities/fac-1/open-shift-claims", {})).status, 400);
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" })).status, 403);
  assert.equal((await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" })).status, 404);
  stubFetch(t, world({ employees: [] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" })).status, 403);
});

test("POST open-shift-claims: a shift that is not open is a 409, a closed claim window a 400", async (t) => {
  stubFetch(t, world({ schedule_shifts: [{ ...OPEN_SHIFT, status: "assigned" }] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" })).status, 409);
  const captured = stubFetch(t, world({ schedule_shifts: [{ ...OPEN_SHIFT, opened_at: "2020-01-01T00:00:00Z" }] }));
  const closed = await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(closed.status, 400);
  assert.match(closed.payload.error, /claim window/);
  assert.deepEqual(writes(captured), []);
});

test("POST open-shift-claims: a missing certification is a structured 409 and nothing is inserted", async (t) => {
  const captured = stubFetch(
    t,
    world({
      schedule_shifts: [{ ...OPEN_SHIFT, required_certification_ids: ["ct-1"] }],
      certification_types: [{ id: "ct-1", code: "BLS" }]
    })
  );
  const result = await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(result.status, 409);
  assert.equal(result.payload.blocking[0].code, "missing_certification");
  assert.equal(result.payload.blocking[0].certificationCode, "BLS");
  assert.deepEqual(writes(captured), []);
});

test("POST open-shift-claims: warning-mode cert enforcement lets the claim through with the warning attached", async (t) => {
  stubFetch(
    t,
    world({
      schedule_shifts: [{ ...OPEN_SHIFT, required_certification_ids: ["ct-1"] }],
      certification_types: [{ id: "ct-1", code: "BLS" }],
      modules: [{ id: "mod-sched", code: "scheduling" }],
      facilities: [{ id: "fac-1", organization_id: "org-1", timezone: "America/New_York" }],
      facility_module_overrides: [{ config_patch_jsonb: { "scheduling.certEnforcementMode": "warning" } }],
      open_shift_claims: (method, url, body) => (method === "POST" ? body : [])
    })
  );
  const result = await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(result.status, 201);
  assert.equal(result.payload.warnings[0].code, "missing_certification");
});

test("POST open-shift-claims: an overlapping live assignment is a 409", async (t) => {
  stubFetch(
    t,
    world({
      schedule_shifts: (method, url) =>
        url.searchParams.get("id") === "eq.shift-1"
          ? [OPEN_SHIFT]
          : [{ ...SHIFT_2, starts_at: `${FUTURE_DAY}T12:00:00Z`, ends_at: `${FUTURE_DAY}T20:00:00Z` }],
      shift_assignments: [{ ...ASSIGNMENT_1, id: "asg-x", shift_id: "shift-2" }]
    })
  );
  const result = await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(result.status, 409);
  assert.equal(result.payload.blocking[0].code, "overlap");
});

test("POST open-shift-claims inserts ONLY server-derived columns (claimant from the session, facility from the path)", async (t) => {
  const captured = stubFetch(
    t,
    world({
      schedule_shifts: [OPEN_SHIFT],
      open_shift_claims: (method, url, body) => (method === "POST" ? body.map((row, index) => ({ id: `claim-${index}`, ...row })) : [])
    })
  );
  const result = await mount().call("POST", "/facilities/fac-1/open-shift-claims", {
    shiftId: "shift-1",
    claimantEmployeeId: "emp-evil",
    facilityId: "fac-2",
    claim_status: "approved"
  });
  assert.equal(result.status, 201);
  const [post] = writes(captured);
  assert.equal(post.table, "open_shift_claims");
  assert.deepEqual(post.body, [{ facility_id: "fac-1", shift_id: "shift-1", claimant_employee_id: "emp-1" }]);
});

test("POST open-shift-claims maps a duplicate (409) and a guard rejection (400, relayed message)", async (t) => {
  stubFetch(t, world({ schedule_shifts: [OPEN_SHIFT], open_shift_claims: http(409, { code: "23505", message: "duplicate key" }) }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" })).status, 409);
  stubFetch(
    t,
    world({ schedule_shifts: [OPEN_SHIFT], open_shift_claims: http(400, { code: "23514", message: "open_shift_claims: this shift has already started." }) })
  );
  const guard = await mount().call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(guard.status, 400);
  assert.match(guard.payload.error, /already started/);
});

// ============================================================================
// Swaps
// ============================================================================

test("POST shift-swaps validates the body (400) before any fetch", async (t) => {
  const captured = stubFetch(t, world());
  const { call } = mount();
  const path = "/facilities/fac-1/shift-swaps";
  assert.equal((await call("POST", path, { swapType: "direct" })).status, 400);
  assert.equal((await call("POST", path, { offeredAssignmentId: "asg-1", swapType: "trade" })).status, 400);
  assert.equal((await call("POST", path, { offeredAssignmentId: "asg-1", swapType: "direct" })).status, 400);
  assert.equal((await call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup", requestedAssignmentId: "asg-2" })).status, 400);
  assert.equal((await call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup", reason: 5 })).status, 400);
  assert.equal(captured.length, 0);
});

test("POST shift-swaps: 403 non-member, 403 without an employee record, 404 unknown assignment, 403 when the offered assignment is not the caller's", async (t) => {
  stubFetch(t, world());
  const body = { offeredAssignmentId: "asg-1", swapType: "drop_pickup" };
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", "/facilities/fac-1/shift-swaps", body)).status, 403);
  assert.equal((await mount().call("POST", "/facilities/fac-1/shift-swaps", body)).status, 404);
  stubFetch(t, world({ shift_assignments: [{ ...ASSIGNMENT_1, employee_id: "emp-2" }] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/shift-swaps", body)).status, 403);
  stubFetch(t, world({ employees: [] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/shift-swaps", body)).status, 403);
});

test("POST shift-swaps (direct) derives the target from the requested assignment and ignores a client-sent target/requester", async (t) => {
  const captured = stubFetch(
    t,
    world({
      shift_assignments: (method, url) => (idOf(url) === "asg-1" ? [ASSIGNMENT_1] : idOf(url) === "asg-2" ? [ASSIGNMENT_2] : []),
      shift_swap_requests: (method, url, body) => (method === "POST" ? body.map((row) => ({ id: "swap-1", ...row })) : [])
    })
  );
  const result = await mount().call("POST", "/facilities/fac-1/shift-swaps", {
    offeredAssignmentId: "asg-1",
    requestedAssignmentId: "asg-2",
    swapType: "direct",
    requesterEmployeeId: "emp-evil",
    targetEmployeeId: "emp-evil",
    status: "approved",
    reason: "  family event "
  });
  assert.equal(result.status, 201);
  const [post] = writes(captured);
  assert.deepEqual(post.body, [
    {
      facility_id: "fac-1",
      offered_assignment_id: "asg-1",
      requested_assignment_id: "asg-2",
      requester_employee_id: "emp-1",
      target_employee_id: "emp-2",
      swap_type: "direct",
      reason: "family event"
    }
  ]);
});

test("POST shift-swaps (direct) refuses to swap with yourself and 404s an unknown requested assignment", async (t) => {
  stubFetch(t, world({ shift_assignments: (method, url) => (idOf(url) === "asg-1" ? [ASSIGNMENT_1] : idOf(url) === "asg-3" ? [{ ...ASSIGNMENT_1, id: "asg-3" }] : []) }));
  const self = await mount().call("POST", "/facilities/fac-1/shift-swaps", {
    offeredAssignmentId: "asg-1",
    requestedAssignmentId: "asg-3",
    swapType: "direct"
  });
  assert.equal(self.status, 400);
  const missing = await mount().call("POST", "/facilities/fac-1/shift-swaps", {
    offeredAssignmentId: "asg-1",
    requestedAssignmentId: "asg-404",
    swapType: "direct"
  });
  assert.equal(missing.status, 404);
});

test("POST shift-swaps (drop_pickup): a named pickup must be an active employee of the facility; none means a drop to the open pool", async (t) => {
  const captured = stubFetch(
    t,
    world({
      shift_assignments: [ASSIGNMENT_1],
      employees: (method, url) => {
        if (url.searchParams.get("user_id")) return [{ id: "emp-1" }];
        const id = idOf(url);
        if (id === "emp-2") return [{ id: "emp-2", status: "active", first_name: "S", last_name: "L" }];
        if (id === "emp-3") return [{ id: "emp-3", status: "inactive", first_name: "I", last_name: "N" }];
        return [];
      },
      shift_swap_requests: (method, url, body) => (method === "POST" ? body.map((row) => ({ id: "swap-1", ...row })) : [])
    })
  );
  const path = "/facilities/fac-1/shift-swaps";
  assert.equal((await mount().call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup", targetEmployeeId: "emp-3" })).status, 400);
  assert.equal((await mount().call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup", targetEmployeeId: "emp-404" })).status, 400);
  assert.equal((await mount().call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup", targetEmployeeId: "emp-1" })).status, 400);
  assert.equal((await mount().call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup", targetEmployeeId: "emp-2" })).status, 201);
  assert.equal((await mount().call("POST", path, { offeredAssignmentId: "asg-1", swapType: "drop_pickup" })).status, 201);
  const posts = writes(captured);
  assert.equal(posts[0].body[0].target_employee_id, "emp-2");
  assert.equal(posts[0].body[0].requested_assignment_id, null);
  assert.equal(posts[1].body[0].target_employee_id, null);
});

test("POST shift-swaps maps a duplicate pending swap to 409 and relays a guard message as 400", async (t) => {
  const body = { offeredAssignmentId: "asg-1", swapType: "drop_pickup" };
  stubFetch(t, world({ shift_assignments: [ASSIGNMENT_1], shift_swap_requests: http(409, { code: "23505", message: "dup" }) }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/shift-swaps", body)).status, 409);
  stubFetch(
    t,
    world({ shift_assignments: [ASSIGNMENT_1], shift_swap_requests: http(400, { code: "23514", message: "shift_swap_requests: the offered shift is cancelled or has already started." }) })
  );
  const guard = await mount().call("POST", "/facilities/fac-1/shift-swaps", body);
  assert.equal(guard.status, 400);
  assert.match(guard.payload.error, /already started/);
});

// ============================================================================
// Time off
// ============================================================================

test("POST time-off-requests validates (400, no fetch), denies a non-member (403), and inserts server-derived columns", async (t) => {
  const captured = stubFetch(
    t,
    world({ time_off_requests: (method, url, body) => (method === "POST" ? body.map((row) => ({ id: "to-1", ...row })) : []) })
  );
  const { call } = mount();
  const path = "/facilities/fac-1/time-off-requests";
  assert.equal((await call("POST", path, { startsAt: "2035-04-02T00:00:00Z", endsAt: "2035-04-01T00:00:00Z" })).status, 400);
  assert.equal((await call("POST", path, { startsAt: "2020-04-01T00:00:00Z", endsAt: "2020-04-02T00:00:00Z" })).status, 400);
  assert.equal(captured.length, 0);
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", path, { startsAt: "2035-04-01T00:00:00Z", endsAt: "2035-04-02T00:00:00Z" })).status, 403);

  const result = await call("POST", path, {
    startsAt: "2035-04-01T00:00:00Z",
    endsAt: "2035-04-03T00:00:00Z",
    requestType: "vacation",
    reason: "trip",
    employeeId: "emp-evil",
    status: "approved"
  });
  assert.equal(result.status, 201);
  const [post] = writes(captured);
  assert.deepEqual(post.body, [
    {
      facility_id: "fac-1",
      employee_id: "emp-1",
      starts_at: "2035-04-01T00:00:00.000Z",
      ends_at: "2035-04-03T00:00:00.000Z",
      request_type: "vacation",
      reason: "trip"
    }
  ]);
});

test("POST time-off-requests: no employee record is a 403; a guard rejection is relayed as 400", async (t) => {
  const input = { startsAt: "2035-04-01T00:00:00Z", endsAt: "2035-04-02T00:00:00Z" };
  stubFetch(t, world({ employees: [] }));
  assert.equal((await mount().call("POST", "/facilities/fac-1/time-off-requests", input)).status, 403);
  stubFetch(t, world({ time_off_requests: http(400, { code: "23514", message: "time_off_requests: the requested window has already ended." }) }));
  const guard = await mount().call("POST", "/facilities/fac-1/time-off-requests", input);
  assert.equal(guard.status, 400);
  assert.match(guard.payload.error, /already ended/);
});

// ============================================================================
// Requester-side cancellation
// ============================================================================

for (const { path, owner, statusColumn, table, to } of [
  { path: "open-shift-claims/req-1/withdraw", owner: "claimant_employee_id", statusColumn: "claim_status", table: "open_shift_claims", to: "withdrawn" },
  { path: "shift-swaps/req-1/cancel", owner: "requester_employee_id", statusColumn: "status", table: "shift_swap_requests", to: "cancelled" },
  { path: "time-off-requests/req-1/cancel", owner: "employee_id", statusColumn: "status", table: "time_off_requests", to: "cancelled" }
]) {
  test(`POST ${path} updates only the caller's own live row`, async (t) => {
    const captured = stubFetch(t, world({ [table]: (method, url, body) => (method === "PATCH" ? [{ id: "req-1", ...body }] : []) }));
    const result = await mount().call("POST", `/facilities/fac-1/${path}`);
    assert.equal(result.status, 200);
    const patch = captured.find((entry) => entry.method === "PATCH");
    assert.equal(patch.url.searchParams.get("id"), "eq.req-1");
    assert.equal(patch.url.searchParams.get("facility_id"), "eq.fac-1");
    assert.equal(patch.url.searchParams.get(owner), "eq.emp-1");
    assert.match(patch.url.searchParams.get(statusColumn), /^in\.\(/);
    assert.deepEqual(patch.body, { [statusColumn]: to });
  });

  test(`POST ${path}: another employee's id matches nothing (404); non-member 403; no employee record 403`, async (t) => {
    stubFetch(t, world({ [table]: [] }));
    assert.equal((await mount().call("POST", `/facilities/fac-1/${path}`)).status, 404);
    assert.equal((await mount({ memberships: OUTSIDER }).call("POST", `/facilities/fac-1/${path}`)).status, 403);
    stubFetch(t, world({ employees: [] }));
    assert.equal((await mount().call("POST", `/facilities/fac-1/${path}`)).status, 403);
  });
}

test("cancelling a started approved time-off request relays the guard's 400", async (t) => {
  stubFetch(t, world({ time_off_requests: http(400, { code: "23514", message: "time_off_requests: approved time off that has already started cannot be cancelled." }) }));
  const result = await mount().call("POST", "/facilities/fac-1/time-off-requests/req-1/cancel");
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /already started/);
});

// ============================================================================
// GET approvals
// ============================================================================

const CLAIM_ROW = {
  id: "req-1",
  facility_id: "fac-1",
  shift_id: "shift-1",
  claimant_employee_id: "emp-1",
  claim_status: "pending",
  created_at: "2035-01-01T00:00:00Z"
};
const SWAP_ROW = {
  id: "req-1",
  facility_id: "fac-1",
  offered_assignment_id: "asg-1",
  requested_assignment_id: "asg-2",
  requester_employee_id: "emp-1",
  target_employee_id: "emp-2",
  target_accepted_at: "2035-01-02T06:00:00Z",
  target_declined_at: null,
  swap_type: "direct",
  status: "pending",
  reason: null,
  created_at: "2035-01-02T00:00:00Z"
};
const TIME_OFF_ROW = {
  id: "req-1",
  facility_id: "fac-1",
  employee_id: "emp-1",
  starts_at: "2035-04-01T00:00:00Z",
  ends_at: "2035-04-03T00:00:00Z",
  request_type: "vacation",
  status: "pending",
  reason: null,
  created_at: "2035-01-03T00:00:00Z"
};

function approvalsWorld() {
  return world({
    open_shift_claims: [CLAIM_ROW],
    shift_swap_requests: [SWAP_ROW],
    time_off_requests: [TIME_OFF_ROW],
    shift_assignments: [ASSIGNMENT_1, ASSIGNMENT_2],
    schedule_shifts: [OPEN_SHIFT, SHIFT_2],
    employees: [
      { id: "emp-1", first_name: "Alex", last_name: "Rivera" },
      { id: "emp-2", first_name: "Sam", last_name: "Lee" }
    ]
  });
}

test("GET approvals: 403 without any approver code; 403 for a type the caller cannot decide; 400 for a bad type/status/limit", async (t) => {
  const captured = stubFetch(t, approvalsWorld());
  assert.equal((await mount({ memberships: READER }).call("GET", "/facilities/fac-1/approvals")).status, 403);
  assert.equal((await mount({ memberships: STAFF }).call("GET", "/facilities/fac-1/approvals")).status, 403);
  assert.equal((await mount({ memberships: SWAP_APPROVER }).call("GET", "/facilities/fac-1/approvals?type=time_off")).status, 403);
  assert.equal((await mount({ memberships: MANAGER }).call("GET", "/facilities/fac-1/approvals?type=time_off")).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", "/facilities/fac-1/approvals")).status, 403);
  assert.equal((await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?type=bogus")).status, 400);
  assert.equal((await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?status=bogus")).status, 400);
  assert.equal((await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?limit=0")).status, 400);
  assert.equal(captured.length, 0);
});

test("GET approvals is scoped to the kinds the caller may decide", async (t) => {
  for (const [memberships, tables, types] of [
    [SWAP_APPROVER, ["shift_swap_requests"], ["swaps"]],
    [TIME_OFF_APPROVER, ["time_off_requests"], ["time_off"]],
    [CLAIM_APPROVER, ["open_shift_claims"], ["claims"]],
    // schedule.manage satisfies claims + swaps but NOT time off.
    [MANAGER, ["open_shift_claims", "shift_swap_requests"], ["claims", "swaps"]],
    [FULL, ["open_shift_claims", "shift_swap_requests", "time_off_requests"], ["claims", "swaps", "time_off"]]
  ]) {
    const captured = stubFetch(t, approvalsWorld());
    const result = await mount({ memberships }).call("GET", "/facilities/fac-1/approvals");
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.permittedTypes, types);
    const queried = new Set(captured.map((entry) => entry.table));
    for (const table of ["open_shift_claims", "shift_swap_requests", "time_off_requests"]) {
      assert.equal(queried.has(table), tables.includes(table), `${table} for ${types.join("+")}`);
    }
    assert.deepEqual([...new Set(result.payload.items.map((item) => item.type))].sort(), [...types].sort());
  }
});

test("GET approvals normalises, orders oldest-first, filters by status and honours type/limit/offset", async (t) => {
  const captured = stubFetch(t, approvalsWorld());
  const all = await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals");
  assert.deepEqual(all.payload.items.map((item) => item.type), ["claims", "swaps", "time_off"]);
  assert.equal(all.payload.items[0].employeeName, "Alex Rivera");
  assert.equal(all.payload.items[1].targetEmployeeName, "Sam Lee");
  assert.equal(all.payload.items[1].requestedShift.id, "shift-2");
  const claimQuery = captured.find((entry) => entry.table === "open_shift_claims");
  assert.equal(claimQuery.url.searchParams.get("claim_status"), "eq.pending");
  assert.equal(claimQuery.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(captured.find((entry) => entry.table === "shift_swap_requests").url.searchParams.get("status"), "eq.pending");

  const paged = await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?limit=1&offset=1");
  assert.deepEqual(paged.payload.items.map((item) => item.type), ["swaps"]);

  const swapsOnly = await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?type=swaps&status=all");
  assert.deepEqual(swapsOnly.payload.items.map((item) => item.type), ["swaps"]);
  const lastSwapQuery = captured.filter((entry) => entry.table === "shift_swap_requests").pop();
  assert.equal(lastSwapQuery.url.searchParams.get("status"), null);

  // 'withdrawn' exists only for claims: the other two kinds are not even queried.
  const before = captured.length;
  const withdrawn = await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?status=withdrawn");
  assert.deepEqual(withdrawn.payload.items.map((item) => item.type), ["claims"]);
  const tablesAfter = new Set(captured.slice(before).map((entry) => entry.table));
  assert.equal(tablesAfter.has("shift_swap_requests"), false);
  assert.equal(tablesAfter.has("time_off_requests"), false);
});

// ============================================================================
// Decisions (approve / deny) -- the atomic RPC call shape
// ============================================================================

const DECISION_KINDS = [
  { name: "claims", path: "open-shift-claims", table: "open_shift_claims", rpc: "decide_open_shift_claim", row: CLAIM_ROW, statusColumn: "claim_status", holder: CLAIM_APPROVER, wrong: [SWAP_APPROVER, TIME_OFF_APPROVER, READER], manageSatisfies: true },
  { name: "swaps", path: "shift-swaps", table: "shift_swap_requests", rpc: "decide_shift_swap", row: SWAP_ROW, statusColumn: "status", holder: SWAP_APPROVER, wrong: [CLAIM_APPROVER, TIME_OFF_APPROVER, READER], manageSatisfies: true },
  { name: "time off", path: "time-off-requests", table: "time_off_requests", rpc: "decide_time_off_request", row: TIME_OFF_ROW, statusColumn: "status", holder: TIME_OFF_APPROVER, wrong: [CLAIM_APPROVER, SWAP_APPROVER, MANAGER, READER], manageSatisfies: false }
];

// An eligible world for every kind: the request itself plus the rows the
// pre-validation reads. The RPC answers with a canned decided payload.
function decisionWorld(kind, { row = kind.row, rpcResult, extra = {} } = {}) {
  return world({
    [kind.table]: (method, url) => (url.pathname.endsWith(`/rpc/${kind.rpc}`) ? [] : [row]),
    [`rpc/${kind.rpc}`]: rpcResult ?? { decided: true, replay: false, request: { id: "req-1" } },
    schedule_shifts: (method, url) => {
      const id = idOf(url);
      return id === "shift-2" ? [SHIFT_2] : [{ ...OPEN_SHIFT, status: kind.name === "claims" ? "open" : "assigned" }];
    },
    shift_assignments: (method, url) => {
      const id = idOf(url);
      if (id === "asg-1") return [ASSIGNMENT_1];
      if (id === "asg-2") return [ASSIGNMENT_2];
      return [];
    },
    ...extra
  });
}

for (const kind of DECISION_KINDS) {
  for (const action of ["approve", "deny"]) {
    const path = `/facilities/fac-1/${kind.path}/req-1/${action}`;

    test(`POST ${kind.path}/:id/${action}: 403 for a plain member and for every code that is not this kind's approver code`, async (t) => {
      const captured = stubFetch(t, decisionWorld(kind));
      const body = { reason: "because" };
      for (const memberships of [STAFF, OUTSIDER, ...kind.wrong]) {
        const result = await mount({ memberships }).call("POST", path, body);
        assert.equal(result.status, 403, JSON.stringify(memberships));
      }
      // Gated before any row is read: nothing was fetched at all.
      assert.equal(captured.length, 0);
    });

    test(`POST ${kind.path}/:id/${action}: the approver code, and schedule.manage where the design says so, are allowed`, async (t) => {
      stubFetch(t, decisionWorld(kind));
      const body = { reason: "because" };
      assert.equal((await mount({ memberships: kind.holder }).call("POST", path, body)).status, 200);
      assert.equal((await mount({ memberships: FULL }).call("POST", path, body)).status, 200);
      const manage = await mount({ memberships: MANAGER }).call("POST", path, body);
      assert.equal(manage.status, kind.manageSatisfies ? 200 : 403);
    });
  }

  test(`POST ${kind.path}/:id/deny requires a reason (400) before any fetch`, async (t) => {
    const captured = stubFetch(t, decisionWorld(kind));
    const { call } = mount({ memberships: FULL });
    const path = `/facilities/fac-1/${kind.path}/req-1/deny`;
    assert.equal((await call("POST", path, {})).status, 400);
    assert.equal((await call("POST", path, { reason: "   " })).status, 400);
    assert.equal((await call("POST", path, { reason: 7 })).status, 400);
    assert.equal(captured.length, 0);
  });

  test(`POST ${kind.path}/:id/approve: invalid JSON is a 400; an unknown request is a 404`, async (t) => {
    stubFetch(t, world({ [kind.table]: [] }));
    const { call } = mount({ memberships: FULL });
    assert.equal((await call("POST", `/facilities/fac-1/${kind.path}/req-1/approve`, {})).status, 404);
    const router = createRouter();
    const sent = [];
    registerSchedulingSelfServiceRoutes(router, {
      authenticate: async () => ({ claims: { sub: "u" }, client: createClient({ url: "https://x.supabase.co", key: "k" }), memberships: FULL, error: null }),
      sendJson: (response, status, payload) => sent.push({ status, payload }),
      readBody: async () => "{not json"
    });
    const { handler, params } = router.match({ method: "POST", url: `/facilities/fac-1/${kind.path}/req-1/approve` });
    await handler({ url: "/x" }, {}, { env: {}, params });
    assert.equal(sent[0].status, 400);
  });

  test(`POST ${kind.path}/:id/approve makes exactly ONE write -- the ${kind.rpc} RPC -- with only the request id and the validated decision`, async (t) => {
    const captured = stubFetch(t, decisionWorld(kind));
    const result = await mount({ memberships: FULL }).call("POST", `/facilities/fac-1/${kind.path}/req-1/approve`, {
      reason: "  fine  ",
      // Everything below is client noise the route must not forward.
      status: "approved",
      facilityId: "fac-2",
      employeeId: "emp-evil",
      p_request_id: "other"
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload, { decided: true, replay: false, request: { id: "req-1" } });
    const issued = writes(captured);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].method, "POST");
    assert.equal(issued[0].table, `rpc/${kind.rpc}`);
    assert.deepEqual(issued[0].body, { p_request_id: "req-1", p_decision: "approve", p_reason: "fine" });
    // The request was loaded scoped to BOTH the id and the path's facility.
    const load = captured.find((entry) => entry.table === kind.table);
    assert.equal(load.url.searchParams.get("id"), "eq.req-1");
    assert.equal(load.url.searchParams.get("facility_id"), "eq.fac-1");
  });

  test(`POST ${kind.path}/:id/deny forwards the reason to the RPC and nothing else`, async (t) => {
    const captured = stubFetch(t, decisionWorld(kind));
    const result = await mount({ memberships: FULL }).call("POST", `/facilities/fac-1/${kind.path}/req-1/deny`, { reason: "short staffed" });
    assert.equal(result.status, 200);
    const issued = writes(captured);
    assert.equal(issued.length, 1);
    assert.deepEqual(issued[0].body, { p_request_id: "req-1", p_decision: "deny", p_reason: "short staffed" });
    // A denial never runs the eligibility pre-validation.
    assert.equal(captured.some((entry) => ["employee_certifications", "certification_types"].includes(entry.table)), false);
  });

  test(`POST ${kind.path}/:id/approve maps RPC failures: 403, 404, 409 (+details), 400`, async (t) => {
    const path = `/facilities/fac-1/${kind.path}/req-1/approve`;
    const failWith = (status, body) => decisionWorld(kind, { extra: { [`rpc/${kind.rpc}`]: http(status, body) } });

    stubFetch(t, failWith(403, { code: "42501", message: "decide: missing permission" }));
    assert.deepEqual(await mount({ memberships: FULL }).call("POST", path, {}), { status: 403, payload: { error: "decide: missing permission" } });
    stubFetch(t, failWith(404, { code: "P0002", message: "decide: request not found" }));
    assert.equal((await mount({ memberships: FULL }).call("POST", path, {})).status, 404);
    stubFetch(
      t,
      failWith(409, { code: "PT409", message: "decide: the shift is no longer open", details: JSON.stringify({ blocking: [{ code: "overlap" }] }) })
    );
    const conflict = await mount({ memberships: FULL }).call("POST", path, {});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.error, "decide: the shift is no longer open");
    assert.deepEqual(conflict.payload.details, { blocking: [{ code: "overlap" }] });
    stubFetch(t, failWith(400, { code: "23514", message: "decide: a denial requires a reason" }));
    assert.equal((await mount({ memberships: FULL }).call("POST", path, {})).status, 400);
  });

  test(`POST ${kind.path}/:id/approve is replay-safe: an already-decided request goes straight to the RPC without re-validation`, async (t) => {
    const captured = stubFetch(
      t,
      decisionWorld(kind, {
        row: { ...kind.row, [kind.statusColumn]: "approved" },
        rpcResult: { decided: false, replay: true, request: { id: "req-1" } }
      })
    );
    const result = await mount({ memberships: FULL }).call("POST", `/facilities/fac-1/${kind.path}/req-1/approve`, {});
    assert.equal(result.status, 200);
    assert.equal(result.payload.replay, true);
    assert.equal(captured.some((entry) => entry.table === "employee_certifications"), false);
    assert.equal(writes(captured).length, 1);
  });
}

test("approving a claim for an ineligible claimant is a structured 409 and never reaches the RPC", async (t) => {
  const kind = DECISION_KINDS[0];
  const captured = stubFetch(
    t,
    decisionWorld(kind, {
      extra: {
        schedule_shifts: [{ ...OPEN_SHIFT, required_certification_ids: ["ct-1"] }],
        certification_types: [{ id: "ct-1", code: "BLS" }]
      }
    })
  );
  const result = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/open-shift-claims/req-1/approve", {});
  assert.equal(result.status, 409);
  assert.deepEqual(result.payload.reasons, ["claimant_ineligible"]);
  assert.equal(result.payload.blocking[0].code, "missing_certification");
  assert.deepEqual(writes(captured), []);
});

test("approving a claim whose shift is no longer open is a 409 (no RPC)", async (t) => {
  const kind = DECISION_KINDS[0];
  const captured = stubFetch(t, decisionWorld(kind, { extra: { schedule_shifts: [{ ...OPEN_SHIFT, status: "assigned" }] } }));
  const result = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/open-shift-claims/req-1/approve", {});
  assert.equal(result.status, 409);
  assert.deepEqual(result.payload.reasons, ["shift_not_open"]);
  assert.deepEqual(writes(captured), []);
});

test("denying a claim never needs the shift to still be open", async (t) => {
  const kind = DECISION_KINDS[0];
  const captured = stubFetch(t, decisionWorld(kind, { extra: { schedule_shifts: [{ ...OPEN_SHIFT, status: "cancelled" }] } }));
  const result = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/open-shift-claims/req-1/deny", { reason: "shift cancelled" });
  assert.equal(result.status, 200);
  assert.equal(writes(captured).length, 1);
});

test("approving a stale swap (offered assignment cancelled) is a 409 with stale=true and never reaches the RPC", async (t) => {
  const kind = DECISION_KINDS[1];
  const captured = stubFetch(
    t,
    decisionWorld(kind, {
      extra: { shift_assignments: (method, url) => (idOf(url) === "asg-1" ? [{ ...ASSIGNMENT_1, status: "cancelled" }] : [ASSIGNMENT_2]) }
    })
  );
  const result = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/shift-swaps/req-1/approve", {});
  assert.equal(result.status, 409);
  assert.equal(result.payload.stale, true);
  assert.deepEqual(result.payload.reasons, ["offered_assignment_changed"]);
  assert.deepEqual(writes(captured), []);
});

test("approving a swap whose incoming employee lacks a required certification is a 409 (no RPC)", async (t) => {
  const kind = DECISION_KINDS[1];
  const captured = stubFetch(
    t,
    decisionWorld(kind, {
      extra: {
        // Both legs sit on shifts that need BLS; nobody holds it.
        schedule_shifts: (method, url) =>
          idOf(url) === "shift-2"
            ? [{ ...SHIFT_2, required_certification_ids: ["ct-1"] }]
            : [{ ...OPEN_SHIFT, status: "assigned", required_certification_ids: ["ct-1"] }],
        certification_types: [{ id: "ct-1", code: "BLS" }]
      }
    })
  );
  const result = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/shift-swaps/req-1/approve", {});
  assert.equal(result.status, 409);
  assert.equal(result.payload.stale, false);
  assert.deepEqual(result.payload.reasons, ["participant_ineligible"]);
  assert.deepEqual(writes(captured), []);
});

test("a swap approver who cannot read a leg skips pre-validation and lets the RPC decide on the full data", async (t) => {
  const kind = DECISION_KINDS[1];
  const captured = stubFetch(t, decisionWorld(kind, { extra: { shift_assignments: [] } }));
  const result = await mount({ memberships: SWAP_APPROVER }).call("POST", "/facilities/fac-1/shift-swaps/req-1/approve", {});
  assert.equal(result.status, 200);
  assert.equal(writes(captured).length, 1);
});

test("an unexpected RPC failure (500) is not swallowed into a 4xx", async (t) => {
  const kind = DECISION_KINDS[2];
  stubFetch(t, decisionWorld(kind, { extra: { [`rpc/${kind.rpc}`]: http(500, { code: "XX000", message: "boom" }) } }));
  await assert.rejects(() => mount({ memberships: FULL }).call("POST", "/facilities/fac-1/time-off-requests/req-1/approve", {}));
});

// ============================================================================
// Review fixes: RLS-honest reads for plain members (F1), settings through the
// definer RPC (M2), the colleague's consent on swaps (M1), the approvals
// offset cap (L4).
// ============================================================================

const PUBLISHED_PERIOD = {
  id: "per-1",
  facility_id: "fac-1",
  status: "published",
  publish_version: 1,
  week_start_date: "2035-03-05",
  week_end_date: "2035-03-11",
  deleted_at: null
};
const DRAFT_PERIOD = { ...PUBLISHED_PERIOD, id: "per-draft", status: "draft", publish_version: 0 };

// Wraps a world so it answers the way the database does for a caller holding
// `permissions`: without schedule.read/schedule.manage, schedule_periods
// returns only PUBLISHED rows (the 0062 "members can read published schedule
// periods" policy) -- a mock that hands a plain member the draft row, or that
// returns periods the real policy would not, hides a defect. The two settings
// tables answer with zero rows unless the caller holds admin.manage.
function rlsFor(permissions, tables) {
  const inner = world(tables);
  const isReader = permissions.includes("schedule.read") || permissions.includes("schedule.manage");
  return (table, method, url, body) => {
    const rows = inner(table, method, url, body);
    if (table === "schedule_periods" && !isReader) {
      return (rows ?? []).filter((row) => row.status === "published" && !row.deleted_at);
    }
    return rows;
  };
}

test("GET /me/schedule works for a plain member (no schedule.read): published period rows are readable, draft ones are not, settings come from the RPC", async (t) => {
  const captured = stubFetch(
    t,
    rlsFor([], {
      schedule_periods: [DRAFT_PERIOD, PUBLISHED_PERIOD],
      schedule_shifts: [SHIFT_1_ASSIGNED, { ...SHIFT_2, schedule_period_id: "per-draft", id: "shift-draft" }],
      shift_assignments: [ASSIGNMENT_1]
    })
  );
  const result = await mount({ memberships: STAFF }).call("GET", "/me/schedule?facilityId=fac-1&week_start=2035-03-05");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.assignments.map((entry) => entry.assignment.id), ["asg-1"]);
  assert.deepEqual(result.payload.assignments.map((entry) => entry.shift.id), ["shift-1"]);
  // The route reads only the published period (the draft row is excluded both
  // by the filter it sends and by the policy it relies on).
  const periodQuery = captured.find((entry) => entry.table === "schedule_periods");
  assert.equal(periodQuery.url.searchParams.get("status"), "eq.published");
  // Settings: through the RPC, never a direct read of the admin-only tables.
  assert.ok(captured.some((entry) => entry.table === "rpc/get_scheduling_config_layers" && entry.body.p_facility_id === "fac-1"));
  for (const entry of captured) {
    assert.ok(!["facility_module_overrides", "organization_module_settings", "modules"].includes(entry.table), `read ${entry.table} directly`);
  }
  assert.deepEqual(writes(captured), []);
});

test("GET open-shifts works for a plain member and applies the facility's claim window from the RPC-served settings", async (t) => {
  stubFetch(
    t,
    rlsFor([], {
      schedule_periods: [DRAFT_PERIOD, PUBLISHED_PERIOD],
      schedule_shifts: [{ ...OPEN_SHIFT, opened_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString() }],
      facility_module_overrides: [{ config_patch_jsonb: { "scheduling.openShiftClaimWindowHours": 168, "communications.x": "ignored" } }]
    })
  );
  const result = await mount({ memberships: STAFF }).call("GET", "/facilities/fac-1/open-shifts");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  // 72h old: closed under the 48h default, open under the facility's 168h.
  assert.equal(result.payload[0].claim_window_open, true);
});

test("POST open-shift-claims: a hard-block time-off mode set by an admin binds a plain member's pre-validation (the setting is not lost to RLS)", async (t) => {
  const timeOff = {
    id: "to-1",
    facility_id: "fac-1",
    employee_id: "emp-1",
    starts_at: "2035-03-04T00:00:00Z",
    ends_at: "2035-03-06T00:00:00Z",
    status: "approved",
    deleted_at: null
  };
  const base = {
    schedule_shifts: [OPEN_SHIFT],
    time_off_requests: [timeOff],
    open_shift_claims: (method, url, body) => (method === "POST" ? body.map((row, index) => ({ id: `claim-${index}`, ...row })) : [])
  };
  const blockedCaptured = stubFetch(
    t,
    rlsFor([], { ...base, facility_module_overrides: [{ config_patch_jsonb: { "scheduling.timeOffConflictMode": "hard-block" } }] })
  );
  const blocked = await mount({ memberships: STAFF }).call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.payload.blocking.some((entry) => entry.code === "time_off"));
  assert.deepEqual(writes(blockedCaptured), []);
  // Non-vacuous: the registry default (warning) lets the same claim through.
  stubFetch(t, rlsFor([], base));
  const allowed = await mount({ memberships: STAFF }).call("POST", "/facilities/fac-1/open-shift-claims", { shiftId: "shift-1" });
  assert.equal(allowed.status, 201);
  assert.ok(allowed.payload.warnings.some((entry) => entry.code === "time_off"));
});

test("GET /me/schedule lists the swap requests that NAME the caller and still await an answer, with the requester's name", async (t) => {
  const incoming = { ...SWAP_ROW, id: "swap-in", requester_employee_id: "emp-2", target_employee_id: "emp-1", target_accepted_at: null };
  const captured = stubFetch(
    t,
    rlsFor([], {
      schedule_periods: [PUBLISHED_PERIOD],
      shift_swap_requests: (method, url) =>
        url.searchParams.get("target_employee_id") === "eq.emp-1" ? [incoming] : [],
      employees: (method, url) =>
        url.searchParams.get("id")?.startsWith("in.")
          ? [{ id: "emp-2", first_name: "Sam", last_name: "Lee" }]
          : [{ id: "emp-1", status: "active", first_name: "Alex", last_name: "Rivera" }]
    })
  );
  const result = await mount({ memberships: STAFF }).call("GET", "/me/schedule?facilityId=fac-1&week_start=2035-03-05");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.incomingSwaps.map((swap) => [swap.id, swap.requester_name]), [["swap-in", "Sam Lee"]]);
  const incomingQuery = captured.find(
    (entry) => entry.table === "shift_swap_requests" && entry.url.searchParams.get("target_employee_id") === "eq.emp-1"
  );
  assert.equal(incomingQuery.url.searchParams.get("status"), "eq.pending");
  // Requests already answered never show up as "awaiting".
  stubFetch(
    t,
    rlsFor([], {
      schedule_periods: [PUBLISHED_PERIOD],
      shift_swap_requests: (method, url) =>
        url.searchParams.get("target_employee_id") === "eq.emp-1"
          ? [{ ...incoming, target_accepted_at: "2035-01-01T00:00:00Z" }]
          : []
    })
  );
  const answered = await mount({ memberships: STAFF }).call("GET", "/me/schedule?facilityId=fac-1&week_start=2035-03-05");
  assert.deepEqual(answered.payload.incomingSwaps, []);
});

for (const answer of ["accept", "decline"]) {
  test(`POST shift-swaps/:id/${answer}: member only, scoped to the path's facility, exactly one RPC with the request id and the answer`, async (t) => {
    const path = `/facilities/fac-1/shift-swaps/req-1/${answer}`;
    const rpcBody = { replay: false, request: { id: "req-1" } };
    const captured = stubFetch(
      t,
      world({ shift_swap_requests: [{ id: "req-1", facility_id: "fac-1" }], "rpc/respond_to_shift_swap": rpcBody })
    );
    // A non-member is refused before anything is read.
    assert.equal((await mount({ memberships: OUTSIDER }).call("POST", path, {})).status, 403);
    assert.equal(captured.length, 0);
    // A plain member (no schedule permission at all) can answer.
    const ok = await mount({ memberships: STAFF }).call("POST", path, { response: "other", status: "approved", p_response: "evil" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.payload, rpcBody);
    const issued = writes(captured);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].table, "rpc/respond_to_shift_swap");
    // Only the id (from the loaded row) and the route's own answer cross the boundary.
    assert.deepEqual(issued[0].body, { p_request_id: "req-1", p_response: answer });
    const load = captured.find((entry) => entry.table === "shift_swap_requests");
    assert.equal(load.url.searchParams.get("id"), "eq.req-1");
    assert.equal(load.url.searchParams.get("facility_id"), "eq.fac-1");
  });
}

test("POST shift-swaps/:id/accept: an unknown / other-facility request is a 404 (no RPC); RPC failures map to 404 / 409 / 400", async (t) => {
  const path = "/facilities/fac-1/shift-swaps/req-1/accept";
  const missing = stubFetch(t, world({ shift_swap_requests: [] }));
  assert.equal((await mount({ memberships: STAFF }).call("POST", path, {})).status, 404);
  assert.deepEqual(writes(missing), []);
  const failWith = (status, body) =>
    world({ shift_swap_requests: [{ id: "req-1", facility_id: "fac-1" }], "rpc/respond_to_shift_swap": http(status, body) });
  stubFetch(t, failWith(404, { code: "P0002", message: "respond_to_shift_swap: request not found" }));
  assert.equal((await mount({ memberships: STAFF }).call("POST", path, {})).status, 404);
  stubFetch(t, failWith(409, { code: "PT409", message: "respond_to_shift_swap: this request can no longer be answered" }));
  assert.equal((await mount({ memberships: STAFF }).call("POST", path, {})).status, 409);
  stubFetch(t, failWith(400, { code: "22023", message: "respond_to_shift_swap: response must be accept or decline" }));
  assert.equal((await mount({ memberships: STAFF }).call("POST", path, {})).status, 400);
  stubFetch(t, failWith(500, { code: "XX000", message: "boom" }));
  await assert.rejects(() => mount({ memberships: STAFF }).call("POST", path, {}));
});

test("approving a swap whose named colleague has not accepted is a 409 (awaitingTarget) and never reaches the RPC; denying does not wait", async (t) => {
  const kind = DECISION_KINDS[1];
  const awaiting = { ...SWAP_ROW, target_accepted_at: null };
  const captured = stubFetch(t, decisionWorld(kind, { row: awaiting }));
  const blocked = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/shift-swaps/req-1/approve", {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.payload.awaitingTarget, true);
  assert.deepEqual(writes(captured), []);
  // Non-vacuous: the same request, once accepted, goes through; and a deny never waits.
  stubFetch(t, decisionWorld(kind, { row: SWAP_ROW }));
  assert.equal((await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/shift-swaps/req-1/approve", {})).status, 200);
  const denied = stubFetch(t, decisionWorld(kind, { row: awaiting }));
  const denial = await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/shift-swaps/req-1/deny", { reason: "no" });
  assert.equal(denial.status, 200);
  assert.equal(writes(denied).length, 1);
  // A pickup with no named colleague needs no acceptance.
  stubFetch(t, decisionWorld(kind, { row: { ...awaiting, swap_type: "drop_pickup", requested_assignment_id: null, target_employee_id: null } }));
  assert.equal((await mount({ memberships: FULL }).call("POST", "/facilities/fac-1/shift-swaps/req-1/approve", {})).status, 200);
});

test("GET approvals caps offset (and limit): a runaway window is a 400 before any table is read", async (t) => {
  const captured = stubFetch(t, approvalsWorld());
  const { call } = mount({ memberships: FULL });
  assert.equal((await call("GET", "/facilities/fac-1/approvals?offset=1001")).status, 400);
  assert.equal((await call("GET", "/facilities/fac-1/approvals?offset=99999999")).status, 400);
  assert.equal(captured.length, 0);
  assert.equal((await call("GET", "/facilities/fac-1/approvals?offset=1000")).status, 200);
  // limit is still clamped to the page maximum in the query it sends.
  const limited = stubFetch(t, approvalsWorld());
  await mount({ memberships: FULL }).call("GET", "/facilities/fac-1/approvals?limit=100000&offset=5");
  const query = limited.find((entry) => entry.table === "open_shift_claims");
  assert.equal(query.url.searchParams.get("limit"), "205");
});

test("GET approvals exposes whether a swap still awaits its named colleague", async (t) => {
  stubFetch(
    t,
    world({
      shift_swap_requests: [{ ...SWAP_ROW, target_accepted_at: null }, { ...SWAP_ROW, id: "req-2", target_accepted_at: "2035-01-02T06:00:00Z" }],
      shift_assignments: [ASSIGNMENT_1, ASSIGNMENT_2],
      schedule_shifts: [OPEN_SHIFT, SHIFT_2]
    })
  );
  const result = await mount({ memberships: SWAP_APPROVER }).call("GET", "/facilities/fac-1/approvals?type=swaps");
  assert.equal(result.status, 200);
  const byId = Object.fromEntries(result.payload.items.map((item) => [item.id, item]));
  assert.equal(byId["req-1"].awaitingTarget, true);
  assert.equal(byId["req-2"].awaitingTarget, false);
});
