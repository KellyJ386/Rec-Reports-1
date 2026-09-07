import test from "node:test";
import assert from "node:assert/strict";
import { sendEmail, noopAdapter, classifyOutcome, createResendAdapter } from "../src/lib/notifications/email.mjs";

test("classifyOutcome maps known provider codes to sent/retryable/permanent", () => {
  assert.equal(classifyOutcome("ok"), "sent");
  assert.equal(classifyOutcome("invalid_recipient"), "permanent");
  assert.equal(classifyOutcome("bounced"), "permanent");
  assert.equal(classifyOutcome("complained"), "permanent");
  assert.equal(classifyOutcome("rate_limited"), "retryable");
  assert.equal(classifyOutcome("server_error"), "retryable");
  assert.equal(classifyOutcome("timeout"), "retryable");
  assert.equal(classifyOutcome("unavailable"), "retryable");
});

test("classifyOutcome defaults an unrecognized code to retryable, not permanent", () => {
  assert.equal(classifyOutcome("some_future_provider_error"), "retryable");
  assert.equal(classifyOutcome(undefined), "retryable");
});

test("noopAdapter reports a message accepted with no network call", async () => {
  const result = await noopAdapter.send({ to: "a@example.com" });
  assert.deepEqual(result, { to: "a@example.com", code: "ok" });
});

test("sendEmail with no adapter configured (the default) marks every message sent", async () => {
  const results = await sendEmail({
    messages: [
      { to: "a@example.com", subject: "Hi", text: "There" },
      { to: "b@example.com", subject: "Hi", text: "There" }
    ]
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.outcome === "sent" && r.code === "ok"));
  assert.deepEqual(results.map((r) => r.to).sort(), ["a@example.com", "b@example.com"]);
});

test("sendEmail returns [] for an empty/absent message list without calling the adapter", async () => {
  let called = false;
  const adapter = { send: async () => { called = true; return { code: "ok" }; } };
  assert.deepEqual(await sendEmail({ messages: [] }, { adapter }), []);
  assert.deepEqual(await sendEmail({}, { adapter }), []);
  assert.equal(called, false);
});

test("sendEmail drops a message with no non-empty `to` before calling the adapter", async () => {
  const captured = [];
  const adapter = {
    send: async (message) => {
      captured.push(message.to);
      return { code: "ok" };
    }
  };
  const results = await sendEmail({ messages: [{ to: "" }, { subject: "no to field" }, { to: "ok@example.com" }] }, { adapter });
  assert.deepEqual(captured, ["ok@example.com"]);
  assert.equal(results.length, 1);
});

test("sendEmail issues exactly one adapter.send call per message, never a batched call", async () => {
  const calls = [];
  const adapter = {
    send: async (message) => {
      calls.push(message);
      return { code: "ok" };
    }
  };
  await sendEmail({ messages: [{ to: "a@example.com" }, { to: "b@example.com" }, { to: "c@example.com" }] }, { adapter });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(typeof call.to, "string");
  }
});

test("sendEmail bounds concurrency: never more than `concurrency` adapter.send calls in flight at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter = {
    send: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { code: "ok" };
    }
  };
  const messages = Array.from({ length: 10 }, (_, i) => ({ to: `user${i}@example.com` }));
  const results = await sendEmail({ messages }, { adapter, concurrency: 3 });
  assert.equal(results.length, 10);
  assert.ok(maxInFlight <= 3, `expected at most 3 concurrent sends, saw ${maxInFlight}`);
  assert.ok(maxInFlight > 1, "expected some overlap, not fully serial");
});

test("sendEmail preserves input order in its results regardless of completion order", async () => {
  const adapter = {
    send: async ({ to }) => {
      // Reverse-order completion: the first message finishes last.
      const delay = to === "a@example.com" ? 15 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { code: "ok" };
    }
  };
  const results = await sendEmail(
    { messages: [{ to: "a@example.com" }, { to: "b@example.com" }, { to: "c@example.com" }] },
    { adapter, concurrency: 3 }
  );
  assert.deepEqual(results.map((r) => r.to), ["a@example.com", "b@example.com", "c@example.com"]);
});

test("sendEmail classifies a mixed adapter response into sent/retryable/permanent outcomes", async () => {
  const codes = { "ok@example.com": "ok", "retry@example.com": "rate_limited", "dead@example.com": "invalid_recipient" };
  const adapter = { send: async ({ to }) => ({ code: codes[to] }) };
  const results = await sendEmail(
    { messages: [{ to: "ok@example.com" }, { to: "retry@example.com" }, { to: "dead@example.com" }] },
    { adapter }
  );
  const byTo = Object.fromEntries(results.map((r) => [r.to, r]));
  assert.equal(byTo["ok@example.com"].outcome, "sent");
  assert.equal(byTo["retry@example.com"].outcome, "retryable");
  assert.equal(byTo["dead@example.com"].outcome, "permanent");
});

test("sendEmail passes providerMessageId through from the adapter", async () => {
  const adapter = { send: async () => ({ code: "ok", providerMessageId: "resend-msg-1" }) };
  const results = await sendEmail({ messages: [{ to: "a@example.com" }] }, { adapter });
  assert.equal(results[0].providerMessageId, "resend-msg-1");
});

test("sendEmail defaults providerMessageId to null when the adapter doesn't report one", async () => {
  const adapter = { send: async () => ({ code: "ok" }) };
  const results = await sendEmail({ messages: [{ to: "a@example.com" }] }, { adapter });
  assert.equal(results[0].providerMessageId, null);
});

test("sendEmail never throws for a single recipient's adapter failure -- it is recorded as retryable", async () => {
  const adapter = {
    send: async ({ to }) => {
      if (to === "boom@example.com") throw new Error("adapter blew up");
      return { code: "ok" };
    }
  };
  const results = await sendEmail(
    { messages: [{ to: "boom@example.com" }, { to: "fine@example.com" }] },
    { adapter }
  );
  const byTo = Object.fromEntries(results.map((r) => [r.to, r]));
  assert.equal(byTo["boom@example.com"].outcome, "retryable");
  assert.equal(byTo["boom@example.com"].code, "server_error");
  assert.equal(byTo["fine@example.com"].outcome, "sent");
});

test("sendEmail passes fetchImpl through to the adapter untouched", async () => {
  let seen = null;
  const fakeFetch = async () => {};
  const adapter = {
    send: async (args) => {
      seen = args;
      return { code: "ok" };
    }
  };
  await sendEmail(
    { messages: [{ to: "a@example.com", subject: "Hi", text: "There", html: "<p>There</p>" }] },
    { adapter, fetchImpl: fakeFetch }
  );
  assert.equal(seen.to, "a@example.com");
  assert.equal(seen.subject, "Hi");
  assert.equal(seen.text, "There");
  assert.equal(seen.html, "<p>There</p>");
  assert.equal(seen.fetchImpl, fakeFetch);
});

// --- createResendAdapter -----------------------------------------------

function fakeFetchWith(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

test("createResendAdapter requires apiKey and from", () => {
  assert.throws(() => createResendAdapter({ from: "a@example.com" }), /apiKey/);
  assert.throws(() => createResendAdapter({ apiKey: "key" }), /from/);
});

test("createResendAdapter posts one POST https://api.resend.com/emails per message with Authorization: Bearer", async () => {
  const { fetchImpl, calls } = fakeFetchWith(200, { id: "resend-id-1" });
  const adapter = createResendAdapter({ apiKey: "test-key", from: "noreply@example.com", fetchImpl });
  const result = await adapter.send({ to: "a@example.com", subject: "Hi", text: "There", html: "<p>There</p>" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ["a@example.com"]);
  assert.equal(body.from, "noreply@example.com");
  assert.equal(body.subject, "Hi");
  assert.equal(body.text, "There");
  assert.equal(body.html, "<p>There</p>");

  assert.equal(result.code, "ok");
  assert.equal(result.providerMessageId, "resend-id-1");
});

test("createResendAdapter maps a 2xx response to ok with the provider's message id", async () => {
  const { fetchImpl } = fakeFetchWith(200, { id: "resend-id-2" });
  const adapter = createResendAdapter({ apiKey: "k", from: "f@example.com", fetchImpl });
  const result = await adapter.send({ to: "a@example.com" });
  assert.equal(result.code, "ok");
  assert.equal(result.providerMessageId, "resend-id-2");
});

test("createResendAdapter maps 422 to invalid_recipient (a permanent, per-message failure)", async () => {
  const { fetchImpl } = fakeFetchWith(422, { message: "invalid `to` field" });
  const adapter = createResendAdapter({ apiKey: "k", from: "f@example.com", fetchImpl });
  const result = await adapter.send({ to: "not-an-email" });
  assert.equal(result.code, "invalid_recipient");
});

test("createResendAdapter maps 429 to rate_limited", async () => {
  const { fetchImpl } = fakeFetchWith(429, { message: "rate limited" });
  const adapter = createResendAdapter({ apiKey: "k", from: "f@example.com", fetchImpl });
  const result = await adapter.send({ to: "a@example.com" });
  assert.equal(result.code, "rate_limited");
});

test("createResendAdapter maps 5xx to server_error", async () => {
  const { fetchImpl } = fakeFetchWith(500, { message: "internal error" });
  const adapter = createResendAdapter({ apiKey: "k", from: "f@example.com", fetchImpl });
  const result = await adapter.send({ to: "a@example.com" });
  assert.equal(result.code, "server_error");
});

test("createResendAdapter maps a rejecting/hanging fetchImpl to timeout", async () => {
  const adapter = createResendAdapter({
    apiKey: "k",
    from: "f@example.com",
    fetchImpl: async () => {
      throw new Error("network error");
    }
  });
  const result = await adapter.send({ to: "a@example.com" });
  assert.equal(result.code, "timeout");
});

test("createResendAdapter's own request is bounded by timeoutMs even if fetchImpl ignores the abort signal", async () => {
  const adapter = createResendAdapter({
    apiKey: "k",
    from: "f@example.com",
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}) // never resolves, ignores signal
  });
  const start = Date.now();
  const result = await adapter.send({ to: "a@example.com" });
  assert.equal(result.code, "timeout");
  assert.ok(Date.now() - start < 2000, "expected the timeout to bound the call well under a hardcoded 2s budget");
});

test("createResendAdapter's per-send fetchImpl override takes precedence over the constructor default", async () => {
  const { fetchImpl: constructorFetch } = fakeFetchWith(200, { id: "should-not-be-used" });
  const { fetchImpl: perCallFetch, calls } = fakeFetchWith(200, { id: "resend-id-override" });
  const adapter = createResendAdapter({ apiKey: "k", from: "f@example.com", fetchImpl: constructorFetch });
  const result = await adapter.send({ to: "a@example.com", fetchImpl: perCallFetch });
  assert.equal(calls.length, 1);
  assert.equal(result.providerMessageId, "resend-id-override");
});
