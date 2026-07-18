// Zero-dependency logger / error-reporter wired to the optional
// OBSERVABILITY_DSN server env field (see src/lib/env.mjs). When the DSN is
// unset both methods are no-ops; when it is set they fire a best-effort JSON
// POST at it and never await the network call, so telemetry can never delay
// or break the request it is describing. Both methods swallow every error —
// synchronous or async — by design.

const REDACTED = "[redacted]";
// Matches header/field names that commonly carry credentials so a caller
// can pass request context (headers, query, etc.) straight through without
// hand-redacting it first.
const SECRET_KEY_PATTERN = /(authorization|cookie|token|secret|password|apikey|api[-_]?key|dsn)/i;

function redactValue(value, seen) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(nested, seen);
    }
    return result;
  }
  return value;
}

// Deep-redacts any key that looks secret-ish (authorization, cookie, token,
// password, apikey, dsn, ...) before a context object is ever serialized.
function redactContext(context) {
  if (context === undefined || context === null) return null;
  if (typeof context !== "object") return context;
  return redactValue(context, new WeakSet());
}

// Fires the POST and immediately detaches from its result. Never returns a
// rejected promise to the caller and never throws synchronously.
function postEvent(dsn, body) {
  try {
    const result = fetch(dsn, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // fire-and-forget: telemetry must never break the caller
  }
}

// createObservability(env) reads OBSERVABILITY_DSN (already URL-validated by
// readServerEnv) and an opt-in OBSERVABILITY_CONSOLE_LOG flag. Safe to
// construct and call with env = {} / DSN unset.
export function createObservability(env = {}) {
  const dsn = env?.OBSERVABILITY_DSN ?? null;
  const consoleEnabled = env?.OBSERVABILITY_CONSOLE_LOG === "true";

  function logRequest(entry) {
    try {
      const { method, path, status, durationMs } = entry ?? {};
      if (consoleEnabled) {
        console.log(`[observability] ${method} ${path} ${status} ${durationMs}ms`);
      }
      if (!dsn) return;
      postEvent(dsn, { type: "request", method, path, status, durationMs });
    } catch {
      // never let telemetry break the request
    }
  }

  function reportError(error, context) {
    try {
      if (!dsn) return;
      const hasContext = context !== undefined && context !== null;
      const isObjectContext = hasContext && typeof context === "object";
      const { ts, ...rest } = isObjectContext ? context : {};
      const contextBody = hasContext ? (isObjectContext ? rest : context) : null;
      const body = {
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
        context: redactContext(contextBody)
      };
      if (ts !== undefined) body.ts = ts;
      postEvent(dsn, body);
    } catch {
      // never throw from error reporting
    }
  }

  return { logRequest, reportError };
}
