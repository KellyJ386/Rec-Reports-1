import test from "node:test";
import assert from "node:assert/strict";
import {
  toCsv,
  toJson,
  buildExportPackage,
  EXPORTABLE_TABLES,
  isExportableTable,
  permissionForTable,
  exportTable
} from "../src/lib/admin/export.mjs";
import { permissions } from "../src/lib/permissions.mjs";

// --- toCsv / toJson: generic shared helpers ---------------------------------

test("toCsv derives a sorted column union when no explicit columns are given", () => {
  const csv = toCsv([{ b: 2, a: 1 }, { a: 3, c: 4 }]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "a,b,c");
  assert.equal(lines[1], "1,2,");
  assert.equal(lines[2], "3,,4");
});

test("toCsv honors an explicit column order/subset", () => {
  const csv = toCsv([{ a: 1, b: 2, c: 3 }], ["c", "a"]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "c,a");
  assert.equal(lines[1], "3,1");
});

test("toCsv escapes commas, quotes, and newlines per RFC 4180", () => {
  const csv = toCsv([{ note: 'has,comma "quote"\nand newline' }], ["note"]);
  const lines = csv.split("\r\n");
  assert.equal(lines[1], '"has,comma ""quote""\nand newline"');
});

test("toCsv stringifies nested objects as one field", () => {
  const csv = toCsv([{ payload: { nested: { ok: true } } }], ["payload"]);
  const lines = csv.split("\r\n");
  // JSON.stringify({nested:{ok:true}}) contains a comma, so csvEscape wraps it
  // in quotes (doubling embedded quotes) -- unwrap+unescape before comparing.
  assert.ok(lines[1].startsWith('"') && lines[1].endsWith('"'));
  const unescaped = lines[1].slice(1, -1).replace(/""/g, '"');
  assert.deepEqual(JSON.parse(unescaped), { nested: { ok: true } });
});

test("toCsv treats null/undefined as an empty field", () => {
  const csv = toCsv([{ a: null, b: undefined }], ["a", "b"]);
  assert.equal(csv.split("\r\n")[1], ",");
});

test("toCsv emits only the header for an empty row set", () => {
  assert.equal(toCsv([], ["a", "b"]), "a,b");
  assert.equal(toCsv(undefined, ["a"]), "a");
});

test("toJson round-trips rows and defaults undefined to an empty array", () => {
  const rows = [{ id: "1" }, { id: "2" }];
  assert.deepEqual(JSON.parse(toJson(rows)), rows);
  assert.deepEqual(JSON.parse(toJson(undefined)), []);
});

// --- buildExportPackage -------------------------------------------------

test("buildExportPackage defaults to csv with a namePrefix-based filename", () => {
  const pkg = buildExportPackage([{ a: 1 }], "csv", { namePrefix: "widgets-export", columns: ["a"] });
  assert.equal(pkg.contentType, "text/csv");
  assert.match(pkg.filename, /^widgets-export-.+\.csv$/);
  assert.equal(pkg.body, "a\r\n1");
});

test("buildExportPackage supports json and falls back to csv for unknown formats", () => {
  const rows = [{ id: "1" }];
  const jsonPkg = buildExportPackage(rows, "json", { namePrefix: "widgets-export" });
  assert.equal(jsonPkg.contentType, "application/json");
  assert.deepEqual(JSON.parse(jsonPkg.body), rows);

  const fallbackPkg = buildExportPackage(rows, "xml", { namePrefix: "widgets-export" });
  assert.equal(fallbackPkg.contentType, "text/csv");
});

test("buildExportPackage defaults namePrefix to 'export' when omitted", () => {
  const pkg = buildExportPackage([], "csv");
  assert.match(pkg.filename, /^export-.+\.csv$/);
});

// --- allow-list enforcement --------------------------------------------------

test("EXPORTABLE_TABLES covers exactly the Phase 6 allow-list", () => {
  assert.deepEqual(Object.keys(EXPORTABLE_TABLES).sort(), [
    "audit_events",
    "employee_certifications",
    "incident_reports",
    "messages",
    "report_submissions",
    "schedule_shifts",
    "training_assignments",
    "work_orders"
  ]);
});

test("every mapped permission code is in the frozen permissions catalog", () => {
  for (const code of Object.values(EXPORTABLE_TABLES)) {
    assert.ok(permissions.includes(code), `${code} is not a known permission code`);
  }
});

test("isExportableTable / permissionForTable agree with the allow-list", () => {
  assert.equal(isExportableTable("incident_reports"), true);
  assert.equal(permissionForTable("incident_reports"), "incidents.read");
  assert.equal(isExportableTable("app_users"), false);
  assert.equal(permissionForTable("app_users"), null);
});

test("exportTable rejects a table outside the allow-list", () => {
  const result = exportTable([{ id: "1" }], "csv", "app_users");
  assert.ok(result.error);
  assert.match(result.error, /not exportable/);
});

test("exportTable exports an allow-listed table as csv", () => {
  const pkg = exportTable([{ id: "1", facility_id: "fac-1" }], "csv", "incident_reports");
  assert.equal(pkg.contentType, "text/csv");
  assert.match(pkg.filename, /^incident_reports-export-.+\.csv$/);
  assert.match(pkg.body, /facility_id/);
});

test("exportTable exports an allow-listed table as json", () => {
  const rows = [{ id: "1" }];
  const pkg = exportTable(rows, "json", "work_orders");
  assert.equal(pkg.contentType, "application/json");
  assert.deepEqual(JSON.parse(pkg.body), rows);
});

test("exportTable handles nested JSONB fields in csv output", () => {
  const rows = [{ id: "1", event_payload: { before: null, after: { locale: "en-US" } } }];
  const pkg = exportTable(rows, "csv", "audit_events");
  const lines = pkg.body.split("\r\n");
  const header = lines[0].split(",");
  const payloadIndex = header.indexOf("event_payload");
  assert.ok(payloadIndex >= 0);
});
