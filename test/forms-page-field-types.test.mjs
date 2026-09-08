import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { supportedFieldTypes } from "../src/lib/report-schema.mjs";

// The Forms & Fields admin builder (src/public/admin/js/pages/forms.js) is
// served statically -- this repo has no bundler and only src/public is ever
// served to a browser (scripts/build.mjs just copies the directory verbatim,
// scripts/server.mjs's static root is src/public/dist) -- so that page
// cannot `import` src/lib/report-schema.mjs the way every server-side module
// does. Its own FIELD_TYPES array is kept in sync BY HAND instead (see that
// file's own comment on the constant); this test is what makes a drift
// between the two lists a failing test rather than a silent stale builder
// dropdown the next time report-schema.mjs's supportedFieldTypes changes.
test("admin forms.js FIELD_TYPES exactly matches report-schema.mjs's supportedFieldTypes", () => {
  const source = readFileSync(
    new URL("../src/public/admin/js/pages/forms.js", import.meta.url),
    "utf8"
  );
  const match = source.match(/const FIELD_TYPES = \[([\s\S]*?)\];/);
  assert.ok(match, "forms.js must declare a FIELD_TYPES array");
  const declared = [...match[1].matchAll(/"([a-z]+)"/g)].map((entry) => entry[1]);

  assert.deepEqual(
    [...declared].sort(),
    [...supportedFieldTypes].sort(),
    "forms.js FIELD_TYPES has drifted from report-schema.mjs's supportedFieldTypes"
  );
});
