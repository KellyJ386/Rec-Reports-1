import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, computeRowHash, verifyChain, buildAuditRow } from "../src/lib/audit.mjs";

test("computeRowHash is deterministic for identical inputs", () => {
  const row = { entity_table: "facility_settings", after: { locale: "en-US" } };
  const first = computeRowHash("prev-hash", row);
  const second = computeRowHash("prev-hash", row);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  // A different prevHash yields a different hash.
  assert.notEqual(first, computeRowHash("other-hash", row));
});

test("canonicalize is independent of object key order", () => {
  assert.equal(
    canonicalize({ a: 1, b: { c: 2, d: 3 } }),
    canonicalize({ b: { d: 3, c: 2 }, a: 1 })
  );
  // Array order is preserved (not sorted).
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
  // Key-order independence propagates into the hash.
  assert.equal(
    computeRowHash(null, { x: 1, y: 2 }),
    computeRowHash(null, { y: 2, x: 1 })
  );
});

function buildChain() {
  const rows = [];
  let prev = null;
  for (const payload of [
    { seq: 1, entity_table: "organizations", after: { name: "Org" } },
    { seq: 2, entity_table: "facility_settings", after: { locale: "en-US" } },
    { seq: 3, entity_table: "branding_profiles", after: { theme: "dark" } }
  ]) {
    const rowHash = computeRowHash(prev, payload);
    rows.push({ ...payload, prev_hash: prev, row_hash: rowHash });
    prev = rowHash;
  }
  return rows;
}

test("verifyChain passes on a well-formed 3-row chain", () => {
  assert.deepEqual(verifyChain(buildChain()), { valid: true, brokenAt: null });
});

test("verifyChain detects a mutated middle row", () => {
  const rows = buildChain();
  rows[1] = { ...rows[1], after: { locale: "fr-FR" } };
  assert.deepEqual(verifyChain(rows), { valid: false, brokenAt: 1 });
});

test("verifyChain detects a reordered chain", () => {
  const rows = buildChain();
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.deepEqual(verifyChain(rows), { valid: false, brokenAt: 1 });
});

test("buildAuditRow reuses buildConfigAuditEvent and chains it", () => {
  const row = buildAuditRow(null, {
    facilityId: "facility-1",
    actorUserId: "user-1",
    entityTable: "facility_settings",
    entityId: "settings-1",
    before: { locale: "en-US" },
    after: { locale: "fr-FR" }
  });
  assert.equal(row.event_type, "config.changed");
  assert.equal(row.prev_hash, null);
  const { prev_hash, row_hash, ...payload } = row;
  assert.equal(row_hash, computeRowHash(null, payload));
  assert.deepEqual(verifyChain([row]), { valid: true, brokenAt: null });
});
