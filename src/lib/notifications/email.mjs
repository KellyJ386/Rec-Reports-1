// Provider-agnostic email adapter interface (DR-22). Mirrors
// src/lib/notifications/push.mjs's shape exactly, one level simpler (email
// is a single send per message, not a fan-out over many device tokens):
//
//   - an adapter interface: `async send({ to, subject, text, fetchImpl }) ->
//     { code, providerMessageId }`, `code` being a provider-agnostic outcome
//     key (see PROVIDER_OUTCOMES below) rather than a raw provider error
//     string. A real provider adapter (Resend, SES, etc. -- the plan's
//     Slice 2C names Resend) would translate its own HTTP status/error body
//     into one of these keys and otherwise look exactly like `noopAdapter`
//     below, including accepting `fetchImpl` so it can be unit-tested
//     without a real network call.
//   - `noopAdapter`, the default: makes no network call, reports every send
//     as accepted ("ok"), and fabricates a stable providerMessageId from the
//     recipient + subject so a test can assert on it deterministically. This
//     is what lets DR-22 mark email deliveries 'sent' today without a
//     configured EMAIL_API_KEY/EMAIL_FROM (neither exists in this branch --
//     Slice 2C's email worker has not landed here yet, see the DR-22 final
//     report), while keeping the exact call shape a real adapter will need
//     to fill in.
//   - `classifyOutcome`/`sendEmail`: the provider-agnostic mapping from a
//     `code` to one of three outcomes the drain consumer
//     (src/lib/report-distribution.mjs) acts on:
//       "sent"      -- delivered (or, for the stub, accepted) successfully.
//       "retryable" -- transient provider-side failure (rate limit, 5xx,
//                      timeout); worth a bounded retry on a later drain pass.
//       "permanent" -- the provider rejected the address itself (hard
//                      bounce, invalid address); retrying will never help,
//                      so the delivery row is marked 'bounced', not 'failed'.
//
// sendEmail() never throws on a provider-reported failure (that is normal,
// expected traffic for an email channel with any real-world deliverability
// variance) -- only a broken adapter call itself (a rejected promise from
// adapter.send) propagates as a thrown error, same as sendPush.

const PROVIDER_OUTCOMES = {
  ok: "sent",
  invalid_recipient: "permanent",
  hard_bounce: "permanent",
  suppressed: "permanent",
  rate_limited: "retryable",
  server_error: "retryable",
  timeout: "retryable",
  unavailable: "retryable"
};

// Maps a provider-agnostic outcome code to "sent" | "retryable" | "permanent".
// An unrecognized code defaults to retryable, same rationale as push.mjs's
// classifyOutcome: an adapter reporting an unfamiliar code is far more
// likely a new transient failure mode than grounds to permanently bounce a
// recipient.
export function classifyOutcome(code) {
  return PROVIDER_OUTCOMES[code] ?? "retryable";
}

export const noopAdapter = {
  async send({ to, subject } = {}) {
    return { code: "ok", providerMessageId: `noop-${to ?? "unknown"}-${(subject ?? "").length}-${Date.now()}` };
  }
};

// sendEmail({to, subject, text}, {adapter, fetchImpl}) -- the drain
// consumer's entry point for a channel='email' delivery. Normalizes the
// adapter's result through classifyOutcome so a caller never has to know a
// specific provider's raw `code` vocabulary.
//
// Returns { outcome, code, providerMessageId }.
export async function sendEmail({ to, subject, text } = {}, { adapter = noopAdapter, fetchImpl } = {}) {
  const result = (await adapter.send({ to, subject, text, fetchImpl })) ?? {};
  const code = result.code ?? "server_error";
  return {
    outcome: classifyOutcome(code),
    code,
    providerMessageId: result.providerMessageId ?? null
  };
}
