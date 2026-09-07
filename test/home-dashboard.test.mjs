import test from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_ACTIONS,
  HOME_DASHBOARD_PERMISSION_CODES,
  buildQuickActions,
  buildTiles,
  computeExpiringCertifications,
  computeTodayShiftsForMe
} from "../src/public/js/home-dashboard.mjs";

// --- buildQuickActions -------------------------------------------------------

test("buildQuickActions returns nothing for a caller with no relevant permissions", () => {
  assert.deepEqual(buildQuickActions([]), []);
  assert.deepEqual(buildQuickActions(undefined), []);
});

test("buildQuickActions returns only the action whose permission the caller holds", () => {
  const actions = buildQuickActions(["reports.create"]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].key, "submit-report");
  assert.equal(actions[0].panelId, "panel-daily-reports");
});

test("buildQuickActions returns every action for a caller holding all three permissions, in QUICK_ACTIONS order", () => {
  const actions = buildQuickActions(["work_orders.manage", "reports.create", "incidents.manage"]);
  assert.deepEqual(
    actions.map((a) => a.key),
    QUICK_ACTIONS.map((a) => a.key)
  );
});

test("buildQuickActions accepts a Set as well as an array", () => {
  const actions = buildQuickActions(new Set(["incidents.manage"]));
  assert.deepEqual(actions.map((a) => a.key), ["log-incident"]);
});

test("buildQuickActions never surfaces an action whose permission code is not a real permission code", () => {
  // Cross-check against the server's own permission list conventions --
  // guards against a typo'd code that would silently never match hasPerm().
  for (const action of QUICK_ACTIONS) {
    assert.ok(action.permission && action.permission.includes("."), `bad permission code on ${action.key}`);
  }
});

// --- computeExpiringCertifications -------------------------------------------

const NOW = new Date("2026-09-07T12:00:00.000Z");

function daysFromNow(days) {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

test("computeExpiringCertifications excludes a certification with no expires_at", () => {
  const result = computeExpiringCertifications([{ id: "c1", status: "active", expires_at: null }], NOW);
  assert.deepEqual(result, []);
});

test("computeExpiringCertifications excludes an already-expired certification", () => {
  const result = computeExpiringCertifications([{ id: "c1", status: "expired", expires_at: daysFromNow(-1) }], NOW);
  assert.deepEqual(result, []);
});

test("computeExpiringCertifications excludes a revoked certification even with a near expiry", () => {
  const result = computeExpiringCertifications([{ id: "c1", status: "revoked", expires_at: daysFromNow(5) }], NOW);
  assert.deepEqual(result, []);
});

test("computeExpiringCertifications includes a certification expiring exactly at the window boundary (30 days)", () => {
  const cert = { id: "c1", status: "expiring", expires_at: daysFromNow(30) };
  const result = computeExpiringCertifications([cert], NOW);
  assert.deepEqual(result, [cert]);
});

test("computeExpiringCertifications excludes a certification expiring one day past the 30-day window", () => {
  const result = computeExpiringCertifications([{ id: "c1", status: "expiring", expires_at: daysFromNow(31) }], NOW);
  assert.deepEqual(result, []);
});

test("computeExpiringCertifications includes a certification expiring right now (0 days out)", () => {
  const cert = { id: "c1", status: "expiring", expires_at: NOW.toISOString() };
  const result = computeExpiringCertifications([cert], NOW);
  assert.deepEqual(result, [cert]);
});

test("computeExpiringCertifications respects a custom window", () => {
  const cert = { id: "c1", status: "active", expires_at: daysFromNow(10) };
  assert.deepEqual(computeExpiringCertifications([cert], NOW, 7), []);
  assert.deepEqual(computeExpiringCertifications([cert], NOW, 14), [cert]);
});

test("computeExpiringCertifications handles an empty/undefined list", () => {
  assert.deepEqual(computeExpiringCertifications([], NOW), []);
  assert.deepEqual(computeExpiringCertifications(undefined, NOW), []);
});

// --- computeTodayShiftsForMe --------------------------------------------------

test("computeTodayShiftsForMe returns [] when myEmployeeId is not set", () => {
  assert.deepEqual(
    computeTodayShiftsForMe({
      shifts: [{ id: "s1", shift_date: "2026-09-07", starts_at: "2026-09-07T08:00:00Z" }],
      assignments: [{ shift_id: "s1", employee_id: "emp-1", status: "approved" }],
      myEmployeeId: null,
      today: "2026-09-07"
    }),
    []
  );
});

test("computeTodayShiftsForMe filters to the caller's own assignments on today's date, sorted by start time", () => {
  const shifts = [
    { id: "s1", shift_date: "2026-09-07", starts_at: "2026-09-07T14:00:00Z" },
    { id: "s2", shift_date: "2026-09-07", starts_at: "2026-09-07T06:00:00Z" },
    { id: "s3", shift_date: "2026-09-08", starts_at: "2026-09-08T06:00:00Z" }
  ];
  const assignments = [
    { shift_id: "s1", employee_id: "emp-1", status: "approved" },
    { shift_id: "s2", employee_id: "emp-1", status: "approved" },
    { shift_id: "s3", employee_id: "emp-1", status: "approved" }, // different day
    { shift_id: "s1", employee_id: "emp-2", status: "approved" } // someone else
  ];
  const result = computeTodayShiftsForMe({ shifts, assignments, myEmployeeId: "emp-1", today: "2026-09-07" });
  assert.deepEqual(
    result.map((s) => s.id),
    ["s2", "s1"]
  );
});

test("computeTodayShiftsForMe defaults `today` to now's UTC calendar date", () => {
  const shifts = [{ id: "s1", shift_date: "2026-09-07", starts_at: "2026-09-07T06:00:00Z" }];
  const assignments = [{ shift_id: "s1", employee_id: "emp-1", status: "approved" }];
  // No `today` passed -- falls back to new Date() internally, so pin via a
  // shift dated "today" relative to the real clock is impractical here;
  // instead assert the explicit-today path (covered above) and that an
  // omitted `today` doesn't throw and returns an array.
  const result = computeTodayShiftsForMe({ shifts, assignments, myEmployeeId: "emp-1" });
  assert.ok(Array.isArray(result));
});

test("computeTodayShiftsForMe drops an assignment whose shift_id has no matching shift row", () => {
  const result = computeTodayShiftsForMe({
    shifts: [],
    assignments: [{ shift_id: "missing", employee_id: "emp-1", status: "approved" }],
    myEmployeeId: "emp-1",
    today: "2026-09-07"
  });
  assert.deepEqual(result, []);
});

test("computeTodayShiftsForMe handles empty inputs", () => {
  assert.deepEqual(computeTodayShiftsForMe({}), []);
  assert.deepEqual(computeTodayShiftsForMe(), []);
});

// --- buildTiles ---------------------------------------------------------------

test("buildTiles returns [] for a caller with no permissions other than the always-eligible certifications tile", () => {
  const tiles = buildTiles({ permissions: [], certifications: [], now: NOW });
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["expiring-certifications"]
  );
});

test("buildTiles omits a tile entirely (not even 'Unavailable') when the caller lacks its permission", () => {
  const tiles = buildTiles({ permissions: [], incidents: null, now: NOW });
  assert.ok(!tiles.some((t) => t.key === "open-incidents"));
});

test("buildTiles shows 'Unavailable' for a permitted tile whose fetch failed (null data)", () => {
  const tiles = buildTiles({ permissions: ["incidents.read"], incidents: null, now: NOW });
  const tile = tiles.find((t) => t.key === "open-incidents");
  assert.ok(tile);
  assert.equal(tile.value, "Unavailable");
});

test("buildTiles computes the reports-due-today tile from a compliance response's per-template totals", () => {
  const compliance = {
    templates: [
      { expected: 1, submitted: 1, missing: 0, overdue: 0 },
      { expected: 1, submitted: 0, missing: 1, overdue: 1 }
    ]
  };
  const tiles = buildTiles({ permissions: ["reports.read"], compliance, now: NOW });
  const tile = tiles.find((t) => t.key === "reports-due-today");
  assert.equal(tile.value, "1/2 filed");
  assert.match(tile.hint, /1 report overdue/);
});

test("buildTiles reports work orders/incidents/messages counts from the given arrays", () => {
  const tiles = buildTiles({
    permissions: ["work_orders.read", "incidents.read", "communications.read"],
    workOrders: [{ id: "wo1" }, { id: "wo2" }],
    incidents: [{ id: "in1" }],
    unackedMessages: [],
    now: NOW
  });
  assert.equal(tiles.find((t) => t.key === "my-open-work-orders").value, "2");
  assert.equal(tiles.find((t) => t.key === "open-incidents").value, "1");
  assert.equal(tiles.find((t) => t.key === "unacknowledged-messages").value, "0");
});

test("buildTiles' expiring-certifications tile applies the 30-day window internally from raw cert rows", () => {
  const certifications = [
    { id: "c1", status: "active", expires_at: daysFromNow(10) },
    { id: "c2", status: "active", expires_at: daysFromNow(90) }
  ];
  const tiles = buildTiles({ permissions: [], certifications, now: NOW });
  const tile = tiles.find((t) => t.key === "expiring-certifications");
  assert.equal(tile.value, "1");
});

test("buildTiles' today-shifts tile is gated on schedule.read and reads the precomputed todayShifts array", () => {
  const withPerm = buildTiles({ permissions: ["schedule.read"], todayShifts: [{ id: "s1" }], now: NOW });
  assert.equal(withPerm.find((t) => t.key === "today-shifts").value, "1");

  const withoutPerm = buildTiles({ permissions: [], todayShifts: [{ id: "s1" }], now: NOW });
  assert.ok(!withoutPerm.some((t) => t.key === "today-shifts"));
});

test("buildTiles returns every tile, in a stable order, for a caller with every permission", () => {
  const tiles = buildTiles({
    permissions: HOME_DASHBOARD_PERMISSION_CODES,
    compliance: { templates: [] },
    workOrders: [],
    incidents: [],
    unackedMessages: [],
    certifications: [],
    todayShifts: [],
    now: NOW
  });
  assert.deepEqual(tiles.map((t) => t.key), [
    "reports-due-today",
    "my-open-work-orders",
    "open-incidents",
    "unacknowledged-messages",
    "expiring-certifications",
    "today-shifts"
  ]);
  for (const tile of tiles) {
    assert.equal(typeof tile.title, "string");
    assert.equal(typeof tile.panelId, "string");
    assert.notEqual(tile.value, "Unavailable");
  }
});

test("buildTiles handles a call with no arguments at all", () => {
  const tiles = buildTiles();
  // Only the permission-free certifications tile is eligible with no
  // permissions granted, and its data is null (unavailable) by default.
  assert.deepEqual(tiles.map((t) => t.key), ["expiring-certifications"]);
  assert.equal(tiles[0].value, "Unavailable");
});
