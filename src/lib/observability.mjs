// OP-20 -- error reporting -----------------------------------------------
//
// Fire-and-forget error capture: posts a small, secret-free JSON payload
// describing a caught error to OBSERVABILITY_DSN. This module exists to make
// production errors *visible* (the pilot-launch blocker the plan calls out)
// without ever becoming a new way for the app to fail.
//
// DSN FORMAT DECISION (OWNER, still open -- see plans/PLATFORM_OPS_PLAN.md
// OP-20 "OWNER decision: DSN provider"):
//   OBSERVABILITY_DSN could point at a Sentry "store" endpoint (its own
//   envelope shape and an `X-Sentry-Auth` header parsed out of the DSN) or a
//   generic JSON webhook (any URL, plain JSON POST, no provider-specific
//   framing). This module ships the generic-webhook shape as the default --
//   it needs no provider SDK and no DSN-parsing beyond "it's a URL" -- and is
//   deliberately structured so a Sentry-compatible builder can be dropped in
//   later without touching any call site:
//     - buildPayload(error, context) is the ONLY place that knows the wire
//       shape. Swapping it for a Sentry envelope builder (and adjusting
///      postWithTimeout's headers/URL parsing for Sentry's `key@host/project`
//       DSN form) is the entire migration.
//     - reportError(error, context) is the stable public entry point every
//       caller (scripts/server.mjs, api/[...path].mjs,
//       src/lib/notifications/worker.mjs) already uses; it never needs to
//       change shape once the owner picks a provider.
//   Until that decision lands, every report is just:
//     POST <OBSERVABILITY_DSN>  { message, stack, route, status, requestId,
//                                  userId, timestamp }
//
// Hard rules (mirrors OP-19's request-logging rules in scripts/server.mjs):
//   - NEVER include request bodies, query strings, Authorization headers, or
//     any raw env value in the reported payload. buildPayload only ever
//     reads the whitelisted fields below -- it never spreads `error` or
//     `context`, so an error object that happens to carry extra properties
//     (e.g. a caught HTTP client error with a `.headers`/`.body` property)
//     can never leak those onto the wire.
//   - NEVER throw into the caller. Every failure mode (missing DSN, a
//     throwing/rejecting fetchImpl, a synchronous bug in buildPayload) is
//     swallowed inside this module.
//   - NEVER block or slow down the response the caller is in the middle of
//     sending. Call sites invoke `reportError(...)` WITHOUT `await`-ing it;
//     the returned promise exists only so tests can await completion -- it
//     always resolves (never rejects) and production code must not rely on
//     it resolving before moving on.
//   - A slow/unreachable DSN endpoint must not hang the process: the POST is
//     bounded by `timeoutMs` (default below), via AbortController when the
//     injected fetch honors it, and via a hard `Promise.race` fallback when
//     it doesn't (e.g. a test stub that ignores the abort signal).

const DEFAULT_TIMEOUT_MS = 3000;

function safeMessage(error) {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function safeStack(error) {
  return typeof error?.stack === "string" ? error.stack : null;
}

// The generic-webhook payload builder (see the DSN decision note above for
// the Sentry-envelope alternative this is standing in for). Only reads
// error.message/error.stack and the explicit whitelist of context fields --
// deliberately does not spread `error` or `context`, so nothing outside this
// whitelist can ever reach the wire.
export function buildPayload(error, context = {}) {
  return {
    message: safeMessage(error),
    stack: safeStack(error),
    route: context.route ?? null,
    status: context.status ?? null,
    requestId: context.requestId ?? null,
    userId: context.userId ?? null,
    timestamp: new Date().toISOString()
  };
}

// Returns { promise, cancel }: `promise` rejects after `ms` unless `cancel`
// is called first. Deliberately NOT unref'd -- this timer is what makes
// reportError's returned promise actually settle within `ms` even against a
// fetchImpl that ignores its AbortSignal; unref'ing it would let an
// otherwise-idle process/test runner exit before it ever fires, leaving the
// fire-and-forget promise permanently unsettled instead of bounded. `cancel`
// is called from postPayload's `finally` the instant the race is decided
// (by either branch), so the common case -- fetchImpl answers well inside
// `ms` -- never actually waits out the full timeout.
function timeoutRejection(ms) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("observability report timed out")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function postPayload(fetchImpl, dsn, payload, timeoutMs) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const { promise: timesOut, cancel: cancelTimeout } = timeoutRejection(timeoutMs);
  try {
    await Promise.race([
      fetchImpl(dsn, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      }),
      // Belt-and-suspenders: a fetchImpl (real or stubbed) that ignores the
      // AbortSignal entirely still can't hang this call past timeoutMs.
      timesOut
    ]);
  } finally {
    clearTimeout(abortTimer);
    cancelTimeout();
  }
}

// Reports one error, fire-and-forget. `context`:
//   dsn        -- OBSERVABILITY_DSN for this request/process; unset (or "")
//                 is the normal local/dev state and is a silent no-op --
//                 fetchImpl is never even called.
//   fetchImpl  -- injectable for tests; defaults to the global fetch.
//   timeoutMs  -- bounds the POST; defaults to DEFAULT_TIMEOUT_MS.
//   route, status, requestId, userId -- see buildPayload.
//
// Returns a promise that ALWAYS resolves (never rejects) once the attempt
// (successful, failed, or timed out) is done. Callers in this codebase never
// await it -- see the file header -- the return value exists purely so tests
// can observe completion without the module needing a separate "wait for the
// fire-and-forget call" hook.
export function reportError(error, context = {}) {
  const { dsn, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = context;
  if (!dsn) return Promise.resolve();

  return (async () => {
    try {
      const payload = buildPayload(error, context);
      await postPayload(fetchImpl, dsn, payload, timeoutMs);
    } catch {
      // Best-effort telemetry only -- a broken/slow/unreachable reporter must
      // never surface to the caller, so every failure mode ends here.
    }
  })();
}
