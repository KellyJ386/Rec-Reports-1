import test from "node:test";
import assert from "node:assert/strict";
import {
  nextAttemptAt,
  shouldDeadLetter,
  planJob,
  classifyResult,
  DEFAULT_MAX_ATTEMPTS
} from "../src/lib/notifications/worker.mjs";

const NOW = "2026-07-18T12:00:00.000Z";

test("nextAttemptAt backs off exponentially from a base of 60s, doubling each attempt", () => {
  assert.equal(nextAttemptAt(1, NOW), "2026-07-18T12:01:00.000Z"); // +60s
  assert.equal(nextAttemptAt(2, NOW), "2026-07-18T12:02:00.000Z"); // +120s
  assert.equal(nextAttemptAt(3, NOW), "2026-07-18T12:04:00.000Z"); // +240s
  assert.equal(nextAttemptAt(4, NOW), "2026-07-18T12:08:00.000Z"); // +480s
});

test("nextAttemptAt caps the delay at maxSeconds", () => {
  const capped = nextAttemptAt(10, NOW, { baseSeconds: 60, maxSeconds: 3600 });
  assert.equal(capped, "2026-07-18T13:00:00.000Z"); // +3600s, would otherwise be far larger
});

test("nextAttemptAt honors custom base/cap overrides", () => {
  assert.equal(nextAttemptAt(0, NOW, { baseSeconds: 900, maxSeconds: 900 }), "2026-07-18T12:15:00.000Z");
});

test("nextAttemptAt rejects an invalid timestamp", () => {
  assert.throws(() => nextAttemptAt(1, "not-a-date"), /valid ISO timestamp/);
});

test("shouldDeadLetter is false below the limit and true at/after it", () => {
  assert.equal(shouldDeadLetter(4, 5), false);
  assert.equal(shouldDeadLetter(5, 5), true);
  assert.equal(shouldDeadLetter(9, 5), true);
});

test("shouldDeadLetter defaults maxAttempts when not provided", () => {
  assert.equal(shouldDeadLetter(DEFAULT_MAX_ATTEMPTS - 1), false);
  assert.equal(shouldDeadLetter(DEFAULT_MAX_ATTEMPTS), true);
});

test("planJob shapes deliveries from an already-resolved job payload", () => {
  const job = {
    id: "job-1",
    facility_id: "fac-1",
    event_type: "incident.escalated",
    payload_jsonb: { channels: ["in_app", "email"], recipients: ["emp-1", "emp-2"] }
  };
  const plan = planJob(job, {
    now: "2026-07-18T15:00:00.000Z", // clear of the default 22:00-06:00 quiet window
    contacts: { "emp-1": { email: "emp1@example.com" } }
  });
  assert.equal(plan.jobId, "job-1");
  assert.equal(plan.facilityId, "fac-1");
  assert.equal(plan.withinQuietHours, false);
  assert.equal(plan.deferred, false);
  assert.deepEqual(plan.channels, ["in_app", "email"]);
  assert.deepEqual(plan.deliveries, [
    { channel: "in_app", employeeId: "emp-1", target: "emp-1" },
    { channel: "in_app", employeeId: "emp-2", target: "emp-2" },
    { channel: "email", employeeId: "emp-1", target: "emp1@example.com" },
    { channel: "email", employeeId: "emp-2", target: null } // no contact on file -> defensive null target
  ]);
});

test("planJob defers (empty deliveries, no attempt spent) inside quiet hours", () => {
  const job = {
    id: "job-2",
    facility_id: "fac-1",
    event_type: "schedule.published",
    payload_jsonb: { channels: ["in_app"], recipients: ["emp-1"] }
  };
  const plan = planJob(job, { now: "2026-07-18T23:30:00.000Z", timeZone: "UTC" }); // 23:30 falls in 22:00-06:00
  assert.equal(plan.withinQuietHours, true);
  assert.equal(plan.deferred, true);
  assert.deepEqual(plan.deliveries, []);
});

test("planJob bypasses quiet hours for urgent/emergency priority", () => {
  const job = {
    id: "job-3",
    facility_id: "fac-1",
    event_type: "incident.escalated",
    payload_jsonb: { channels: ["in_app"], recipients: ["emp-1"], priority: "emergency" }
  };
  const plan = planJob(job, { now: "2026-07-18T23:30:00.000Z", timeZone: "UTC" });
  assert.equal(plan.withinQuietHours, false);
  assert.equal(plan.deferred, false);
  assert.equal(plan.deliveries.length, 1);
});

test("planJob falls back to resolveRoute/expandDistributionList when recipients weren't pre-resolved", () => {
  const job = {
    id: "job-4",
    facility_id: "fac-1",
    event_type: "incident.escalated",
    payload_jsonb: { route_id: "route-1" }
  };
  const routes = [
    { id: "route-1", event_code: "incident.escalated", active: true, priority: 1, route_jsonb: { channels: ["in_app"], distribution_list_id: "list-1" } }
  ];
  const distributionLists = [{ id: "list-1" }];
  const distributionListMembers = [
    { distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-9" }
  ];
  const plan = planJob(job, {
    now: "2026-07-18T15:00:00.000Z",
    routes,
    distributionLists,
    distributionListMembers
  });
  assert.deepEqual(plan.channels, ["in_app"]);
  assert.deepEqual(plan.recipients, ["emp-9"]);
  assert.deepEqual(plan.deliveries, [{ channel: "in_app", employeeId: "emp-9", target: "emp-9" }]);
});

test("planJob is defensive against a missing/malformed payload", () => {
  const plan = planJob({ id: "job-5", facility_id: "fac-1", event_type: "x" }, { now: NOW });
  assert.deepEqual(plan.channels, ["in_app"]); // safe default channel
  assert.deepEqual(plan.recipients, []);
  assert.deepEqual(plan.deliveries, []);
  assert.doesNotThrow(() => planJob(null, { now: NOW }));
  assert.doesNotThrow(() => planJob({}, {}));
});

test("classifyResult transitions a successful delivery to sent", () => {
  const result = classifyResult({ ok: true }, { attempts: 0, maxAttempts: 5, now: NOW });
  assert.deepEqual(result, { status: "sent", attempts: 1, nextAttemptAt: null, deadLettered: false });
});

test("classifyResult retries a transient failure with a computed nextAttemptAt", () => {
  const result = classifyResult({ ok: false, error: "smtp timeout" }, { attempts: 1, maxAttempts: 5, now: NOW });
  assert.equal(result.status, "pending");
  assert.equal(result.attempts, 2);
  assert.equal(result.deadLettered, false);
  assert.equal(result.nextAttemptAt, nextAttemptAt(2, NOW));
});

test("classifyResult dead-letters once attempts are exhausted", () => {
  const result = classifyResult({ ok: false, error: "still failing" }, { attempts: 4, maxAttempts: 5, now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 5);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.deadLettered, true);
});

test("classifyResult defaults maxAttempts to DEFAULT_MAX_ATTEMPTS", () => {
  const result = classifyResult(
    { ok: false, error: "boom" },
    { attempts: DEFAULT_MAX_ATTEMPTS - 1, now: NOW }
  );
  assert.equal(result.deadLettered, true);
  assert.equal(result.status, "failed");
});
