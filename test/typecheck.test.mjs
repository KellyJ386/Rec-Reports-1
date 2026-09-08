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

  // DR-21 (0054): also matches the InitPlan-caching `(select auth.uid())`
  // wrapper 0049's own header made the go-forward convention for every new
  // policy from 0050 onward -- the bare form above must keep matching too
  // (older policies still use it), so this is additive, not a replacement.
  const wrappedSample = "internal.has_permission((select auth.uid()), facility_id, 'reports.distribution.manage')";
  hasPermissionPattern.lastIndex = 0;
  const wrappedMatch = hasPermissionPattern.exec(wrappedSample);
  assert.ok(wrappedMatch, "expected the regex to match a (select auth.uid())-wrapped has_permission call");
  assert.equal(wrappedMatch[1], "reports.distribution.manage");
});

// Slice 1C, S-5: exactly the two codes documented as BFF-only (no DB write
// of their own, or reserved for a future DR-18/DR-20 route) may skip the
// "appears in a has_permission(...) literal" coverage rule.
// reports.distribution.manage graduated out of this set in 0054 (DR-21): it
// now has its own has_permission(...) literal in report_distribution_lists'
// RLS policy, so it is covered like every other RLS-wired code instead of
// being listed here.
test("bffOnlyPermissionCodes lists exactly the two documented BFF-only codes", () => {
  const source = readFileSync(new URL("../scripts/typecheck.mjs", import.meta.url), "utf8");
  const listMatch = source.match(/const bffOnlyPermissionCodes = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(listMatch, "expected a bffOnlyPermissionCodes Set literal in scripts/typecheck.mjs");
  const codes = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(codes), new Set(["incidents.export.pdf", "reports.workflow.manage"]));
});

// The coverage rule's own scanner (anyHasPermissionPattern) must match both
// the internal.-qualified form (0042) and the 4-arg department-scoped
// overload (0023), not just the bare 3-arg form hasPermissionPattern above
// matches.
test("typecheck's any-has_permission regex matches internal.-qualified and 4-arg calls", () => {
  const source = readFileSync(new URL("../scripts/typecheck.mjs", import.meta.url), "utf8");
  const patternMatch = source.match(/const anyHasPermissionPattern = \/(.*)\/([a-z]*);/);
  assert.ok(patternMatch, "expected an anyHasPermissionPattern regex literal in scripts/typecheck.mjs");
  const anyHasPermissionPattern = new RegExp(patternMatch[1], patternMatch[2]);

  const qualifiedSample = "using (internal.has_permission(auth.uid(), facility_id, 'incidents.escalate'))";
  anyHasPermissionPattern.lastIndex = 0;
  const qualifiedMatch = anyHasPermissionPattern.exec(qualifiedSample);
  assert.ok(qualifiedMatch, "expected a match against an internal.-qualified call");
  assert.equal(qualifiedMatch[1], "incidents.escalate");

  const fourArgSample =
    "has_permission(auth.uid(), facility_id, department_id, 'reports.read') and deleted_at is null";
  anyHasPermissionPattern.lastIndex = 0;
  const fourArgMatch = anyHasPermissionPattern.exec(fourArgSample);
  assert.ok(fourArgMatch, "expected a match against the 4-arg department-scoped overload");
  assert.equal(fourArgMatch[1], "reports.read");

  // DR-21 (0054): the wrapped (select auth.uid()) form, same as above.
  const wrappedSample = "with check (internal.has_permission((select auth.uid()), facility_id, 'reports.distribution.manage'))";
  anyHasPermissionPattern.lastIndex = 0;
  const wrappedMatch = anyHasPermissionPattern.exec(wrappedSample);
  assert.ok(wrappedMatch, "expected a match against a (select auth.uid())-wrapped call");
  assert.equal(wrappedMatch[1], "reports.distribution.manage");
});
