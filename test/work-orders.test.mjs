import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkOrderFromIncident,
  isWorkOrderOverdue,
  sortWorkOrdersForDashboard,
  slaHoursForPriority
} from "../src/lib/work-orders.mjs";

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
