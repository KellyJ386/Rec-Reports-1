// Pure helpers for the certification lifecycle event writer (TR-04) and the
// evidence-upload write path (TR-03). No I/O here: the route layer loads/
// writes the employee_certifications row and passes a before/after snapshot
// in, so this stays a deterministic transform node:test can exercise
// directly -- mirroring ../admin/cert-policy.mjs and ../admin/training.mjs.

const REVOKED = "revoked";

// Adapts an employee_certifications row (snake_case DB shape, or a
// caller-built camelCase object) into the payload_jsonb snapshot shape.
// Returns null for a missing row (the "before" side of an issue/create).
function certSnapshot(cert) {
  if (!cert) return null;
  return {
    status: cert.status ?? null,
    issuedAt: cert.issued_at ?? cert.issuedAt ?? null,
    expiresAt: cert.expires_at ?? cert.expiresAt ?? null,
    certificationTypeId: cert.certification_type_id ?? cert.certificationTypeId ?? null,
    employeeId: cert.employee_id ?? cert.employeeId ?? null
  };
}

// Derives the certification_events row to append for an
// employee_certifications write, given the row's state `before` the write
// (null/undefined on a fresh issue) and `after` the write. Returns
// { eventType, payload } or null when the write does not correspond to any
// of the three lifecycle events this module tracks -- e.g. a cosmetic
// correction (title/description-only edit, or no employee_certifications
// table has none of those, but a re-save with identical expires_at/status)
// that changes neither expires_at nor status.
//
// Precedence, in order:
//   1. No `before` row at all -> 'created' (an issue). Always fires.
//   2. A transition INTO 'revoked' -> 'revoked'. This wins over any
//      simultaneous expires_at change in the same write (a manager can
//      revoke and edit expires_at in one PATCH; the revoke is the
//      meaningful event, so no separate 'renewed' event is also emitted).
//   3. expires_at moves strictly later than before, and the write does not
//      also revoke the cert -> 'renewed'.
//   4. Anything else (status-only correction back to 'active', expires_at
//      unchanged or moved earlier, no-op patch) -> null, no event.
export function certificationEventFor(before, after) {
  if (!after) return null;

  if (!before) {
    return { eventType: "created", payload: { before: null, after: certSnapshot(after) } };
  }

  const beforeStatus = before.status ?? null;
  const afterStatus = after.status ?? null;

  if (afterStatus === REVOKED && beforeStatus !== REVOKED) {
    return { eventType: "revoked", payload: { before: certSnapshot(before), after: certSnapshot(after) } };
  }

  const beforeExpiresAt = before.expires_at ?? before.expiresAt ?? null;
  const afterExpiresAt = after.expires_at ?? after.expiresAt ?? null;
  const isRenewal =
    afterStatus !== REVOKED &&
    afterExpiresAt &&
    (!beforeExpiresAt || new Date(afterExpiresAt) > new Date(beforeExpiresAt));
  if (isRenewal) {
    return { eventType: "renewed", payload: { before: certSnapshot(before), after: certSnapshot(after) } };
  }

  return null;
}

// Shapes the payload_jsonb for an 'evidence_uploaded' certification_events
// row. Kept alongside certificationEventFor since both are "what goes into
// certification_events.payload_jsonb for this write" helpers, even though
// the route always fires this event unconditionally (unlike the lifecycle
// transitions above, an evidence upload is never a no-op).
export function evidenceUploadedPayload({ path, checksumSha256, contentType, sizeBytes } = {}) {
  return {
    path: path ?? null,
    checksumSha256: checksumSha256 ?? null,
    contentType: contentType ?? null,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null
  };
}
