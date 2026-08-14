import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReportSubmission,
  validateReportSubmissionPartial,
  validateReportTemplateSchema,
  unknownPayloadKeys
} from "../src/lib/report-schema.mjs";

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

// --- validateReportSubmissionPartial ----------------------------------------

test("partial validation skips fields whose key is entirely absent from the payload", () => {
  assert.deepEqual(validateReportSubmissionPartial(openingChecklist, {}), []);
  assert.deepEqual(validateReportSubmissionPartial(openingChecklist, { pool_ready: "pass" }), []);
});

test("partial validation still enforces type/option rules on keys that ARE supplied", () => {
  assert.deepEqual(validateReportSubmissionPartial(openingChecklist, { pool_ready: "maybe" }), [
    "Pool ready must be one of: pass, fail"
  ]);
  assert.deepEqual(validateReportSubmissionPartial(openingChecklist, { attendance: "many" }), [
    "Expected attendance must be a number"
  ]);
});

test("partial validation still flags a required field that is present but empty", () => {
  assert.deepEqual(validateReportSubmissionPartial(openingChecklist, { pool_ready: "" }), [
    "Pool ready is required"
  ]);
});

test("partial validation reports the same error shape (array of strings) as the full validator", () => {
  const errors = validateReportSubmissionPartial(richSchema, { hazards: "wet", signed_off: "yes" });
  assert.ok(Array.isArray(errors));
  assert.deepEqual(errors, ["Hazards must be a list of selections", "Signed off must be true or false"]);
});

test("partial validation on a fully valid partial payload still returns []", () => {
  assert.deepEqual(
    validateReportSubmissionPartial(richSchema, { hazards: ["wet"], signed_off: true }),
    []
  );
});

// --- unknownPayloadKeys ------------------------------------------------------

test("unknownPayloadKeys is empty when every payload key is a declared field", () => {
  assert.deepEqual(unknownPayloadKeys(openingChecklist, { pool_ready: "pass", attendance: 5 }), []);
  assert.deepEqual(unknownPayloadKeys(openingChecklist, {}), []);
});

test("unknownPayloadKeys reports keys the schema doesn't declare, sorted for a stable message", () => {
  assert.deepEqual(
    unknownPayloadKeys(openingChecklist, { pool_ready: "pass", zeta: 1, alpha: 2 }),
    ["alpha", "zeta"]
  );
});
