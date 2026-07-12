import { createHash } from "node:crypto";
import { buildConfigAuditEvent } from "./admin-config.mjs";

// Deterministic JSON: object keys emitted in stable (sorted) order at every
// depth, arrays preserved in their original order. This is the canonical form
// hashed into the audit chain so equal payloads always produce equal hashes.
export function canonicalize(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

// sha256 hex of the previous row's hash concatenated with the canonical form of
// this row. A null/undefined prevHash (the genesis row) contributes the empty
// string, so the first hash depends only on the row itself.
export function computeRowHash(prevHash, row) {
  return createHash("sha256")
    .update((prevHash ?? "") + canonicalize(row))
    .digest("hex");
}

// Walk a chain of [{...row, prev_hash, row_hash}] rows in order. Returns
// { valid, brokenAt }: brokenAt is the index of the first row whose stored
// linkage or hash does not match a recomputation, or null when the chain is
// intact. Detects both in-place mutation (recomputed hash diverges) and
// reordering (prev_hash no longer points at the preceding row's row_hash).
export function verifyChain(rows) {
  let previousHash = null;
  for (let index = 0; index < rows.length; index += 1) {
    const { prev_hash: prevHash = null, row_hash: rowHash, ...payload } = rows[index];
    if ((prevHash ?? null) !== (previousHash ?? null)) {
      return { valid: false, brokenAt: index };
    }
    if (computeRowHash(prevHash, payload) !== rowHash) {
      return { valid: false, brokenAt: index };
    }
    previousHash = rowHash;
  }
  return { valid: true, brokenAt: null };
}

// Shape a chained audit row: reuses buildConfigAuditEvent for the payload and
// links it to the previous row via prev_hash/row_hash. The hash covers the
// event fields only (not the hash columns themselves), matching verifyChain.
export function buildAuditRow(prevHash, params) {
  const event = buildConfigAuditEvent(params);
  return {
    ...event,
    prev_hash: prevHash ?? null,
    row_hash: computeRowHash(prevHash, event)
  };
}

// --- DB-side chain (0013_audit_chain.sql) -----------------------------------
// audit_events/incident_audit_events rows are hashed by the DB trigger
// fn_audit_chain_link(), not by buildAuditRow above (that pure function is
// unused pending this migration). computeDbRowHash/verifyDbChain mirror that
// trigger's formula exactly so the API can re-verify a chain from rows it
// fetches back over PostgREST.
//
// Canonical formula (must match the SQL comment on fn_audit_chain_link in
// supabase/migrations/0013_audit_chain.sql verbatim):
//
//   canonical =
//     event_type || '|' ||
//     entity_table || '|' ||
//     coalesce(entity_id::text, '') || '|' ||
//     coalesce(event_payload::text, '') || '|' ||
//     coalesce(facility_id::text, '') || '|' ||
//     coalesce(organization_id::text, '') || '|' ||
//     coalesce(to_jsonb(created_at) #>> '{}', '')
//
//   row_hash = sha256hex(coalesce(prev_hash, '') || canonical)
//
// jsonbText below deliberately does NOT re-sort object keys the way
// canonicalize() above does: jsonb normalizes key order at write time, and a
// row fetched back from PostgREST already carries jsonb's own key order in
// the JSON it returns, so replaying that order (rather than re-deriving it)
// is what makes this match `event_payload::text` as computed by the trigger.
// This is why the DB chain must be verified against DB-fetched rows rather
// than hand-built objects -- see 0013_audit_chain.sql's comment for the full
// reasoning, including why created_at is read from the DB's ISO-8601 JSON
// serialization rather than reformatted here.
function jsonbText(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(jsonbText).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value).map((key) => `${JSON.stringify(key)}: ${jsonbText(value[key])}`);
    return `{${entries.join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

// sha256 hex of a DB-fetched audit_events row, matching fn_audit_chain_link's
// row_hash formula exactly. `row` is expected to carry event_type,
// entity_table, entity_id, event_payload, facility_id, organization_id,
// created_at, and prev_hash as returned by PostgREST.
export function computeDbRowHash(row) {
  const canonical = [
    row.event_type ?? "",
    row.entity_table ?? "",
    row.entity_id != null ? String(row.entity_id) : "",
    row.event_payload != null ? jsonbText(row.event_payload) : "",
    row.facility_id != null ? String(row.facility_id) : "",
    row.organization_id != null ? String(row.organization_id) : "",
    row.created_at != null ? String(row.created_at) : ""
  ].join("|");
  return createHash("sha256")
    .update((row.prev_hash ?? "") + canonical)
    .digest("hex");
}

// Walk a chain of DB-fetched audit_events rows (ascending by created_at).
// Returns { valid, brokenAt } exactly like verifyChain above: brokenAt is the
// index of the first row whose stored prev_hash no longer points at the
// preceding row's row_hash, or whose row_hash no longer matches a
// recomputation (in-place tampering); null when the chain is intact.
export function verifyDbChain(rows) {
  let previousHash = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const prevHash = row.prev_hash ?? null;
    if (prevHash !== previousHash) {
      return { valid: false, brokenAt: index };
    }
    if (computeDbRowHash(row) !== row.row_hash) {
      return { valid: false, brokenAt: index };
    }
    previousHash = row.row_hash;
  }
  return { valid: true, brokenAt: null };
}
