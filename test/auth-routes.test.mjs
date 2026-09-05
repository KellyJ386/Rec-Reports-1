import test from "node:test";
import assert from "node:assert/strict";
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
// windows/limits instead of relying on real elapsed time.
function mount({ env = ENV, now, signInRateLimit } = {}) {
  const router = createRouter();
  const sent = [];
  const sendJson = (response, status, payload) =>
    sent.push({ status, payload, headers: { ...(response.__headers ?? {}) } });
  const readBody = async (request) => request.__body ?? "{}";
  registerAuthRoutes(router, { sendJson, readBody, now, signInRateLimit });
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
  assert.equal(result.payload.refresh_token, "refresh-123");
  assert.deepEqual(result.payload.user, { id: "user-1", email: "a@b.com" });
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(gotrueCall.init.headers.apikey, "anon-key");
  assert.deepEqual(gotrueCall.body, { email: "a@b.com", password: "secret" });
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

test("refresh requires a refresh_token (400)", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("refresh forwards to GoTrue refresh grant and returns the session", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new", expires_in: 3600 }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", { refresh_token: "refresh-123" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.access_token, "jwt-new");
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/token\?grant_type=refresh_token$/);
  assert.deepEqual(gotrueCall.body, { refresh_token: "refresh-123" });
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
});

test("sign-out without a token succeeds without calling GoTrue", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true, data: {} }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-out");
  assert.equal(result.status, 200);
  assert.equal(captured.length, 0);
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
