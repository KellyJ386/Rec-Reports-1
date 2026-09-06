import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgementState,
  resolveMessageAudience,
  shouldBypassQuietHours
} from "../src/lib/communications.mjs";

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

test("communications.requireAckDefault applies when a message omits isRequiredAck", () => {
  const message = { requiredRecipientCount: 1 };
  // default false -> not required
  assert.equal(acknowledgementState(message, []), "not_required");
  // config true -> now the ack is required and pending until acknowledged
  assert.equal(
    acknowledgementState(message, [], new Date(), { "communications.requireAckDefault": true }),
    "pending"
  );
  // an explicit flag on the message still wins over the config default
  assert.equal(
    acknowledgementState({ ...message, isRequiredAck: false }, [], new Date(), {
      "communications.requireAckDefault": true
    }),
    "not_required"
  );
});

test("shouldBypassQuietHours allows urgent and emergency messages", () => {
  assert.equal(shouldBypassQuietHours({ priority: "normal" }), false);
  assert.equal(shouldBypassQuietHours({ priority: "urgent" }), true);
  assert.equal(shouldBypassQuietHours({ priority: "emergency" }), true);
});

test("resolveMessageAudience resolves live rows by audience_ref_id, never the row's own id", () => {
  // A message_audiences row carries both `id` (its own PK) and
  // `audience_ref_id` (the target). Resolving against `id` would silently
  // target nobody for department audiences and the audience row itself for
  // employee ones, so the live shape must always win over the { type, id }
  // fallback used by the pure-shape tests above.
  assert.deepEqual(
    resolveMessageAudience(
      {
        audiences: [
          { id: "aud-1", audience_type: "department", audience_ref_id: "dept-1" },
          { id: "aud-2", audience_type: "employee", audience_ref_id: "emp-5" },
          { id: "aud-3", audience_type: "role", audience_ref_id: "role-9" },
          { id: "aud-4", audience_type: "shift", audience_ref_id: "shift-7" }
        ]
      },
      {
        employees: [
          { id: "emp-1", department_id: "dept-1" },
          { id: "emp-2", department_id: "dept-2" }
        ],
        roleAssignments: [{ role_id: "role-9", employee_id: "emp-3" }],
        shiftAssignments: [{ shift_id: "shift-7", employee_id: "emp-4" }]
      }
    ),
    ["emp-1", "emp-3", "emp-4", "emp-5"]
  );
});

// M3: a live row with audience_type='employee' and a NULL audience_ref_id
// must resolve to zero recipients, never the audience row's own `id` --
// the bug the 0047 migration header claimed was already inert (it wasn't;
// see the fixed audienceRefId() above).
test("resolveMessageAudience: a null audience_ref_id on an employee row resolves to zero recipients, never the row's own id", () => {
  assert.deepEqual(
    resolveMessageAudience({
      audiences: [
        { id: "AUDROW-1", audience_type: "employee", audience_ref_id: null },
        { id: "AUDROW-2", audience_type: "department", audience_ref_id: null }
      ]
    }),
    []
  );
});
