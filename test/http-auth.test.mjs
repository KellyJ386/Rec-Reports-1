import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  verifySupabaseJwt,
  createJwtVerifier,
  resetJwksCache,
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

// --- Asymmetric (JWKS) verification ---------------------------------------
// Supabase projects may sign access tokens with a project keypair instead of
// the legacy shared secret, so the verifier has to handle both. These tests use
// a real generated keypair rather than fixtures.

function makeJwksToken(payload, { privateKey, kid, alg = "ES256", dsaEncoding = "ieee-p1363" }) {
  const headerB64 = base64Url(JSON.stringify({ alg, typ: "JWT", kid }));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signature = sign(
    alg === "ES512" ? "sha512" : "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: privateKey, dsaEncoding }
  );
  return `${headerB64}.${payloadB64}.${base64Url(signature)}`;
}

function es256Keys(kid = "key-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
  return { privateKey, jwk };
}

function jwksFetch(keys, counter = { calls: 0 }) {
  const fetchImpl = async () => {
    counter.calls += 1;
    return { ok: true, text: async () => JSON.stringify({ keys }) };
  };
  return { fetchImpl, counter };
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

test("createJwtVerifier accepts an ES256 token signed by a published JWKS key", async () => {
  resetJwksCache();
  const { privateKey, jwk } = es256Keys();
  const { fetchImpl } = jwksFetch([jwk]);
  const verify = createJwtVerifier({ supabaseUrl: "https://proj.supabase.co", fetchImpl });
  const token = makeJwksToken({ sub: "user-9", role: "authenticated", exp: futureExp() }, { privateKey, kid: "key-1" });
  const claims = await verify(token);
  assert.equal(claims.sub, "user-9");
});

test("createJwtVerifier rejects an ES256 token signed by a key not in the JWKS", async () => {
  resetJwksCache();
  const published = es256Keys("key-1");
  const attacker = es256Keys("key-1");
  const { fetchImpl } = jwksFetch([published.jwk]);
  const verify = createJwtVerifier({ supabaseUrl: "https://proj.supabase.co", fetchImpl });
  const token = makeJwksToken({ sub: "user-9", exp: futureExp() }, { privateKey: attacker.privateKey, kid: "key-1" });
  assert.equal(await verify(token), null);
});

test("createJwtVerifier rejects an expired ES256 token", async () => {
  resetJwksCache();
  const { privateKey, jwk } = es256Keys();
  const { fetchImpl } = jwksFetch([jwk]);
  const verify = createJwtVerifier({ supabaseUrl: "https://proj.supabase.co", fetchImpl });
  const token = makeJwksToken(
    { sub: "user-9", exp: Math.floor(Date.now() / 1000) - 60 },
    { privateKey, kid: "key-1" }
  );
  assert.equal(await verify(token), null);
});

test("createJwtVerifier rejects an unknown kid without trusting another key", async () => {
  resetJwksCache();
  const { privateKey, jwk } = es256Keys("key-1");
  const { fetchImpl } = jwksFetch([jwk]);
  const verify = createJwtVerifier({ supabaseUrl: "https://proj.supabase.co", fetchImpl });
  const token = makeJwksToken({ sub: "user-9", exp: futureExp() }, { privateKey, kid: "key-does-not-exist" });
  assert.equal(await verify(token), null);
});

test("createJwtVerifier caches the JWKS across verifications", async () => {
  resetJwksCache();
  const { privateKey, jwk } = es256Keys();
  const counter = { calls: 0 };
  const { fetchImpl } = jwksFetch([jwk], counter);
  const verify = createJwtVerifier({ supabaseUrl: "https://proj.supabase.co", fetchImpl });
  const token = makeJwksToken({ sub: "user-9", exp: futureExp() }, { privateKey, kid: "key-1" });
  await verify(token);
  await verify(token);
  await verify(token);
  assert.equal(counter.calls, 1, "JWKS should be fetched once and reused");
});

test("createJwtVerifier fails closed when the JWKS is unreachable", async () => {
  resetJwksCache();
  const { privateKey, jwk } = es256Keys();
  const verify = createJwtVerifier({
    supabaseUrl: "https://proj.supabase.co",
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  const token = makeJwksToken({ sub: "user-9", exp: futureExp() }, { privateKey, kid: jwk.kid });
  assert.equal(await verify(token), null);
});

test("createJwtVerifier still handles HS256 tokens with the shared secret", async () => {
  resetJwksCache();
  const verify = createJwtVerifier({ jwtSecret: secret, supabaseUrl: "https://proj.supabase.co" });
  const claims = await verify(signToken({ sub: "user-1", exp: futureExp() }));
  assert.equal(claims.sub, "user-1");
});

test("createJwtVerifier rejects alg:none regardless of signing mode", async () => {
  resetJwksCache();
  const { privateKey, jwk } = es256Keys();
  const { fetchImpl } = jwksFetch([jwk]);
  const verify = createJwtVerifier({ jwtSecret: secret, supabaseUrl: "https://proj.supabase.co", fetchImpl });
  const headerB64 = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payloadB64 = base64Url(JSON.stringify({ sub: "attacker", exp: futureExp() }));
  assert.equal(await verify(`${headerB64}.${payloadB64}.`), null);
  // And a valid ES256 signature relabelled as an unsupported alg is still out.
  const token = makeJwksToken({ sub: "user-9", exp: futureExp() }, { privateKey, kid: "key-1", alg: "ES384" });
  assert.equal(await verify(token), null);
});
