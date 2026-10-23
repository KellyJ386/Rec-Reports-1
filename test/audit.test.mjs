import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  computeRowHash,
  verifyChain,
  buildAuditRow,
  computeIncidentAuditRowHash,
  verifyIncidentAuditChain
} from "../src/lib/audit.mjs";

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

// --- incident_audit_events' own canonical formula (IN-18) --------------------
// Distinct from computeDbRowHash/verifyDbChain (audit_events' formula,
// tested in audit-routes.test.mjs/internal-routes.test.mjs) -- these mirror
// fn_audit_chain_link's OTHER branch (0013_audit_chain.sql,
// `tg_table_name = 'incident_audit_events'`): incident_id in place of
// entity_table/entity_id/organization_id.

function buildIncidentChain(overrides = []) {
  const rows = [];
  let prevHash = null;
  const specs = [
    { id: 1, incident_id: "inc-1", event_type: "incident.created", event_payload: {}, created_at: "2026-07-18T10:00:00Z" },
    {
      id: 2,
      incident_id: "inc-1",
      event_type: "incident.submitted",
      event_payload: { actor: "user-1" },
      created_at: "2026-07-18T11:00:00Z"
    },
    {
      id: 3,
      incident_id: "inc-2",
      event_type: "incident.created",
      event_payload: {},
      created_at: "2026-07-18T12:00:00Z"
    }
  ].map((spec, index) => ({ ...spec, ...(overrides[index] ?? {}) }));
  for (const spec of specs) {
    const row = { ...spec, facility_id: "fac-1", prev_hash: prevHash };
    row.row_hash = computeIncidentAuditRowHash(row);
    rows.push(row);
    prevHash = row.row_hash;
  }
  return rows;
}

test("computeIncidentAuditRowHash is deterministic and depends on incident_id (not entity_table/entity_id)", () => {
  const row = { event_type: "incident.created", incident_id: "inc-1", facility_id: "fac-1", event_payload: {}, created_at: "2026-07-18T10:00:00Z", prev_hash: null };
  const first = computeIncidentAuditRowHash(row);
  const second = computeIncidentAuditRowHash(row);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);

  // A row carrying entity_table/entity_id (audit_events' own columns, which
  // incident_audit_events rows never have) must not change the hash --
  // proving this formula genuinely ignores them, unlike computeDbRowHash.
  const withStrayColumns = { ...row, entity_table: "incident_reports", entity_id: "inc-1" };
  assert.equal(computeIncidentAuditRowHash(withStrayColumns), first);

  // A different incident_id changes the hash.
  assert.notEqual(computeIncidentAuditRowHash({ ...row, incident_id: "inc-2" }), first);
});

test("verifyIncidentAuditChain passes on a well-formed, multi-incident, single-facility chain", () => {
  assert.deepEqual(verifyIncidentAuditChain(buildIncidentChain()), { valid: true, brokenAt: null });
});

test("verifyIncidentAuditChain detects a mutated row", () => {
  const rows = buildIncidentChain();
  rows[1] = { ...rows[1], event_payload: { actor: "tampered" } };
  assert.deepEqual(verifyIncidentAuditChain(rows), { valid: false, brokenAt: 1 });
});

test("verifyIncidentAuditChain detects a reordered chain", () => {
  const rows = buildIncidentChain();
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.deepEqual(verifyIncidentAuditChain(rows), { valid: false, brokenAt: 1 });
});

test("verifyIncidentAuditChain misreports a broken link when given a per-incident-filtered subset (must be run facility-wide)", () => {
  // This is the exact footgun incidents-routes.mjs's GET .../packet.pdf
  // avoids by fetching the facility's FULL chain for verification, separate
  // from the incident-filtered rows it displays. Reorder the fixture so
  // inc-1's own two rows are adjacent in insert order (id 1, 2) with inc-2's
  // row last (id 3) -- filtering OUT a middle row that belongs to a
  // different incident is the shape that actually matters (an incident's
  // own two rows staying adjacent would trivially still verify).
  const rows = buildIncidentChain([{}, { id: 2, incident_id: "inc-2" }, { id: 3, incident_id: "inc-1" }]);
  assert.deepEqual(verifyIncidentAuditChain(rows), { valid: true, brokenAt: null }); // the true, full chain is intact

  const inc1Only = rows.filter((row) => row.incident_id === "inc-1");
  assert.equal(inc1Only.length, 2);
  // inc-1's second row's prev_hash still points at inc-2's (excluded) row's
  // row_hash, not at inc-1's first row -- verifyIncidentAuditChain correctly
  // reports this as broken, which is exactly why the route must never call
  // it on a per-incident-filtered fetch.
  assert.deepEqual(verifyIncidentAuditChain(inc1Only), { valid: false, brokenAt: 1 });
});
