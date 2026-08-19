import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkOrderQuery,
  validateWorkOrderCreate,
  buildWorkOrderCreatePayload
} from "../src/public/js/work-order-filters.mjs";

test("buildWorkOrderQuery with the 'all' chip and no priority only sets pagination", () => {
  const params = buildWorkOrderQuery({ chip: "all", page: 1, pageSize: 20 });
  assert.equal(params.get("status"), null);
  assert.equal(params.get("overdue"), null);
  assert.equal(params.get("assignee"), null);
  assert.equal(params.get("limit"), "20");
  assert.equal(params.get("offset"), "0");
});

test("buildWorkOrderQuery 'open' chip sets status=open", () => {
  const params = buildWorkOrderQuery({ chip: "open" });
  assert.equal(params.get("status"), "open");
});

test("buildWorkOrderQuery 'overdue' chip sets overdue=true", () => {
  const params = buildWorkOrderQuery({ chip: "overdue" });
  assert.equal(params.get("overdue"), "true");
});

test("buildWorkOrderQuery 'mine' chip sets assignee only when myEmployeeId is supplied", () => {
  const withEmployee = buildWorkOrderQuery({ chip: "mine", myEmployeeId: "emp-1" });
  assert.equal(withEmployee.get("assignee"), "emp-1");

  const withoutEmployee = buildWorkOrderQuery({ chip: "mine", myEmployeeId: null });
  assert.equal(withoutEmployee.get("assignee"), null);
});

test("buildWorkOrderQuery composes chip and priority together", () => {
  const params = buildWorkOrderQuery({ chip: "open", priority: "high" });
  assert.equal(params.get("status"), "open");
  assert.equal(params.get("priority"), "high");
});

test("buildWorkOrderQuery ignores an unknown priority value", () => {
  const params = buildWorkOrderQuery({ priority: "not_a_priority" });
  assert.equal(params.get("priority"), null);
});

test("buildWorkOrderQuery computes offset from page and pageSize", () => {
  const page1 = buildWorkOrderQuery({ page: 1, pageSize: 10 });
  const page2 = buildWorkOrderQuery({ page: 2, pageSize: 10 });
  const page3 = buildWorkOrderQuery({ page: 3, pageSize: 10 });
  assert.equal(page1.get("offset"), "0");
  assert.equal(page2.get("offset"), "10");
  assert.equal(page3.get("offset"), "20");
});

test("buildWorkOrderQuery clamps a sub-1 page and non-positive pageSize", () => {
  const params = buildWorkOrderQuery({ page: 0, pageSize: -5 });
  assert.equal(params.get("offset"), "0");
  assert.equal(Number(params.get("limit")) > 0, true);
});

test("validateWorkOrderCreate requires title, description, and a known priority", () => {
  const bad = validateWorkOrderCreate({});
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.title);
  assert.ok(bad.errors.description);
  assert.ok(bad.errors.priority);

  const badPriority = validateWorkOrderCreate({ title: "t", description: "d", priority: "urgentish" });
  assert.equal(badPriority.valid, false);
  assert.ok(badPriority.errors.priority);

  const good = validateWorkOrderCreate({ title: "Fix pump", description: "Leaking", priority: "urgent" });
  assert.equal(good.valid, true);
});

test("buildWorkOrderCreatePayload trims text and omits unset optional refs", () => {
  const payload = buildWorkOrderCreatePayload({ title: "  Fix pump  ", description: "  Leaking  ", priority: "high" });
  assert.deepEqual(payload, { title: "Fix pump", description: "Leaking", priority: "high" });
});

test("buildWorkOrderCreatePayload includes optional refs when provided", () => {
  const payload = buildWorkOrderCreatePayload({
    title: "Fix pump",
    description: "Leaking",
    priority: "high",
    assetId: "asset-1",
    assignedToEmployeeId: "emp-2",
    dueAt: "2026-08-20T00:00:00Z"
  });
  assert.equal(payload.asset_id, "asset-1");
  assert.equal(payload.assigned_to_employee_id, "emp-2");
  assert.equal(payload.due_at, "2026-08-20T00:00:00Z");
});
