import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkOrderFromIncident,
  isWorkOrderOpen,
  isWorkOrderOverdue,
  sortWorkOrdersForDashboard,
  slaHoursForPriority,
  workOrderDueAt,
  canTransition,
  applyStatusChange,
  isResolvingStatus,
  slaState,
  WORK_ORDER_STATUSES
} from "../src/lib/work-orders.mjs";

test("isWorkOrderOpen treats open/in_progress/on_hold as open", () => {
  assert.equal(isWorkOrderOpen({ status: "open" }), true);
  assert.equal(isWorkOrderOpen({ status: "in_progress" }), true);
  assert.equal(isWorkOrderOpen({ status: "on_hold" }), true);
});

test("isWorkOrderOpen treats resolved/closed/cancelled as not open", () => {
  assert.equal(isWorkOrderOpen({ status: "resolved" }), false);
  assert.equal(isWorkOrderOpen({ status: "closed" }), false);
  assert.equal(isWorkOrderOpen({ status: "cancelled" }), false);
});

test("workOrderDueAt derives the due date from createdAt plus the priority's SLA hours", () => {
  const workOrder = { priority: "urgent", createdAt: "2026-07-08T00:00:00Z" };
  assert.equal(workOrderDueAt(workOrder).toISOString(), "2026-07-09T00:00:00.000Z"); // default urgent SLA = 24h
  assert.equal(
    workOrderDueAt(workOrder, { "workOrders.slaHoursUrgent": 6 }).toISOString(),
    "2026-07-08T06:00:00.000Z"
  );
});

test("workOrderDueAt anchors on `now` when createdAt is absent", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const dueAt = workOrderDueAt({ priority: "low" }, {}, now); // default routine SLA = 72h
  assert.equal(dueAt.toISOString(), "2026-07-11T00:00:00.000Z");
});

test("isWorkOrderOverdue only flags open work past its due date", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  assert.equal(isWorkOrderOverdue({ status: "open", dueAt: "2026-07-08T11:00:00Z" }, now), true);
  assert.equal(isWorkOrderOverdue({ status: "closed", dueAt: "2026-07-08T11:00:00Z" }, now), false);
});

test("sortWorkOrdersForDashboard prioritizes overdue and urgent work", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const sorted = sortWorkOrdersForDashboard(
    [
      { id: "routine", status: "open", priority: "low", dueAt: "2026-07-10T12:00:00Z", createdAt: "2026-07-01T12:00:00Z" },
      { id: "urgent", status: "open", priority: "urgent", dueAt: "2026-07-09T12:00:00Z", createdAt: "2026-07-02T12:00:00Z" },
      { id: "overdue", status: "in_progress", priority: "medium", dueAt: "2026-07-07T12:00:00Z", createdAt: "2026-07-03T12:00:00Z" }
    ],
    now
  );
  assert.deepEqual(sorted.map((workOrder) => workOrder.id), ["overdue", "urgent", "routine"]);
});

test("workOrders.defaultPriority overrides the medium fallback for non-high/critical incidents", () => {
  const base = { id: "i-1", facilityId: "f-1", incidentNo: "INC-1", severity: "low", summary: "x" };
  assert.equal(createWorkOrderFromIncident(base).priority, "medium");
  assert.equal(
    createWorkOrderFromIncident(base, {}, { "workOrders.defaultPriority": "high" }).priority,
    "high"
  );
});

test("slaHoursForPriority honors configured urgent/routine SLAs", () => {
  assert.equal(slaHoursForPriority("urgent"), 24); // default
  assert.equal(slaHoursForPriority("low"), 72); // default routine
  assert.equal(slaHoursForPriority("urgent", { "workOrders.slaHoursUrgent": 6 }), 6);
  assert.equal(slaHoursForPriority("medium", { "workOrders.slaHoursRoutine": 120 }), 120);
});

test("createWorkOrderFromIncident maps high severity incident context into maintenance work", () => {
  assert.deepEqual(
    createWorkOrderFromIncident({ id: "incident-1", facilityId: "facility-1", incidentNo: "INC-1", severity: "high", summary: "Deck mat missing" }),
    {
      sourceType: "incident",
      sourceId: "incident-1",
      facilityId: "facility-1",
      title: "Follow up: INC-1",
      description: "Deck mat missing",
      priority: "high",
      status: "open"
    }
  );
});

// --- Status lifecycle (canTransition / applyStatusChange) ------------------

test("canTransition allows the full open -> in_progress -> resolved -> closed lifecycle", () => {
  assert.equal(canTransition("open", "in_progress"), true);
  assert.equal(canTransition("in_progress", "resolved"), true);
  assert.equal(canTransition("resolved", "closed"), true);
});

test("canTransition allows open to move to on_hold or cancelled", () => {
  assert.equal(canTransition("open", "on_hold"), true);
  assert.equal(canTransition("open", "cancelled"), true);
});

test("canTransition allows on_hold back to in_progress or cancelled", () => {
  assert.equal(canTransition("on_hold", "in_progress"), true);
  assert.equal(canTransition("on_hold", "cancelled"), true);
});

test("canTransition allows reopening a resolved work order back to in_progress", () => {
  assert.equal(canTransition("resolved", "in_progress"), true);
});

test("canTransition rejects leaving closed and cancelled (terminal states)", () => {
  for (const to of WORK_ORDER_STATUSES) {
    assert.equal(canTransition("closed", to), false, `closed -> ${to}`);
    assert.equal(canTransition("cancelled", to), false, `cancelled -> ${to}`);
  }
});

test("canTransition rejects illegal skips and same-status no-ops", () => {
  assert.equal(canTransition("closed", "in_progress"), false);
  assert.equal(canTransition("open", "closed"), false);
  assert.equal(canTransition("resolved", "open"), false);
  assert.equal(canTransition("open", "open"), false);
});

test("canTransition rejects unknown statuses", () => {
  assert.equal(canTransition("open", "bogus"), false);
  assert.equal(canTransition("bogus", "open"), false);
});

test("applyStatusChange stamps completed_at when entering resolved/closed/cancelled", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  for (const status of ["resolved", "closed", "cancelled"]) {
    const patch = applyStatusChange({ status: "in_progress" }, status, now);
    assert.deepEqual(patch, { status, completed_at: "2026-07-08T12:00:00.000Z" });
  }
});

test("applyStatusChange clears completed_at when reopening", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const patch = applyStatusChange({ status: "resolved", completed_at: "2026-07-01T00:00:00Z" }, "in_progress", now);
  assert.deepEqual(patch, { status: "in_progress", completed_at: null });
});

// --- WO-15: isResolvingStatus ------------------------------------------

test("isResolvingStatus is true only for resolved/closed", () => {
  assert.equal(isResolvingStatus("resolved"), true);
  assert.equal(isResolvingStatus("closed"), true);
  assert.equal(isResolvingStatus("cancelled"), false);
  assert.equal(isResolvingStatus("open"), false);
  assert.equal(isResolvingStatus("in_progress"), false);
  assert.equal(isResolvingStatus("on_hold"), false);
});

// --- WO-15: slaState -----------------------------------------------------

test("slaState reports on_track with no sla_due_at at all", () => {
  const state = slaState({}, {}, new Date("2026-07-08T12:00:00Z"));
  assert.deepEqual(state, { state: "on_track", dueAt: null, remainingHours: null });
});

test("slaState reports breached once sla_breached_at is stamped, regardless of remaining time", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const state = slaState(
    { slaDueAt: "2026-07-09T12:00:00Z", slaBreachedAt: "2026-07-08T11:00:00Z" },
    {},
    now
  );
  assert.equal(state.state, "breached");
});

test("slaState reports breached as soon as now reaches sla_due_at, even without a stamp", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const atDeadline = slaState({ slaDueAt: "2026-07-08T12:00:00Z" }, {}, now);
  assert.equal(atDeadline.state, "breached");
  assert.equal(atDeadline.remainingHours, 0);

  const pastDeadline = slaState({ slaDueAt: "2026-07-08T11:00:00Z" }, {}, now);
  assert.equal(pastDeadline.state, "breached");
  assert.ok(pastDeadline.remainingHours < 0);
});

test("slaState uses the 4h floor as the at_risk threshold when the window is short (< 20h)", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const workOrder = { createdAt: "2026-07-08T09:00:00Z", slaDueAt: "2026-07-08T19:00:00Z" }; // 10h window, 20% = 2h -> floor 4h wins
  // Exactly at the 4h boundary (15:00): at_risk (inclusive).
  assert.equal(slaState(workOrder, {}, new Date("2026-07-08T15:00:00Z")).state, "at_risk");
  // Just outside the 4h boundary: on_track.
  assert.equal(slaState(workOrder, {}, new Date("2026-07-08T14:59:00Z")).state, "on_track");
});

test("slaState uses 20% of the window as the at_risk threshold when it exceeds 4h", () => {
  const workOrder = { createdAt: "2026-07-01T00:00:00Z", slaDueAt: "2026-07-11T00:00:00Z" }; // 240h window, 20% = 48h
  // 48h remaining: at_risk (inclusive boundary).
  assert.equal(slaState(workOrder, {}, new Date("2026-07-09T00:00:00Z")).state, "at_risk");
  // 49h remaining: on_track.
  assert.equal(slaState(workOrder, {}, new Date("2026-07-08T23:00:00Z")).state, "on_track");
});

test("slaState falls back to the 4h floor when createdAt is unknown or the window is non-positive", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const noCreatedAt = slaState({ slaDueAt: "2026-07-08T15:00:00Z" }, {}, now);
  assert.equal(noCreatedAt.state, "at_risk"); // 3h remaining <= 4h floor

  const invertedWindow = slaState(
    { createdAt: "2026-07-08T20:00:00Z", slaDueAt: "2026-07-08T15:00:00Z" },
    {},
    now
  );
  assert.equal(invertedWindow.state, "at_risk"); // 3h remaining <= 4h floor
});

test("slaState reports remainingHours and an ISO dueAt alongside the state", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  const state = slaState({ slaDueAt: "2026-07-09T00:00:00Z" }, {}, now);
  assert.equal(state.dueAt, "2026-07-09T00:00:00.000Z");
  assert.equal(state.remainingHours, 12);
});
