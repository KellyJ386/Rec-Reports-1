import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAuthRoutes } from "../src/lib/http/auth-routes.mjs";
import { createRateLimiter } from "../src/lib/http/rate-limit.mjs";

const ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon-key"
};

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : null });
    const { ok = true, status = 200, data = {} } = respond(url, init) ?? {};
    return { ok, status, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// `now` and `signInRateLimit` are forwarded straight to registerAuthRoutes so
// throttle tests can inject a fake, manually-advanced clock and tiny
// windows/limits instead of relying on real elapsed time. `durableLimiter`
// is forwarded the same way for the S-7 durable-backstop tests below.
function mount({ env = ENV, now, signInRateLimit, durableLimiter } = {}) {
  const router = createRouter();
  const sent = [];
  const sendJson = (response, status, payload) =>
    sent.push({ status, payload, headers: { ...(response.__headers ?? {}) } });
  const readBody = async (request) => request.__body ?? "{}";
  registerAuthRoutes(router, { sendJson, readBody, now, signInRateLimit, durableLimiter });
  async function call(method, path, body, { headers = {} } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = {
      url: path,
      headers,
      __body: body === undefined ? undefined : JSON.stringify(body)
    };
    const response = {
      __headers: {},
      setHeader(name, value) {
        this.__headers[name] = value;
      }
    };
    await handler(request, response, { env, params });
    return sent[sent.length - 1];
  }
  return { call };
}

// A stub durable limiter that records every check/recordFailure/reset call
// (key + call order) and answers according to `blockedKeys` (a Set of keys
// that should report as blocked). Mirrors createDurableRateLimiter's async
// {check, recordFailure, reset} shape without touching PostgREST.
function stubDurableLimiter({ blockedKeys = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async check(key) {
      calls.push({ method: "check", key });
      return blockedKeys.has(key) ? { blocked: true, retryAfterMs: 42000 } : { blocked: false, retryAfterMs: 0 };
    },
    async recordFailure(key) {
      calls.push({ method: "recordFailure", key });
    },
    async reset(key) {
      calls.push({ method: "reset", key });
    }
  };
}

// A manually-advanced fake clock: `clock.now` is the injectable `now`
// function, `clock.advance(ms)` moves it forward. No real timers involved.
function fakeClock(start = 0) {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

test("sign-in requires email and password (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("sign-in forwards to GoTrue password grant and returns the session", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: {
      access_token: "jwt-123",
      refresh_token: "refresh-123",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: "user-1", email: "a@b.com", extra: "ignored" }
    }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "secret" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.access_token, "jwt-123");
  assert.equal("refresh_token" in result.payload, false, "refresh_token must never appear in the body (S-11)");
  assert.deepEqual(result.payload.user, { id: "user-1", email: "a@b.com" });
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(gotrueCall.init.headers.apikey, "anon-key");
  assert.deepEqual(gotrueCall.body, { email: "a@b.com", password: "secret" });
});

test("sign-in sets an HttpOnly refresh cookie with the expected attributes", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: {
      access_token: "jwt-123",
      refresh_token: "refresh-123",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: "user-1", email: "a@b.com" }
    }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "secret" });
  assert.equal(result.status, 200);
  const cookie = result.headers["Set-Cookie"];
  assert.ok(cookie, "Set-Cookie header must be present");
  assert.match(cookie, /^rr_refresh=refresh-123;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/v1\/auth/);
  assert.match(cookie, /Max-Age=2592000/);
});

test("sign-in omits Secure on the refresh cookie for plain-http localhost", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-123", refresh_token: "refresh-123", user: { id: "u1", email: "a@b.com" } }
  }));
  const { call } = mount();
  const result = await call(
    "POST",
    "/auth/sign-in",
    { email: "a@b.com", password: "secret" },
    { headers: { host: "localhost:4411" } }
  );
  const cookie = result.headers["Set-Cookie"];
  assert.ok(cookie);
  assert.doesNotMatch(cookie, /Secure/);
});

test("sign-in keeps Secure on the refresh cookie for a non-localhost host with no proxy header", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-123", refresh_token: "refresh-123", user: { id: "u1", email: "a@b.com" } }
  }));
  const { call } = mount();
  const result = await call(
    "POST",
    "/auth/sign-in",
    { email: "a@b.com", password: "secret" },
    { headers: { host: "app.example.com" } }
  );
  const cookie = result.headers["Set-Cookie"];
  assert.match(cookie, /Secure/);
});

test("sign-in maps a GoTrue rejection to 401", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "wrong" });
  assert.equal(result.status, 401);
});

test("sign-in returns 503 when Supabase is not configured", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount({ env: {} });
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "secret" });
  assert.equal(result.status, 503);
  assert.equal(captured.length, 0);
});

test("refresh requires a refresh_token (400) when neither cookie nor body carries one", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("refresh reads the token from the rr_refresh cookie, not the body", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new", expires_in: 3600 }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", {}, { headers: { cookie: "rr_refresh=refresh-123" } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.access_token, "jwt-new");
  assert.equal("refresh_token" in result.payload, false);
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/token\?grant_type=refresh_token$/);
  assert.deepEqual(gotrueCall.body, { refresh_token: "refresh-123" });
});

test("refresh rotates the cookie on success (new token, same attributes)", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new", expires_in: 3600 }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", {}, { headers: { cookie: "rr_refresh=refresh-123" } });
  const cookie = result.headers["Set-Cookie"];
  assert.match(cookie, /^rr_refresh=refresh-new;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/v1\/auth/);
});

// One-release compat: a body refresh_token still works when there is no
// cookie yet (a session that signed in before S-11 shipped).
test("refresh falls back to a body refresh_token when there is no cookie", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new", expires_in: 3600 }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", { refresh_token: "legacy-refresh" });
  assert.equal(result.status, 200);
  const gotrueCall = captured[0];
  assert.deepEqual(gotrueCall.body, { refresh_token: "legacy-refresh" });
});

test("refresh prefers the cookie over a body refresh_token when both are present", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new" }
  }));
  const { call } = mount();
  await call(
    "POST",
    "/auth/refresh",
    { refresh_token: "body-token" },
    { headers: { cookie: "rr_refresh=cookie-token" } }
  );
  const gotrueCall = captured[0];
  assert.deepEqual(gotrueCall.body, { refresh_token: "cookie-token" });
});

test("refresh rejects a cross-site request (sec-fetch-site: cross-site) without calling GoTrue", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount();
  const result = await call(
    "POST",
    "/auth/refresh",
    {},
    { headers: { cookie: "rr_refresh=refresh-123", "sec-fetch-site": "cross-site" } }
  );
  assert.equal(result.status, 403);
  assert.deepEqual(result.payload, { error: "cross-site request" });
  assert.equal(captured.length, 0, "GoTrue must not be called for a cross-site refresh attempt");
});

test("refresh allows sec-fetch-site: same-origin and none, and a missing header", async (t) => {
  stubFetch(t, () => ({ ok: true, data: { access_token: "jwt-new", refresh_token: "refresh-new" } }));
  const { call } = mount();
  for (const secFetchSite of ["same-origin", "none", undefined]) {
    const headers = { cookie: "rr_refresh=refresh-123" };
    if (secFetchSite) headers["sec-fetch-site"] = secFetchSite;
    const result = await call("POST", "/auth/refresh", {}, { headers });
    assert.equal(result.status, 200, `sec-fetch-site=${secFetchSite} should be allowed`);
  }
});

test("refresh clears the cookie when GoTrue rejects the token (401)", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 401, data: { error: "invalid_grant" } }));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", {}, { headers: { cookie: "rr_refresh=stale-token" } });
  assert.equal(result.status, 401);
  const cookie = result.headers["Set-Cookie"];
  assert.match(cookie, /^rr_refresh=;/);
  assert.match(cookie, /Max-Age=0/);
});

// ---------------------------------------------------------------------------
// OP-23: brute-force throttle on POST /auth/sign-in
// ---------------------------------------------------------------------------

test("sign-in: a burst of failed attempts for one email hits 429 with Retry-After", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const clock = fakeClock();
  const { call } = mount({
    now: clock.now,
    signInRateLimit: { emailMax: 3, emailWindowMs: 15 * 60 * 1000, ipMax: 1000 }
  });
  const creds = { email: "victim@example.com", password: "wrong" };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await call("POST", "/auth/sign-in", creds);
    assert.equal(result.status, 401, `attempt ${attempt} should still reach GoTrue and 401`);
  }

  const blocked = await call("POST", "/auth/sign-in", creds);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.payload.error, "too many attempts, try again later");
  const retryAfter = Number(blocked.headers["Retry-After"]);
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, "Retry-After should be a positive number of seconds");

  // The 429 body must not be distinguishable from "email doesn't exist" --
  // it's the exact same generic shape as the plain 401 above.
  assert.deepEqual(Object.keys(blocked.payload), ["error"]);
});

test("sign-in: a successful sign-in clears the failed-attempt counter for that email", async (t) => {
  let succeed = false;
  stubFetch(t, () =>
    succeed
      ? { ok: true, data: { access_token: "jwt-1", refresh_token: "r-1", user: { id: "u1", email: "a@b.com" } } }
      : { ok: false, status: 400, data: { error: "invalid_grant" } }
  );
  const clock = fakeClock();
  const { call } = mount({
    now: clock.now,
    signInRateLimit: { emailMax: 3, emailWindowMs: 15 * 60 * 1000, ipMax: 1000 }
  });
  const email = "a@b.com";

  // Two failures -- still under the limit of 3.
  assert.equal((await call("POST", "/auth/sign-in", { email, password: "wrong" })).status, 401);
  assert.equal((await call("POST", "/auth/sign-in", { email, password: "wrong" })).status, 401);

  // A correct sign-in succeeds (still under the limit) and resets the counter.
  succeed = true;
  const ok = await call("POST", "/auth/sign-in", { email, password: "correct" });
  assert.equal(ok.status, 200);
  succeed = false;

  // If the two earlier failures had not been cleared, one more failure would
  // already be the 3rd strike and the *next* one would 429. Because of the
  // reset, it takes a fresh 3 failures (not 1) to trip the limit again.
  const afterReset1 = await call("POST", "/auth/sign-in", { email, password: "wrong" });
  assert.equal(afterReset1.status, 401);
  const afterReset2 = await call("POST", "/auth/sign-in", { email, password: "wrong" });
  assert.equal(afterReset2.status, 401);
  const afterReset3 = await call("POST", "/auth/sign-in", { email, password: "wrong" });
  assert.equal(afterReset3.status, 401, "only the 3rd failure since reset -- limit is 3, so still allowed");
  const afterReset4 = await call("POST", "/auth/sign-in", { email, password: "wrong" });
  assert.equal(afterReset4.status, 429, "the 4th failure since the reset should trip the limit again");
});

test("sign-in: the per-email throttle is scoped per email (one lockout does not block another)", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const clock = fakeClock();
  const { call } = mount({
    now: clock.now,
    signInRateLimit: { emailMax: 1, emailWindowMs: 15 * 60 * 1000, ipMax: 1000 }
  });

  const victim = await call("POST", "/auth/sign-in", { email: "victim@example.com", password: "wrong" });
  assert.equal(victim.status, 401);
  const victimBlocked = await call("POST", "/auth/sign-in", { email: "victim@example.com", password: "wrong" });
  assert.equal(victimBlocked.status, 429);

  // A different email, from the same test/IP bucket, is unaffected.
  const other = await call("POST", "/auth/sign-in", { email: "other@example.com", password: "wrong" });
  assert.equal(other.status, 401, "a different email must not be caught by another email's lockout");
});

test("sign-in: the per-IP throttle blocks a burst spread across many different emails", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const clock = fakeClock();
  const { call } = mount({
    now: clock.now,
    signInRateLimit: { emailMax: 1000, emailWindowMs: 15 * 60 * 1000, ipMax: 3, ipWindowMs: 15 * 60 * 1000 }
  });
  const headers = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };

  for (let i = 1; i <= 3; i += 1) {
    const result = await call(
      "POST",
      "/auth/sign-in",
      { email: `attacker${i}@example.com`, password: "wrong" },
      { headers }
    );
    assert.equal(result.status, 401, `attempt ${i} (distinct email) should still reach GoTrue`);
  }

  // A 4th attempt, yet another brand-new email, from the same IP is blocked
  // even though no single email has more than one failure.
  const blocked = await call(
    "POST",
    "/auth/sign-in",
    { email: "attacker4@example.com", password: "wrong" },
    { headers }
  );
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers["Retry-After"]);

  // A different IP entirely is unaffected by the first IP's lockout.
  const otherIp = await call(
    "POST",
    "/auth/sign-in",
    { email: "attacker5@example.com", password: "wrong" },
    { headers: { "x-forwarded-for": "198.51.100.9" } }
  );
  assert.equal(otherIp.status, 401);
});

// M5 (re-verification): which forwarded hop feeds the per-IP throttle bucket.
async function signInIpKeyFor(t, headers) {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const durable = stubDurableLimiter();
  const { call } = mount({ durableLimiter: durable });
  await call("POST", "/auth/sign-in", { email: "x@example.com", password: "wrong" }, { headers });
  return durable.calls.filter((c) => c.method === "check").map((c) => c.key).find((key) => key.startsWith("ip:"));
}

test("client IP: the RIGHTMOST x-forwarded-for hop is the bucket, not the attacker-writable leftmost one", async (t) => {
  const key = await signInIpKeyFor(t, { "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
  assert.equal(key, ipThrottleKey("ip", "203.0.113.7"));
  assert.notEqual(key, ipThrottleKey("ip", "6.6.6.6"));
});

test("client IP: the rightmost x-forwarded-for hop outranks a (possibly pass-through) x-real-ip", async (t) => {
  const key = await signInIpKeyFor(t, { "x-real-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7" });
  assert.equal(key, ipThrottleKey("ip", "203.0.113.7"));
});

test("client IP: x-real-ip is used when no x-forwarded-for is present", async (t) => {
  const key = await signInIpKeyFor(t, { "x-real-ip": "198.51.100.9" });
  assert.equal(key, ipThrottleKey("ip", "198.51.100.9"));
});

test("client IP: a header value that is not an IP address lands in one shared 'invalid' bucket, never a per-request one", async (t) => {
  const first = await signInIpKeyFor(t, { "x-forwarded-for": 'a"b)' });
  const second = await signInIpKeyFor(t, { "x-forwarded-for": "not an ip, also not, ${nope}" });
  assert.equal(first, ipThrottleKey("ip", "invalid"));
  assert.equal(second, first);
  assert.match(first, /^ip:[0-9a-f]{64}$/, "the durable key is fixed-width hex regardless of the header contents");
});

test("client IP: IPv6 forwarded addresses are accepted", async (t) => {
  const key = await signInIpKeyFor(t, { "x-forwarded-for": "2001:db8::1" });
  assert.equal(key, ipThrottleKey("ip", "2001:db8::1"));
});

test("sign-in: success path is unaffected while under the limit", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-ok", refresh_token: "r-ok", user: { id: "u1", email: "a@b.com" } }
  }));
  const clock = fakeClock();
  const { call } = mount({
    now: clock.now,
    signInRateLimit: { emailMax: 5, emailWindowMs: 15 * 60 * 1000, ipMax: 20 }
  });

  for (let i = 0; i < 3; i += 1) {
    const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "correct" });
    assert.equal(result.status, 200);
    assert.equal(result.payload.access_token, "jwt-ok");
  }
});

test("rate limiter: expired entries are evicted so the store does not grow without bound", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 5, now: clock.now, sweepEvery: 1000 });

  for (let i = 0; i < 50; i += 1) limiter.recordFailure(`key-${i}`);
  assert.equal(limiter.size(), 50);

  clock.advance(5000); // well past the 1s window for every key above
  limiter.sweep();
  assert.equal(limiter.size(), 0, "the store should shrink once every entry has aged out");
});

test("rate limiter: the periodic sweep cadence evicts expired keys during normal traffic", () => {
  const clock = fakeClock();
  const sweepEvery = 5;
  const limiter = createRateLimiter({ windowMs: 1000, max: 100, now: clock.now, sweepEvery });

  for (let i = 0; i < 10; i += 1) limiter.recordFailure(`stale-${i}`);
  assert.equal(limiter.size(), 10);

  clock.advance(5000); // stale-* are now outside the window
  for (let i = 0; i < sweepEvery; i += 1) limiter.recordFailure("fresh");
  // The sweepEvery-th call above trips the automatic sweep (no explicit
  // sweep() call): every stale-* key is gone, leaving only "fresh".
  assert.equal(limiter.size(), 1);
});

test("rate limiter: reset() clears a key outright", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: clock.now });
  limiter.recordFailure("a@b.com");
  limiter.recordFailure("a@b.com");
  assert.equal(limiter.check("a@b.com").blocked, true);
  limiter.reset("a@b.com");
  assert.equal(limiter.check("a@b.com").blocked, false);
  assert.equal(limiter.size(), 0);
});

// ---------------------------------------------------------------------------
// S-7: durable (cross-instance) throttle backstop, layered behind the
// in-memory limiter tested above.
// ---------------------------------------------------------------------------

// M5/L1: the durable sign-in email key is sha256(normalized email), never
// the plaintext address (see auth-routes.mjs's emailThrottleKey) -- both to
// bound the key that lands in the durable auth_throttle table and because a
// PostgREST failure forwards the key as `requestId` to OBSERVABILITY_DSN.
function emailThrottleKey(email) {
  const hash = createHash("sha256")
    .update(String(email).trim().toLowerCase())
    .digest("hex");
  return `email:${hash}`;
}

function ipThrottleKey(prefix, ip) {
  return `${prefix}:${createHash("sha256").update(ip).digest("hex")}`;
}

test("sign-in: the durable limiter is checked (hashed-email/ip keys) and recorded on failure", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const durable = stubDurableLimiter();
  const clock = fakeClock();
  const { call } = mount({ now: clock.now, durableLimiter: durable });

  const result = await call("POST", "/auth/sign-in", { email: "victim@example.com", password: "wrong" });
  assert.equal(result.status, 401);

  const expectedEmailKey = emailThrottleKey("victim@example.com");
  const checked = durable.calls.filter((c) => c.method === "check").map((c) => c.key);
  assert.deepEqual(checked.sort(), [expectedEmailKey, ipThrottleKey("ip", "unknown")].sort());
  assert.doesNotMatch(expectedEmailKey, /victim@example\.com/, "the durable key must never carry the raw email");
  const recorded = durable.calls.filter((c) => c.method === "recordFailure").map((c) => c.key);
  assert.deepEqual(recorded.sort(), [expectedEmailKey, ipThrottleKey("ip", "unknown")].sort());
});

test("sign-in: a successful sign-in resets the durable (hashed) email key", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-ok", refresh_token: "r-ok", user: { id: "u1", email: "a@b.com" } }
  }));
  const durable = stubDurableLimiter();
  const { call } = mount({ durableLimiter: durable });
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "correct" });
  assert.equal(result.status, 200);
  assert.deepEqual(
    durable.calls.filter((c) => c.method === "reset"),
    [{ method: "reset", key: emailThrottleKey("a@b.com") }]
  );
});

test("sign-in: a durable-only block (in-memory clear) still returns 429 with Retry-After, before calling GoTrue", async (t) => {
  const captured = stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const durable = stubDurableLimiter({ blockedKeys: new Set([emailThrottleKey("victim@example.com")]) });
  const { call } = mount({ durableLimiter: durable });

  const result = await call("POST", "/auth/sign-in", { email: "victim@example.com", password: "wrong" });
  assert.equal(result.status, 429);
  assert.equal(result.payload.error, "too many attempts, try again later");
  assert.equal(result.headers["Retry-After"], "42");
  assert.equal(captured.length, 0, "GoTrue must not be called once the durable limiter blocks");
});

test("refresh: throttled by the in-memory refresh limiter after enough failures (429, Retry-After)", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const clock = fakeClock();
  const { call } = mount({
    now: clock.now,
    signInRateLimit: { refreshMax: 2, refreshWindowMs: 15 * 60 * 1000, refreshIpMax: 1000 }
  });
  const body = { refresh_token: "stale-refresh-token" };

  assert.equal((await call("POST", "/auth/refresh", body)).status, 401);
  assert.equal((await call("POST", "/auth/refresh", body)).status, 401);
  const blocked = await call("POST", "/auth/refresh", body);
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers["Retry-After"]);
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0);
});

test("refresh: the durable limiter is checked/recorded keyed on sha256(refresh_token) and client IP", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const durable = stubDurableLimiter();
  const { call } = mount({ durableLimiter: durable });

  const result = await call(
    "POST",
    "/auth/refresh",
    { refresh_token: "stale-refresh-token" },
    { headers: { "x-forwarded-for": "203.0.113.9" } }
  );
  assert.equal(result.status, 401);

  const expectedTokenHash = createHash("sha256").update("stale-refresh-token").digest("hex");
  const checked = durable.calls.filter((c) => c.method === "check").map((c) => c.key);
  assert.deepEqual(checked.sort(), [`refresh:${expectedTokenHash}`, ipThrottleKey("refresh-ip", "203.0.113.9")].sort());
  const recorded = durable.calls.filter((c) => c.method === "recordFailure").map((c) => c.key);
  assert.deepEqual(recorded.sort(), [`refresh:${expectedTokenHash}`, ipThrottleKey("refresh-ip", "203.0.113.9")].sort());
});

test("refresh: prefers the rr_refresh cookie over body.refresh_token for the durable throttle key", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const durable = stubDurableLimiter();
  const { call } = mount({ durableLimiter: durable });

  await call(
    "POST",
    "/auth/refresh",
    { refresh_token: "body-token" },
    { headers: { cookie: "rr_refresh=cookie-token; other=1" } }
  );

  const expectedTokenHash = createHash("sha256").update("cookie-token").digest("hex");
  const checked = durable.calls.filter((c) => c.method === "check").map((c) => c.key);
  assert.ok(checked.includes(`refresh:${expectedTokenHash}`));
});

test("refresh: a durable-only block returns 429 before calling GoTrue", async (t) => {
  const expectedTokenHash = createHash("sha256").update("stale-refresh-token").digest("hex");
  const captured = stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const durable = stubDurableLimiter({ blockedKeys: new Set([`refresh:${expectedTokenHash}`]) });
  const { call } = mount({ durableLimiter: durable });

  const result = await call("POST", "/auth/refresh", { refresh_token: "stale-refresh-token" });
  assert.equal(result.status, 429);
  assert.equal(result.headers["Retry-After"], "42");
  assert.equal(captured.length, 0, "GoTrue must not be called once the durable limiter blocks");
});

test("refresh: a successful refresh resets the in-memory and durable token counters", async (t) => {
  stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new", expires_in: 3600 }
  }));
  const durable = stubDurableLimiter();
  const { call } = mount({ durableLimiter: durable });
  const result = await call("POST", "/auth/refresh", { refresh_token: "good-refresh-token" });
  assert.equal(result.status, 200);

  const expectedTokenHash = createHash("sha256").update("good-refresh-token").digest("hex");
  assert.deepEqual(
    durable.calls.filter((c) => c.method === "reset"),
    [{ method: "reset", key: `refresh:${expectedTokenHash}` }]
  );
});

test("sign-out revokes the caller's token upstream", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true, data: {} }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-out", undefined, {
    headers: { authorization: "Bearer jwt-123" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { signed_out: true });
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/logout$/);
  // GoTrue scopes logout to the caller, so the user's own token must be
  // forwarded rather than the anon key.
  assert.equal(gotrueCall.init.headers.Authorization, "Bearer jwt-123");
  assert.equal(gotrueCall.init.headers.apikey, "anon-key");
  const cookie = result.headers["Set-Cookie"];
  assert.match(cookie, /^rr_refresh=;/);
  assert.match(cookie, /Max-Age=0/);
});

test("sign-out without a token succeeds without calling GoTrue", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true, data: {} }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-out");
  assert.equal(result.status, 200);
  assert.equal(captured.length, 0);
  assert.match(result.headers["Set-Cookie"], /^rr_refresh=;.*Max-Age=0/s);
});

test("sign-out still succeeds when GoTrue rejects the token", async (t) => {
  // An already-expired or already-revoked token is not an error the user can
  // act on: the browser drops its copy either way.
  stubFetch(t, () => ({ ok: false, status: 401, data: { error: "invalid token" } }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-out", undefined, {
    headers: { authorization: "Bearer stale" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { signed_out: true });
});

test("sign-out returns 503 when Supabase is not configured", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount({ env: {} });
  const result = await call("POST", "/auth/sign-out", undefined, {
    headers: { authorization: "Bearer jwt-123" }
  });
  assert.equal(result.status, 503);
  assert.equal(captured.length, 0);
});
