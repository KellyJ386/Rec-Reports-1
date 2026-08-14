import test from "node:test";
import assert from "node:assert/strict";
import { certificationEventFor, evidenceUploadedPayload } from "../src/lib/admin/cert-evidence.mjs";

const BASE = {
  id: "cert-1",
  facility_id: "fac-1",
  employee_id: "emp-1",
  certification_type_id: "type-cpr",
  issued_at: "2026-01-01",
  expires_at: "2027-01-01",
  status: "active"
};

test("certificationEventFor returns null when there is no after row", () => {
  assert.equal(certificationEventFor(null, null), null);
  assert.equal(certificationEventFor(BASE, undefined), null);
});

test("certificationEventFor derives 'created' when there is no before row (issue)", () => {
  const result = certificationEventFor(null, BASE);
  assert.equal(result.eventType, "created");
  assert.equal(result.payload.before, null);
  assert.equal(result.payload.after.status, "active");
  assert.equal(result.payload.after.expiresAt, "2027-01-01");
  assert.equal(result.payload.after.certificationTypeId, "type-cpr");
  assert.equal(result.payload.after.employeeId, "emp-1");
});

test("certificationEventFor derives 'created' the same way for a before=undefined caller", () => {
  const result = certificationEventFor(undefined, BASE);
  assert.equal(result.eventType, "created");
});

test("certificationEventFor derives 'renewed' when expires_at moves strictly later", () => {
  const after = { ...BASE, expires_at: "2028-01-01" };
  const result = certificationEventFor(BASE, after);
  assert.equal(result.eventType, "renewed");
  assert.equal(result.payload.before.expiresAt, "2027-01-01");
  assert.equal(result.payload.after.expiresAt, "2028-01-01");
});

test("certificationEventFor does not fire 'renewed' when expires_at moves earlier or stays the same", () => {
  assert.equal(certificationEventFor(BASE, { ...BASE, expires_at: "2026-06-01" }), null);
  assert.equal(certificationEventFor(BASE, { ...BASE, expires_at: "2027-01-01" }), null);
});

test("certificationEventFor derives 'revoked' on a transition into status='revoked'", () => {
  const after = { ...BASE, status: "revoked" };
  const result = certificationEventFor(BASE, after);
  assert.equal(result.eventType, "revoked");
  assert.equal(result.payload.before.status, "active");
  assert.equal(result.payload.after.status, "revoked");
});

test("certificationEventFor does not re-fire 'revoked' when the cert is already revoked", () => {
  const revoked = { ...BASE, status: "revoked" };
  assert.equal(certificationEventFor(revoked, { ...revoked }), null);
});

test("certificationEventFor prefers 'revoked' over 'renewed' when both fields change in the same write", () => {
  const after = { ...BASE, status: "revoked", expires_at: "2029-01-01" };
  const result = certificationEventFor(BASE, after);
  assert.equal(result.eventType, "revoked");
});

test("certificationEventFor returns null for a no-op or cosmetic patch (status back to active, no expiry change)", () => {
  assert.equal(certificationEventFor(BASE, { ...BASE }), null);
});

test("certificationEventFor accepts camelCase before/after rows as well as snake_case", () => {
  const beforeCamel = {
    status: "active",
    expiresAt: "2027-01-01",
    issuedAt: "2026-01-01",
    certificationTypeId: "type-cpr",
    employeeId: "emp-1"
  };
  const afterCamel = { ...beforeCamel, expiresAt: "2028-01-01" };
  const result = certificationEventFor(beforeCamel, afterCamel);
  assert.equal(result.eventType, "renewed");
  assert.equal(result.payload.after.expiresAt, "2028-01-01");
});

test("evidenceUploadedPayload shapes a payload_jsonb snapshot with nulls for missing fields", () => {
  assert.deepEqual(evidenceUploadedPayload(), {
    path: null,
    checksumSha256: null,
    contentType: null,
    sizeBytes: null
  });
  assert.deepEqual(
    evidenceUploadedPayload({ path: "facilities/x/certifications/y/z-file.pdf", checksumSha256: "abc", contentType: "application/pdf", sizeBytes: 1024 }),
    {
      path: "facilities/x/certifications/y/z-file.pdf",
      checksumSha256: "abc",
      contentType: "application/pdf",
      sizeBytes: 1024
    }
  );
});
