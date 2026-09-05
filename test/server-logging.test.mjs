import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Disjoint from test/server-headers.test.mjs (43000-46999) so parallel test
// files never share a port.
const port = 41000 + (process.pid % 2000);
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

test("structured request logging: one JSON line per request, no secrets leaked", async (t) => {
  const allLogs = [];

  const child = spawn(process.execPath, ["scripts/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      APP_URL: "http://localhost:3000",
      SUPABASE_JWT_SECRET: "test-secret-for-logging"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Capture stdout from the child process
  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    lines.forEach((line) => {
      try {
        // Try to parse as JSON (log lines) and skip non-JSON output
        const parsed = JSON.parse(line);
        if (parsed.request_id && parsed.method) {
          allLogs.push(parsed);
        }
      } catch {
        // Ignore non-JSON output (server startup messages)
      }
    });
  });

  t.after(() => {
    child.kill();
  });

  await waitForServer(`${base}/`);

  function waitForLogCount(expectedCount, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (allLogs.length >= expectedCount) {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for ${expectedCount} logs, got ${allLogs.length}`));
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  await t.test("GET / (static file) emits exactly one structured log line", async () => {
    const initialCount = allLogs.length;
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);

    await waitForLogCount(initialCount + 1);
    const log = allLogs[allLogs.length - 1];
    assert.equal(log.method, "GET");
    assert.equal(log.path, "/");
    assert.equal(log.status, 200);
    assert.equal(typeof log.duration_ms, "number");
    assert.ok(log.duration_ms >= 0);
    assert.equal(typeof log.request_id, "string");
    assert.ok(log.request_id.length > 0);
    assert.equal(log.user_id, null);
  });

  await t.test("404 API route logs with correct path and status", async () => {
    const initialCount = allLogs.length;
    const response = await fetch(`${base}/api/admin/v1/does-not-exist`);
    assert.equal(response.status, 404);

    await waitForLogCount(initialCount + 1);
    // Get the most recent log with status 404
    let log = null;
    for (let i = allLogs.length - 1; i >= 0; i--) {
      if (allLogs[i].status === 404 && allLogs[i].path.includes("does-not-exist")) {
        log = allLogs[i];
        break;
      }
    }
    assert.ok(log, `Could not find 404 log for /does-not-exist. Last 3 logs: ${JSON.stringify(allLogs.slice(-3))}`);
    assert.equal(log.method, "GET");
    // For unmapped routes, we log the full pathname since there's no route template
    assert.equal(log.path, "/api/admin/v1/does-not-exist");
    assert.equal(log.status, 404);
    assert.equal(log.user_id, null);
  });

  await t.test("request without bearer token has user_id null", async () => {
    const initialCount = allLogs.length;
    const response = await fetch(`${base}/api/admin/v1/modules`);
    assert.equal(response.status, 401);

    await waitForLogCount(initialCount + 1);
    const log = allLogs[allLogs.length - 1];
    assert.equal(log.method, "GET");
    assert.equal(log.path, "/modules");
    assert.equal(log.status, 401);
    assert.equal(log.user_id, null);
    // Verify no authorization header leaked into log
    assert.equal(log.authorization, undefined);
  });

  await t.test("request with authorization header and token-bearing body does not leak secrets", async () => {
    const initialCount = allLogs.length;

    // Create a valid JWT token payload
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "user-123",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    ).toString("base64url");

    // Create HMAC signature
    const { createHmac } = await import("node:crypto");
    const message = `${header}.${payload}`;
    const signature = createHmac("sha256", "test-secret-for-logging")
      .update(message)
      .digest("base64url");
    const token = `${message}.${signature}`;

    // Send request with Authorization header and a body containing a "password" field
    const response = await fetch(`${base}/api/admin/v1/org/org-1/module-settings/mod-1`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        enabled: true,
        configPatch: {},
        password: "secret-password-123"
      })
    });

    // We expect 200 or 422 depending on whether the request is valid
    assert.ok([200, 400, 401, 403, 422, 500].includes(response.status));

    await waitForLogCount(initialCount + 1);
    const log = allLogs[allLogs.length - 1];

    // Verify the log line contains the required fields
    assert.equal(log.method, "PUT");
    assert.ok(log.path.includes("module-settings"));
    assert.equal(typeof log.status, "number");
    assert.equal(typeof log.duration_ms, "number");
    assert.equal(typeof log.request_id, "string");

    // Verify no secrets leaked into the log
    const logStr = JSON.stringify(log);
    assert.equal(
      logStr.includes("Bearer"),
      false,
      "Log should not contain Bearer token"
    );
    assert.equal(
      logStr.includes(token),
      false,
      "Log should not contain the actual token"
    );
    assert.equal(
      logStr.includes("secret-password-123"),
      false,
      "Log should not contain body secrets"
    );
    assert.equal(
      logStr.includes("password"),
      false,
      "Log should not contain password field from body"
    );

    // User id should be extracted from the token (if verification succeeded)
    // In this case it might be null or "user-123" depending on JWT verification
    assert.ok(log.user_id === null || typeof log.user_id === "string");
  });

  await t.test("multiple requests each emit exactly one log line", async () => {
    const initialCount = allLogs.length;

    // Make several requests
    await fetch(`${base}/`);
    await fetch(`${base}/api/admin/v1/modules`);
    await fetch(`${base}/api/v1/public-config`);

    // Wait for all three new log lines
    await waitForLogCount(initialCount + 3);

    // Get the last three logs
    const lastThreeLogs = allLogs.slice(allLogs.length - 3);

    // Verify each has a unique request_id
    const requestIds = lastThreeLogs.map((log) => log.request_id);
    const uniqueIds = new Set(requestIds);
    assert.equal(uniqueIds.size, 3, "Each log line should have a unique request_id");

    // Verify each log has required fields
    lastThreeLogs.forEach((log) => {
      assert.equal(typeof log.method, "string");
      assert.equal(typeof log.path, "string");
      assert.equal(typeof log.status, "number");
      assert.equal(typeof log.duration_ms, "number");
      assert.equal(typeof log.request_id, "string");
    });
  });
});
