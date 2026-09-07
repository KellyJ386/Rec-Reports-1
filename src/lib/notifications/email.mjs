// Provider-agnostic email adapter interface (P-4), mirroring push.mjs's
// shape exactly so the worker (src/lib/notifications/worker.mjs) can treat
// email delivery the same way it already treats push:
//
//   - an adapter interface: `async send({ to, subject, text, html,
//     fetchImpl }) -> { to, code, providerMessageId? }`, one message in,
//     one result out (unlike push.mjs's token-batch adapter -- see the
//     "why per-message" note on createResendAdapter below), `code` being a
//     provider-agnostic outcome key (see PROVIDER_OUTCOMES) rather than a
//     raw provider error string.
//   - `noopAdapter`, the default: makes no network call and reports every
//     message as accepted ("ok"). Same role as push.mjs's noopAdapter --
//     lets a job with an `email` channel mark deliveries 'sent' before any
//     real provider is configured.
//   - `classifyOutcome`/`sendEmail`: the provider-agnostic mapping from a
//     `code` to one of three outcomes the worker acts on -- "sent" |
//     "retryable" | "permanent" -- identical vocabulary to push.mjs's.
//
// sendEmail() is the single entry point the worker calls; it never throws
// on a per-recipient provider failure (a bad address, a bounced mailbox --
// normal, expected traffic for an email channel) -- only a broken adapter
// call itself (a rejected promise from adapter.send that this file's own
// try/catch didn't already convert into a result) would be a bug in an
// adapter, and even that is caught below rather than propagated, so one bad
// recipient can never take down the rest of a batch.

const PROVIDER_OUTCOMES = {
  ok: "sent",
  invalid_recipient: "permanent",
  bounced: "permanent",
  complained: "permanent",
  rate_limited: "retryable",
  server_error: "retryable",
  timeout: "retryable",
  unavailable: "retryable"
};

// Maps a provider-agnostic outcome code to "sent" | "retryable" | "permanent".
// An unrecognized code defaults to retryable, not permanent -- see push.mjs's
// classifyOutcome for the identical rationale.
export function classifyOutcome(code) {
  return PROVIDER_OUTCOMES[code] ?? "retryable";
}

// The default adapter: no provider is configured, so every message is
// treated as accepted without any network call. A plain object (not a
// class), same as push.mjs's noopAdapter, so a test's fake adapter can be a
// bare `{ send: async () => ({ to, code: "ok" }) }` too.
export const noopAdapter = {
  async send({ to } = {}) {
    return { to, code: "ok" };
  }
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CONCURRENCY = 4;
const RESEND_URL = "https://api.resend.com/emails";

// Returns { promise, cancel }: `promise` rejects after `ms` unless `cancel`
// is called first. Mirrors src/lib/observability.mjs's identically-named
// helper -- see its comment for why this belt-and-suspenders timeout (on top
// of AbortController) is needed: it bounds a fetchImpl that ignores its
// AbortSignal (real Node fetch honors it; a naive test stub might not).
function timeoutRejection(ms) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("email provider request timed out")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function postWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const { promise: timesOut, cancel: cancelTimeout } = timeoutRejection(timeoutMs);
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timesOut]);
  } finally {
    clearTimeout(abortTimer);
    cancelTimeout();
  }
}

// Resend's own /emails/batch endpoint is all-or-nothing on validation (one
// bad address bounces the whole batch), which is exactly the failure mode
// CM-14/OP-12 need to avoid -- one recipient's bad address must never affect
// any other recipient's delivery. That is why this adapter's `send` takes
// ONE message and issues ONE POST /emails per call (never /emails/batch);
// bounded concurrency across many recipients is sendEmail()'s job below, not
// this adapter's.
export function createResendAdapter({ apiKey, from, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new Error("createResendAdapter requires apiKey");
  if (!from) throw new Error("createResendAdapter requires from");

  return {
    async send({ to, subject, text, html, fetchImpl: callFetch } = {}) {
      const effectiveFetch = callFetch ?? fetchImpl;
      let response;
      try {
        response = await postWithTimeout(
          effectiveFetch,
          RESEND_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({ from, to: [to], subject, text, html })
          },
          timeoutMs
        );
      } catch {
        // Network failure, abort (timeout), or a fetchImpl that rejects --
        // all indistinguishable from "the request never got a response", so
        // all map to the same retryable "timeout" code.
        return { to, code: "timeout" };
      }

      let body = null;
      try {
        const raw = await response.text();
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }

      const status = response.status;
      if (status >= 200 && status < 300) {
        return { to, code: "ok", providerMessageId: body?.id ?? null };
      }
      if (status === 422) return { to, code: "invalid_recipient" };
      if (status === 429) return { to, code: "rate_limited" };
      if (status >= 500) return { to, code: "server_error" };
      // Any other 4xx (401 bad key, 400 malformed request, ...) is a
      // configuration problem, not something retrying THIS message fixes --
      // but it's also not "this address is bad", so it is treated the same
      // as an unrecognized code: retryable, never silently downgraded to
      // permanent (see classifyOutcome's unrecognized-code note).
      return { to, code: "server_error" };
    }
  };
}

// Runs `worker` over `items` with at most `limit` calls in flight at once,
// preserving each result at its original index (order-stable output, even
// though completion order is not). A plain hand-rolled pool rather than a
// dependency -- this repo stays zero-dependency by rule.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, runner));
  return results;
}

// sendEmail({messages}, {adapter, concurrency, fetchImpl}) -- the worker's
// entry point for a channel='email' delivery. One `adapter.send` call per
// message (never batched -- see createResendAdapter's comment), at most
// `concurrency` in flight at once. Returns one { to, code, outcome,
// providerMessageId } per input message, in input order; a message missing
// a non-empty `to` is dropped before ever reaching the adapter (nothing
// sensible to send it to). An adapter call that throws is caught here and
// turned into a retryable result rather than propagating -- a single
// recipient's failure (bad adapter, thrown network error the adapter itself
// didn't catch) must never fail every other recipient's send, nor the
// caller's whole delivery pass.
export async function sendEmail({ messages = [] } = {}, { adapter = noopAdapter, concurrency = DEFAULT_CONCURRENCY, fetchImpl } = {}) {
  const list = (messages ?? []).filter((message) => typeof message?.to === "string" && message.to.length > 0);
  if (list.length === 0) return [];

  return runWithConcurrency(list, concurrency, async (message) => {
    let raw;
    try {
      raw = await adapter.send({ ...message, fetchImpl });
    } catch {
      return { to: message.to, code: "server_error", outcome: "retryable", providerMessageId: null };
    }
    const code = raw?.code ?? "server_error";
    return {
      to: message.to,
      code,
      outcome: classifyOutcome(code),
      providerMessageId: raw?.providerMessageId ?? null
    };
  });
}
