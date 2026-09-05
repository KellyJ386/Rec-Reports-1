// Bounded, in-memory sliding-window rate limiter.
//
// IMPORTANT (read before reusing this for anything security-critical):
// this state lives in a plain module-level Map, i.e. per Node process. On
// Vercel serverless each invocation can land on a different instance (cold
// starts, scale-out, region failover), and each instance has its own Map.
// An attacker whose requests are spread across instances gets a fresh
// counter on every one, so this is a *speed bump* against a single-instance
// burst, not a durable, globally-consistent rate limit. A real bound needs
// a shared store (Redis/Upstash, a Postgres table with atomic counters,
// etc.) keyed the same way the callers below key it.
//
// Bounding under attack: a naive "one array per key, keys never removed"
// design lets an attacker grow the Map without limit simply by presenting
// many distinct keys (e.g. many spoofed IPs, or an email-enumeration
// sweep). Two independent mechanisms keep this store bounded instead:
//   1. Per-key: each key holds at most `max` timestamps -- once a key has
//      hit the limit there is nothing more useful to record about it, so
//      recordFailure() caps the array length rather than growing it.
//   2. Store-wide: every `sweepEvery` calls, the whole Map is swept and any
//      key whose timestamps have all aged out of the window is deleted, so
//      stale keys from one-off/spoofed callers don't linger forever.
export function createRateLimiter({ windowMs, max, now = Date.now, sweepEvery = 500 }) {
  if (!(windowMs > 0)) throw new Error("createRateLimiter: windowMs must be > 0");
  if (!(max > 0)) throw new Error("createRateLimiter: max must be > 0");

  const store = new Map(); // key -> number[] failure timestamps (ms), ascending, length <= max
  let callsSinceSweep = 0;

  function pruneList(timestamps, current) {
    const cutoff = current - windowMs;
    let start = 0;
    while (start < timestamps.length && timestamps[start] <= cutoff) start++;
    return start === 0 ? timestamps : timestamps.slice(start);
  }

  function sweepStore(current) {
    for (const [key, timestamps] of store) {
      const pruned = pruneList(timestamps, current);
      if (pruned.length === 0) store.delete(key);
      else if (pruned !== timestamps) store.set(key, pruned);
    }
  }

  function maybeSweep(current) {
    callsSinceSweep += 1;
    if (callsSinceSweep >= sweepEvery) {
      callsSinceSweep = 0;
      sweepStore(current);
    }
  }

  return {
    // Read-only: is `key` currently over the limit? Does not record an
    // attempt, so callers can pre-check before doing expensive work.
    check(key) {
      const current = now();
      maybeSweep(current);
      const existing = store.get(key);
      if (!existing) return { blocked: false, retryAfterMs: 0 };
      const timestamps = pruneList(existing, current);
      if (timestamps.length === 0) {
        store.delete(key);
        return { blocked: false, retryAfterMs: 0 };
      }
      if (timestamps !== existing) store.set(key, timestamps);
      if (timestamps.length < max) return { blocked: false, retryAfterMs: 0 };
      const oldest = timestamps[0];
      return { blocked: true, retryAfterMs: Math.max(0, oldest + windowMs - current) };
    },
    // Record one failed attempt for `key`.
    recordFailure(key) {
      const current = now();
      maybeSweep(current);
      const timestamps = pruneList(store.get(key) ?? [], current);
      timestamps.push(current);
      if (timestamps.length > max) timestamps.shift();
      store.set(key, timestamps);
    },
    // Clear all recorded failures for `key` (e.g. a successful sign-in).
    reset(key) {
      store.delete(key);
    },
    // Force a full sweep now, independent of the sweepEvery cadence.
    // Exposed mainly so tests can assert eviction deterministically.
    sweep() {
      sweepStore(now());
    },
    // Number of distinct keys currently tracked. Test/introspection hook.
    size() {
      return store.size;
    }
  };
}
