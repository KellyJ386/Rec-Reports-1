import test from "node:test";
import assert from "node:assert/strict";
import { fieldDescriptors, collectPayload, applyServerErrors } from "../src/public/js/report-form.mjs";

// Exercises every one of the 10 supported field types (src/lib/report-schema.mjs's
// supportedFieldTypes) across two sections, so both fieldDescriptors' shape and
// its section-grouping/ordering can be asserted in one place.
const twoSectionSchema = {
  sections: [
    {
      title: "Opening checks",
      fields: [
        { key: "pool_ready", label: "Pool ready", type: "select", required: true, options: ["pass", "fail"] },
        { key: "attendance", label: "Expected attendance", type: "number", required: true },
        { key: "notes", label: "Notes", type: "text", helpText: "Anything unusual" },
        { key: "long_notes", label: "Long notes", type: "textarea" }
      ]
    },
    {
      title: "Evidence",
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

test("fieldDescriptors covers all 10 field types with correct section grouping and ordering", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  assert.equal(descriptors.length, 10);

  // Global order matches the schema's section-then-field order.
  assert.deepEqual(
    descriptors.map((d) => d.key),
    [
      "pool_ready",
      "attendance",
      "notes",
      "long_notes",
      "hazards",
      "signed_off",
      "shift_date",
      "open_time",
      "deck_photo",
      "supervisor_sig"
    ]
  );
  assert.deepEqual(
    descriptors.map((d) => d.order),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  );

  // Every field carries its section's index/title, and fieldIndex resets
  // per section.
  const bySection = new Map();
  for (const d of descriptors) {
    if (!bySection.has(d.sectionIndex)) bySection.set(d.sectionIndex, []);
    bySection.get(d.sectionIndex).push(d);
  }
  assert.deepEqual([...bySection.keys()], [0, 1]);
  assert.equal(bySection.get(0).every((d) => d.sectionTitle === "Opening checks"), true);
  assert.equal(bySection.get(1).every((d) => d.sectionTitle === "Evidence"), true);
  assert.deepEqual(
    bySection.get(0).map((d) => d.fieldIndex),
    [0, 1, 2, 3]
  );
  assert.deepEqual(
    bySection.get(1).map((d) => d.fieldIndex),
    [0, 1, 2, 3, 4, 5]
  );

  // Type-specific shape: required flag, options carried for select/multiselect
  // only, helpText tolerated, required defaults to false when absent.
  const byKey = Object.fromEntries(descriptors.map((d) => [d.key, d]));
  assert.equal(byKey.pool_ready.type, "select");
  assert.deepEqual(byKey.pool_ready.options, ["pass", "fail"]);
  assert.equal(byKey.pool_ready.required, true);
  assert.equal(byKey.attendance.type, "number");
  assert.equal(byKey.notes.type, "text");
  assert.equal(byKey.notes.helpText, "Anything unusual");
  assert.equal(byKey.notes.required, false);
  assert.equal(byKey.long_notes.type, "textarea");
  assert.equal(byKey.hazards.type, "multiselect");
  assert.deepEqual(byKey.hazards.options, ["wet", "ice", "crowd"]);
  assert.equal(byKey.signed_off.type, "checkbox");
  assert.equal(byKey.shift_date.type, "date");
  assert.equal(byKey.open_time.type, "time");
  assert.equal(byKey.deck_photo.type, "photo");
  assert.equal(byKey.deck_photo.required, true);
  assert.equal(byKey.supervisor_sig.type, "signature");
  assert.equal(byKey.supervisor_sig.required, true);
});

test("fieldDescriptors tolerates a missing/malformed schema", () => {
  assert.deepEqual(fieldDescriptors(null), []);
  assert.deepEqual(fieldDescriptors({}), []);
  assert.deepEqual(fieldDescriptors({ sections: [{ title: "Empty" }] }), []);
});

test("fieldDescriptors reads help_text as a fallback for helpText", () => {
  const schema = { sections: [{ title: "S", fields: [{ key: "k", label: "K", type: "text", help_text: "hi" }] }] };
  assert.equal(fieldDescriptors(schema)[0].helpText, "hi");
});

// --- DR-16: datetime/counter/rating descriptors -----------------------------

const newTypesSchema = {
  sections: [
    {
      title: "Shift",
      fields: [
        { key: "checked_in", label: "Checked in", type: "datetime", required: true },
        { key: "laps", label: "Laps counted", type: "counter", step: 5 },
        { key: "cleanliness", label: "Cleanliness", type: "rating", scale: 4, required: true }
      ]
    }
  ]
};

test("fieldDescriptors carries datetime/counter/rating through, including step/scale", () => {
  const descriptors = fieldDescriptors(newTypesSchema);
  assert.deepEqual(
    descriptors.map((d) => d.type),
    ["datetime", "counter", "rating"]
  );
  assert.equal(descriptors[0].step, undefined);
  assert.equal(descriptors[1].step, 5);
  assert.equal(descriptors[2].scale, 4);
});

test("collectPayload coerces counter/rating like number, and passes datetime through as a string", () => {
  const descriptors = fieldDescriptors(newTypesSchema);
  const payload = collectPayload(descriptors, {
    checked_in: "2026-07-08T06:30",
    laps: "10",
    cleanliness: "3"
  });
  assert.deepEqual(payload, { checked_in: "2026-07-08T06:30", laps: 10, cleanliness: 3 });
});

test("collectPayload round-trips a full answer set through DOM-shaped form state", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  // Simulates exactly what app.js reads off the real controls: strings for
  // text/number/date/time/select inputs, a boolean for the checkbox, and an
  // array for the multiselect's checked options.
  const formState = {
    pool_ready: "pass",
    attendance: "42", // <input type="number">.value is always a string
    notes: "Deck was slippery near the diving board",
    long_notes: "A longer paragraph of shift notes.",
    hazards: ["wet", "ice"],
    signed_off: true,
    shift_date: "2026-07-08",
    open_time: "06:30",
    deck_photo: "uploads/facility/reports/sub-1/deck.jpg",
    supervisor_sig: "uploads/facility/reports/sub-1/sig.png"
  };

  const payload = collectPayload(descriptors, formState);

  assert.deepEqual(payload, {
    pool_ready: "pass",
    attendance: 42, // coerced to a real number
    notes: "Deck was slippery near the diving board",
    long_notes: "A longer paragraph of shift notes.",
    hazards: ["wet", "ice"],
    signed_off: true,
    shift_date: "2026-07-08",
    open_time: "06:30",
    deck_photo: "uploads/facility/reports/sub-1/deck.jpg",
    supervisor_sig: "uploads/facility/reports/sub-1/sig.png"
  });
});

test("collectPayload drops empty/untouched answers and keeps unparsable numbers as strings for server validation", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  const formState = {
    pool_ready: "", // cleared -> omitted, not sent as ""
    attendance: "not-a-number", // left as-is so the server reports "must be a number"
    notes: "   ", // whitespace-only -> omitted
    hazards: [], // nothing checked -> omitted
    signed_off: false // explicit false is a real, present answer -> kept
    // every other key entirely absent from formState -> omitted
  };

  const payload = collectPayload(descriptors, formState);

  assert.deepEqual(payload, {
    attendance: "not-a-number",
    signed_off: false
  });
});

test("collectPayload ignores formState keys the descriptors don't declare", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  const payload = collectPayload(descriptors, { pool_ready: "pass", not_a_field: "sneaky" });
  assert.deepEqual(payload, { pool_ready: "pass" });
});

test("applyServerErrors maps per-field messages onto their field's key", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  const { fieldErrors, formErrors } = applyServerErrors(descriptors, [
    "Pool ready must be one of: pass, fail",
    "Expected attendance is required",
    "Expected attendance must be a number"
  ]);

  assert.deepEqual(fieldErrors, {
    pool_ready: ["Pool ready must be one of: pass, fail"],
    attendance: ["Expected attendance is required", "Expected attendance must be a number"]
  });
  assert.deepEqual(formErrors, []);
});

test("applyServerErrors falls back to form-level errors for messages that don't name a field", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  const { fieldErrors, formErrors } = applyServerErrors(descriptors, [
    "payload has unknown keys not defined on the template version: bogus_key",
    "only draft reports can be edited"
  ]);

  assert.deepEqual(fieldErrors, {});
  assert.deepEqual(formErrors, [
    "payload has unknown keys not defined on the template version: bogus_key",
    "only draft reports can be edited"
  ]);
});

test("applyServerErrors prefers the longer, more specific label when one label prefixes another", () => {
  const schema = {
    sections: [
      {
        title: "S",
        fields: [
          { key: "pool", label: "Pool", type: "text" },
          { key: "pool_ready", label: "Pool ready", type: "select", options: ["pass", "fail"] }
        ]
      }
    ]
  };
  const descriptors = fieldDescriptors(schema);
  const { fieldErrors } = applyServerErrors(descriptors, ["Pool ready is required"]);
  assert.deepEqual(fieldErrors, { pool_ready: ["Pool ready is required"] });
});

test("applyServerErrors accepts a single error string as well as an array", () => {
  const descriptors = fieldDescriptors(twoSectionSchema);
  const { fieldErrors, formErrors } = applyServerErrors(descriptors, "Pool ready must be one of: pass, fail");
  assert.deepEqual(fieldErrors, { pool_ready: ["Pool ready must be one of: pass, fail"] });
  assert.deepEqual(formErrors, []);
});

test("applyServerErrors ignores blank/non-string entries and handles no descriptors", () => {
  assert.deepEqual(applyServerErrors([], ["Some error"]), { fieldErrors: {}, formErrors: ["Some error"] });
  assert.deepEqual(applyServerErrors(undefined, [""]), { fieldErrors: {}, formErrors: [] });
});
