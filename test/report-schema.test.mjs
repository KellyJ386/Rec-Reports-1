import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReportSubmission,
  validateReportSubmissionPartial,
  validateReportTemplateSchema,
  unknownPayloadKeys,
  unsafeRegexPatternReason,
  validateSignatureRequirements,
  evaluateVisibility,
  hiddenFieldKeys,
  findFieldByKey,
  supportedFieldTypes
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

// --- DR-16: new field types (datetime, counter, rating) ---------------------

test("supportedFieldTypes includes the DR-16 additions", () => {
  assert.ok(supportedFieldTypes.includes("datetime"));
  assert.ok(supportedFieldTypes.includes("counter"));
  assert.ok(supportedFieldTypes.includes("rating"));
});

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

test("datetime requires a real YYYY-MM-DDTHH:MM value", () => {
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, {
      checked_in: "2026-07-08T06:30",
      cleanliness: 3
    }),
    []
  );
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, { checked_in: "2026-07-08 06:30", cleanliness: 3 }),
    ["Checked in must be a valid date/time (YYYY-MM-DDTHH:MM)"]
  );
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, { checked_in: "2026-13-40T06:30", cleanliness: 3 }),
    ["Checked in must be a valid date/time (YYYY-MM-DDTHH:MM)"]
  );
});

test("counter requires a whole number and honors its step", () => {
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, {
      checked_in: "2026-07-08T06:30",
      laps: 10,
      cleanliness: 3
    }),
    []
  );
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, {
      checked_in: "2026-07-08T06:30",
      laps: 2.5,
      cleanliness: 3
    }),
    ["Laps counted must be a whole number"]
  );
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, {
      checked_in: "2026-07-08T06:30",
      laps: 7,
      cleanliness: 3
    }),
    ["Laps counted must be a multiple of 5"]
  );
});

test("rating requires a whole number within [1, scale]", () => {
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, { checked_in: "2026-07-08T06:30", cleanliness: 4 }),
    []
  );
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, { checked_in: "2026-07-08T06:30", cleanliness: 5 }),
    ["Cleanliness must be a whole number between 1 and 4"]
  );
  assert.deepEqual(
    validateReportSubmission(newTypesSchema, { checked_in: "2026-07-08T06:30", cleanliness: 0 }),
    ["Cleanliness must be a whole number between 1 and 4"]
  );
});

test("schema validation requires rating.scale (integer >= 2) and rejects a non-positive counter.step", () => {
  const missingScale = {
    sections: [{ title: "s", fields: [{ key: "r", label: "R", type: "rating" }] }]
  };
  assert.match(validateReportTemplateSchema(missingScale)[0], /scale is required for rating fields/);

  const badStep = {
    sections: [{ title: "s", fields: [{ key: "c", label: "C", type: "counter", step: 0 }] }]
  };
  assert.match(validateReportTemplateSchema(badStep)[0], /step must be a positive integer/);
});

// --- DR-16: validation_rules (min/max/regex/minLength/maxLength) ------------

const ruledSchema = {
  sections: [
    {
      title: "s",
      fields: [
        {
          key: "attendance",
          label: "Attendance",
          type: "number",
          validation_rules: { min: 1, max: 100 }
        },
        {
          key: "notes",
          label: "Notes",
          type: "text",
          validation_rules: { minLength: 2, maxLength: 5, regex: "^[a-z]+$" }
        }
      ]
    }
  ]
};

test("validation_rules min/max are enforced on a number field", () => {
  assert.deepEqual(validateReportSubmission(ruledSchema, { attendance: 50, notes: "abcd" }), []);
  assert.deepEqual(validateReportSubmission(ruledSchema, { attendance: 0, notes: "abcd" }), [
    "Attendance must be at least 1"
  ]);
  assert.deepEqual(validateReportSubmission(ruledSchema, { attendance: 500, notes: "abcd" }), [
    "Attendance must be at most 100"
  ]);
});

test("validation_rules minLength/maxLength/regex are enforced on a string field", () => {
  assert.deepEqual(validateReportSubmission(ruledSchema, { attendance: 50, notes: "a" }), [
    "Notes must be at least 2 characters"
  ]);
  assert.deepEqual(validateReportSubmission(ruledSchema, { attendance: 50, notes: "abcdef" }), [
    "Notes must be at most 5 characters"
  ]);
  assert.deepEqual(validateReportSubmission(ruledSchema, { attendance: 50, notes: "AB" }), [
    "Notes does not match the required pattern"
  ]);
});

test("schema validation rejects an unknown validation_rules key and an inverted min/max", () => {
  const unknownKey = {
    sections: [
      { title: "s", fields: [{ key: "n", label: "N", type: "number", validation_rules: { minimum: 1 } }] }
    ]
  };
  assert.match(validateReportTemplateSchema(unknownKey)[0], /validation_rules has an unknown key: minimum/);

  const inverted = {
    sections: [
      { title: "s", fields: [{ key: "n", label: "N", type: "number", validation_rules: { min: 10, max: 1 } }] }
    ]
  };
  assert.match(validateReportTemplateSchema(inverted)[0], /min must not exceed max/);
});

// --- DR-16: regex safety (unsafeRegexPatternReason) --------------------------

test("unsafeRegexPatternReason accepts a simple anchored pattern", () => {
  assert.equal(unsafeRegexPatternReason("^[a-z]{1,10}$"), null);
});

test("unsafeRegexPatternReason rejects an unanchored pattern", () => {
  assert.match(unsafeRegexPatternReason("[a-z]+"), /anchored/);
  assert.match(unsafeRegexPatternReason("^[a-z]+"), /anchored/);
  assert.match(unsafeRegexPatternReason("[a-z]+$"), /anchored/);
});

test("unsafeRegexPatternReason rejects a pattern over 200 characters", () => {
  const long = `^${"a".repeat(201)}$`;
  assert.match(unsafeRegexPatternReason(long), /at most 200 characters/);
});

test("unsafeRegexPatternReason rejects nested-quantifier (catastrophic backtracking) shapes", () => {
  assert.match(unsafeRegexPatternReason("^(a+)+$"), /nest quantifiers/);
  assert.match(unsafeRegexPatternReason("^(\\d*)*$"), /nest quantifiers/);
  assert.match(unsafeRegexPatternReason("^(x{2,})+$"), /nest quantifiers/);
});

test("unsafeRegexPatternReason rejects backreferences", () => {
  assert.match(unsafeRegexPatternReason("^(a)\\1$"), /backreferences/);
});

test("unsafeRegexPatternReason rejects a syntactically invalid pattern", () => {
  assert.match(unsafeRegexPatternReason("^(unterminated$"), /not a valid regular expression/);
});

test("unsafeRegexPatternReason rejects a non-string or empty pattern", () => {
  assert.match(unsafeRegexPatternReason(""), /non-empty string/);
  assert.match(unsafeRegexPatternReason(42), /non-empty string/);
});

test("schema validation surfaces an unsafe regex via validation_rules.regex", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [{ key: "n", label: "N", type: "text", validation_rules: { regex: "(a+)+" } }]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /validation_rules\.regex/);
});

// --- DR-16: default_value / help_text ----------------------------------------

test("schema validation type-checks default_value against the field's type", () => {
  const good = {
    sections: [{ title: "s", fields: [{ key: "n", label: "N", type: "number", default_value: 5 }] }]
  };
  assert.deepEqual(validateReportTemplateSchema(good), []);

  const bad = {
    sections: [{ title: "s", fields: [{ key: "n", label: "N", type: "number", default_value: "five" }] }]
  };
  assert.match(validateReportTemplateSchema(bad)[0], /default_value is not valid for type number/);
});

test("schema validation caps help_text at 500 characters", () => {
  const ok = {
    sections: [{ title: "s", fields: [{ key: "n", label: "N", type: "text", help_text: "short" }] }]
  };
  assert.deepEqual(validateReportTemplateSchema(ok), []);

  const tooLong = {
    sections: [
      { title: "s", fields: [{ key: "n", label: "N", type: "text", help_text: "x".repeat(501) }] }
    ]
  };
  assert.match(validateReportTemplateSchema(tooLong)[0], /help_text must be at most 500 characters/);
});

// --- DR-16: photo_constraints -------------------------------------------------

test("schema validation accepts photo_constraints on a photo field", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [
          {
            key: "deck_photo",
            label: "Deck photo",
            type: "photo",
            photo_constraints: { maxCount: 3, maxBytes: 2000000, mimeTypes: ["image/jpeg"] }
          }
        ]
      }
    ]
  };
  assert.deepEqual(validateReportTemplateSchema(schema), []);
  assert.deepEqual(findFieldByKey(schema, "deck_photo").photo_constraints.maxCount, 3);
});

test("schema validation rejects photo_constraints on a non-photo field", () => {
  const schema = {
    sections: [
      { title: "s", fields: [{ key: "n", label: "N", type: "text", photo_constraints: { maxCount: 1 } }] }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /photo_constraints is only valid on a photo field/);
});

test("schema validation rejects a malformed photo_constraints shape", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [{ key: "p", label: "P", type: "photo", photo_constraints: { maxCount: -1, mimeTypes: [] } }]
      }
    ]
  };
  const errors = validateReportTemplateSchema(schema);
  assert.ok(errors.some((e) => /maxCount must be a positive integer/.test(e)));
  assert.ok(errors.some((e) => /mimeTypes must be a non-empty array/.test(e)));
});

// --- DR-16: visibility_rules -------------------------------------------------

const visibilitySchema = {
  sections: [
    {
      title: "s",
      fields: [
        { key: "pool_open", label: "Pool open", type: "checkbox" },
        {
          key: "water_temp",
          label: "Water temperature",
          type: "number",
          required: true,
          visibility_rules: [{ field: "pool_open", op: "eq", value: true }]
        }
      ]
    }
  ]
};

test("evaluateVisibility hides a field whose rules fail against the payload", () => {
  assert.deepEqual(hiddenFieldKeys(visibilitySchema, { pool_open: false }), ["water_temp"]);
  assert.deepEqual(hiddenFieldKeys(visibilitySchema, { pool_open: true }), []);
  assert.deepEqual(hiddenFieldKeys(visibilitySchema, {}), ["water_temp"]);
});

test("a hidden required field is not required, and a value submitted for it is ignored", () => {
  assert.deepEqual(validateReportSubmission(visibilitySchema, { pool_open: false }), []);
  assert.deepEqual(
    validateReportSubmission(visibilitySchema, { pool_open: false, water_temp: "not a number" }),
    []
  );
  assert.deepEqual(validateReportSubmission(visibilitySchema, { pool_open: true }), [
    "Water temperature is required"
  ]);
  assert.deepEqual(
    validateReportSubmissionPartial(visibilitySchema, { pool_open: false, water_temp: "not a number" }),
    []
  );
});

test("visibility_rules op variants: neq/in/gt/lt", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [
          { key: "status", label: "Status", type: "text" },
          { key: "count", label: "Count", type: "number" },
          { key: "a", label: "A", type: "text", visibility_rules: [{ field: "status", op: "neq", value: "closed" }] },
          {
            key: "b",
            label: "B",
            type: "text",
            visibility_rules: [{ field: "status", op: "in", value: ["open", "limited"] }]
          },
          { key: "c", label: "C", type: "text", visibility_rules: [{ field: "count", op: "gt", value: 10 }] },
          { key: "d", label: "D", type: "text", visibility_rules: [{ field: "count", op: "lt", value: 10 }] }
        ]
      }
    ]
  };
  assert.deepEqual(hiddenFieldKeys(schema, { status: "closed", count: 10 }), ["a", "b", "c", "d"]);
  assert.deepEqual(hiddenFieldKeys(schema, { status: "open", count: 15 }), ["d"]);
  assert.deepEqual(hiddenFieldKeys(schema, { status: "open", count: 5 }), ["c"]);
});

test("schema validation rejects self-referential visibility_rules", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [{ key: "a", label: "A", type: "text", visibility_rules: [{ field: "a", op: "eq", value: 1 }] }]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /self-referential visibility/);
});

test("schema validation rejects visibility_rules referencing an unknown field", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [{ key: "a", label: "A", type: "text", visibility_rules: [{ field: "ghost", op: "eq", value: 1 }] }]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /references unknown field "ghost"/);
});

test("schema validation rejects a two-field visibility cycle", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [
          { key: "a", label: "A", type: "text", visibility_rules: [{ field: "b", op: "eq", value: 1 }] },
          { key: "b", label: "B", type: "text", visibility_rules: [{ field: "a", op: "eq", value: 1 }] }
        ]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /visibility_rules contain a cycle/);
});

test("schema validation rejects an unrecognized visibility op", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [
          { key: "a", label: "A", type: "text", visibility_rules: [{ field: "b", op: "startsWith", value: 1 }] },
          { key: "b", label: "B", type: "text" }
        ]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /op must be one of/);
});

// --- DR-17: signature_requirements shape validation --------------------------

test("validateSignatureRequirements accepts a well-formed policy and undefined/null", () => {
  assert.deepEqual(validateSignatureRequirements(undefined), []);
  assert.deepEqual(validateSignatureRequirements(null), []);
  assert.deepEqual(validateSignatureRequirements({ required: true, roles: ["manager", "supervisor"] }), []);
});

test("validateSignatureRequirements rejects unknown keys, a non-boolean required, and bad roles", () => {
  assert.match(validateSignatureRequirements({ requird: true })[0], /unknown key/);
  assert.match(validateSignatureRequirements({ required: "yes" })[0], /required must be a boolean/);
  assert.match(validateSignatureRequirements({ roles: ["manager", ""] })[0], /roles must be an array of non-empty strings/);
  assert.match(validateSignatureRequirements({ roles: ["manager", "manager"] })[0], /must not contain duplicates/);
});
