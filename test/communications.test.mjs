import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgementState,
  resolveMessageAudience,
  shouldBypassQuietHours,
  summarizeAckCompliance,
  DEFAULT_ACK_DUE_HOURS
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

// --- summarizeAckCompliance (P-1: CM-09/CM-11) ------------------------------

const ACK_AUDIENCE = ["emp-1", "emp-2", "emp-3"];

test("summarizeAckCompliance: delivered but not read counts toward delivered only", () => {
  const summary = summarizeAckCompliance(
    ACK_AUDIENCE,
    [{ employeeId: "emp-1", deliveredAt: "2026-07-18T08:00:00Z" }],
    [],
    new Date("2026-07-18T09:00:00Z"),
    { isRequiredAck: true, publishedAt: "2026-07-18T08:00:00Z" }
  );
  assert.equal(summary.delivered, 1);
  assert.equal(summary.read, 0);
  assert.equal(summary.acknowledged, 0);
  assert.equal(summary.total, 3);
});

test("summarizeAckCompliance: read but not acknowledged counts toward read only, and stays pending", () => {
  const summary = summarizeAckCompliance(
    ACK_AUDIENCE,
    [{ employeeId: "emp-1", deliveredAt: "2026-07-18T08:00:00Z", readAt: "2026-07-18T08:05:00Z" }],
    [],
    new Date("2026-07-18T09:00:00Z"),
    { isRequiredAck: true, publishedAt: "2026-07-18T08:00:00Z" }
  );
  assert.equal(summary.delivered, 1);
  assert.equal(summary.read, 1);
  assert.equal(summary.acknowledged, 0);
  assert.equal(summary.pending, 3);
  assert.equal(summary.overdue, 0);
});

test("summarizeAckCompliance: an acknowledged recipient is counted acknowledged, not pending", () => {
  const summary = summarizeAckCompliance(
    ACK_AUDIENCE,
    [],
    [{ employeeId: "emp-1", acknowledgedAt: "2026-07-18T08:10:00Z" }],
    new Date("2026-07-18T09:00:00Z"),
    { isRequiredAck: true, publishedAt: "2026-07-18T08:00:00Z" }
  );
  assert.equal(summary.acknowledged, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.overdue, 0);
  assert.equal(summary.total, 3);
});

test("summarizeAckCompliance: overdue boundary -- exactly at publishedAt + ackDueHours is NOT overdue, one tick past is", () => {
  const publishedAt = "2026-07-18T08:00:00Z";
  const dueAt = new Date(new Date(publishedAt).getTime() + 2 * 3_600_000);
  const atBoundary = summarizeAckCompliance(ACK_AUDIENCE, [], [], dueAt, {
    isRequiredAck: true,
    publishedAt,
    ackDueHours: 2
  });
  assert.equal(atBoundary.overdue, 0, "now === due instant is not yet overdue");
  assert.equal(atBoundary.pending, 3);

  const pastBoundary = summarizeAckCompliance(ACK_AUDIENCE, [], [], new Date(dueAt.getTime() + 1), {
    isRequiredAck: true,
    publishedAt,
    ackDueHours: 2
  });
  assert.equal(pastBoundary.overdue, 3, "one millisecond past due, every still-pending recipient is overdue");
});

test("summarizeAckCompliance: overdue never counts an already-acknowledged recipient", () => {
  const publishedAt = "2026-07-18T08:00:00Z";
  const wayPastDue = new Date("2027-01-01T00:00:00Z");
  const summary = summarizeAckCompliance(
    ACK_AUDIENCE,
    [],
    [{ employeeId: "emp-1", acknowledgedAt: "2026-07-18T08:10:00Z" }],
    wayPastDue,
    { isRequiredAck: true, publishedAt, ackDueHours: 2 }
  );
  assert.equal(summary.acknowledged, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.overdue, 2);
});

test("summarizeAckCompliance: a message that does not require acknowledgement is never overdue (and never pending)", () => {
  const publishedAt = "2026-07-18T08:00:00Z";
  const wayPastDue = new Date("2027-01-01T00:00:00Z");
  const summary = summarizeAckCompliance(ACK_AUDIENCE, [], [], wayPastDue, {
    isRequiredAck: false,
    publishedAt,
    ackDueHours: 2
  });
  assert.equal(summary.pending, 0);
  assert.equal(summary.overdue, 0);
  // A voluntary ack on a not-required message still counts toward `acknowledged`.
  const withVoluntaryAck = summarizeAckCompliance(
    ACK_AUDIENCE,
    [],
    [{ employeeId: "emp-1", acknowledgedAt: "2026-07-18T08:10:00Z" }],
    wayPastDue,
    { isRequiredAck: false, publishedAt, ackDueHours: 2 }
  );
  assert.equal(withVoluntaryAck.acknowledged, 1);
  assert.equal(withVoluntaryAck.pending, 0);
  assert.equal(withVoluntaryAck.overdue, 0);
});

test("summarizeAckCompliance: falls back to DEFAULT_ACK_DUE_HOURS when ackDueHours is not supplied", () => {
  const publishedAt = "2026-07-18T08:00:00Z";
  const justBeforeDefault = new Date(new Date(publishedAt).getTime() + DEFAULT_ACK_DUE_HOURS * 3_600_000 - 1);
  const justAfterDefault = new Date(new Date(publishedAt).getTime() + DEFAULT_ACK_DUE_HOURS * 3_600_000 + 1);
  assert.equal(summarizeAckCompliance(ACK_AUDIENCE, [], [], justBeforeDefault, { isRequiredAck: true, publishedAt }).overdue, 0);
  assert.equal(summarizeAckCompliance(ACK_AUDIENCE, [], [], justAfterDefault, { isRequiredAck: true, publishedAt }).overdue, 3);
});

test("summarizeAckCompliance: a receipt/ack from someone outside the resolved audience is ignored", () => {
  const summary = summarizeAckCompliance(
    ["emp-1"],
    [{ employeeId: "emp-1", deliveredAt: "t" }, { employeeId: "outsider", deliveredAt: "t", readAt: "t" }],
    [{ employeeId: "outsider", acknowledgedAt: "t" }],
    new Date("2026-07-18T09:00:00Z"),
    { isRequiredAck: true, publishedAt: "2026-07-18T08:00:00Z" }
  );
  assert.equal(summary.total, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.read, 0);
  assert.equal(summary.acknowledged, 0);
  assert.equal(summary.pending, 1);
});

test("summarizeAckCompliance: accepts live snake_case PostgREST rows the same as camelCase test fixtures", () => {
  const summary = summarizeAckCompliance(
    ["emp-1", "emp-2"],
    [{ employee_id: "emp-1", delivered_at: "2026-07-18T08:00:00Z", read_at: "2026-07-18T08:05:00Z" }],
    [{ employee_id: "emp-2", acknowledged_at: "2026-07-18T08:10:00Z" }],
    new Date("2026-07-18T09:00:00Z"),
    { isRequiredAck: true, publishedAt: "2026-07-18T08:00:00Z" }
  );
  assert.equal(summary.delivered, 1);
  assert.equal(summary.read, 1);
  assert.equal(summary.acknowledged, 1);
  assert.equal(summary.pending, 1);
});
