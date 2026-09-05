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

// Leeway for the time-based claims. Servers and the auth issuer do not share a
// clock; without it a few seconds of drift rejects freshly-minted tokens.
const CLOCK_SKEW_SECONDS = 30;

// The reserved-claim gate both signing modes go through. A valid signature only
// proves who minted the token -- it says nothing about whether the token is
// still live, or whether it is a *user session* at all -- so this is where the
// verifier decides to trust the payload.
//
// `aud` is deliberately not enforced: Supabase projects can be configured with
// a custom audience (and GoTrue emits `aud` as either a string or an array), so
// pinning it to "authenticated" would reject legitimate deployments. The
// `sub`/`role` checks below cover the case that actually matters -- a
// non-session token being replayed as one.
function validateClaims(payload) {
  if (!payload || typeof payload !== "object") return null;
  const now = Math.floor(Date.now() / 1000);

  // `exp` is REQUIRED. Treating a missing (or non-numeric) exp as "no expiry"
  // would make any leaked token valid forever and defeat session expiry.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  if (payload.exp <= now - CLOCK_SKEW_SECONDS) return null;

  // Not-yet-valid tokens are not valid tokens.
  if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_SECONDS) return null;

  // `sub` is REQUIRED, and the two non-user roles are refused outright.
  // Supabase's legacy `anon` and `service_role` API keys are themselves HS256
  // JWTs signed with this very SUPABASE_JWT_SECRET, and the anon key is public
  // -- it ships in the browser bundle. They carry no `sub`, so requiring one
  // here (rather than relying on every caller to re-check) stops a published
  // API key from authenticating as a user.
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (payload.role === "anon" || payload.role === "service_role") return null;

  return payload;
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

  return validateClaims(payload);
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

// The algorithm allow-list. `kty`/`crv` are part of the entry, not decoration:
// the header names an algorithm but the *key* comes from the JWKS, and nothing
// otherwise stops a P-521 key (or an RSA key) from being used to check an
// "ES256" signature. Membership is tested with Object.hasOwn, never a bare
// property read -- `alg: "constructor"` reads truthy off Object.prototype.
const JWS_ALGORITHMS = {
  // JWS ES256 signatures are the raw r||s pair, not the DER encoding
  // node:crypto verifies by default.
  ES256: { hash: "sha256", kty: "EC", crv: "P-256", options: { dsaEncoding: "ieee-p1363" } },
  ES512: { hash: "sha512", kty: "EC", crv: "P-521", options: { dsaEncoding: "ieee-p1363" } },
  RS256: { hash: "sha256", kty: "RSA", crv: null, options: {} },
  RS512: { hash: "sha512", kty: "RSA", crv: null, options: {} }
};

const JWKS_TTL_MS = 10 * 60 * 1000;
// A failed fetch is cached too, briefly: without it a JWKS outage (or a flood
// of tokens carrying bogus kids) turns every single request into an outbound
// call to the auth server.
const JWKS_ERROR_TTL_MS = 30 * 1000;
// The JWKS fetch sits in the request path of every authenticated call, so it
// must not be able to hang one. Fail closed and fast instead.
const JWKS_FETCH_TIMEOUT_MS = 3000;

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
    response = await fetchImpl(jwksUrl(supabaseUrl), {
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS)
    });
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
    if (now - cached.fetchedAt < (cached.failed ? JWKS_ERROR_TTL_MS : JWKS_TTL_MS)) return null;
  }

  const keys = await fetchJwks(supabaseUrl, fetchImpl);
  if (!keys) {
    // Negative cache. Any previously fetched keys are kept (a transient outage
    // must not sign every user out); only the retry clock is reset, so a JWKS
    // the server cannot reach is retried at most once per JWKS_ERROR_TTL_MS
    // rather than once per request.
    jwksCache.set(supabaseUrl, { keys: cached?.keys ?? [], fetchedAt: now, failed: true });
    return null;
  }
  jwksCache.set(supabaseUrl, { keys, fetchedAt: now, failed: false });
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

    if (typeof header.alg !== "string" || !Object.hasOwn(JWS_ALGORITHMS, header.alg)) return null;
    const algorithm = JWS_ALGORITHMS[header.alg];
    if (!supabaseUrl) return null;

    const jwk = await resolveJwk(supabaseUrl, header.kid, fetchImpl);
    if (!jwk) return null;

    // The header picks the algorithm but the JWKS supplies the key, so the two
    // have to agree before a signature check means anything: a key of the wrong
    // family or curve, or one the issuer published for encryption rather than
    // signing, is not a key for this token.
    if (jwk.kty !== algorithm.kty) return null;
    if (algorithm.crv && jwk.crv !== algorithm.crv) return null;
    if (jwk.use && jwk.use !== "sig") return null;
    if (jwk.alg && jwk.alg !== header.alg) return null;

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

    return validateClaims(payload);
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
