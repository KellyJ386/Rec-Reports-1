import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function loadVercelConfig() {
  const raw = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  return JSON.parse(raw);
}

// Extract the literal key/value pairs out of the `securityHeaders` object in
// scripts/server.mjs by reading the source as text, so vercel.json cannot
// silently drift from the headers the Node server actually sends.
function loadServerSecurityHeaders() {
  const source = readFileSync(new URL("../scripts/server.mjs", import.meta.url), "utf8");
  const blockMatch = source.match(/const securityHeaders = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(blockMatch, "expected to find `securityHeaders` object literal in scripts/server.mjs");
  const body = blockMatch[1];
  const pairs = {};
  const pairPattern = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  let match;
  while ((match = pairPattern.exec(body)) !== null) {
    pairs[match[1]] = match[2];
  }
  return pairs;
}

function loadCronRoutePaths() {
  const source = readFileSync(new URL("../src/lib/http/internal-routes.mjs", import.meta.url), "utf8");
  const registerPattern = /router\.register\(\s*"(?:GET|POST)"\s*,\s*"([^"]+)"/g;
  const paths = new Set();
  let match;
  while ((match = registerPattern.exec(source)) !== null) {
    paths.add(match[1]);
  }
  return paths;
}

test("vercel.json defines a global headers entry for all routes", () => {
  const config = loadVercelConfig();
  assert.ok(Array.isArray(config.headers), "vercel.json must have a top-level `headers` array");
  const globalEntry = config.headers.find((entry) => entry.source === "/(.*)");
  assert.ok(globalEntry, "expected a headers entry with source \"/(.*)\"");
  assert.ok(Array.isArray(globalEntry.headers) && globalEntry.headers.length > 0);
});

test("vercel.json security headers match scripts/server.mjs securityHeaders exactly", () => {
  const config = loadVercelConfig();
  const globalEntry = config.headers.find((entry) => entry.source === "/(.*)");
  const configHeaders = Object.fromEntries(globalEntry.headers.map(({ key, value }) => [key, value]));
  const serverHeaders = loadServerSecurityHeaders();

  const expectedNames = [
    "Content-Security-Policy",
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Strict-Transport-Security"
  ];

  for (const name of expectedNames) {
    assert.ok(name in serverHeaders, `expected scripts/server.mjs securityHeaders to define ${name}`);
    assert.ok(name in configHeaders, `expected vercel.json headers to define ${name}`);
  }

  // Every header except CSP and HSTS must match the server's value
  // byte-for-byte.
  for (const name of expectedNames) {
    if (name === "Content-Security-Policy" || name === "Strict-Transport-Security") continue;
    assert.equal(
      configHeaders[name],
      serverHeaders[name],
      `${name} in vercel.json must match scripts/server.mjs`
    );
  }

  // HSTS: Vercel's edge already emits a two-year, includeSubDomains, preload
  // policy on its domains, and a configured header replaces it. vercel.json
  // therefore carries that stronger value rather than the server's one-year
  // one; the test only requires it to be at least as strong as the server's.
  const maxAge = (value) => Number((/max-age=(\d+)/.exec(value) ?? [])[1] ?? NaN);
  assert.ok(
    maxAge(configHeaders["Strict-Transport-Security"]) >= maxAge(serverHeaders["Strict-Transport-Security"]),
    "HSTS max-age in vercel.json must be at least the server's"
  );
  assert.match(configHeaders["Strict-Transport-Security"], /includeSubDomains/);

  // CSP: vercel.json is allowed to append frame-ancestors 'none' on top of
  // the server's directive(s), but must not drop or alter anything the
  // server sends.
  const serverDirectives = serverHeaders["Content-Security-Policy"]
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const configCsp = configHeaders["Content-Security-Policy"];
  for (const directive of serverDirectives) {
    assert.ok(
      configCsp.includes(directive),
      `expected vercel.json CSP to include server directive "${directive}"`
    );
  }
});

test("vercel.json CSP is locked down with default-src 'self' and frame-ancestors 'none'", () => {
  const config = loadVercelConfig();
  const globalEntry = config.headers.find((entry) => entry.source === "/(.*)");
  const csp = globalEntry.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  assert.ok(csp.includes("default-src 'self'"), "CSP must contain default-src 'self'");
  assert.ok(csp.includes("frame-ancestors 'none'"), "CSP must contain frame-ancestors 'none'");
});

test("vercel.json registers both internal cron routes as actual server routes", () => {
  const config = loadVercelConfig();
  assert.ok(Array.isArray(config.crons) && config.crons.length > 0);
  const registeredPaths = loadCronRoutePaths();

  for (const cron of config.crons) {
    assert.ok(typeof cron.path === "string" && cron.path.startsWith("/api/v1/internal/"));
    const internalPath = cron.path.replace(/^\/api\/v1/, "");
    assert.ok(
      registeredPaths.has(internalPath),
      `expected ${internalPath} to be registered in src/lib/http/internal-routes.mjs (found: ${[...registeredPaths].join(", ")})`
    );
  }
});

test("vercel.json rewrites still cover /admin and /signin", () => {
  const config = loadVercelConfig();
  assert.ok(Array.isArray(config.rewrites));
  const sources = config.rewrites.map((r) => r.source);
  assert.ok(sources.includes("/admin"), "expected a rewrite for /admin");
  assert.ok(sources.includes("/signin"), "expected a rewrite for /signin");

  const adminRewrite = config.rewrites.find((r) => r.source === "/admin");
  const signinRewrite = config.rewrites.find((r) => r.source === "/signin");
  assert.equal(adminRewrite.destination, "/admin/index.html");
  assert.equal(signinRewrite.destination, "/signin/index.html");
});
