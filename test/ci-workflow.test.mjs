import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// P-13: proves the smoke-in-CI steps exist, run in the right order relative
// to the build step, and always stop the background server -- by reading
// .github/workflows/ci.yml as plain text, the same approach
// test/vercel-config.test.mjs uses for vercel.json/server.mjs, rather than
// pulling in a YAML parser (this repo stays dependency-free).
function loadCiWorkflowText() {
  return readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
}

function indexOfOrFail(text, needle, label) {
  const index = text.indexOf(needle);
  assert.ok(index !== -1, `expected to find ${label} (looked for: ${JSON.stringify(needle)})`);
  return index;
}

test("ci.yml starts the smoke server, waits for it, runs smoke, and stops it -- in that order after the build step", () => {
  const text = loadCiWorkflowText();

  const buildIndex = indexOfOrFail(text, "run: npm run build", "the `npm run build` step");
  const startIndex = indexOfOrFail(text, "name: Start server for smoke tests", "the start-server step");
  const waitIndex = indexOfOrFail(text, "name: Wait for smoke server to become ready", "the wait-for-ready step");
  const smokeIndex = indexOfOrFail(text, "name: Run smoke tests", "the run-smoke-tests step");
  const stopIndex = indexOfOrFail(text, "name: Stop smoke test server", "the stop-server step");
  const dbVerifyIndex = indexOfOrFail(text, "run: npm run db:verify", "the `npm run db:verify` step");

  assert.ok(
    buildIndex < startIndex &&
      startIndex < waitIndex &&
      waitIndex < smokeIndex &&
      smokeIndex < stopIndex &&
      stopIndex < dbVerifyIndex,
    "expected order: build -> start server -> wait for ready -> run smoke -> stop server -> db:verify"
  );
});

test("the start-server step boots scripts/server.mjs against dist with fake Supabase credentials and a fixed port", () => {
  const text = loadCiWorkflowText();
  const startIndex = text.indexOf("name: Start server for smoke tests");
  const nextStepIndex = text.indexOf("name: Wait for smoke server to become ready");
  const stepBody = text.slice(startIndex, nextStepIndex);

  assert.match(stepBody, /node scripts\/server\.mjs dist/, "expected the step to run scripts/server.mjs against the dist/ build");
  assert.match(stepBody, /SUPABASE_URL=https:\/\/example\.invalid/, "expected a fake, non-resolvable SUPABASE_URL");
  assert.match(stepBody, /SUPABASE_ANON_KEY=x/, "expected a placeholder SUPABASE_ANON_KEY");
  assert.match(stepBody, /PORT=8000/, "expected a fixed PORT so the wait/smoke steps know where to look");
  assert.match(stepBody, /&\s*$/m, "expected the server to be started in the background (trailing &)");
});

test("the wait-for-ready step polls GET /api/v1/public-config with a bounded loop and fails with the server log on timeout", () => {
  const text = loadCiWorkflowText();
  const waitIndex = text.indexOf("name: Wait for smoke server to become ready");
  const nextStepIndex = text.indexOf("name: Run smoke tests");
  const stepBody = text.slice(waitIndex, nextStepIndex);

  assert.match(stepBody, /localhost:8000\/api\/v1\/public-config/, "expected the loop to poll public-config on the fixed port");
  assert.match(stepBody, /for i in .*30/, "expected a bounded loop (~30 iterations)");
  assert.match(stepBody, /exit 1/, "expected the step to fail (non-zero exit) when the server never becomes ready");
  assert.match(stepBody, /cat server-smoke\.log/, "expected the server log to be printed before failing");
});

test("the run-smoke-tests step targets the local server and runs `npm run smoke`", () => {
  const text = loadCiWorkflowText();
  const smokeIndex = text.indexOf("name: Run smoke tests");
  const nextStepIndex = text.indexOf("name: Stop smoke test server");
  const stepBody = text.slice(smokeIndex, nextStepIndex);

  assert.match(stepBody, /SMOKE_BASE_URL:\s*http:\/\/localhost:8000/, "expected SMOKE_BASE_URL pointed at the local smoke server");
  assert.match(stepBody, /run:\s*npm run smoke/, "expected the step to invoke `npm run smoke`");
});

test("the stop-server step is unconditional (if: always()) so it runs even when an earlier step failed", () => {
  const text = loadCiWorkflowText();
  const stopIndex = text.indexOf("name: Stop smoke test server");
  assert.ok(stopIndex !== -1, "expected a stop-server step");
  // The `if:` line for a step must appear between this step's `name:` line
  // and its own `run:` block, not borrowed from some other step.
  const runIndex = text.indexOf("run:", stopIndex);
  const stepHeader = text.slice(stopIndex, runIndex);
  assert.match(stepHeader, /if:\s*always\(\)/, "expected `if: always()` directly on the stop-server step");
});

test("the CI job still runs db:verify and db:verify:seed after the smoke steps, and the db-step order is otherwise unchanged", () => {
  const text = loadCiWorkflowText();
  const stopIndex = indexOfOrFail(text, "name: Stop smoke test server", "the stop-server step");
  const dbVerifyIndex = indexOfOrFail(text, "run: npm run db:verify\n", "the `npm run db:verify` step");
  const dbVerifySeedIndex = indexOfOrFail(text, "run: npm run db:verify:seed", "the `npm run db:verify:seed` step");
  const rlsBootstrapIndex = indexOfOrFail(
    text,
    "Bootstrap Supabase-style auth schema/role",
    "the RLS bootstrap step"
  );

  assert.ok(stopIndex < dbVerifyIndex, "expected db:verify to run after the smoke server is stopped");
  assert.ok(dbVerifyIndex < dbVerifySeedIndex, "expected db:verify before db:verify:seed, unchanged from before");
  assert.ok(dbVerifySeedIndex < rlsBootstrapIndex, "expected db:verify:seed before the RLS bootstrap step, unchanged from before");
});
