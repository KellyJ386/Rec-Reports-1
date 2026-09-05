import test from "node:test";
import assert from "node:assert/strict";
import { toCsv, toJson, buildExportPackage } from "../src/lib/admin/audit-export.mjs";
import { computeDbRowHash, verifyDbChain } from "../src/lib/audit.mjs";

const CSV_HEADER =
  "id,chain_seq,created_at,event_type,entity_table,entity_id,facility_id,organization_id,actor_user_id,event_payload,prev_hash,row_hash";

// Minimal RFC 4180 line parser used only to assert toCsv's output round-trips
// correctly, independent of exactly how it chooses to escape any given field.
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

test("toCsv emits only the header for an empty row set", () => {
  assert.equal(toCsv([]), CSV_HEADER);
  assert.equal(toCsv(undefined), CSV_HEADER);
});

test("toCsv escapes commas, quotes, and newlines, and stringifies nested jsonb", () => {
  const row = {
    id: "row-1",
    chain_seq: 1,
    created_at: "2026-01-01T00:00:00Z",
    event_type: "config,changed",
    entity_table: 'facility"settings',
    entity_id: "entity-1",
    facility_id: "fac-1",
    organization_id: null,
    actor_user_id: null,
    event_payload: { note: "line one\nline two", nested: { ok: true } },
    prev_hash: null,
    row_hash: "hash-1"
  };
  const csv = toCsv([row]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], CSV_HEADER);

  const fields = parseCsvLine(lines[1]);
  assert.equal(fields[0], "row-1");
  assert.equal(fields[1], "1");
  assert.equal(fields[3], "config,changed");
  assert.equal(fields[4], 'facility"settings');
  assert.equal(fields[6], "fac-1");
  assert.equal(fields[7], "");
  assert.equal(fields[8], "");
  assert.deepEqual(JSON.parse(fields[9]), { note: "line one\nline two", nested: { ok: true } });
  assert.equal(fields[10], "");
  assert.equal(fields[11], "hash-1");
});

test("toJson round-trips rows exactly", () => {
  const rows = [
    { id: "1", event_type: "config.changed", event_payload: { after: { a: 1 } } },
    { id: "2", event_type: "config.changed", event_payload: { after: { b: 2 } } }
  ];
  assert.deepEqual(JSON.parse(toJson(rows)), rows);
  assert.deepEqual(JSON.parse(toJson(undefined)), []);
});

test("buildExportPackage defaults to csv with a timestamped filename", () => {
  const pkg = buildExportPackage([], "csv");
  assert.equal(pkg.contentType, "text/csv");
  assert.match(pkg.filename, /^audit-export-.+\.csv$/);
  assert.equal(pkg.body, toCsv([]));
});

test("buildExportPackage supports json and falls back to csv for unknown formats", () => {
  const rows = [{ id: "1" }];
  const jsonPkg = buildExportPackage(rows, "json");
  assert.equal(jsonPkg.contentType, "application/json");
  assert.match(jsonPkg.filename, /\.json$/);
  assert.deepEqual(JSON.parse(jsonPkg.body), rows);

  const fallbackPkg = buildExportPackage(rows, "xml");
  assert.equal(fallbackPkg.contentType, "text/csv");
  assert.match(fallbackPkg.filename, /\.csv$/);
});

// --- computeDbRowHash / verifyDbChain --------------------------------------
// Rows shaped as PostgREST would return an audit_events row.
function buildDbChain() {
  const specs = [
    {
      event_type: "config.changed",
      entity_table: "organizations",
      entity_id: "org-1",
      event_payload: { before: null, after: { name: "Org" } },
      facility_id: null,
      organization_id: "org-1",
      created_at: "2026-01-01T00:00:00.000000+00:00"
    },
    {
      event_type: "config.changed",
      entity_table: "facility_settings",
      entity_id: "fs-1",
      event_payload: { before: null, after: { locale: "en-US" } },
      facility_id: "fac-1",
      organization_id: null,
      created_at: "2026-01-01T00:00:01.000000+00:00"
    },
    {
      event_type: "config.changed",
      entity_table: "branding_profiles",
      entity_id: "bp-1",
      event_payload: { before: { theme: "light" }, after: { theme: "dark" } },
      facility_id: "fac-1",
      organization_id: null,
      created_at: "2026-01-01T00:00:02.000000+00:00"
    }
  ];
  const rows = [];
  let prev = null;
  for (const spec of specs) {
    const row = { ...spec, prev_hash: prev };
    row.row_hash = computeDbRowHash(row);
    rows.push(row);
    prev = row.row_hash;
  }
  return rows;
}

test("computeDbRowHash is deterministic and sensitive to prev_hash", () => {
  const row = {
    event_type: "config.changed",
    entity_table: "facilities",
    entity_id: "f-1",
    event_payload: { after: { name: "A" } },
    facility_id: "fac-1",
    organization_id: null,
    created_at: "2026-01-01T00:00:00Z",
    prev_hash: null
  };
  const first = computeDbRowHash(row);
  const second = computeDbRowHash(row);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, computeDbRowHash({ ...row, prev_hash: "other-hash" }));
});

test("verifyDbChain passes on a well-formed 3-row chain", () => {
  assert.deepEqual(verifyDbChain(buildDbChain()), { valid: true, brokenAt: null });
});

test("verifyDbChain detects a mutated payload", () => {
  const rows = buildDbChain();
  rows[1] = { ...rows[1], event_payload: { before: null, after: { locale: "fr-FR" } } };
  assert.deepEqual(verifyDbChain(rows), { valid: false, brokenAt: 1 });
});

test("verifyDbChain detects reordered rows", () => {
  const rows = buildDbChain();
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.deepEqual(verifyDbChain(rows), { valid: false, brokenAt: 1 });
});
