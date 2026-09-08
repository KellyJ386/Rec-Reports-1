import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReportSubmission,
  validateReportSubmissionPartial,
  validateReportTemplateSchema,
  unknownPayloadKeys,
  unsafeRegexPatternReason,
  validateSignatureRequirements,
  normalizeSignatureRoleRequirement,
  evaluateVisibility,
  hiddenFieldKeys,
  findFieldByKey,
  supportedFieldTypes,
  extractDefects
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

// L-1 (security review, wave3-slice-3c): a bare-integer field key (e.g. "0")
// would otherwise collide with actionEventType's default `${type}:${index}`
// composition once report-workflow.mjs namespaces a defect's own eventType
// -- rejected here, at template-authoring time, on top of (not instead of)
// that namespacing fix.
test("report template schemas reject a field key that does not start with a lowercase letter", () => {
  const schema = {
    sections: [{ title: "Section", fields: [{ key: "0", label: "Numeric key", type: "text" }] }]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /\.key must match/);
});

test("report template schemas reject a field key with an uppercase letter, hyphen, or leading underscore", () => {
  for (const key of ["Gate", "gate-broken", "_gate"]) {
    const schema = { sections: [{ title: "Section", fields: [{ key, label: "Field", type: "text" }] }] };
    assert.match(validateReportTemplateSchema(schema)[0], /\.key must match/, `expected "${key}" to be rejected`);
  }
});

test("report template schemas accept every real field-key shape already in use (single letters, snake_case)", () => {
  for (const key of ["a", "n", "gate_broken", "pool_ready", "chemical_level"]) {
    const schema = { sections: [{ title: "Section", fields: [{ key, label: "Field", type: "text" }] }] };
    assert.deepEqual(validateReportTemplateSchema(schema), [], `expected "${key}" to be accepted`);
  }
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

test("a value longer than 512 characters is rejected before the regex ever runs", () => {
  const schema = {
    sections: [
      {
        title: "s",
        fields: [{ key: "code", label: "Code", type: "text", validation_rules: { regex: "^[a-z]+$" } }]
      }
    ]
  };
  assert.deepEqual(validateReportSubmission(schema, { code: "a".repeat(512) }), []);
  assert.deepEqual(validateReportSubmission(schema, { code: "a".repeat(513) }), [
    "Code is too long to match the required pattern"
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
  assert.match(unsafeRegexPatternReason("^(a+)+$"), /repeat a group/);
  assert.match(unsafeRegexPatternReason("^(\\d*)*$"), /repeat a group/);
  assert.match(unsafeRegexPatternReason("^(x{2,})+$"), /repeat a group/);
});

// H-2 (security review): every pattern the review proved catastrophic under
// the OLD flat-group heuristic must be rejected by the new structural
// allow-list grammar -- alternation overlap, a nested paren the old flat
// `[^()]*` scan couldn't see into, ambiguity from a bare `?` inside a
// repeated group, and a bounded-but-still-explosive `{n,m}`.
test("unsafeRegexPatternReason rejects every ReDoS shape the security review measured", () => {
  assert.match(unsafeRegexPatternReason("^(a|a)*$"), /repeat a group/);
  assert.match(unsafeRegexPatternReason("^((a+))+$"), /nest groups/);
  assert.match(unsafeRegexPatternReason("^(\\d\\d?)*$"), /repeat a group/);
  assert.match(unsafeRegexPatternReason("^(a{1,2})*$"), /repeat a group/);
});

test("unsafeRegexPatternReason rejects lookaround assertions", () => {
  assert.match(unsafeRegexPatternReason("^(?=foo)bar$"), /lookaround/);
  assert.match(unsafeRegexPatternReason("^(?!foo)bar$"), /lookaround/);
  assert.match(unsafeRegexPatternReason("^(?<=foo)bar$"), /lookaround/);
  assert.match(unsafeRegexPatternReason("^(?<!foo)bar$"), /lookaround/);
});

// N-3 (security re-verification): a top-level `|` binds looser than the `^`/`$`
// anchors, so `^AM|PM$` has an unanchored second branch (`PM$` matches
// "xxPM"). Alternation is therefore only legal inside a group, where both
// anchors still apply to every branch.
test("unsafeRegexPatternReason accepts alternation inside a group and rejects a top-level |", () => {
  assert.equal(unsafeRegexPatternReason("^(AM|PM)$"), null);
  assert.equal(unsafeRegexPatternReason("^(foo|bar)$"), null);
  assert.equal(unsafeRegexPatternReason("^(foo|bar)?-\\d{2}$"), null);
  assert.match(unsafeRegexPatternReason("^AM|PM$"), /wrap alternation in a group/);
  assert.match(unsafeRegexPatternReason("^foo$|^bar$"), /wrap alternation in a group/);
});

// H-2 (security re-verification): the previous grammar only restricted
// quantifiers on GROUPS, so several unbounded quantifiers on adjacent
// ordinary atoms that can match the same characters were still accepted --
// `^\d+\d+\d+\d+x$` measured ~9 s on a 400-character value. Rule (f)
// bounds the product of every quantifier's split count instead.
test("unsafeRegexPatternReason rejects overlapping unbounded quantifiers on ordinary atoms", () => {
  assert.match(unsafeRegexPatternReason("^\\d+\\d+\\d+\\d+x$"), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^\\d+\\d+\\d+x$"), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^\\d*\\d*\\d*x$"), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^\\d{1,}\\d{1,}\\d{1,}x$"), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^[0-9]+[0-9]+[0-9]+x$"), /backtracking potential/);
});

// Second re-verification: `[]` / `[^]` are COMPLETE classes in JavaScript, so
// a scanner that treated the leading `]` as a literal member ran on to the
// next `]` and let a repeated alternation group (`^[^](a|a)*[^]x$`, 873 ms at
// 28 characters) or a run of `.*` slip past every rule.
test("unsafeRegexPatternReason cannot be desynchronised by the empty-class forms [] and [^]", () => {
  assert.match(unsafeRegexPatternReason("^[^](a|a)*[^]x$"), /repeat a group/);
  assert.match(unsafeRegexPatternReason("^[^].*.*.*.*.*.*.*.*[^]x$"), /backtracking potential|more than 8/);
  assert.match(unsafeRegexPatternReason("^[^]*[^]*[^]*[^]*[^]*x$"), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^[]a|b$"), /wrap alternation/);
  assert.match(unsafeRegexPatternReason("^[](a+)+$"), /repeat a group/);
  // Still-legal uses of the same forms.
  assert.equal(unsafeRegexPatternReason("^[^]$"), null);
  assert.equal(unsafeRegexPatternReason("^[^]{1,64}$"), null);
  assert.equal(unsafeRegexPatternReason("^[]]$"), null); // empty class then a literal ]
  assert.equal(unsafeRegexPatternReason("^[\\]+]+$"), null); // escaped ] inside a class
  assert.equal(unsafeRegexPatternReason("^[[]$"), null); // literal [ inside a class
});

// Third re-verification (H-3): the budget counts paths, but every path also
// re-scans the tail. Twenty-two optional groups in front of `[a-z]{500}`
// measured 9 s while sitting inside the budget, and an EMPTY alternative
// `(|a)` defeats the engine's prefix folding. Alternation paths are capped
// separately at 2^8.
test("unsafeRegexPatternReason caps alternation and optional-group paths independently of the budget", () => {
  const optional = (n) => "^" + "(|a)".repeat(n);
  assert.match(unsafeRegexPatternReason(optional(22) + "[a-z]{500}x$"), /alternation or optional-group paths/);
  assert.match(unsafeRegexPatternReason(optional(22) + "x$"), /alternation or optional-group paths/);
  assert.match(unsafeRegexPatternReason("^(a|a)".repeat(1) + "(a|a)".repeat(8) + "x$"), /alternation or optional-group paths/);
  assert.match(unsafeRegexPatternReason("^" + "(a)?".repeat(9) + "x$"), /alternation or optional-group paths/);
  assert.match(unsafeRegexPatternReason("^(|a)".repeat(1) + "(|a)".repeat(8) + "x$"), /alternation or optional-group paths/);
  // Eight two-way choices are still fine, with or without a long exact tail.
  assert.equal(unsafeRegexPatternReason(optional(8) + "[a-z]{190}x$"), null);
  assert.equal(unsafeRegexPatternReason("^" + "(a)?".repeat(8) + "x$"), null);
  assert.equal(unsafeRegexPatternReason("^(AM|PM)$"), null);
  assert.equal(unsafeRegexPatternReason("^\\d+(\\.\\d+)?$"), null);
  assert.equal(unsafeRegexPatternReason("^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,10}$"), null);
});

// The two caps multiply: 2^8 group paths x 2^14 quantifier splits stays
// inside both, and every path re-scans an exact {440} tail. Charging {n}
// its scan length closes the product axis (measured 3.6 s before).
test("unsafeRegexPatternReason charges an exact {n} its scan length so long tails cannot ride a full budget", () => {
  const tail = "[a-z]*[a-z]{0,31}[a-z]{440}x$";
  assert.match(unsafeRegexPatternReason("^" + "(a)?".repeat(4) + "(|a)".repeat(4) + tail), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^" + "(|a)".repeat(7) + "(a)?" + tail), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^" + "(|a|aa|aaa)".repeat(4) + tail), /backtracking potential/);
  assert.match(unsafeRegexPatternReason("^" + "(|a)".repeat(8) + tail), /backtracking potential/);
  // Exact repetitions in ordinary patterns are cheap and stay accepted.
  assert.equal(unsafeRegexPatternReason("^\\d{4}-\\d{2}-\\d{2}$"), null);
  assert.equal(unsafeRegexPatternReason("^\\d{3}-\\d{2}-\\d{4}$"), null);
  assert.equal(unsafeRegexPatternReason("^[A-Z]{2}-\\d{4}$"), null);
  assert.equal(unsafeRegexPatternReason("^(|a)(|a)(|a)(|a)(|a)(|a)(|a)(|a)[a-z]{190}x$"), null);
  // A wide {n,m} range with a large n is charged its scan length too.
  assert.match(unsafeRegexPatternReason("^(|a)(|a)(|a)(|a)(|a)(|a)(|a)(|a).*.{480,511}x$"), /backtracking potential/);
  assert.equal(unsafeRegexPatternReason("^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,10}$"), null);
  assert.equal(unsafeRegexPatternReason("^[A-Z]{1,3}\\d{1,6}[A-Z]?$"), null);
});

test("unsafeRegexPatternReason rejects named backreferences as well as numbered ones", () => {
  assert.match(unsafeRegexPatternReason("^(?<n>[a-z]*)\\k<n>x$"), /backreferences/);
  assert.match(unsafeRegexPatternReason("^(a)\\1$"), /backreferences/);
});

test("unsafeRegexPatternReason rejects bounded ranges whose combinations still explode", () => {
  assert.match(
    unsafeRegexPatternReason("^\\d{1,64}\\d{1,64}\\d{1,64}\\d{1,64}x$"),
    /backtracking potential/
  );
  assert.match(unsafeRegexPatternReason("^\\d+\\d{1,64}\\d{1,64}\\d{1,8}x$"), /backtracking potential/);
  // A huge upper bound is capped at the input cap, not taken literally.
  assert.match(unsafeRegexPatternReason("^\\d+\\d{1,9999}\\d{1,9999}x$"), /backtracking potential/);
});

test("unsafeRegexPatternReason keeps two unbounded quantifiers and realistic bounded mixes", () => {
  assert.equal(unsafeRegexPatternReason("^\\d+\\d+x$"), null);
  assert.equal(unsafeRegexPatternReason("^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,10}$"), null);
  assert.equal(unsafeRegexPatternReason("^\\d+\\d{1,64}\\d{1,64}x$"), null);
  assert.equal(unsafeRegexPatternReason("^\\d{3}-\\d{3}-\\d{4}$"), null);
  assert.equal(unsafeRegexPatternReason("^[A-Z]{1,3}\\d{1,6}[A-Z]?$"), null);
});

test("every pattern the allow-list accepts in these tests matches a 512-character value quickly", () => {
  const accepted = [
    "^\\d+\\d+x$",
    "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,10}$",
    "^\\d+\\d{1,64}\\d{1,64}x$",
    "^\\d+(\\.\\d+)?$",
    "^(a|a)?(a|a)?\\d+\\d+y$",
    "^(|a)(|a)(|a)(|a)(|a)(|a)(|a)(|a)[a-z]{190}x$"
  ];
  for (const pattern of accepted) {
    assert.equal(unsafeRegexPatternReason(pattern), null, pattern);
    const started = performance.now();
    new RegExp(pattern).test("1".repeat(512));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `${pattern} took ${elapsed.toFixed(1)}ms on a 512-character non-matching value`);
  }
});

test("unsafeRegexPatternReason rejects groups nested more than one level deep", () => {
  assert.match(unsafeRegexPatternReason("^(a(b)c)$"), /nest groups/);
  assert.equal(unsafeRegexPatternReason("^(a)(b)$"), null);
});

test("unsafeRegexPatternReason allows a single optional-group quantifier but not a repeated one", () => {
  assert.equal(unsafeRegexPatternReason("^\\d+(\\.\\d+)?$"), null);
  assert.match(unsafeRegexPatternReason("^(a)???$"), /repeat a group/);
});

test("unsafeRegexPatternReason rejects more than 8 quantifiers", () => {
  assert.match(
    unsafeRegexPatternReason("^a{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}$"),
    /more than 8 quantifiers/
  );
});

test("unsafeRegexPatternReason accepts ordinary field-validation patterns", () => {
  assert.equal(unsafeRegexPatternReason("^[A-Z]{2}-\\d{4}$"), null);
  assert.equal(unsafeRegexPatternReason("^\\d+(\\.\\d+)?$"), null);
});

test("unsafeRegexPatternReason rejects backreferences", () => {
  assert.match(unsafeRegexPatternReason("^(a)\\1$"), /backreferences/);
});

test("unsafeRegexPatternReason rejects a syntactically invalid pattern", () => {
  // Unbalanced parens are now caught by the structural scan itself (a more
  // specific, still-correct rejection reason) -- ^[z-a]$ is structurally
  // fine (balanced, no groups at all) but still an invalid regex (inverted
  // character-class range), so it reaches -- and is rejected by -- the
  // `new RegExp` validity check.
  assert.match(unsafeRegexPatternReason("^(unterminated$"), /unbalanced parentheses/);
  assert.match(unsafeRegexPatternReason("^[z-a]$"), /not a valid regular expression/);
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
  assert.match(validateSignatureRequirements({ roles: ["manager", ""] })[0], /role must be a non-empty string/);
  assert.match(validateSignatureRequirements({ roles: ["manager", "manager"] })[0], /duplicate role "manager"/);
});

// M-3: roles[] entries are { role, permission } objects; a bare string is
// still accepted for backward compatibility (normalizes to reports.submit).
test("validateSignatureRequirements accepts { role, permission } entries and normalizes bare strings", () => {
  assert.deepEqual(
    validateSignatureRequirements({
      required: true,
      roles: [
        { role: "supervisor", permission: "reports.publish" },
        "manager"
      ]
    }),
    []
  );
  assert.deepEqual(normalizeSignatureRoleRequirement("manager"), {
    role: "manager",
    permission: "reports.submit"
  });
  assert.deepEqual(normalizeSignatureRoleRequirement({ role: "supervisor", permission: "reports.publish" }), {
    role: "supervisor",
    permission: "reports.publish"
  });
});

test("validateSignatureRequirements rejects an unknown permission code and an unrecognized entry shape", () => {
  assert.match(
    validateSignatureRequirements({ roles: [{ role: "supervisor", permission: "not.a.real.code" }] })[0],
    /permission must be a known permission code/
  );
  assert.match(
    validateSignatureRequirements({ roles: [{ role: "supervisor", extra: true }] })[0],
    /must be a non-empty string or an object/
  );
  assert.equal(normalizeSignatureRoleRequirement(42), null);
  assert.equal(normalizeSignatureRoleRequirement({ role: "supervisor", extra: true }), null);
});

// --- WO-21: the isDefect / defectWhen field convention ----------------------

test("a checkbox field may declare isDefect without defectWhen (defaults to true)", () => {
  const schema = {
    sections: [
      { title: "Checks", fields: [{ key: "pool_gate_broken", label: "Gate broken", type: "checkbox", isDefect: true }] }
    ]
  };
  assert.deepEqual(validateReportTemplateSchema(schema), []);
});

test("a checkbox field may declare an explicit boolean defectWhen", () => {
  const schema = {
    sections: [
      {
        title: "Checks",
        fields: [{ key: "gate_secure", label: "Gate secure", type: "checkbox", isDefect: true, defectWhen: false }]
      }
    ]
  };
  assert.deepEqual(validateReportTemplateSchema(schema), []);
});

test("a checkbox field rejects a non-boolean defectWhen", () => {
  const schema = {
    sections: [
      {
        title: "Checks",
        fields: [{ key: "gate_secure", label: "Gate secure", type: "checkbox", isDefect: true, defectWhen: "nope" }]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /defectWhen must be a boolean/);
});

test("a select field requires defectWhen when isDefect is true", () => {
  const schema = {
    sections: [
      {
        title: "Checks",
        fields: [
          { key: "chemical_level", label: "Chemical level", type: "select", isDefect: true, options: ["ok", "low", "critical"] }
        ]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /defectWhen is required/);
});

test("a select field's defectWhen must be one of its own options", () => {
  const schema = {
    sections: [
      {
        title: "Checks",
        fields: [
          {
            key: "chemical_level",
            label: "Chemical level",
            type: "select",
            isDefect: true,
            defectWhen: "explosive",
            options: ["ok", "low", "critical"]
          }
        ]
      }
    ]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /must be one of the field's own options/);
});

test("a select field with a valid defectWhen passes validation", () => {
  const schema = {
    sections: [
      {
        title: "Checks",
        fields: [
          {
            key: "chemical_level",
            label: "Chemical level",
            type: "select",
            isDefect: true,
            defectWhen: "critical",
            options: ["ok", "low", "critical"]
          }
        ]
      }
    ]
  };
  assert.deepEqual(validateReportTemplateSchema(schema), []);
});

test("isDefect is rejected on any field type other than checkbox/select", () => {
  const schema = {
    sections: [{ title: "Checks", fields: [{ key: "notes", label: "Notes", type: "textarea", isDefect: true }] }]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /only valid on checkbox or select fields/);
});

test("isDefect must be a boolean when present", () => {
  const schema = {
    sections: [{ title: "Checks", fields: [{ key: "gate", label: "Gate", type: "checkbox", isDefect: "yes" }] }]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /isDefect must be a boolean/);
});

test("defectWhen without isDefect:true is rejected", () => {
  const schema = {
    sections: [{ title: "Checks", fields: [{ key: "gate", label: "Gate", type: "checkbox", defectWhen: true }] }]
  };
  assert.match(validateReportTemplateSchema(schema)[0], /defectWhen is only valid when isDefect is true/);
});

// --- WO-21: extractDefects ---------------------------------------------

const poolChecklist = {
  sections: [
    {
      title: "Pool checks",
      fields: [
        { key: "gate_broken", label: "Gate broken", type: "checkbox", isDefect: true },
        {
          key: "chemical_level",
          label: "Chemical level",
          type: "select",
          isDefect: true,
          defectWhen: "critical",
          options: ["ok", "low", "critical"]
        },
        { key: "attendance", label: "Attendance", type: "number" },
        {
          key: "filter_note",
          label: "Filter note",
          type: "textarea",
          visibility_rules: [{ field: "gate_broken", op: "eq", value: true }]
        }
      ]
    }
  ]
};

test("extractDefects returns [] when nothing fires", () => {
  const submission = { payload: { gate_broken: false, chemical_level: "ok", attendance: 40 } };
  assert.deepEqual(extractDefects(submission, { schema_json: poolChecklist }), []);
});

test("extractDefects fires a checkbox defect and a select defect independently", () => {
  const submission = { payload: { gate_broken: true, chemical_level: "critical", attendance: 40 } };
  const defects = extractDefects(submission, { schema_json: poolChecklist });
  assert.equal(defects.length, 2);
  assert.deepEqual(defects[0], {
    fieldKey: "gate_broken",
    label: "Gate broken",
    value: true,
    summary: "Gate broken flagged as a defect"
  });
  assert.deepEqual(defects[1], {
    fieldKey: "chemical_level",
    label: "Chemical level",
    value: "critical",
    summary: "Chemical level: critical"
  });
});

test("extractDefects ignores a select answer that isn't the declared defectWhen value", () => {
  const submission = { payload: { gate_broken: false, chemical_level: "low", attendance: 40 } };
  assert.deepEqual(extractDefects(submission, { schema_json: poolChecklist }), []);
});

test("extractDefects never fires for a field with no answer at all", () => {
  const submission = { payload: { attendance: 40 } };
  assert.deepEqual(extractDefects(submission, { schema_json: poolChecklist }), []);
});

test("extractDefects skips a defect field currently hidden by its own visibility_rules", () => {
  const hiddenDefectSchema = {
    sections: [
      {
        title: "Checks",
        fields: [
          { key: "toggle", label: "Toggle", type: "checkbox" },
          {
            key: "secondary_defect",
            label: "Secondary defect",
            type: "checkbox",
            isDefect: true,
            visibility_rules: [{ field: "toggle", op: "eq", value: true }]
          }
        ]
      }
    ]
  };
  const submission = { payload: { toggle: false, secondary_defect: true } };
  assert.deepEqual(extractDefects(submission, { schema_json: hiddenDefectSchema }), []);
});

test("extractDefects accepts a version.schema fallback and an empty submission gracefully", () => {
  assert.deepEqual(extractDefects({}, { schema: poolChecklist }), []);
  assert.deepEqual(extractDefects(undefined, undefined), []);
  assert.deepEqual(extractDefects({ payload: {} }, {}), []);
});

test("extractDefects preserves schema field order across sections", () => {
  const multiSection = {
    sections: [
      { title: "A", fields: [{ key: "a", label: "A", type: "checkbox", isDefect: true }] },
      { title: "B", fields: [{ key: "b", label: "B", type: "checkbox", isDefect: true }] }
    ]
  };
  const defects = extractDefects({ payload: { a: true, b: true } }, { schema_json: multiSection });
  assert.deepEqual(defects.map((d) => d.fieldKey), ["a", "b"]);
});
