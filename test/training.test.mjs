import test from "node:test";
import assert from "node:assert/strict";
import {
  certificationBlocksSchedule,
  certificationStatus,
  trainingAssignmentState,
  assignmentReadyToComplete
} from "../src/lib/training.mjs";

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

test("training.recertWindowDays widens the expiring window when the cert omits its own", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  const cert = { expiresAt: "2026-08-01T12:00:00Z" }; // 31 days out, no renewalWindowDays
  // default 30-day window -> still active
  assert.equal(certificationStatus(cert, now), "active");
  // configured 45-day window -> now inside the expiring window
  assert.equal(certificationStatus(cert, now, { "training.recertWindowDays": 45 }), "expiring");
  // the cert's own renewalWindowDays still wins over config when present
  assert.equal(
    certificationStatus({ ...cert, renewalWindowDays: 10 }, now, { "training.recertWindowDays": 45 }),
    "active"
  );
});

test("certificationBlocksSchedule blocks expired or revoked credentials", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  assert.equal(certificationBlocksSchedule({ expiresAt: "2026-06-01T12:00:00Z" }, now), true);
  assert.equal(certificationBlocksSchedule({ status: "revoked", expiresAt: "2026-12-01T12:00:00Z" }, now), true);
  assert.equal(certificationBlocksSchedule({ expiresAt: "2026-07-15T12:00:00Z", renewalWindowDays: 30 }, now), false);
});

// --- TR-06: assignmentReadyToComplete ---------------------------------------

test("assignmentReadyToComplete is ready when every required module is completed", () => {
  const modules = [
    { id: "mod-1", required: true, title: "Module 1" },
    { id: "mod-2", required: true, title: "Module 2" }
  ];
  const progressRows = [
    { moduleId: "mod-1", state: "completed" },
    { moduleId: "mod-2", state: "completed" }
  ];
  const result = assignmentReadyToComplete(modules, progressRows);
  assert.equal(result.ready, true);
  assert.deepEqual(result.outstandingModules, []);
});

test("assignmentReadyToComplete names the outstanding required module(s)", () => {
  const modules = [
    { id: "mod-1", required: true, title: "Module 1" },
    { id: "mod-2", required: true, title: "Module 2" }
  ];
  const progressRows = [
    { moduleId: "mod-1", state: "completed" },
    { moduleId: "mod-2", state: "in_progress" }
  ];
  const result = assignmentReadyToComplete(modules, progressRows);
  assert.equal(result.ready, false);
  assert.deepEqual(result.outstandingModules, [{ id: "mod-2", title: "Module 2" }]);
});

test("assignmentReadyToComplete treats a required module with no progress row at all as outstanding", () => {
  const modules = [{ id: "mod-1", required: true, title: "Module 1" }];
  const result = assignmentReadyToComplete(modules, []);
  assert.equal(result.ready, false);
  assert.deepEqual(result.outstandingModules, [{ id: "mod-1", title: "Module 1" }]);
});

test("assignmentReadyToComplete is vacuously ready for a course with no modules", () => {
  const result = assignmentReadyToComplete([], []);
  assert.equal(result.ready, true);
  assert.deepEqual(result.outstandingModules, []);
});

test("assignmentReadyToComplete ignores non-required modules regardless of their progress state", () => {
  const modules = [
    { id: "mod-1", required: true, title: "Required" },
    { id: "mod-2", required: false, title: "Optional" }
  ];
  const progressRows = [{ moduleId: "mod-1", state: "completed" }];
  // mod-2 has no progress row at all -- it must still not block completion.
  const result = assignmentReadyToComplete(modules, progressRows);
  assert.equal(result.ready, true);
  assert.deepEqual(result.outstandingModules, []);
});

test("assignmentReadyToComplete treats a module missing the `required` key as required (matches the course_modules default)", () => {
  const modules = [{ id: "mod-1", title: "Module 1" }];
  const result = assignmentReadyToComplete(modules, []);
  assert.equal(result.ready, false);
  assert.deepEqual(result.outstandingModules, [{ id: "mod-1", title: "Module 1" }]);
});
