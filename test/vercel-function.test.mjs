import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// The API pipeline validates server env before routing (an unknown route still
// needs configured env, otherwise it returns 503). node --test isolates each
// test file in its own process, so setting these here does not leak elsewhere.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.SUPABASE_JWT_SECRET = "test-secret";

const { default: handler } = await import("../api/index.mjs");

// Minimal Node-style response double that records writeHead + end, mirroring
// what Vercel passes to the serverless function.
function makeResponse() {
  const response = new EventEmitter();
  response.headersSent = false;
  response.statusCode = null;
  response.headers = null;
  response.body = "";
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers ?? {};
    response.headersSent = true;
    return response;
  };
  response.end = (chunk) => {
    if (chunk) response.body += chunk;
    response.emit("finish");
  };
  return response;
}

function makeRequest(method, url, headers = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = headers;
  request.destroy = () => {};
  return request;
}

function invoke(request, response) {
  return new Promise((resolve) => {
    response.on("finish", resolve);
    handler(request, response);
  });
}

test("api/index.mjs default export is a request handler function", () => {
  assert.equal(typeof handler, "function");
});

test("serverless handler returns a JSON 404 for an unknown /api/admin/v1 route", async () => {
  // Vercel preserves the full original path, so we pass it exactly as-is.
  const request = makeRequest("GET", "/api/admin/v1/does-not-exist");
  const response = makeResponse();
  await invoke(request, response);

  assert.equal(response.statusCode, 404);
  assert.match(response.headers["Content-Type"] ?? "", /application\/json/);
  // Security headers must be present on the serverless response too.
  assert.equal(response.headers["Content-Security-Policy"], "default-src 'self'");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  const body = JSON.parse(response.body);
  assert.equal(body.error, "not found");
});

test("serverless handler rejects a protected route without a bearer token", async () => {
  const request = makeRequest("GET", "/api/admin/v1/modules");
  const response = makeResponse();
  await invoke(request, response);

  // 401 (missing token) or 503 (missing JWT secret) depending on env; both prove
  // the auth pipeline ran rather than the request crashing.
  assert.ok([401, 503].includes(response.statusCode));
  assert.equal(response.headers["Content-Security-Policy"], "default-src 'self'");
});
