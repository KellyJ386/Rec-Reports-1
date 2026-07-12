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
