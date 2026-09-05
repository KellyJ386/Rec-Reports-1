import test from "node:test";
import assert from "node:assert/strict";
import { reportError, buildPayload } from "../src/lib/observability.mjs";

test("DSN unset: reportError never calls fetch and resolves silently", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true };
  };

  await reportError(new Error("boom"), { dsn: undefined, fetchImpl });
  assert.equal(called, false);

  // Empty-string DSN is treated the same as unset (falsy).
  await reportError(new Error("boom"), { dsn: "", fetchImpl });
  assert.equal(called, false);
});

test("a throwing/rejecting reporter never surfaces to the caller", async () => {
  const throwing = async () => {
    throw new Error("reporter backend is down");
  };
  await assert.doesNotReject(() =>
    reportError(new Error("boom"), { dsn: "https://observability.example/report", fetchImpl: throwing })
  );

  const syncThrowing = () => {
    throw new Error("synchronous failure in fetchImpl");
  };
  await assert.doesNotReject(() =>
    reportError(new Error("boom"), { dsn: "https://observability.example/report", fetchImpl: syncThrowing })
  );
});

test("reportError never throws synchronously, even with a bad DSN/context", () => {
  assert.doesNotThrow(() => {
    reportError(new Error("boom"), { dsn: "https://observability.example/report", fetchImpl: () => {
      throw new Error("nope");
    } });
  });
});

test("payload carries only the whitelisted fields -- no Authorization/token/body leakage", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true };
  };

  // An error object that carries exactly the kind of extra properties a
  // caught HTTP client error might have -- these must never reach the wire.
  const error = new Error("upstream request failed");
  error.authorization = "Bearer super-secret-token";
  error.token = "abc123-token";
  error.body = { password: "hunter2", cardNumber: "4111111111111111" };
  error.headers = { Authorization: "Bearer super-secret-token", Cookie: "session=xyz" };
  error.requestBody = JSON.stringify({ ssn: "123-45-6789" });

  await reportError(error, {
    dsn: "https://observability.example/report",
    fetchImpl,
    route: "/api/v1/reports/:id",
    status: 500,
    requestId: "req-1",
    userId: "user-1"
  });

  assert.ok(captured, "fetchImpl should have been called");
  assert.equal(captured.url, "https://observability.example/report");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.ok(!("Authorization" in captured.init.headers));
  assert.ok(!("authorization" in captured.init.headers));

  const payload = JSON.parse(captured.init.body);
  assert.deepEqual(Object.keys(payload).sort(), ["message", "requestId", "route", "stack", "status", "timestamp", "userId"]);
  assert.equal(payload.message, "upstream request failed");
  assert.equal(payload.route, "/api/v1/reports/:id");
  assert.equal(payload.status, 500);
  assert.equal(payload.requestId, "req-1");
  assert.equal(payload.userId, "user-1");

  const wire = captured.init.body;
  for (const secret of [
    "super-secret-token",
    "abc123-token",
    "hunter2",
    "4111111111111111",
    "session=xyz",
    "123-45-6789",
    "Authorization",
    "Cookie"
  ]) {
    assert.equal(wire.includes(secret), false, `wire payload must not contain "${secret}"`);
  }
});

test("buildPayload alone never spreads the error or context object onto the result", () => {
  const error = new Error("boom");
  error.secretField = "should-not-leak";
  const payload = buildPayload(error, { route: "/x", secretContextField: "also-should-not-leak" });
  assert.deepEqual(Object.keys(payload).sort(), ["message", "requestId", "route", "stack", "status", "timestamp", "userId"]);
  assert.equal(JSON.stringify(payload).includes("should-not-leak"), false);
});

// A fetchImpl that "hangs" relative to timeoutMs (resolves well after it,
// but not literally never) -- a truly never-settling promise would still be
// pending when this test function returns, which node:test's per-test
// promise-tracking flags as a failure even though it can't affect anything
// (the timer is unref'd). SLOW_MS is kept short and the test drains it
// before returning so nothing outlives the test either way.
const SLOW_MS = 150;
function slowFetch() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: true }), SLOW_MS);
    timer.unref?.();
  });
}

test("a hanging reporter times out instead of hanging the caller", async () => {
  const start = Date.now();
  await reportError(new Error("boom"), {
    dsn: "https://observability.example/report",
    fetchImpl: slowFetch,
    timeoutMs: 20
  });
  const elapsed = Date.now() - start;

  // Bounded well under SLOW_MS -- reportError's own timeout (20ms) won the
  // race, not the slow fetchImpl's eventual resolution.
  assert.ok(elapsed < SLOW_MS, `expected reportError to resolve before the slow fetch, took ${elapsed}ms`);

  // Drain the slow fetch's own timer so nothing from this test is still
  // pending once the test function returns.
  await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
});

test("a reporter that ignores the AbortSignal is still bounded by timeoutMs", async () => {
  // Simulates a stub/provider client that doesn't honor `init.signal` at all
  // -- slowFetch never even looks at the signal it's passed.
  const start = Date.now();
  await reportError(new Error("boom"), {
    dsn: "https://observability.example/report",
    fetchImpl: slowFetch,
    timeoutMs: 20
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < SLOW_MS, `expected the timeout race to win regardless of fetchImpl, took ${elapsed}ms`);

  await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
});

test("reportError resolves (does not reject) on success", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200 });
  await assert.doesNotReject(() =>
    reportError(new Error("boom"), { dsn: "https://observability.example/report", fetchImpl })
  );
});
