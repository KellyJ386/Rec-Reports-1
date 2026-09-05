import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("typecheck script exits 0 and reports success", () => {
  const result = spawnSync(process.execPath, ["scripts/typecheck.mjs"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Type contract checks passed/);
});

// OP-05 (0042) moved has_permission to internal.has_permission(...). The
// scanner's hasPermissionPattern must keep matching the schema-qualified
// call form -- it is unanchored on the left (no `^` or word boundary before
// "has_permission"), so an "internal." prefix falls outside the match and
// does not break it. Extract the real regex literal straight out of
// scripts/typecheck.mjs (rather than re-typing it here) so this test fails
// the moment that literal changes in a way that stops matching.
test("typecheck's has_permission regex matches the internal.-qualified call form", () => {
  const source = readFileSync(new URL("../scripts/typecheck.mjs", import.meta.url), "utf8");
  const patternMatch = source.match(/const hasPermissionPattern = \/(.*)\/([a-z]*);/);
  assert.ok(patternMatch, "expected a hasPermissionPattern regex literal in scripts/typecheck.mjs");
  const hasPermissionPattern = new RegExp(patternMatch[1], patternMatch[2]);

  const sample = "select internal.has_permission(auth.uid(), facility_id, 'reports.read') as allowed;";
  hasPermissionPattern.lastIndex = 0;
  const match = hasPermissionPattern.exec(sample);
  assert.ok(match, "expected the regex to match an internal.-qualified has_permission call");
  assert.equal(match[1], "reports.read");
});
