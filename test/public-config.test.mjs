import test from "node:test";
import assert from "node:assert/strict";
import { userRouter } from "../scripts/server.mjs";

// P-5: GET /api/v1/public-config's optional `firebaseWebConfig` field.
// Exercises the registered handler directly (same pattern as
// test/server-routes.test.mjs) rather than spawning a real server, since the
// route's whole job here is a pure function of `env`.
function call(env) {
  const { handler } = userRouter.match({ method: "GET", url: "/public-config" });
  assert.ok(handler, "expected GET /public-config to be registered on the end-user router");
  return new Promise((resolve) => {
    let statusCode = null;
    const response = {
      get headersSent() {
        return statusCode !== null;
      },
      writeHead(status) {
        statusCode = status;
      },
      end(body) {
        resolve({ status: statusCode, body: body ? JSON.parse(body) : null });
      }
    };
    handler({}, response, { env });
  });
}

const BASE_ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };

test("GET /public-config omits firebaseWebConfig when FIREBASE_WEB_CONFIG_JSON is unset", async () => {
  const result = await call(BASE_ENV);
  assert.equal(result.status, 200);
  assert.equal(result.body.supabaseUrl, BASE_ENV.SUPABASE_URL);
  assert.equal(result.body.supabaseAnonKey, BASE_ENV.SUPABASE_ANON_KEY);
  assert.equal("firebaseWebConfig" in result.body, false);
});

test("GET /public-config includes a parsed firebaseWebConfig when set to valid JSON", async () => {
  const firebaseConfig = {
    apiKey: "browser-key",
    authDomain: "example.firebaseapp.com",
    projectId: "example-proj",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abc123"
  };
  const result = await call({ ...BASE_ENV, FIREBASE_WEB_CONFIG_JSON: JSON.stringify(firebaseConfig) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.firebaseWebConfig, firebaseConfig);
});

test("GET /public-config omits firebaseWebConfig when FIREBASE_WEB_CONFIG_JSON is malformed JSON", async () => {
  const result = await call({ ...BASE_ENV, FIREBASE_WEB_CONFIG_JSON: "{not valid json" });
  assert.equal(result.status, 200);
  assert.equal("firebaseWebConfig" in result.body, false);
});

test("GET /public-config omits firebaseWebConfig when FIREBASE_WEB_CONFIG_JSON is a JSON array", async () => {
  const result = await call({ ...BASE_ENV, FIREBASE_WEB_CONFIG_JSON: "[1,2,3]" });
  assert.equal(result.status, 200);
  assert.equal("firebaseWebConfig" in result.body, false);
});
