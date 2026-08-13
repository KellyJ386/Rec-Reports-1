import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";

const port = 41000 + (process.pid % 4000);
const base = `http://localhost:${port}`;

function waitForServer(url, attempts = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      fetch(url)
        .then(resolve)
        .catch((error) => {
          if (remaining <= 0) return reject(error);
          setTimeout(() => attempt(remaining - 1), 100);
        });
    };
    attempt(attempts);
  });
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
}

test("hardened server: security headers, 404s, JSON API 404, and stream resilience", async (t) => {
  const child = spawn(process.execPath, ["scripts/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      APP_URL: "http://localhost:3000",
      SUPABASE_JWT_SECRET: "test-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => {
    child.kill();
  });

  await waitForServer(`${base}/`);

  await t.test("GET / serves the static index with security headers", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html");
    assertSecurityHeaders(response);
  });

  await t.test("unknown static path 404s cleanly with security headers", async () => {
    const response = await fetch(`${base}/no-such-page`);
    assert.equal(response.status, 404);
    assertSecurityHeaders(response);
  });

  await t.test("unknown /api route returns a JSON 404", async () => {
    const response = await fetch(`${base}/api/admin/v1/does-not-exist`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assertSecurityHeaders(response);
    const body = await response.json();
    assert.equal(body.error, "not found");
  });

  await t.test("GET /api/admin/v1/modules without a bearer token is rejected, not crashed", async () => {
    const response = await fetch(`${base}/api/admin/v1/modules`);
    assert.equal(response.status, 401);
    assertSecurityHeaders(response);
  });

  await t.test("PUT with a malformed JSON body 400s instead of crashing", async () => {
    const response = await fetch(`${base}/api/admin/v1/org/org-1/module-settings/mod-1`, {
      method: "PUT",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: "{not-json"
    });
    assert.ok([400, 401].includes(response.status));
    assertSecurityHeaders(response);
  });

  await t.test("a client that aborts mid-stream does not crash the server", async () => {
    await new Promise((resolve, reject) => {
      const socket = connect(port, "localhost", () => {
        socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });

    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
  });
});

test("server returns 503 JSON on API routes when required server env is missing", async (t) => {
  const badPort = port + 1;
  const child = spawn(process.execPath, ["scripts/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(badPort),
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      APP_URL: "http://localhost:3000",
      SUPABASE_JWT_SECRET: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => {
    child.kill();
  });

  await waitForServer(`http://localhost:${badPort}/`);

  const response = await fetch(`http://localhost:${badPort}/api/admin/v1/modules`);
  assert.equal(response.status, 503);
  assertSecurityHeaders(response);
  const body = await response.json();
  assert.match(body.error, /not configured/);
});
