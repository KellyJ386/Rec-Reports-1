import test from "node:test";
import assert from "node:assert/strict";
import { certificationBlocksSchedule, certificationStatus, trainingAssignmentState } from "../src/lib/training.mjs";

test("certificationStatus identifies active, expiring, expired, and revoked credentials", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  assert.equal(certificationStatus({ expiresAt: "2026-12-01T12:00:00Z", renewalWindowDays: 30 }, now), "active");
  assert.equal(certificationStatus({ expiresAt: "2026-07-15T12:00:00Z", renewalWindowDays: 30 }, now), "expiring");
  assert.equal(certificationStatus({ expiresAt: "2026-06-01T12:00:00Z", renewalWindowDays: 30 }, now), "expired");
  assert.equal(certificationStatus({ status: "revoked", expiresAt: "2026-12-01T12:00:00Z" }, now), "revoked");
});

test("trainingAssignmentState tracks not started, in progress, overdue, and complete", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  assert.equal(trainingAssignmentState({}, now), "not_started");
  assert.equal(trainingAssignmentState({ startedAt: "2026-06-30T12:00:00Z" }, now), "in_progress");
  assert.equal(trainingAssignmentState({ dueAt: "2026-06-30T12:00:00Z" }, now), "overdue");
  assert.equal(trainingAssignmentState({ completedAt: "2026-06-30T12:00:00Z" }, now), "complete");
});

test("certificationBlocksSchedule blocks expired or revoked credentials", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  assert.equal(certificationBlocksSchedule({ expiresAt: "2026-06-01T12:00:00Z" }, now), true);
  assert.equal(certificationBlocksSchedule({ status: "revoked", expiresAt: "2026-12-01T12:00:00Z" }, now), true);
  assert.equal(certificationBlocksSchedule({ expiresAt: "2026-07-15T12:00:00Z", renewalWindowDays: 30 }, now), false);
});
