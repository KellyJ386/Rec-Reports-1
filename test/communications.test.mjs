import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgementState, resolveMessageAudience, shouldBypassQuietHours } from "../src/lib/communications.mjs";

test("resolveMessageAudience expands department, shift, and employee targets without duplicates", () => {
  assert.deepEqual(
    resolveMessageAudience(
      { audiences: [{ type: "department", id: "aquatics" }, { type: "shift", id: "shift-1" }, { type: "employee", id: "employee-3" }] },
      {
        employees: [
          { id: "employee-1", departmentId: "aquatics" },
          { id: "employee-2", departmentId: "arena" }
        ],
        shiftAssignments: [{ shiftId: "shift-1", employeeId: "employee-1" }]
      }
    ),
    ["employee-1", "employee-3"]
  );
});

test("acknowledgementState tracks pending, overdue, and complete required acknowledgement", () => {
  const message = { isRequiredAck: true, requiredRecipientCount: 2, ackDueAt: "2026-07-08T12:00:00Z" };
  assert.equal(acknowledgementState(message, [], new Date("2026-07-08T11:00:00Z")), "pending");
  assert.equal(acknowledgementState(message, [], new Date("2026-07-08T13:00:00Z")), "overdue");
  assert.equal(acknowledgementState(message, [{ acknowledgedAt: "now" }, { acknowledgedAt: "now" }]), "complete");
});

test("shouldBypassQuietHours allows urgent and emergency messages", () => {
  assert.equal(shouldBypassQuietHours({ priority: "normal" }), false);
  assert.equal(shouldBypassQuietHours({ priority: "urgent" }), true);
  assert.equal(shouldBypassQuietHours({ priority: "emergency" }), true);
});
