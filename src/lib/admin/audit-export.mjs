import { pgSelect } from "../supabase-rest.mjs";

// Columns returned/exported for every audit timeline row. Order here is the
// column order in the CSV export.
const AUDIT_COLUMNS = [
  "id",
  "created_at",
  "event_type",
  "entity_table",
  "entity_id",
  "facility_id",
  "organization_id",
  "actor_user_id",
  "event_payload",
  "prev_hash",
  "row_hash"
];

// Query audit_events for a facility's timeline, translating the caller's
// filters into PostgREST query params. entityTable/eventType are exact-match
// (pgSelect's `filters` already emits `eq.`); from/to are a created_at range,
// built as a raw `extra` param since pgSelect's filters helper only knows
// `eq.` -- a single bound uses `created_at=gte.X` (or `lte.X`), and both
// bounds together use PostgREST's `and=(...)` grouping so two conditions can
// land on the same column (a bare `extra` object can only set one value per
// key).
export async function queryAuditTimeline(
  client,
  { facilityId, entityTable, eventType, from, to, limit, order } = {}
) {
  const filters = {};
  if (facilityId) filters.facility_id = facilityId;
  if (entityTable) filters.entity_table = entityTable;
  if (eventType) filters.event_type = eventType;

  const extra = {};
  if (from && to) {
    extra.and = `(created_at.gte.${from},created_at.lte.${to})`;
  } else if (from) {
    extra.created_at = `gte.${from}`;
  } else if (to) {
    extra.created_at = `lte.${to}`;
  }

  const rows = await pgSelect(client, "audit_events", {
    filters,
    select: AUDIT_COLUMNS.join(","),
    order: order ?? "created_at.desc",
    limit: limit ?? 100,
    extra: Object.keys(extra).length > 0 ? extra : undefined
  });
  return rows ?? [];
}

// Escape a single CSV field per RFC 4180: wrap in quotes (doubling any
// embedded quotes) whenever the value contains a comma, quote, or newline.
// Nested jsonb (event_payload) is stringified first so it round-trips as one
// field rather than exploding the row.
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows) {
  const lines = [AUDIT_COLUMNS.join(",")];
  for (const row of rows ?? []) {
    lines.push(AUDIT_COLUMNS.map((column) => csvEscape(row[column])).join(","));
  }
  return lines.join("\r\n");
}

export function toJson(rows) {
  return JSON.stringify(rows ?? [], null, 2);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Shapes the exportable file for a set of audit rows. Returns
// { contentType, filename, body } -- the caller (audit-routes.mjs) is
// responsible for how that gets to the client, since it also has to survive
// the Bearer-token auth header the export endpoint requires (see
// src/public/admin/js/pages/audit.js, which turns this into a Blob download
// rather than a bare href).
export function buildExportPackage(rows, format) {
  const normalized = format === "json" ? "json" : "csv";
  const filename = `audit-export-${timestampSlug()}.${normalized}`;
  if (normalized === "json") {
    return { contentType: "application/json", filename, body: toJson(rows) };
  }
  return { contentType: "text/csv", filename, body: toCsv(rows) };
}
