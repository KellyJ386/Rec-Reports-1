import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { pgSelect } from "../supabase-rest.mjs";

function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
}

function base64UrlEncode(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
    if (!header || typeof header !== "object") return null;
    if (!payload || typeof payload !== "object") return null;
    return { header, payload, headerB64, payloadB64, signatureB64 };
  } catch {
    return null;
  }
}

// Shared claim checks for both signing algorithms: the token must be unexpired
// and, when an audience is present, minted for the "authenticated" audience
// (what Supabase Auth stamps on user access tokens).
function validateClaims(payload) {
  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.aud !== undefined) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes("authenticated")) return null;
  }
  return payload;
}

export function verifySupabaseJwt(token, jwtSecret) {
  if (!jwtSecret) return null;
  const decoded = decodeToken(token);
  if (!decoded) return null;
  const { header, payload, headerB64, payloadB64, signatureB64 } = decoded;
  if (header.alg !== "HS256") return null;

  const expectedSignature = base64UrlEncode(
    createHmac("sha256", jwtSecret).update(`${headerB64}.${payloadB64}`).digest()
  );
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signatureB64);
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;

  return validateClaims(payload);
}

// --- Asymmetric (ES256/JWKS) verification ----------------------------------
// New Supabase projects sign access tokens with ES256 (P-256) and publish the
// public keys at {SUPABASE_URL}/auth/v1/.well-known/jwks.json. The key set is
// cached in-module with a TTL so steady-state verification never touches the
// network; a fetch implementation can be injected for tests.

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map();

export function clearJwksCache() {
  jwksCache.clear();
}

async function fetchJwks(supabaseUrl, fetchImpl) {
  const url = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const response = await doFetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`JWKS fetch failed with status ${response.status}`);
  const body = JSON.parse(await response.text());
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys;
}

function verifyEs256Signature(headerB64, payloadB64, signatureB64, jwk) {
  try {
    const publicKey = createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      format: "jwk"
    });
    return verifySignature(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      base64UrlDecode(signatureB64)
    );
  } catch {
    return false;
  }
}

// Async verifier covering both signing schemes. HS256 is used when a shared
// SUPABASE_JWT_SECRET is configured (legacy projects); otherwise the token is
// verified against the project's published JWKS (ES256, P-256). Returns the
// claims payload on success, null on any failure.
export async function verifySupabaseToken(token, { jwtSecret, supabaseUrl, fetchImpl } = {}) {
  const decoded = decodeToken(token);
  if (!decoded) return null;

  if (decoded.header.alg === "HS256") {
    return jwtSecret ? verifySupabaseJwt(token, jwtSecret) : null;
  }
  if (decoded.header.alg !== "ES256" || !supabaseUrl) return null;

  let keys;
  try {
    keys = await fetchJwks(supabaseUrl, fetchImpl);
  } catch {
    return null;
  }
  const jwk = keys.find((key) => key.kid === decoded.header.kid && key.kty === "EC");
  if (!jwk) return null;
  if (!verifyEs256Signature(decoded.headerB64, decoded.payloadB64, decoded.signatureB64, jwk)) {
    return null;
  }
  return validateClaims(decoded.payload);
}

// True when the user is on the platform_admins roster (0022): the platform
// super-admin scope that passes every permission check and sees every
// facility. Fail-closed: any lookup problem reads as "not a platform admin".
export async function loadPlatformAdmin(client, userId) {
  try {
    const rows = await pgSelect(client, "platform_admins", {
      filters: { user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? []).length > 0;
  } catch {
    return false;
  }
}

export async function loadMemberships(client, userId) {
  const rows = await pgSelect(client, "memberships", {
    filters: { user_id: userId },
    select: "id,facility_id,department_id,status,role_id,roles(role_permissions(permission_code))"
  });
  return (rows ?? []).map((row) => ({
    id: row.id,
    facilityId: row.facility_id,
    departmentId: row.department_id ?? null,
    status: row.status,
    roleId: row.role_id,
    permissions: (row.roles?.role_permissions ?? []).map((entry) => entry.permission_code)
  }));
}
