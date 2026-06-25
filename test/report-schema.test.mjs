import test from "node:test";
import assert from "node:assert/strict";
import { validateReportSubmission, validateReportTemplateSchema } from "../src/lib/report-schema.mjs";

const openingChecklist = {
  sections: [
    {
      title: "Opening checks",
      fields: [
        { key: "pool_ready", label: "Pool ready", type: "select", required: true, options: ["pass", "fail"] },
        { key: "attendance", label: "Expected attendance", type: "number", required: true }
      ]
    }
  ]
};

test("report template schemas require valid sections and fields", () => {
  assert.deepEqual(validateReportTemplateSchema(openingChecklist), []);
  assert.match(validateReportTemplateSchema({ sections: [] })[0], /at least one section/);
});

test("report submission validation enforces required answers and field types", () => {
  assert.deepEqual(validateReportSubmission(openingChecklist, { pool_ready: "pass", attendance: 42 }), []);
  assert.deepEqual(validateReportSubmission(openingChecklist, { pool_ready: "maybe", attendance: "many" }), [
    "Pool ready must be one of: pass, fail",
    "Expected attendance must be a number"
  ]);
});
