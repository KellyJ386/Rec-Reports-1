import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_REQUEST_STATUSES,
  TRANSITIONS,
  createChangeRequest,
  validateChangeRequestInput,
  canTransition,
  advanceChangeRequest
} from "../src/lib/admin/change-requests.mjs";

test("CHANGE_REQUEST_STATUSES matches the DB check constraint (0008:78)", () => {
  assert.deepEqual(CHANGE_REQUEST_STATUSES, ["draft", "pending_review", "approved", "rejected", "published"]);
});

// --- createChangeRequest ----------------------------------------------------

test("createChangeRequest shapes an insert row starting in draft", () => {
  const row = createChangeRequest({
    facilityId: "fac-1",
    entityTable: "branding_profiles",
    entityId: "bp-1",
    changeSummary: "Update theme colors",
    before: { primary: "#111111" },
    after: { primary: "#222222" },
    requestedBy: "user-1"
  });
  assert.deepEqual(row, {
    facility_id: "fac-1",
    entity_table: "branding_profiles",
    entity_id: "bp-1",
    change_summary: "Update theme colors",
    before_jsonb: { primary: "#111111" },
    after_jsonb: { primary: "#222222" },
    status: "draft",
    requested_by: "user-1"
  });
});

test("createChangeRequest defaults entityId/before/after/requestedBy", () => {
  const row = createChangeRequest({
    facilityId: "fac-1",
    entityTable: "facility_settings",
    changeSummary: "Set locale"
  });
  assert.equal(row.entity_id, null);
  assert.deepEqual(row.before_jsonb, {});
  assert.deepEqual(row.after_jsonb, {});
  assert.equal(row.requested_by, null);
  assert.equal(row.status, "draft");
});

// --- validateChangeRequestInput ---------------------------------------------

test("validateChangeRequestInput accepts a minimal valid payload", () => {
  const result = validateChangeRequestInput({
    entityTable: "branding_profiles",
    changeSummary: "Update theme"
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateChangeRequestInput requires entityTable and changeSummary", () => {
  const result = validateChangeRequestInput({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("entityTable is required"));
  assert.ok(result.errors.includes("changeSummary is required"));
});

test("validateChangeRequestInput rejects a non-object payload", () => {
  assert.equal(validateChangeRequestInput(null).valid, false);
  assert.equal(validateChangeRequestInput("nope").valid, false);
});

test("validateChangeRequestInput rejects non-object before/after", () => {
  const result = validateChangeRequestInput({
    entityTable: "branding_profiles",
    changeSummary: "Update theme",
    before: "not-an-object",
    after: ["also-not"]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("before must be an object"));
  assert.ok(result.errors.includes("after must be an object"));
});

// --- canTransition: every legal transition ----------------------------------

test("canTransition allows every legal transition in the state machine", () => {
  assert.deepEqual(canTransition("draft", "submit"), {
    allowed: true,
    nextStatus: "pending_review",
    reason: null
  });
  assert.deepEqual(canTransition("pending_review", "approve"), {
    allowed: true,
    nextStatus: "approved",
    reason: null
  });
  assert.deepEqual(canTransition("pending_review", "reject"), {
    allowed: true,
    nextStatus: "rejected",
    reason: null
  });
  assert.deepEqual(canTransition("approved", "publish"), {
    allowed: true,
    nextStatus: "published",
    reason: null
  });
});

// --- canTransition: every illegal transition --------------------------------

test("canTransition rejects skipping straight from draft to approved/published", () => {
  assert.equal(canTransition("draft", "approve").allowed, false);
  assert.equal(canTransition("draft", "reject").allowed, false);
  assert.equal(canTransition("draft", "publish").allowed, false);
});

test("canTransition rejects re-submitting a non-draft request", () => {
  assert.equal(canTransition("pending_review", "submit").allowed, false);
  assert.equal(canTransition("approved", "submit").allowed, false);
  assert.equal(canTransition("rejected", "submit").allowed, false);
  assert.equal(canTransition("published", "submit").allowed, false);
});

test("canTransition rejects approving/rejecting from any status but pending_review", () => {
  for (const status of ["draft", "approved", "rejected", "published"]) {
    assert.equal(canTransition(status, "approve").allowed, false);
    assert.equal(canTransition(status, "reject").allowed, false);
  }
});

test("canTransition rejects publishing from any status but approved", () => {
  for (const status of ["draft", "pending_review", "rejected", "published"]) {
    assert.equal(canTransition(status, "publish").allowed, false);
  }
});

test("canTransition rejects an already-terminal request moving anywhere", () => {
  for (const action of Object.keys(TRANSITIONS)) {
    assert.equal(canTransition("published", action).allowed, false);
    assert.equal(canTransition("rejected", action).allowed, false);
  }
});

test("canTransition rejects an unknown action", () => {
  const result = canTransition("draft", "delete");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /unknown action/);
});

// --- advanceChangeRequest: patch shapes -------------------------------------

test("advanceChangeRequest submit produces a bare status patch", () => {
  const patch = advanceChangeRequest({ status: "draft", requested_by: "user-1" }, "submit", "user-1");
  assert.deepEqual(patch, { status: "pending_review" });
});

test("advanceChangeRequest approve stamps reviewed_by/reviewed_at (reviewer differs from requester)", () => {
  const patch = advanceChangeRequest(
    { status: "pending_review", requested_by: "user-1" },
    "approve",
    "user-2"
  );
  assert.equal(patch.status, "approved");
  assert.equal(patch.reviewed_by, "user-2");
  assert.ok(patch.reviewed_at, "expected reviewed_at to be stamped");
  assert.equal(patch.error, undefined);
});

test("advanceChangeRequest reject stamps reviewed_by/reviewed_at and allows the requester as reviewer", () => {
  const patch = advanceChangeRequest(
    { status: "pending_review", requested_by: "user-1" },
    "reject",
    "user-1"
  );
  assert.equal(patch.status, "rejected");
  assert.equal(patch.reviewed_by, "user-1");
  assert.ok(patch.reviewed_at);
});

test("advanceChangeRequest publish stamps published_at only", () => {
  const patch = advanceChangeRequest(
    { status: "approved", requested_by: "user-1", reviewed_by: "user-2" },
    "publish",
    "user-3"
  );
  assert.deepEqual(Object.keys(patch).sort(), ["published_at", "status"]);
  assert.equal(patch.status, "published");
  assert.ok(patch.published_at);
});

// --- advanceChangeRequest: self-approval block ------------------------------

test("advanceChangeRequest blocks self-approval (reviewer === requester)", () => {
  const patch = advanceChangeRequest(
    { status: "pending_review", requested_by: "user-1" },
    "approve",
    "user-1"
  );
  assert.ok(patch.error, "expected a self-approval error");
  assert.match(patch.error, /self-approved/);
});

test("advanceChangeRequest does not block self-approval when requested_by is unset", () => {
  const patch = advanceChangeRequest({ status: "pending_review", requested_by: null }, "approve", "user-1");
  assert.equal(patch.status, "approved");
  assert.equal(patch.error, undefined);
});

// --- advanceChangeRequest: illegal transitions / missing actor -------------

test("advanceChangeRequest returns an error for an illegal transition", () => {
  const patch = advanceChangeRequest({ status: "draft", requested_by: "user-1" }, "publish", "user-1");
  assert.ok(patch.error);
  assert.equal(patch.status, undefined);
});

test("advanceChangeRequest requires an actor for approve/reject", () => {
  assert.ok(advanceChangeRequest({ status: "pending_review", requested_by: "user-1" }, "approve").error);
  assert.ok(advanceChangeRequest({ status: "pending_review", requested_by: "user-1" }, "reject", "").error);
});

test("advanceChangeRequest rejects a missing/statusless change request", () => {
  assert.ok(advanceChangeRequest(null, "submit", "user-1").error);
  assert.ok(advanceChangeRequest({}, "submit", "user-1").error);
});
