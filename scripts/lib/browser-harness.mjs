// Shared scaffolding behind every on-demand Playwright script in this repo
// (scripts/a11y-check.mjs, scripts/pilot-journey.mjs): resolving a
// pre-installed Playwright without adding it as a project dependency,
// finding a free port, building the user-facing app to a temp dir, spawning
// scripts/server.mjs against that build with the same placeholder Supabase
// credentials CI's smoke-test job uses, and polling until it's ready to
// accept requests. Extracted out of a11y-check.mjs (P-7) rather than
// duplicated so the two scripts' build/serve/port plumbing can never drift
// out of sync with each other.

import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
// This file lives at scripts/lib/browser-harness.mjs -- two levels below
// the repo root.
export const repoRoot = new URL("../..", import.meta.url).pathname;

// --- Locate Playwright without adding it as a project dependency -----------
// Tries, in order: a normal resolution (in case a caller's own environment
// happens to have it on the module path already), then npm's global
// node_modules (`npm root -g` -- where a "pre-installed" Playwright, per
// this task's own instructions, is expected to live), then a couple of
// common fallback locations. Throws a clear, actionable error rather than a
// bare MODULE_NOT_FOUND if none of them have it.
export function loadPlaywright() {
  const candidates = [];
  try {
    candidates.push(spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim());
  } catch {
    // npm not on PATH -- fall through to the other candidates.
  }
  candidates.push("/opt/node22/lib/node_modules", "/usr/lib/node_modules", "/usr/local/lib/node_modules");

  // Global locations are tried BEFORE a plain (path-less) resolution: a
  // plain require.resolve("playwright") walks up from this file looking for
  // a node_modules in an ancestor directory, which can land on an unrelated
  // copy that happens to sit above the repo checkout (e.g. a scratch
  // directory's own node_modules) whose bundled Chromium revision does not
  // match what's actually unpacked at PLAYWRIGHT_BROWSERS_PATH -- the global
  // install this task's own instructions point at is the one guaranteed to
  // match.
  const attempts = [...candidates.filter(Boolean), null];
  const attemptErrors = [];
  for (const base of attempts) {
    try {
      const resolved = base ? require.resolve("playwright", { paths: [base] }) : require.resolve("playwright");
      return { module: require(resolved), resolvedFrom: resolved };
    } catch (error) {
      attemptErrors.push(`${base || "(plain resolution)"}: ${error.message}`);
    }
  }
  throw new Error(
    "Could not resolve the 'playwright' package from any known location. This script expects Playwright to be " +
      `pre-installed in the runtime environment -- see this function's own header comment.\nTried:\n${attemptErrors.join("\n")}`
  );
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Builds the user-facing app (scripts/build.mjs) into a fresh temp
// directory, named with `prefix` so a script's own temp dirs are
// identifiable in `mkdtemp`'s parent (a11y-check.mjs uses
// "rr-a11y-check-", pilot-journey.mjs "rr-pilot-journey-"). Throws with the
// build's own stdout/stderr on a non-zero exit rather than leaving the
// caller to guess why nothing got built.
export function buildToTempDir(prefix) {
  const buildDir = mkdtempSync(join(tmpdir(), prefix));
  const result = spawnSync(process.execPath, ["scripts/build.mjs", buildDir], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`npm run build failed:\n${result.stdout}\n${result.stderr}`);
  }
  return buildDir;
}

export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export async function waitForServer(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/public-config`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

// Spawns `node scripts/server.mjs <buildDir>` against `port`, with the same
// placeholder SUPABASE_URL/SUPABASE_ANON_KEY CI's smoke-test job and
// test/build-user-app.test.mjs use (a real backend is never reached -- every
// authenticated request is answered by the caller's own page.route()
// mocks). Captures combined stdout/stderr into the returned `getOutput()` so
// a caller can print it on failure without wiring up its own listeners.
export function startBuiltAppServer({ buildDir, port, extraEnv = {} }) {
  const server = spawn(process.execPath, ["scripts/server.mjs", buildDir], {
    cwd: repoRoot,
    env: { ...process.env, SUPABASE_URL: "https://example.invalid", SUPABASE_ANON_KEY: "x", PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  return { server, getOutput: () => output };
}
