import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { createDurableRateLimiter, sweepAuthThrottle } from "../src/lib/http/durable-rate-limit.mjs";

// Same programmable-stub style as test/notifications-worker.test.mjs and
// test/internal-routes.test.mjs: `respond(table, method, url, body)` returns
// the JSON payload (or throws to simulate a PostgREST/network failure) for a
// given request; every call is recorded in `captured` so assertions can
// inspect the exact PostgREST request shape.
function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, headers: init.headers, body });
    if (respond.reject) throw respond.reject;
    const data = respond(table, method, parsed, body) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// A stub that always answers with a network-level rejection, to exercise the
// fail-open path.
function stubFetchThrows(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unreachable");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const client = createClient({ url: "https://example.supabase.co", key: "service-key" });

test("check(): GET request shape (select, key filter, limit 1)", async (t) => {
  const captured = stubFetch(t, () => []);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  const result = await limiter.check("email:a@b.com");
  assert.equal(result.blocked, false);
  assert.equal(captured.length, 1);
  const req = captured[0];
  assert.equal(req.table, "auth_throttle");
  assert.equal(req.method, "GET");
  assert.equal(req.url.searchParams.get("key"), "eq.email:a@b.com");
  assert.equal(req.url.searchParams.get("select"), "failures,window_start");
  assert.equal(req.url.searchParams.get("limit"), "1");
});

test("check(): blocked once failures >= max within the window", async (t) => {
  const now = 1_000_000;
  stubFetch(t, () => [{ failures: 5, window_start: new Date(now - 1000).toISOString() }]);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5, now: () => now });
  const result = await limiter.check("email:a@b.com");
  assert.equal(result.blocked, true);
  assert.ok(result.retryAfterMs > 0);
});

test("check(): not blocked once the window has expired, even with failures >= max", async (t) => {
  const now = 1_000_000;
  stubFetch(t, () => [{ failures: 5, window_start: new Date(now - 1_000_000).toISOString() }]);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5, now: () => now });
  const result = await limiter.check("email:a@b.com");
  assert.equal(result.blocked, false);
});

test("check(): no row for the key -> not blocked, single GET, no write", async (t) => {
  const captured = stubFetch(t, () => []);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  const result = await limiter.check("ip:203.0.113.7");
  assert.equal(result.blocked, false);
  assert.equal(captured.length, 1);
});

test("recordFailure(): fresh key -> upsert with failures=1, on_conflict=key, merge-duplicates", async (t) => {
  const captured = stubFetch(t, () => []);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5, now: () => 1_000_000 });
  await limiter.recordFailure("email:a@b.com");

  assert.equal(captured.length, 2, "expected one GET then one POST upsert");
  const [getReq, postReq] = captured;
  assert.equal(getReq.method, "GET");

  assert.equal(postReq.table, "auth_throttle");
  assert.equal(postReq.method, "POST");
  assert.equal(postReq.url.searchParams.get("on_conflict"), "key");
  assert.equal(postReq.headers.Prefer, "resolution=merge-duplicates");
  assert.equal(postReq.body.length, 1);
  assert.equal(postReq.body[0].key, "email:a@b.com");
  assert.equal(postReq.body[0].failures, 1);
  assert.equal(postReq.body[0].window_start, new Date(1_000_000).toISOString());
  assert.equal(postReq.body[0].updated_at, new Date(1_000_000).toISOString());
});

test("recordFailure(): existing row within the window -> increments failures, keeps window_start", async (t) => {
  const windowStart = new Date(500_000).toISOString();
  const captured = stubFetch(t, (table, method) => {
    if (table === "auth_throttle" && method === "GET") return [{ failures: 2, window_start: windowStart }];
    return [];
  });
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5, now: () => 600_000 });
  await limiter.recordFailure("email:a@b.com");

  const postReq = captured[1];
  assert.equal(postReq.body[0].failures, 3);
  assert.equal(postReq.body[0].window_start, windowStart);
  assert.equal(postReq.body[0].updated_at, new Date(600_000).toISOString());
});

test("recordFailure(): existing row whose window expired -> resets failures=1 and window_start", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "auth_throttle" && method === "GET") {
      return [{ failures: 5, window_start: new Date(0).toISOString() }];
    }
    return [];
  });
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5, now: () => 2_000_000 });
  await limiter.recordFailure("email:a@b.com");

  const postReq = captured[1];
  assert.equal(postReq.body[0].failures, 1);
  assert.equal(postReq.body[0].window_start, new Date(2_000_000).toISOString());
});

test("reset(): DELETE request shape", async (t) => {
  const captured = stubFetch(t, () => []);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  await limiter.reset("email:a@b.com");
  assert.equal(captured.length, 1);
  const req = captured[0];
  assert.equal(req.table, "auth_throttle");
  assert.equal(req.method, "DELETE");
  assert.equal(req.url.searchParams.get("key"), "eq.email:a@b.com");
});

// ---------------------------------------------------------------------------
// Fail-open contract: a down/unreachable PostgREST must never block a
// sign-in or refresh, and must never throw into the caller.
// ---------------------------------------------------------------------------

test("check(): fails open (not blocked) on a network error", async (t) => {
  stubFetchThrows(t);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  const result = await limiter.check("email:a@b.com");
  assert.deepEqual(result, { blocked: false, retryAfterMs: 0 });
});

test("recordFailure(): resolves without throwing on a network error", async (t) => {
  stubFetchThrows(t);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  await assert.doesNotReject(limiter.recordFailure("email:a@b.com"));
});

test("reset(): resolves without throwing on a network error", async (t) => {
  stubFetchThrows(t);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  await assert.doesNotReject(limiter.reset("email:a@b.com"));
});

test("a failure reports via reportError when a dsn is configured", async (t) => {
  const reports = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://observability.example/report") {
      reports.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => "" };
    }
    throw new Error("postgrest unreachable");
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const limiter = createDurableRateLimiter({
    client,
    windowMs: 900000,
    max: 5,
    dsn: "https://observability.example/report"
  });
  await limiter.check("email:a@b.com");

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reports.length, 1);
  assert.match(reports[0].message, /postgrest unreachable/);
  assert.equal(reports[0].route, "durable-rate-limit.check");
});

// ---------------------------------------------------------------------------
// sweepAuthThrottle (called from internal-routes.mjs's handleDrain)
// ---------------------------------------------------------------------------

test("sweepAuthThrottle: DELETE request shape (lt filter on updated_at), then a row-cap check that finds nothing over the cap", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "auth_throttle" && method === "DELETE") return [{ key: "a" }, { key: "b" }];
    if (table === "auth_throttle" && method === "GET") return []; // M5: no rows past maxRows
    return [];
  });
  const now = 10_000_000;
  const result = await sweepAuthThrottle(client, { now: () => now, olderThanMs: 60 * 60 * 1000 });
  assert.deepEqual(result, { deleted: 2 });
  assert.equal(captured.length, 2, "expected the staleness DELETE plus the row-cap GET");
  const deleteReq = captured[0];
  assert.equal(deleteReq.method, "DELETE");
  assert.equal(deleteReq.url.searchParams.get("updated_at"), `lt.${new Date(now - 60 * 60 * 1000).toISOString()}`);
  const rowCapReq = captured[1];
  assert.equal(rowCapReq.method, "GET");
  assert.equal(rowCapReq.url.searchParams.get("order"), "updated_at.desc");
});

test("sweepAuthThrottle: fails open (deleted: 0) on a network error", async (t) => {
  stubFetchThrows(t);
  const result = await sweepAuthThrottle(client, {});
  assert.deepEqual(result, { deleted: 0 });
});

// ---------------------------------------------------------------------------
// M5: bounded keys and a bounded total row count.
// ---------------------------------------------------------------------------

test("check()/recordFailure()/reset(): a key over 128 chars is refused before any fetch, fail-open shape", async (t) => {
  const captured = stubFetch(t, () => {
    throw new Error("must not be called for an oversized key");
  });
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  const hugeKey = `ip:${"1".repeat(200)}`;
  assert.ok(hugeKey.length > 128);

  assert.deepEqual(await limiter.check(hugeKey), { blocked: false, retryAfterMs: 0 });
  await assert.doesNotReject(limiter.recordFailure(hugeKey));
  await assert.doesNotReject(limiter.reset(hugeKey));
  assert.equal(captured.length, 0, "an oversized key must never reach PostgREST");
});

test("check(): a key at exactly 128 chars is still allowed through to PostgREST", async (t) => {
  const captured = stubFetch(t, () => []);
  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  const exactKey = `e${"1".repeat(127)}`;
  assert.equal(exactKey.length, 128);
  await limiter.check(exactKey);
  assert.equal(captured.length, 1);
});

test("sweepAuthThrottle: deletes the oldest rows beyond maxRows even when none are individually stale", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "auth_throttle" && method === "DELETE") {
      // Two distinct DELETE calls happen: the staleness pass (lt filter,
      // matches nothing here) and the row-cap pass (key in.(...)).
      if (url.searchParams.has("updated_at")) return [];
      return [{ key: "excess-1" }, { key: "excess-2" }];
    }
    if (table === "auth_throttle" && method === "GET") {
      return [{ key: "excess-1" }, { key: "excess-2" }];
    }
    return [];
  });
  const result = await sweepAuthThrottle(client, { maxRows: 3 });
  assert.deepEqual(result, { deleted: 2 });

  const rowCapGet = captured.find((c) => c.method === "GET");
  assert.equal(rowCapGet.url.searchParams.get("offset"), "3");

  const rowCapDelete = captured.find((c) => c.method === "DELETE" && c.url.searchParams.has("key"));
  assert.equal(rowCapDelete.url.searchParams.get("key"), "in.(excess-1,excess-2)");
});

test("sweepAuthThrottle: a row-cap failure still reports the staleness sweep's own count", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "auth_throttle" && method === "DELETE") return [{ key: "a" }];
    if (table === "auth_throttle" && method === "GET") throw new Error("row-cap query failed");
    return [];
  });
  const result = await sweepAuthThrottle(client, {});
  assert.deepEqual(result, { deleted: 1 });
});

// ---------------------------------------------------------------------------
// L5: a request timeout, so a hanging PostgREST cannot hang sign-in/refresh.
// ---------------------------------------------------------------------------

test("check()/recordFailure()/reset(): every fetch carries an AbortSignal", async (t) => {
  const signals = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    signals.push(init.signal);
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5 });
  await limiter.check("email:abc"); // 1 fetch (GET)
  await limiter.recordFailure("email:abc"); // 2 fetches (GET then POST upsert)
  await limiter.reset("email:abc"); // 1 fetch (DELETE)

  assert.equal(signals.length, 4);
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal, "expected every durable-limiter fetch to carry an AbortSignal");
  }
});

test("check(): an aborted (timed-out) PostgREST request fails open, same as any other error", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  t.after(() => {
    globalThis.fetch = original;
  });

  // AbortSignal.timeout()'s internal timer is deliberately unref'd (per spec
  // it must never by itself keep a process alive) -- a real server always
  // has other ref'd activity (its own HTTP listener) so this is a non-issue
  // in production, but this standalone test needs its own ref'd keep-alive
  // or the runner can decide there is nothing left to wait for before the
  // timeout ever fires.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));

  const limiter = createDurableRateLimiter({ client, windowMs: 900000, max: 5, requestTimeoutMs: 5 });
  const result = await limiter.check("email:abc");
  assert.deepEqual(result, { blocked: false, retryAfterMs: 0 });
});
