import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as signWithKey } from "node:crypto";
import {
  verifySupabaseJwt,
  verifySupabaseToken,
  clearJwksCache,
  loadMemberships,
  loadPlatformAdmin
} from "../src/lib/http/auth.mjs";

const secret = "test-jwt-secret";

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signToken(payload, { secretOverride = secret, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secretOverride).update(`${headerB64}.${payloadB64}`).digest();
  return `${headerB64}.${payloadB64}.${base64Url(signature)}`;
}

test("verifySupabaseJwt accepts a validly signed, unexpired token", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({ sub: "user-1", role: "authenticated", exp: futureExp });
  const claims = verifySupabaseJwt(token, secret);
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.role, "authenticated");
});

test("verifySupabaseJwt rejects a token signed with the wrong secret", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({ sub: "user-1", exp: futureExp }, { secretOverride: "wrong-secret" });
  assert.equal(verifySupabaseJwt(token, secret), null);
});

test("verifySupabaseJwt rejects a tampered payload", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({ sub: "user-1", exp: futureExp });
  const [headerB64, , signatureB64] = token.split(".");
  const tamperedPayload = base64Url(JSON.stringify({ sub: "attacker", exp: futureExp }));
  const tampered = `${headerB64}.${tamperedPayload}.${signatureB64}`;
  assert.equal(verifySupabaseJwt(tampered, secret), null);
});

test("verifySupabaseJwt rejects an expired token", () => {
  const pastExp = Math.floor(Date.now() / 1000) - 60;
  const token = signToken({ sub: "user-1", exp: pastExp });
  assert.equal(verifySupabaseJwt(token, secret), null);
});

test("verifySupabaseJwt rejects a non-HS256 header", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({ sub: "user-1", exp: futureExp }, { header: { alg: "none", typ: "JWT" } });
  assert.equal(verifySupabaseJwt(token, secret), null);
});

test("verifySupabaseJwt rejects malformed tokens", () => {
  assert.equal(verifySupabaseJwt("not-a-jwt", secret), null);
  assert.equal(verifySupabaseJwt("", secret), null);
  assert.equal(verifySupabaseJwt(null, secret), null);
  assert.equal(verifySupabaseJwt("a.b.c", secret), null);
});

test("verifySupabaseJwt returns null without a jwtSecret", () => {
  const token = signToken({ sub: "user-1" });
  assert.equal(verifySupabaseJwt(token, ""), null);
});

// --- Asymmetric (ES256/JWKS) verification ----------------------------------

const supabaseUrl = "https://es256-project.supabase.co";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "ES256", use: "sig" };

function signEs256Token(payload, { kid = "key-1", signingKey = privateKey } = {}) {
  const headerB64 = base64Url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signature = signWithKey("sha256", Buffer.from(`${headerB64}.${payloadB64}`), {
    key: signingKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${headerB64}.${payloadB64}.${base64Url(signature)}`;
}

// Injected JWKS endpoint: records every request and serves the given key set.
function jwksFetch(keys, calls = []) {
  return async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ keys }) };
  };
}

test("verifySupabaseToken accepts a valid ES256 token via the published JWKS", async () => {
  clearJwksCache();
  const calls = [];
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", aud: "authenticated", exp: futureExp });
  const claims = await verifySupabaseToken(token, {
    supabaseUrl,
    fetchImpl: jwksFetch([publicJwk], calls)
  });
  assert.equal(claims.sub, "user-1");
  assert.deepEqual(calls, [`${supabaseUrl}/auth/v1/.well-known/jwks.json`]);
});

test("verifySupabaseToken caches the JWKS across verifications", async () => {
  clearJwksCache();
  const calls = [];
  const fetchImpl = jwksFetch([publicJwk], calls);
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", exp: futureExp });
  assert.ok(await verifySupabaseToken(token, { supabaseUrl, fetchImpl }));
  assert.ok(await verifySupabaseToken(token, { supabaseUrl, fetchImpl }));
  assert.equal(calls.length, 1, "second verification should be served from the cache");
});

test("verifySupabaseToken rejects a token whose kid is not in the JWKS", async () => {
  clearJwksCache();
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", exp: futureExp }, { kid: "unknown-kid" });
  const claims = await verifySupabaseToken(token, {
    supabaseUrl,
    fetchImpl: jwksFetch([publicJwk])
  });
  assert.equal(claims, null);
});

test("verifySupabaseToken rejects an expired ES256 token", async () => {
  clearJwksCache();
  const pastExp = Math.floor(Date.now() / 1000) - 60;
  const token = signEs256Token({ sub: "user-1", exp: pastExp });
  assert.equal(
    await verifySupabaseToken(token, { supabaseUrl, fetchImpl: jwksFetch([publicJwk]) }),
    null
  );
});

test("verifySupabaseToken rejects an ES256 token signed by a different key", async () => {
  clearJwksCache();
  const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", exp: futureExp }, { signingKey: otherKey });
  assert.equal(
    await verifySupabaseToken(token, { supabaseUrl, fetchImpl: jwksFetch([publicJwk]) }),
    null
  );
});

test("verifySupabaseToken rejects a tampered ES256 payload", async () => {
  clearJwksCache();
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", exp: futureExp });
  const [headerB64, , signatureB64] = token.split(".");
  const tamperedPayload = base64Url(JSON.stringify({ sub: "attacker", exp: futureExp }));
  const tampered = `${headerB64}.${tamperedPayload}.${signatureB64}`;
  assert.equal(
    await verifySupabaseToken(tampered, { supabaseUrl, fetchImpl: jwksFetch([publicJwk]) }),
    null
  );
});

test("verifySupabaseToken rejects an ES256 token minted for another audience", async () => {
  clearJwksCache();
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", aud: "anon", exp: futureExp });
  assert.equal(
    await verifySupabaseToken(token, { supabaseUrl, fetchImpl: jwksFetch([publicJwk]) }),
    null
  );
});

test("verifySupabaseToken fails closed when the JWKS fetch fails", async () => {
  clearJwksCache();
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", exp: futureExp });
  const failingFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await verifySupabaseToken(token, { supabaseUrl, fetchImpl: failingFetch }), null);
});

test("verifySupabaseToken still verifies HS256 tokens when a secret is configured", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({ sub: "user-1", role: "authenticated", exp: futureExp });
  const neverFetch = async () => {
    throw new Error("HS256 verification must not hit the network");
  };
  const claims = await verifySupabaseToken(token, {
    jwtSecret: secret,
    supabaseUrl,
    fetchImpl: neverFetch
  });
  assert.equal(claims.sub, "user-1");
});

test("verifySupabaseToken rejects an HS256 token when no secret is configured", async () => {
  clearJwksCache();
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({ sub: "user-1", exp: futureExp });
  assert.equal(
    await verifySupabaseToken(token, { supabaseUrl, fetchImpl: jwksFetch([publicJwk]) }),
    null
  );
});

test("verifySupabaseToken uses JWKS for ES256 tokens even when a secret is set", async () => {
  clearJwksCache();
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = signEs256Token({ sub: "user-1", exp: futureExp });
  const claims = await verifySupabaseToken(token, {
    jwtSecret: secret,
    supabaseUrl,
    fetchImpl: jwksFetch([publicJwk])
  });
  assert.equal(claims.sub, "user-1");
});

test("verifySupabaseToken rejects malformed tokens", async () => {
  assert.equal(await verifySupabaseToken("not-a-jwt", { supabaseUrl }), null);
  assert.equal(await verifySupabaseToken("", { supabaseUrl }), null);
  assert.equal(await verifySupabaseToken(null, { supabaseUrl }), null);
});

test("loadMemberships flattens the role/permission embed from PostgREST", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/rest\/v1\/memberships\?/);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          {
            id: "membership-1",
            facility_id: "facility-a",
            status: "active",
            role_id: "role-1",
            roles: { role_permissions: [{ permission_code: "admin.manage" }, { permission_code: "reports.read" }] }
          }
        ])
    };
  };
  try {
    const memberships = await loadMemberships({ url: "https://example.supabase.co", key: "key" }, "user-1");
    assert.deepEqual(memberships, [
      {
        id: "membership-1",
        facilityId: "facility-a",
        departmentId: null,
        status: "active",
        roleId: "role-1",
        permissions: ["admin.manage", "reports.read"]
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadPlatformAdmin is true when the roster has a row for the user", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/rest\/v1\/platform_admins\?/);
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "pa-1" }]) };
  };
  try {
    const result = await loadPlatformAdmin({ url: "https://example.supabase.co", key: "key" }, "user-1");
    assert.equal(result, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadPlatformAdmin is false for an empty roster lookup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "[]" });
  try {
    const result = await loadPlatformAdmin({ url: "https://example.supabase.co", key: "key" }, "user-1");
    assert.equal(result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadPlatformAdmin fails closed when the lookup throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const result = await loadPlatformAdmin({ url: "https://example.supabase.co", key: "key" }, "user-1");
    assert.equal(result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
