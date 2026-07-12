// Generic CSV/JSON export helpers shared by every facility-scoped data-export
// surface: audit-export.mjs's audit timeline (which re-exports toCsv/toJson
// from here so its public API is unchanged) and the generic
// GET /facilities/:facilityId/export/:table route (workflow-routes.mjs).
// This module owns the actual escaping/shaping so the two surfaces can never
// drift apart on RFC 4180 quoting rules.

// Escape a single CSV field per RFC 4180: wrap in quotes (doubling any
// embedded quotes) whenever the value contains a comma, quote, or newline.
// Nested jsonb is stringified first so it round-trips as one field rather
// than exploding the row.
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// Column list to export, in order. An explicit `columns` array wins (e.g.
// audit-export's fixed AUDIT_COLUMNS); otherwise the sorted union of keys
// across every row, so an arbitrary allow-listed table exports something
// sane without the caller needing to know its schema up front.
function resolveColumns(rows, columns) {
  if (Array.isArray(columns) && columns.length > 0) return columns;
  const keys = new Set();
  for (const row of rows ?? []) {
    for (const key of Object.keys(row ?? {})) keys.add(key);
  }
  return [...keys].sort();
}

export function toCsv(rows, columns) {
  const cols = resolveColumns(rows, columns);
  const lines = [cols.join(",")];
  for (const row of rows ?? []) {
    lines.push(cols.map((column) => csvEscape((row ?? {})[column])).join(","));
  }
  return lines.join("\r\n");
}

export function toJson(rows) {
  return JSON.stringify(rows ?? [], null, 2);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Shapes the exportable file for a set of rows -- { contentType, filename,
// body }. `namePrefix` becomes the leading segment of the filename (e.g.
// "audit-export", "incident_reports-export"); `columns` fixes the CSV column
// order when the caller has one.
export function buildExportPackage(rows, format, { namePrefix = "export", columns } = {}) {
  const normalized = format === "json" ? "json" : "csv";
  const filename = `${namePrefix}-${timestampSlug()}.${normalized}`;
  if (normalized === "json") {
    return { contentType: "application/json", filename, body: toJson(rows) };
  }
  return { contentType: "text/csv", filename, body: toCsv(rows, columns) };
}

// Allow-list of facility-scoped tables the generic /export/:table endpoint
// may read, each mapped to the permission code required to export it (the
// route layer also accepts admin.manage as a fallback for every table).
export const EXPORTABLE_TABLES = Object.freeze({
  report_submissions: "reports.export",
  incident_reports: "incidents.read",
  work_orders: "work_orders.read",
  schedule_shifts: "schedule.read",
  messages: "communications.read",
  training_assignments: "training.read",
  employee_certifications: "training.read",
  audit_events: "admin.manage"
});

export function isExportableTable(tableName) {
  return Object.prototype.hasOwnProperty.call(EXPORTABLE_TABLES, tableName);
}

export function permissionForTable(tableName) {
  return EXPORTABLE_TABLES[tableName] ?? null;
}

// Exports `rows` from `tableName` (must be in EXPORTABLE_TABLES) as csv/json.
// Returns { error } for an unknown table instead of throwing, so the route
// layer can map it to a 400 without a try/catch.
export function exportTable(rows, format, tableName) {
  if (!isExportableTable(tableName)) {
    return { error: `table is not exportable: ${tableName}` };
  }
  return buildExportPackage(rows ?? [], format, { namePrefix: `${tableName}-export` });
}
