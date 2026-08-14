// Provider-agnostic push adapter interface (CM-07). No real APNS/FCM
// integration is wired up here -- that is explicitly deferred (no
// credentials to invent, no dependency to add). What this file provides is
// the SHAPE the worker (src/lib/notifications/worker.mjs) delivers against,
// so swapping in a real provider later is a one-file change:
//
//   - an adapter interface: `async send({ tokens, title, body, data,
//     fetchImpl }) -> [{ token, code }, ...]`, one result per input token,
//     `code` being a provider-agnostic outcome key (see PROVIDER_OUTCOMES
//     below) rather than a raw provider error string. A real APNS/FCM
//     adapter would translate its own status codes/error reasons into one of
//     these keys and otherwise look exactly like `noopAdapter` below,
//     including accepting `fetchImpl` so it can be unit-tested without a
//     real network call (mirrors the `fetchImpl`-injection convention used
//     elsewhere in this codebase's HTTP-calling adapters).
//   - `noopAdapter`, the default: makes no network call and reports every
//     token as accepted ("ok"). This is what lets CM-07 mark push
//     deliveries 'sent' today without a configured provider, while keeping
//     the exact call shape a real adapter will need to fill in.
//   - `classifyOutcome`/`sendPush`: the provider-agnostic mapping from a
//     `code` to one of three outcomes the worker acts on:
//       "sent"      -- delivered (or, for the stub, accepted) successfully.
//       "retryable" -- transient provider-side failure (rate limit, 5xx,
//                      timeout); the token itself may still be good, so it
//                      is NOT revoked.
//       "permanent" -- the token itself is bad and will never succeed again
//                      (unregistered/invalid/mismatched-sender); the worker
//                      revokes it (employee_device_tokens.revoked_at) so a
//                      future job stops trying it.
//
// sendPush() is the single entry point the worker calls; it never throws on
// a per-token provider failure (that is normal, expected traffic for a push
// channel with any real-world token churn) -- only a broken adapter call
// itself (a rejected promise from adapter.send) propagates as a thrown
// error, same as any other I/O failure in this codebase.

// Provider-agnostic outcome keys -> the three delivery outcomes the worker
// distinguishes. Extend this map (not the worker) when a real adapter
// introduces a new provider-specific rejection reason -- the worker only
// ever sees "sent" | "retryable" | "permanent".
const PROVIDER_OUTCOMES = {
  ok: "sent",
  invalid_token: "permanent",
  unregistered: "permanent",
  not_registered: "permanent",
  mismatched_sender: "permanent",
  rate_limited: "retryable",
  server_error: "retryable",
  timeout: "retryable",
  unavailable: "retryable"
};

// Maps a provider-agnostic outcome code to "sent" | "retryable" | "permanent".
// An unrecognized code is treated as retryable rather than permanent -- an
// adapter reporting a code this file doesn't yet know about is far more
// likely to be a new transient failure mode than grounds to revoke someone's
// token, so the safe default is "try again later", not "give up forever".
export function classifyOutcome(code) {
  return PROVIDER_OUTCOMES[code] ?? "retryable";
}

// The default adapter: no provider is configured, so every token is treated
// as accepted without any network call. Kept a plain object (not a class) so
// a test's fake adapter can be a plain `{ send: async () => [...] }` too.
export const noopAdapter = {
  async send({ tokens = [] } = {}) {
    return tokens.map((token) => ({ token, code: "ok" }));
  }
};

// sendPush({tokens, title, body, data}, {adapter, fetchImpl}) -- the worker's
// entry point for a channel='push' delivery. Dedupes/filters `tokens` before
// calling the adapter (a caller passing the same token twice, e.g. two
// recipients who happen to share a device, should not trigger two sends to
// it) and normalizes every result through classifyOutcome, so a caller never
// has to know a specific adapter's raw `code` vocabulary.
//
// Returns:
//   results        -- [{ token, code, outcome }] in the order tokens were
//                      deduped, one entry per unique input token. A token
//                      the adapter didn't return a result for is treated as
//                      "server_error" (retryable) rather than silently
//                      dropped -- a malformed/partial adapter response
//                      should never look like an unattempted send.
//   sentTokens      -- outcome === "sent"
//   retryableTokens -- outcome === "retryable"
//   revokeTokens    -- outcome === "permanent" -- the worker revokes these.
export async function sendPush({ tokens = [], title, body, data = {} } = {}, { adapter = noopAdapter, fetchImpl } = {}) {
  const uniqueTokens = [...new Set((tokens ?? []).filter((token) => typeof token === "string" && token.length > 0))];
  if (uniqueTokens.length === 0) {
    return { results: [], sentTokens: [], retryableTokens: [], revokeTokens: [] };
  }

  const raw = (await adapter.send({ tokens: uniqueTokens, title, body, data, fetchImpl })) ?? [];
  const codeByToken = new Map(raw.map((entry) => [entry?.token, entry?.code]));

  const results = uniqueTokens.map((token) => {
    const code = codeByToken.has(token) ? codeByToken.get(token) : "server_error";
    return { token, code, outcome: classifyOutcome(code) };
  });

  return {
    results,
    sentTokens: results.filter((r) => r.outcome === "sent").map((r) => r.token),
    retryableTokens: results.filter((r) => r.outcome === "retryable").map((r) => r.token),
    revokeTokens: results.filter((r) => r.outcome === "permanent").map((r) => r.token)
  };
}
