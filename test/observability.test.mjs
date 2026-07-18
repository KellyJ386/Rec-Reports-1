import test from "node:test";
import assert from "node:assert/strict";
import { createObservability } from "../src/lib/observability/observability.mjs";

const DSN = "https://ingest.example.com/events";

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : null });
    const { ok = true, status = 200, data = {}, reject = null } = respond?.(url, init) ?? {};
    if (reject) throw reject;
    return { ok, status, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

test("logRequest is a no-op when OBSERVABILITY_DSN is unset", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({});
  observability.logRequest({ method: "GET", path: "/api/v1/me", status: 200, durationMs: 12 });
  assert.equal(captured.length, 0);
});

test("reportError is a no-op when OBSERVABILITY_DSN is unset", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({});
  observability.reportError(new Error("boom"), { userId: "u1" });
  assert.equal(captured.length, 0);
});

test("logRequest POSTs a structured event to the DSN when set", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  observability.logRequest({ method: "GET", path: "/api/v1/me", status: 200, durationMs: 12 });
  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.url.href, DSN);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.deepEqual(call.body, {
    type: "request",
    method: "GET",
    path: "/api/v1/me",
    status: 200,
    durationMs: 12
  });
});

test("logRequest does not await the telemetry POST (fire-and-forget)", (t) => {
  let resolveFetch;
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  const returned = observability.logRequest({ method: "GET", path: "/x", status: 200, durationMs: 1 });
  assert.equal(returned, undefined);
  assert.equal(typeof resolveFetch, "function");
});

test("reportError POSTs message, stack, and context to the DSN when set", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  const error = new Error("kaboom");
  observability.reportError(error, { route: "/api/v1/reports", userId: "u1" });
  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.url.href, DSN);
  assert.equal(call.body.message, "kaboom");
  assert.equal(call.body.stack, error.stack);
  assert.deepEqual(call.body.context, { route: "/api/v1/reports", userId: "u1" });
  assert.equal(call.body.ts, undefined);
});

test("reportError forwards a caller-supplied ts without calling Date.now()", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  observability.reportError(new Error("kaboom"), { ts: 1700000000000, userId: "u1" });
  assert.equal(captured[0].body.ts, 1700000000000);
  assert.deepEqual(captured[0].body.context, { userId: "u1" });
});

test("reportError sends null context when no context is supplied", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  observability.reportError(new Error("kaboom"));
  assert.equal(captured[0].body.context, null);
});

test("reportError redacts obvious secrets from context before sending", (t) => {
  const captured = stubFetch(t);
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  observability.reportError(new Error("kaboom"), {
    headers: { Authorization: "Bearer secret-jwt", "X-Api-Key": "abc123", "content-type": "application/json" },
    token: "raw-token",
    password: "hunter2",
    user: { id: "u1", refreshToken: "should-be-redacted" },
    safe: "keep-me"
  });
  const context = captured[0].body.context;
  assert.equal(context.headers.Authorization, "[redacted]");
  assert.equal(context.headers["X-Api-Key"], "[redacted]");
  assert.equal(context.headers["content-type"], "application/json");
  assert.equal(context.token, "[redacted]");
  assert.equal(context.password, "[redacted]");
  assert.equal(context.user.id, "u1");
  assert.equal(context.user.refreshToken, "[redacted]");
  assert.equal(context.safe, "keep-me");
});

test("reportError never throws even when fetch rejects", async (t) => {
  stubFetch(t, () => ({ reject: new Error("network down") }));
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  assert.doesNotThrow(() => observability.reportError(new Error("kaboom"), { userId: "u1" }));
  // Let the rejected fetch promise settle so it doesn't surface as an
  // unhandled rejection after the test completes.
  await new Promise((resolve) => setImmediate(resolve));
});

test("reportError never throws when fetch itself throws synchronously", (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch unavailable");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const observability = createObservability({ OBSERVABILITY_DSN: DSN });
  assert.doesNotThrow(() => observability.reportError(new Error("kaboom"), { userId: "u1" }));
});

test("logRequest stays quiet by default (no console output) when DSN is unset", (t) => {
  const originalLog = console.log;
  let called = false;
  console.log = () => {
    called = true;
  };
  t.after(() => {
    console.log = originalLog;
  });
  const observability = createObservability({});
  observability.logRequest({ method: "GET", path: "/x", status: 200, durationMs: 1 });
  assert.equal(called, false);
});
