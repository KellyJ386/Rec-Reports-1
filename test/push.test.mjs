import test from "node:test";
import assert from "node:assert/strict";
import { sendPush, noopAdapter, classifyOutcome } from "../src/lib/notifications/push.mjs";

test("classifyOutcome maps known provider codes to sent/retryable/permanent", () => {
  assert.equal(classifyOutcome("ok"), "sent");
  assert.equal(classifyOutcome("invalid_token"), "permanent");
  assert.equal(classifyOutcome("unregistered"), "permanent");
  assert.equal(classifyOutcome("not_registered"), "permanent");
  assert.equal(classifyOutcome("mismatched_sender"), "permanent");
  assert.equal(classifyOutcome("rate_limited"), "retryable");
  assert.equal(classifyOutcome("server_error"), "retryable");
  assert.equal(classifyOutcome("timeout"), "retryable");
  assert.equal(classifyOutcome("unavailable"), "retryable");
});

test("classifyOutcome defaults an unrecognized code to retryable, not permanent", () => {
  assert.equal(classifyOutcome("some_future_provider_error"), "retryable");
  assert.equal(classifyOutcome(undefined), "retryable");
});

test("noopAdapter reports every token accepted with no network call", async () => {
  const result = await noopAdapter.send({ tokens: ["tok-1", "tok-2"] });
  assert.deepEqual(result, [
    { token: "tok-1", code: "ok" },
    { token: "tok-2", code: "ok" }
  ]);
});

test("sendPush with no adapter configured (the CM-07 default) marks every token sent", async () => {
  const result = await sendPush({ tokens: ["tok-1", "tok-2"], title: "Hi", body: "There" });
  assert.deepEqual(result.sentTokens, ["tok-1", "tok-2"]);
  assert.deepEqual(result.retryableTokens, []);
  assert.deepEqual(result.revokeTokens, []);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.outcome === "sent"));
});

test("sendPush returns empty results for an empty token list without calling the adapter", async () => {
  let called = false;
  const adapter = { send: async () => { called = true; return []; } };
  const result = await sendPush({ tokens: [], title: "x", body: "y" }, { adapter });
  assert.deepEqual(result, { results: [], sentTokens: [], retryableTokens: [], revokeTokens: [] });
  assert.equal(called, false);
});

test("sendPush dedupes repeated tokens before calling the adapter", async () => {
  const captured = [];
  const adapter = {
    send: async ({ tokens }) => {
      captured.push(...tokens);
      return tokens.map((token) => ({ token, code: "ok" }));
    }
  };
  const result = await sendPush({ tokens: ["tok-1", "tok-1", "tok-2"] }, { adapter });
  assert.deepEqual(captured, ["tok-1", "tok-2"]);
  assert.deepEqual(result.sentTokens, ["tok-1", "tok-2"]);
});

test("sendPush classifies a mixed adapter response into sent/retryable/revoke buckets", async () => {
  const adapter = {
    send: async ({ tokens }) =>
      tokens.map((token, index) => {
        const codes = ["ok", "rate_limited", "unregistered"];
        return { token, code: codes[index] };
      })
  };
  const result = await sendPush({ tokens: ["tok-ok", "tok-retry", "tok-dead"] }, { adapter });
  assert.deepEqual(result.sentTokens, ["tok-ok"]);
  assert.deepEqual(result.retryableTokens, ["tok-retry"]);
  assert.deepEqual(result.revokeTokens, ["tok-dead"]);
});

test("sendPush treats a token missing from the adapter's response as a retryable server_error, not a silent drop", async () => {
  const adapter = { send: async () => [] }; // adapter forgot to report on the requested token
  const result = await sendPush({ tokens: ["tok-1"] }, { adapter });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].code, "server_error");
  assert.equal(result.results[0].outcome, "retryable");
  assert.deepEqual(result.retryableTokens, ["tok-1"]);
});

test("sendPush passes title/body/data and fetchImpl through to the adapter untouched", async () => {
  let seen = null;
  const fakeFetch = async () => {};
  const adapter = {
    send: async (args) => {
      seen = args;
      return args.tokens.map((token) => ({ token, code: "ok" }));
    }
  };
  await sendPush(
    { tokens: ["tok-1"], title: "Emergency", body: "Evacuate", data: { messageId: "msg-1" } },
    { adapter, fetchImpl: fakeFetch }
  );
  assert.equal(seen.title, "Emergency");
  assert.equal(seen.body, "Evacuate");
  assert.deepEqual(seen.data, { messageId: "msg-1" });
  assert.equal(seen.fetchImpl, fakeFetch);
});
