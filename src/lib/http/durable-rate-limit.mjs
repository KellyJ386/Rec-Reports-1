// S-7: durable, cross-instance backstop for the in-memory limiter in
// ./rate-limit.mjs. That limiter's own header explains why a per-process
// Map is only a single-instance speed bump on Vercel serverless -- this
// module is the "real bound needs a shared store" it points at, backed by
// the auth_throttle table (supabase/migrations/0046_auth_throttle.sql).
//
// This is layered BEHIND the in-memory limiter, never instead of it: the
// in-memory check is free (no network hop) and already stops the common
// single-instance burst before a request ever reaches here. The durable
// layer only has to catch what the in-memory layer misses -- an attacker
// whose requests happen to land on many different cold-started instances.
//
// PostgREST cannot do an atomic "increment failures, resetting the window
// if it expired" in one round trip: there is no conditional-update
// expression PostgREST exposes over HTTP, only whole-row upserts. So
// recordFailure is a plain read-then-upsert:
//   1. GET the row for `key` (if any).
//   2. Decide client-side whether its window has expired.
//   3. POST the recomputed row with `on_conflict=key` and
//      `Prefer: resolution=merge-duplicates` (a full-row upsert).
// Two concurrent recordFailure calls for the same key can both read the same
// pre-write row and each compute "current + 1", so a failure can be lost
// under true concurrency (last upsert wins, not last-plus-one). That race is
// accepted deliberately: this store is a backstop behind the in-memory
// limiter, which already blocks the request that would trigger it in the
// overwhelmingly common single-instance case, and undercounting a lockout by
// one or two attempts under a genuine cross-instance race is a far smaller
// risk than adding a second round trip (or a stored procedure this
// zero-dependency PostgREST client has no way to express) just to close it.
//
// Fail-open contract (every method): a down/unreachable/erroring PostgREST
// must never turn into a blocked sign-in or refresh. Every method below
// catches every failure, reports it (fire-and-forget, via
// src/lib/observability.mjs -- a no-op when no dsn is configured) and
// returns the same "not blocked" / no-op result it would return for an
// empty store. Callers never see a rejected promise from this module.
import { pgSelect, pgInsert, pgDelete } from "../supabase-rest.mjs";
import { reportError } from "../observability.mjs";

const TABLE = "auth_throttle";
const ROW_SELECT = "failures,window_start";
const DEFAULT_SWEEP_OLDER_THAN_MS = 60 * 60 * 1000; // 1 hour

// M5: `key` is derived from attacker-influenced input. auth-routes.mjs now
// sha256-hashes both its email and its IP keys (fixed-length hex, well under
// this cap), but nothing stops a future caller of this module from building
// a key out of other unbounded input. Refusing an oversized key here --
// rather than trusting every call site to have bounded its own input --
// keeps a single unbounded key from becoming an unbounded row in a durable,
// cross-instance store. Treated the same as every other failure mode in
// this module: fail open, no throw.
const MAX_KEY_LENGTH = 128;

function isOversizedKey(key) {
  return typeof key !== "string" || key.length > MAX_KEY_LENGTH;
}

// M5: hard ceiling on total row count, enforced by the sweep below
// independent of the staleness (updated_at) sweep -- an attacker minting a
// fresh key on every single request (before MAX_KEY_LENGTH existed, or via
// any key material this module doesn't itself bound, e.g. a legitimately
// short but endlessly varying IP) would otherwise keep every row "fresh"
// forever and never age out of the updated_at sweep at all.
const DEFAULT_MAX_ROWS = 10000;
// Deleted per sweep call when over MAX_ROWS -- bounded so one sweep can
// never issue an unbounded SELECT/DELETE; a sustained overage is worked
// down over consecutive drain-cadence sweeps instead.
const EXCESS_SWEEP_BATCH = 1000;

function reportFailure(error, { dsn, fetchImpl, route, key }) {
  // Fire-and-forget by design (see observability.mjs) -- callers below never
  // await this, and it never rejects.
  reportError(error, { dsn, fetchImpl, route, status: null, requestId: key ?? null, userId: null });
}

// `{ client, windowMs, max, now }` mirrors createRateLimiter's constructor
// shape (./rate-limit.mjs) so the two are interchangeable at call sites.
// `dsn`/`fetchImpl` are forwarded straight to reportError for the fail-open
// path above; both are optional (an unset dsn makes every report a silent
// no-op, same as everywhere else in this codebase).
export function createDurableRateLimiter({
  client,
  windowMs,
  max,
  now = Date.now,
  dsn,
  fetchImpl,
  requestTimeoutMs = 1500
}) {
  if (!(windowMs > 0)) throw new Error("createDurableRateLimiter: windowMs must be > 0");
  if (!(max > 0)) throw new Error("createDurableRateLimiter: max must be > 0");

  // L5: bounds every PostgREST round trip this limiter makes. Fail-open
  // above already covers a down/erroring PostgREST (an immediate rejected
  // fetch or a non-2xx response); it did nothing for a *hanging* one, since
  // nothing in supabase-rest.mjs ever carried a timeout/AbortSignal before
  // pgRpc/signal support was added (0048-adjacent change) -- an unbounded
  // await here turned a slow database into a slow sign-in/refresh even
  // though this module's whole job is to never do that. AbortSignal.timeout
  // rejects with a DOMException the `catch` blocks below already handle
  // exactly like any other failure.
  function requestSignal() {
    return requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined;
  }

  async function fetchRow(key) {
    const rows = await pgSelect(client, TABLE, {
      filters: { key },
      select: ROW_SELECT,
      limit: 1,
      signal: requestSignal()
    });
    return rows?.[0] ?? null;
  }

  function isExpired(row, current) {
    return !row || current - new Date(row.window_start).getTime() >= windowMs;
  }

  return {
    // Read-only: is `key` currently over the limit? Never writes.
    async check(key) {
      if (isOversizedKey(key)) return { blocked: false, retryAfterMs: 0 }; // M5: refuse before any fetch
      try {
        const current = now();
        const row = await fetchRow(key);
        if (isExpired(row, current)) return { blocked: false, retryAfterMs: 0 };
        if (row.failures < max) return { blocked: false, retryAfterMs: 0 };
        const windowStart = new Date(row.window_start).getTime();
        return { blocked: true, retryAfterMs: Math.max(0, windowStart + windowMs - current) };
      } catch (error) {
        reportFailure(error, { dsn, fetchImpl, route: "durable-rate-limit.check", key });
        return { blocked: false, retryAfterMs: 0 }; // fail open
      }
    },

    // Record one failed attempt for `key`. Read-then-upsert -- see the file
    // header for the small race this accepts and why.
    async recordFailure(key) {
      if (isOversizedKey(key)) return; // M5: never write an unbounded key
      try {
        const current = now();
        const nowIso = new Date(current).toISOString();
        const row = await fetchRow(key);
        const expired = isExpired(row, current);
        const nextRow = {
          key,
          window_start: expired ? nowIso : row.window_start,
          failures: expired ? 1 : row.failures + 1,
          updated_at: nowIso
        };
        await pgInsert(client, TABLE, [nextRow], {
          onConflict: "key",
          merge: true,
          returning: false,
          signal: requestSignal()
        });
      } catch (error) {
        reportFailure(error, { dsn, fetchImpl, route: "durable-rate-limit.recordFailure", key });
        // fail open: a store that can't be written to must not block the
        // caller's request, so there is nothing more to do here.
      }
    },

    // Clear all recorded failures for `key` (e.g. a successful sign-in).
    async reset(key) {
      if (isOversizedKey(key)) return;
      try {
        await pgDelete(client, TABLE, { key }, { signal: requestSignal() });
      } catch (error) {
        reportFailure(error, { dsn, fetchImpl, route: "durable-rate-limit.reset", key });
        // fail open: a reset that silently didn't happen is never worse than
        // the pre-existing counter it was trying to clear.
      }
    }
  };
}

// Sweeps stale auth_throttle rows -- called from internal-routes.mjs's
// handleDrain (the existing CRON_SECRET-guarded cron entry) after each
// drain, so this table stays bounded the same way the in-memory limiter
// bounds itself via its own periodic sweep. One PostgREST delete with a
// `lt` filter on updated_at; `returning: true` so the deleted rows come back
// and the caller can report exactly how many were swept.
//
// Fail-open like every method above: a failing sweep must never fail the
// cron response it rides along with, so this always resolves with
// `{ deleted: 0 }` on error (after reporting it) rather than rejecting.
export async function sweepAuthThrottle(client, {
  olderThanMs = DEFAULT_SWEEP_OLDER_THAN_MS,
  maxRows = DEFAULT_MAX_ROWS,
  now = Date.now,
  dsn,
  fetchImpl
} = {}) {
  let deleted = 0;
  try {
    const cutoffIso = new Date(now() - olderThanMs).toISOString();
    const deletedRows = await pgDelete(client, TABLE, { updated_at: { lt: cutoffIso } }, { returning: true });
    deleted += Array.isArray(deletedRows) ? deletedRows.length : 0;
  } catch (error) {
    reportFailure(error, { dsn, fetchImpl, route: "durable-rate-limit.sweep", key: null });
    return { deleted: 0 };
  }

  // M5: cap total row count even when every remaining row is individually
  // within the staleness window -- keep only the maxRows most recently
  // updated rows, deleting the oldest excess (bounded to EXCESS_SWEEP_BATCH
  // per call; a sustained overage is worked down over consecutive sweeps
  // rather than one unbounded query). A separate try/catch from the sweep
  // above: a failure here must not undo or misreport the staleness sweep
  // that already succeeded.
  try {
    const excessRows = await pgSelect(client, TABLE, {
      select: "key",
      order: "updated_at.desc",
      offset: maxRows,
      limit: EXCESS_SWEEP_BATCH
    });
    const excessKeys = (excessRows ?? []).map((row) => row.key).filter(Boolean);
    if (excessKeys.length > 0) {
      // supabase-rest.mjs quotes any list value containing `,` `(` `)` `"`
      // or whitespace, so a row whose key somehow carries one of those (no
      // current writer produces such a key, but the table is shared state)
      // cannot wedge this DELETE for every other row behind it.
      await pgDelete(client, TABLE, { key: { in: excessKeys } }, { returning: false });
      deleted += excessKeys.length;
    }
  } catch (error) {
    reportFailure(error, { dsn, fetchImpl, route: "durable-rate-limit.sweep.rowcap", key: null });
    // fail open: the staleness sweep above already ran and its count is
    // still reported; only the row-cap pass is skipped this cycle.
  }

  return { deleted };
}
