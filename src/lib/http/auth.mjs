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

export function verifySupabaseJwt(token, jwtSecret) {
  if (typeof token !== "string" || !jwtSecret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const expectedSignature = base64UrlEncode(
    createHmac("sha256", jwtSecret).update(`${headerB64}.${payloadB64}`).digest()
  );
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signatureB64);
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;

  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// --- Asymmetric (JWKS) verification ---------------------------------------
//
// Supabase projects can sign access tokens either with the legacy shared HS256
// secret or with a project keypair (ES256/RS256) published at
// /auth/v1/.well-known/jwks.json. Which one a project uses is a project
// setting, not something the token issuer tells us in advance, so the verifier
// below handles both and picks based on the token's own `alg` header. Without
// this, a project on asymmetric signing would let users sign in successfully
// and then reject every subsequent API call with 401.

const JWS_ALGORITHMS = {
  // JWS ES256 signatures are the raw r||s pair, not the DER encoding
  // node:crypto verifies by default.
  ES256: { hash: "sha256", options: { dsaEncoding: "ieee-p1363" } },
  ES512: { hash: "sha512", options: { dsaEncoding: "ieee-p1363" } },
  RS256: { hash: "sha256", options: {} },
  RS512: { hash: "sha512", options: {} }
};

const JWKS_TTL_MS = 10 * 60 * 1000;

// Cache of parsed JWKS per project URL. Refetched when a token presents an
// unknown `kid` (key rotation) but at most once per TTL window, so a bogus kid
// cannot be used to hammer the auth server.
const jwksCache = new Map();

function jwksUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
}

async function fetchJwks(supabaseUrl, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(jwksUrl(supabaseUrl));
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  try {
    const body = JSON.parse(await response.text());
    return Array.isArray(body?.keys) ? body.keys : null;
  } catch {
    return null;
  }
}

async function resolveJwk(supabaseUrl, kid, fetchImpl) {
  const now = Date.now();
  const cached = jwksCache.get(supabaseUrl);
  const findKey = (keys) =>
    keys?.find((key) => (kid ? key.kid === kid : true)) ?? (kid ? null : (keys?.[0] ?? null));

  if (cached) {
    const hit = findKey(cached.keys);
    if (hit) return hit;
    // Unknown kid: only pay for a refetch once the TTL has elapsed.
    if (now - cached.fetchedAt < JWKS_TTL_MS) return null;
  }

  const keys = await fetchJwks(supabaseUrl, fetchImpl);
  if (!keys) return null;
  jwksCache.set(supabaseUrl, { keys, fetchedAt: now });
  return findKey(keys);
}

// Exported for tests: drops the cached JWKS so a test can control what the next
// verification fetches.
export function resetJwksCache() {
  jwksCache.clear();
}

// Builds the verifier the request pipeline uses. Returns an async function that
// resolves to the token's claims, or null for anything it cannot positively
// verify (unknown algorithm, bad signature, expired, unreachable JWKS).
export function createJwtVerifier({ jwtSecret, supabaseUrl, fetchImpl = globalThis.fetch } = {}) {
  return async function verify(token) {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    let header;
    try {
      header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    } catch {
      return null;
    }

    // Legacy shared-secret projects.
    if (header.alg === "HS256") return verifySupabaseJwt(token, jwtSecret);

    const algorithm = JWS_ALGORITHMS[header.alg];
    if (!algorithm || !supabaseUrl) return null;

    const jwk = await resolveJwk(supabaseUrl, header.kid, fetchImpl);
    if (!jwk) return null;

    let key;
    try {
      key = createPublicKey({ key: jwk, format: "jwk" });
    } catch {
      return null;
    }

    let signatureValid;
    try {
      signatureValid = verifySignature(
        algorithm.hash,
        Buffer.from(`${headerB64}.${payloadB64}`),
        { key, ...algorithm.options },
        base64UrlDecode(signatureB64)
      );
    } catch {
      return null;
    }
    if (!signatureValid) return null;

    let payload;
    try {
      payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
    } catch {
      return null;
    }
    if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return payload;
  };
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
