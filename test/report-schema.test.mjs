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

const richSchema = {
  sections: [
    {
      title: "Details",
      fields: [
        { key: "hazards", label: "Hazards", type: "multiselect", options: ["wet", "ice", "crowd"] },
        { key: "signed_off", label: "Signed off", type: "checkbox" },
        { key: "shift_date", label: "Shift date", type: "date" },
        { key: "open_time", label: "Open time", type: "time" },
        { key: "deck_photo", label: "Deck photo", type: "photo", required: true },
        { key: "supervisor_sig", label: "Supervisor signature", type: "signature", required: true }
      ]
    }
  ]
};

const validRich = {
  hazards: ["wet", "ice"],
  signed_off: true,
  shift_date: "2026-07-08",
  open_time: "06:30",
  deck_photo: "uploads/deck.jpg",
  supervisor_sig: "sig/abc"
};

test("submission validation accepts valid multiselect/checkbox/date/time/photo/signature", () => {
  assert.deepEqual(validateReportSubmission(richSchema, validRich), []);
});

test("multiselect rejects non-arrays and out-of-catalog selections", () => {
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, hazards: "wet" }), [
    "Hazards must be a list of selections"
  ]);
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, hazards: ["wet", "lava"] }), [
    "Hazards contains invalid selections: lava"
  ]);
});

test("checkbox requires a boolean", () => {
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, signed_off: "yes" }), [
    "Signed off must be true or false"
  ]);
});

test("date requires a real YYYY-MM-DD", () => {
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, shift_date: "2026-13-40" }), [
    "Shift date must be a valid date (YYYY-MM-DD)"
  ]);
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, shift_date: "07/08/2026" }), [
    "Shift date must be a valid date (YYYY-MM-DD)"
  ]);
});

test("time requires HH:MM", () => {
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, open_time: "6:30" }), [
    "Open time must be a valid time (HH:MM)"
  ]);
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, open_time: "25:00" }), [
    "Open time must be a valid time (HH:MM)"
  ]);
});

test("required photo/signature must be a non-empty file reference", () => {
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, deck_photo: "" }), [
    "Deck photo is required"
  ]);
  assert.deepEqual(validateReportSubmission(richSchema, { ...validRich, supervisor_sig: "   " }), [
    "Supervisor signature must reference an uploaded file"
  ]);
});
