import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAuthRoutes } from "../src/lib/http/auth-routes.mjs";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key"
};

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : null });
    const { ok = true, status = 200, data = {} } = respond(url, init) ?? {};
    return { ok, status, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ env = ENV } = {}) {
  const router = createRouter();
  const sent = [];
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerAuthRoutes(router, { sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("sign-in requires email and password (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("sign-in forwards to GoTrue password grant and returns the session", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: {
      access_token: "jwt-123",
      refresh_token: "refresh-123",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: "user-1", email: "a@b.com", extra: "ignored" }
    }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "secret" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.access_token, "jwt-123");
  assert.equal(result.payload.refresh_token, "refresh-123");
  assert.deepEqual(result.payload.user, { id: "user-1", email: "a@b.com" });
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(gotrueCall.init.headers.apikey, "anon-key");
  assert.deepEqual(gotrueCall.body, { email: "a@b.com", password: "secret" });
});

test("sign-in maps a GoTrue rejection to 401", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 400, data: { error: "invalid_grant" } }));
  const { call } = mount();
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "wrong" });
  assert.equal(result.status, 401);
});

test("sign-in returns 503 when Supabase is not configured", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount({ env: {} });
  const result = await call("POST", "/auth/sign-in", { email: "a@b.com", password: "secret" });
  assert.equal(result.status, 503);
  assert.equal(captured.length, 0);
});

test("refresh requires a refresh_token (400)", async (t) => {
  const captured = stubFetch(t, () => ({}));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("refresh forwards to GoTrue refresh grant and returns the session", async (t) => {
  const captured = stubFetch(t, () => ({
    ok: true,
    data: { access_token: "jwt-new", refresh_token: "refresh-new", expires_in: 3600 }
  }));
  const { call } = mount();
  const result = await call("POST", "/auth/refresh", { refresh_token: "refresh-123" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.access_token, "jwt-new");
  const gotrueCall = captured[0];
  assert.match(gotrueCall.url.href, /\/auth\/v1\/token\?grant_type=refresh_token$/);
  assert.deepEqual(gotrueCall.body, { refresh_token: "refresh-123" });
});
