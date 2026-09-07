const allowedFieldTypes = new Set([
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "checkbox",
  "date",
  "time",
  "photo",
  "signature",
  // DR-16 additions. datetime is an anchored YYYY-MM-DDTHH:MM[:SS] string
  // (the <input type="datetime-local"> value shape); counter is a whole
  // number with an optional `step` (default 1); rating is a whole number in
  // [1, field.scale] -- scale is required on the field, mirroring select's
  // own required `options`.
  "datetime",
  "counter",
  "rating"
]);

// The shared set of supported field/data types, exported so the Forms & Fields
// builder (src/lib/admin/forms.mjs) validates custom-field data types against
// exactly the same vocabulary the runtime submission validator enforces, and
// so the admin builder's own type <select> (src/public/admin/js/pages/forms.js
// FIELD_TYPES -- browser code can't import this module directly, this repo
// has no bundler, see that file's own comment) is asserted to stay in sync
// with it by test/forms-page-field-types.test.mjs.
export const supportedFieldTypes = Object.freeze([...allowedFieldTypes]);

export function isSupportedFieldType(type) {
  return allowedFieldTypes.has(type);
}

// --- DR-16: regex safety for validation_rules.regex -------------------------
//
// A field's validation_rules.regex is compiled once at schema-validation time
// (authoring) and then `.test()`-ed against caller-supplied submission values
// at every future validate call -- i.e. untrusted input reaches `.test()` on
// a pattern an admin authored once. Node's regex engine can exhibit
// catastrophic (exponential) backtracking on certain pattern shapes, so this
// module never runs an *unvetted* pattern against user input. The rule,
// applied in this exact order by unsafeRegexPatternReason:
//   1. Must be a non-empty string, at most MAX_REGEX_PATTERN_LENGTH (200)
//      characters -- bounds the search space of every check below and caps
//      how much backtracking even a pathological pattern could ever attempt.
//   2. Must be anchored: starts with `^` and ends with an UNESCAPED `$`
//      (rejects a pattern ending `\$`, since that is a literal dollar sign,
//      not the end anchor) -- an unanchored pattern can be forced into more
//      backtracking by a longer input than the author intended, and it also
//      changes what "matches" means (substring vs whole-value).
//   3. Must not contain a nested-quantifier shape -- a parenthesized group
//      (with no further nesting) that itself ends in `+`/`*`/an open-ended
//      `{n,}`, immediately followed by an outer `+`/`*` on that same group
//      (e.g. `(a+)+`, `(\d*)*`, `(x{2,})+`). This is the textbook shape
//      behind catastrophic backtracking; NESTED_QUANTIFIER_RE below is
//      itself a simple, linear-time check (no nested groups, bounded input),
//      so checking it is never itself a ReDoS risk.
//   4. Must not contain a backreference (`\1`-`\9`) -- not needed for field
//      validation patterns and removes another engine-dependent complexity
//      source.
//   5. Must be syntactically valid (`new RegExp(pattern)` does not throw).
//      Constructing a RegExp only compiles it -- it never executes matching
//      -- so this step carries no backtracking risk regardless of shape.
// Defense in depth at match time (validateFieldValue): a value longer than
// MAX_REGEX_INPUT_LENGTH is rejected without ever being passed to `.test()`,
// bounding the worst case even if a future pattern shape turns out to evade
// the static checks above.
const MAX_REGEX_PATTERN_LENGTH = 200;
const MAX_REGEX_INPUT_LENGTH = 2000;
const NESTED_QUANTIFIER_RE = /\([^()]*(?:[+*]|\{\d*,\})[^()]*\)[+*]/;
const BACKREFERENCE_RE = /\\[1-9]/;

export function unsafeRegexPatternReason(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return "must be a non-empty string";
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `must be at most ${MAX_REGEX_PATTERN_LENGTH} characters`;
  }
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) {
    return "must be anchored with ^ at the start and an unescaped $ at the end";
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return "must not nest quantifiers (e.g. (a+)+) -- a catastrophic-backtracking shape";
  }
  if (BACKREFERENCE_RE.test(pattern)) {
    return "must not use backreferences";
  }
  try {
    // eslint-disable-next-line no-new -- validity check only, never executed
    new RegExp(pattern);
  } catch {
    return "is not a valid regular expression";
  }
  return null;
}

const VALIDATION_RULE_KEYS = new Set(["min", "max", "regex", "minLength", "maxLength"]);
const VISIBILITY_OPS = new Set(["eq", "neq", "in", "gt", "lt"]);
const MAX_HELP_TEXT_LENGTH = 500;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Validates one field's `validation_rules` object at authoring time: unknown
// keys, wrong-typed bounds, an inverted min/max, and (via
// unsafeRegexPatternReason) an unsafe regex shape are all rejected here so a
// template can never be published with a rule the runtime validator would
// have to defend against on every submission.
function validateValidationRules(rules, prefix, errors) {
  if (rules === undefined) return;
  if (!isPlainObject(rules)) {
    errors.push(`${prefix}.validation_rules must be an object`);
    return;
  }
  for (const key of Object.keys(rules)) {
    if (!VALIDATION_RULE_KEYS.has(key)) {
      errors.push(`${prefix}.validation_rules has an unknown key: ${key}`);
    }
  }
  if (rules.min !== undefined && !isFiniteNumber(rules.min)) {
    errors.push(`${prefix}.validation_rules.min must be a number`);
  }
  if (rules.max !== undefined && !isFiniteNumber(rules.max)) {
    errors.push(`${prefix}.validation_rules.max must be a number`);
  }
  if (isFiniteNumber(rules.min) && isFiniteNumber(rules.max) && rules.min > rules.max) {
    errors.push(`${prefix}.validation_rules.min must not exceed max`);
  }
  if (rules.minLength !== undefined && !(Number.isInteger(rules.minLength) && rules.minLength >= 0)) {
    errors.push(`${prefix}.validation_rules.minLength must be a non-negative integer`);
  }
  if (rules.maxLength !== undefined && !(Number.isInteger(rules.maxLength) && rules.maxLength >= 0)) {
    errors.push(`${prefix}.validation_rules.maxLength must be a non-negative integer`);
  }
  if (
    Number.isInteger(rules.minLength) &&
    Number.isInteger(rules.maxLength) &&
    rules.minLength > rules.maxLength
  ) {
    errors.push(`${prefix}.validation_rules.minLength must not exceed maxLength`);
  }
  if (rules.regex !== undefined) {
    if (typeof rules.regex !== "string") {
      errors.push(`${prefix}.validation_rules.regex must be a string`);
    } else {
      const reason = unsafeRegexPatternReason(rules.regex);
      if (reason) errors.push(`${prefix}.validation_rules.regex ${reason}`);
    }
  }
}

function validateHelpText(field, prefix, errors) {
  if (field.help_text === undefined) return;
  if (typeof field.help_text !== "string") {
    errors.push(`${prefix}.help_text must be a string`);
  } else if (field.help_text.length > MAX_HELP_TEXT_LENGTH) {
    errors.push(`${prefix}.help_text must be at most ${MAX_HELP_TEXT_LENGTH} characters`);
  }
}

const PHOTO_CONSTRAINT_KEYS = new Set(["maxCount", "maxBytes", "mimeTypes"]);

// photo_constraints is only meaningful on a photo field -- POST
// /reports/:id/attachments (attachments-routes.mjs) reads it off the pinned
// version's schema for whichever field_key the upload targets and enforces
// maxCount/maxBytes/mimeTypes there, so a non-photo field carrying it would
// be silently ignored by the enforcement point; rejected here instead so
// that never happens quietly.
function validatePhotoConstraints(field, prefix, errors) {
  if (field.photo_constraints === undefined) return;
  if (field.type !== "photo") {
    errors.push(`${prefix}.photo_constraints is only valid on a photo field`);
    return;
  }
  const constraints = field.photo_constraints;
  if (!isPlainObject(constraints)) {
    errors.push(`${prefix}.photo_constraints must be an object`);
    return;
  }
  for (const key of Object.keys(constraints)) {
    if (!PHOTO_CONSTRAINT_KEYS.has(key)) {
      errors.push(`${prefix}.photo_constraints has an unknown key: ${key}`);
    }
  }
  if (constraints.maxCount !== undefined && !(Number.isInteger(constraints.maxCount) && constraints.maxCount > 0)) {
    errors.push(`${prefix}.photo_constraints.maxCount must be a positive integer`);
  }
  if (constraints.maxBytes !== undefined && !(Number.isInteger(constraints.maxBytes) && constraints.maxBytes > 0)) {
    errors.push(`${prefix}.photo_constraints.maxBytes must be a positive integer`);
  }
  if (constraints.mimeTypes !== undefined) {
    if (
      !Array.isArray(constraints.mimeTypes) ||
      constraints.mimeTypes.length === 0 ||
      !constraints.mimeTypes.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    ) {
      errors.push(`${prefix}.photo_constraints.mimeTypes must be a non-empty array of non-empty strings`);
    }
  }
}

const VISIBILITY_RULE_KEYS = new Set(["field", "op", "value"]);

// Validates one field's `visibility_rules` array at authoring time: shape,
// unknown keys, a legal op, self-reference, and (given every field's own
// declared dependencies) a cycle across the whole schema. Returns the Set of
// field keys THIS field's rules depend on, so the caller can fold it into a
// schema-wide dependency graph for the cycle check.
function validateFieldVisibilityRules(field, prefix, errors) {
  if (field.visibility_rules === undefined) return new Set();
  if (!Array.isArray(field.visibility_rules)) {
    errors.push(`${prefix}.visibility_rules must be an array`);
    return new Set();
  }
  const deps = new Set();
  field.visibility_rules.forEach((rule, ruleIndex) => {
    const rulePrefix = `${prefix}.visibility_rules[${ruleIndex}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${rulePrefix} must be an object`);
      return;
    }
    for (const key of Object.keys(rule)) {
      if (!VISIBILITY_RULE_KEYS.has(key)) {
        errors.push(`${rulePrefix} has an unknown key: ${key}`);
      }
    }
    if (typeof rule.field !== "string" || rule.field.length === 0) {
      errors.push(`${rulePrefix}.field is required`);
    } else if (field.key && rule.field === field.key) {
      errors.push(`${rulePrefix}.field must not reference its own field (self-referential visibility)`);
    } else {
      deps.add(rule.field);
    }
    if (!VISIBILITY_OPS.has(rule.op)) {
      errors.push(`${rulePrefix}.op must be one of: ${[...VISIBILITY_OPS].join(", ")}`);
    }
    if (!Object.prototype.hasOwnProperty.call(rule, "value")) {
      errors.push(`${rulePrefix}.value is required`);
    } else if (rule.op === "in" && !Array.isArray(rule.value)) {
      errors.push(`${rulePrefix}.value must be an array when op is "in"`);
    }
  });
  return deps;
}

// Depth-first cycle detection over the schema-wide visibility dependency
// graph (field key -> the set of other field keys its own visibility_rules
// reference). A reference to an unknown field is reported separately by the
// caller and simply skipped here (walking into it would find no further
// edges anyway). Returns the cycle as an ordered array of keys, or null.
function findVisibilityCycle(depsByKey) {
  const UNVISITED = 0;
  const VISITING = 1;
  const DONE = 2;
  const state = new Map();
  let cycle = null;

  function visit(node, path) {
    state.set(node, VISITING);
    path.push(node);
    for (const dep of depsByKey.get(node) ?? []) {
      if (!depsByKey.has(dep)) continue;
      const depState = state.get(dep) ?? UNVISITED;
      if (depState === VISITING) {
        cycle = [...path, dep];
        return true;
      }
      if (depState === UNVISITED && visit(dep, path)) return true;
    }
    path.pop();
    state.set(node, DONE);
    return false;
  }

  for (const node of depsByKey.keys()) {
    if ((state.get(node) ?? UNVISITED) === UNVISITED) {
      if (visit(node, [])) return cycle;
    }
  }
  return null;
}

// Returns true when `value` fails the field's declared type (ignoring
// required/empty -- callers decide what to do with an empty value). Shared
// by validateFieldValue (submission time) and validateDefaultValue (schema
// authoring time) so "does this value fit this field's type" is defined
// exactly once.
function fieldTypeMismatch(field, value) {
  if (field.type === "number" && Number.isNaN(Number(value))) return true;
  if (field.type === "select") return Array.isArray(field.options) && !field.options.includes(value);
  if (field.type === "multiselect") {
    if (!Array.isArray(value)) return true;
    if (Array.isArray(field.options) && field.options.length > 0) {
      return value.some((entry) => !field.options.includes(entry));
    }
    return false;
  }
  if (field.type === "checkbox") return typeof value !== "boolean";
  if (field.type === "date") return !(typeof value === "string" && isValidCalendarDate(value));
  if (field.type === "time") return !(typeof value === "string" && TIME_PATTERN.test(value));
  if (field.type === "datetime") return !(typeof value === "string" && isValidCalendarDateTime(value));
  if (field.type === "counter") {
    const num = Number(value);
    if (!Number.isInteger(num)) return true;
    if (typeof field.step === "number" && field.step > 0 && num % field.step !== 0) return true;
    return false;
  }
  if (field.type === "rating") {
    const num = Number(value);
    const scale = Number.isInteger(field.scale) ? field.scale : DEFAULT_RATING_SCALE;
    return !(Number.isInteger(num) && num >= 1 && num <= scale);
  }
  if (field.type === "photo" || field.type === "signature") {
    return !(typeof value === "string" && value.trim().length > 0);
  }
  return false;
}

// default_value is type-checked against the field's own type at authoring
// time -- a default that would itself fail validateFieldValue at submission
// time is rejected before the template can be saved, rather than silently
// pre-filling every new draft with a value that immediately errors.
function validateDefaultValue(field, prefix, errors) {
  if (field.default_value === undefined) return;
  if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) return;
  if (fieldTypeMismatch(field, field.default_value)) {
    errors.push(`${prefix}.default_value is not valid for type ${field.type}`);
  }
}

export function validateReportTemplateSchema(schema) {
  const errors = [];
  if (!schema || typeof schema !== "object") {
    return ["schema must be an object"];
  }
  if (!Array.isArray(schema.sections) || schema.sections.length === 0) {
    errors.push("schema.sections must contain at least one section");
    return errors;
  }

  const fieldKeys = new Set();
  const visibilityDeps = new Map();

  for (const [sectionIndex, section] of schema.sections.entries()) {
    if (!section.title) errors.push(`sections[${sectionIndex}].title is required`);
    if (!Array.isArray(section.fields) || section.fields.length === 0) {
      errors.push(`sections[${sectionIndex}].fields must contain at least one field`);
      continue;
    }
    for (const [fieldIndex, field] of section.fields.entries()) {
      const prefix = `sections[${sectionIndex}].fields[${fieldIndex}]`;
      if (!field.key) errors.push(`${prefix}.key is required`);
      if (field.key && fieldKeys.has(field.key)) errors.push(`${prefix}.key must be unique`);
      if (field.key) fieldKeys.add(field.key);
      if (!field.label) errors.push(`${prefix}.label is required`);
      if (!allowedFieldTypes.has(field.type)) errors.push(`${prefix}.type is unsupported`);
      if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) {
        errors.push(`${prefix}.options is required for select fields`);
      }
      if (field.type === "rating" && !(Number.isInteger(field.scale) && field.scale >= 2)) {
        errors.push(`${prefix}.scale is required for rating fields and must be an integer >= 2`);
      }
      if (field.type === "counter" && field.step !== undefined && !(Number.isInteger(field.step) && field.step > 0)) {
        errors.push(`${prefix}.step must be a positive integer when provided`);
      }

      validateValidationRules(field.validation_rules, prefix, errors);
      validateHelpText(field, prefix, errors);
      validatePhotoConstraints(field, prefix, errors);
      validateDefaultValue(field, prefix, errors);

      const deps = validateFieldVisibilityRules(field, prefix, errors);
      if (field.key) visibilityDeps.set(field.key, deps);
    }
  }

  for (const [key, deps] of visibilityDeps.entries()) {
    for (const dep of deps) {
      if (!fieldKeys.has(dep)) {
        errors.push(`field "${key}" visibility_rules references unknown field "${dep}"`);
      }
    }
  }
  const cycle = findVisibilityCycle(visibilityDeps);
  if (cycle) {
    errors.push(`visibility_rules contain a cycle: ${cycle.join(" -> ")}`);
  }

  return errors;
}

// --- DR-17: template-level signature policy shape ---------------------------
// signature_requirements lives on a template VERSION's validation_json (the
// same jsonb column submit_policy already lives on -- reports-routes.mjs's
// version.validation_json?.submit_policy), not inside schema_json: "the
// template's signature_requirements" (DR-17) is a submission-completeness
// policy, not a per-field value-shape rule, so it is authored and stored
// alongside the other submit-time policy knob rather than attached to one
// specific field. { required: boolean, roles: [nonEmptyString, ...] }.
export function validateSignatureRequirements(value) {
  const errors = [];
  if (value === undefined || value === null) return errors;
  if (!isPlainObject(value)) {
    return ["signature_requirements must be an object"];
  }
  for (const key of Object.keys(value)) {
    if (key !== "required" && key !== "roles") {
      errors.push(`signature_requirements has an unknown key: ${key}`);
    }
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    errors.push("signature_requirements.required must be a boolean");
  }
  if (value.roles !== undefined) {
    if (
      !Array.isArray(value.roles) ||
      value.roles.some((role) => typeof role !== "string" || role.trim().length === 0)
    ) {
      errors.push("signature_requirements.roles must be an array of non-empty strings");
    } else if (new Set(value.roles).size !== value.roles.length) {
      errors.push("signature_requirements.roles must not contain duplicates");
    }
  }
  return errors;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DEFAULT_RATING_SCALE = 5;

function isEmptyValue(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function isValidCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidCalendarDateTime(value) {
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return false;
  return isValidCalendarDate(match[1]);
}

// Applies a field's `validation_rules` (min/max/regex/minLength/maxLength) to
// an already-present, already-type-checked value. min/max compare
// Number(value) (meaningful for number/counter/rating, harmlessly NaN and
// therefore skipped for anything else); minLength/maxLength/regex only ever
// apply to a string value. The regex itself was already vetted safe at
// schema-validation time (validateValidationRules, above) -- see that
// function's doc comment for the exact rule -- and the tested value is
// length-capped here as defense in depth before it is ever handed to
// `.test()`.
function applyValidationRules(field, value, errors) {
  const rules = field.validation_rules;
  if (!isPlainObject(rules)) return;

  if (isFiniteNumber(rules.min) || isFiniteNumber(rules.max)) {
    const num = Number(value);
    if (!Number.isNaN(num)) {
      if (isFiniteNumber(rules.min) && num < rules.min) {
        errors.push(`${field.label} must be at least ${rules.min}`);
      }
      if (isFiniteNumber(rules.max) && num > rules.max) {
        errors.push(`${field.label} must be at most ${rules.max}`);
      }
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(rules.minLength) && value.length < rules.minLength) {
      errors.push(`${field.label} must be at least ${rules.minLength} characters`);
    }
    if (Number.isInteger(rules.maxLength) && value.length > rules.maxLength) {
      errors.push(`${field.label} must be at most ${rules.maxLength} characters`);
    }
    if (typeof rules.regex === "string") {
      if (value.length > MAX_REGEX_INPUT_LENGTH) {
        errors.push(`${field.label} is too long to match the required pattern`);
      } else if (!new RegExp(rules.regex).test(value)) {
        errors.push(`${field.label} does not match the required pattern`);
      }
    }
  }
}

// Validates a single field's value against its schema definition, returning
// the (possibly empty) list of error messages for that field alone. Shared by
// the full and partial submission validators so both apply identical rules.
function validateFieldValue(field, value) {
  const errors = [];
  const empty = isEmptyValue(value);
  if (field.required && empty) {
    errors.push(`${field.label} is required`);
    return errors;
  }
  if (empty) return errors;

  if (field.type === "number" && Number.isNaN(Number(value))) {
    errors.push(`${field.label} must be a number`);
  }
  if (field.type === "select" && !field.options.includes(value)) {
    errors.push(`${field.label} must be one of: ${field.options.join(", ")}`);
  }
  if (field.type === "multiselect") {
    if (!Array.isArray(value)) {
      errors.push(`${field.label} must be a list of selections`);
    } else if (Array.isArray(field.options) && field.options.length > 0) {
      const invalid = value.filter((entry) => !field.options.includes(entry));
      if (invalid.length > 0) {
        errors.push(`${field.label} contains invalid selections: ${invalid.join(", ")}`);
      }
    }
  }
  if (field.type === "checkbox" && typeof value !== "boolean") {
    errors.push(`${field.label} must be true or false`);
  }
  if (field.type === "date" && !(typeof value === "string" && isValidCalendarDate(value))) {
    errors.push(`${field.label} must be a valid date (YYYY-MM-DD)`);
  }
  if (field.type === "time" && !(typeof value === "string" && TIME_PATTERN.test(value))) {
    errors.push(`${field.label} must be a valid time (HH:MM)`);
  }
  if (field.type === "datetime" && !(typeof value === "string" && isValidCalendarDateTime(value))) {
    errors.push(`${field.label} must be a valid date/time (YYYY-MM-DDTHH:MM)`);
  }
  if (field.type === "counter") {
    const num = Number(value);
    if (!Number.isInteger(num)) {
      errors.push(`${field.label} must be a whole number`);
    } else if (typeof field.step === "number" && field.step > 0 && num % field.step !== 0) {
      errors.push(`${field.label} must be a multiple of ${field.step}`);
    }
  }
  if (field.type === "rating") {
    const num = Number(value);
    const scale = Number.isInteger(field.scale) ? field.scale : DEFAULT_RATING_SCALE;
    if (!Number.isInteger(num) || num < 1 || num > scale) {
      errors.push(`${field.label} must be a whole number between 1 and ${scale}`);
    }
  }
  if ((field.type === "photo" || field.type === "signature") && !(typeof value === "string" && value.trim().length > 0)) {
    errors.push(`${field.label} must reference an uploaded file`);
  }

  if (errors.length === 0) applyValidationRules(field, value, errors);
  return errors;
}

function compareVisibility(op, actual, expected) {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "gt":
      return Number(actual) > Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    default:
      // Schema validation already rejects any op outside VISIBILITY_OPS at
      // authoring time; an unrecognized op reaching here (e.g. a template
      // saved before this rule existed) fails open -- the field stays
      // visible rather than being silently hidden by a rule nobody can name.
      return true;
  }
}

// Evaluates every field's visibility_rules against `payload`, returning the
// Set of field keys currently HIDDEN. A field with no visibility_rules is
// always visible; a field WITH rules is visible only when every rule passes
// (AND). Rules read the referenced field's raw value straight off `payload`
// -- never a hidden field's own value being cascaded/zeroed first -- so a
// chain of fields whose visibility depends on each other's raw answers
// evaluates independently per field; validateReportTemplateSchema's cycle
// check (above) is what keeps that well-defined (no field's visibility can
// depend, even transitively, on itself).
export function evaluateVisibility(schema, payload) {
  const hidden = new Set();
  for (const section of schema?.sections ?? []) {
    for (const field of section?.fields ?? []) {
      if (!field?.key) continue;
      const rules = Array.isArray(field.visibility_rules) ? field.visibility_rules : [];
      if (rules.length === 0) continue;
      const visible = rules.every((rule) => {
        if (!rule || typeof rule.field !== "string") return true;
        return compareVisibility(rule.op, payload?.[rule.field], rule.value);
      });
      if (!visible) hidden.add(field.key);
    }
  }
  return hidden;
}

// Sorted array form of evaluateVisibility, for direct use as
// validation_results.hidden_fields (reports-routes.mjs) and in test
// assertions, where a stable order matters and a Set does not serialize to
// JSON usefully.
export function hiddenFieldKeys(schema, payload) {
  return [...evaluateVisibility(schema, payload)].sort();
}

// Shared driver for the full and partial submission validators. When
// `partial` is true, fields whose key is absent from `payload` (not merely
// empty) are skipped entirely instead of being flagged as missing/required —
// this is what makes partial validation safe to run on in-progress drafts.
// A field hidden by its own visibility_rules (evaluated against the raw
// payload) is skipped unconditionally, in both modes: it is never required
// even when `required: true`, and any value submitted for it is ignored
// rather than validated against its own type/rules (DR-16).
function collectSubmissionErrors(schema, payload, { partial }) {
  const templateErrors = validateReportTemplateSchema(schema);
  if (templateErrors.length > 0) return templateErrors;
  const hidden = evaluateVisibility(schema, payload);
  const errors = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (hidden.has(field.key)) continue;
      const present = payload != null && Object.prototype.hasOwnProperty.call(payload, field.key);
      if (partial && !present) continue;
      errors.push(...validateFieldValue(field, payload?.[field.key]));
    }
  }
  return errors;
}

// Full validation: every field in the schema is checked, whether or not the
// key is present in the payload (an absent required field is still an
// error). Used at submit time, where the payload must be complete.
export function validateReportSubmission(schema, payload) {
  return collectSubmissionErrors(schema, payload, { partial: false });
}

// Partial validation: only keys actually present in `payload` are checked
// against their field rules; fields the caller hasn't answered yet are
// skipped rather than reported as missing. Used on draft create/update so an
// in-progress submission can be saved without satisfying every requirement
// up front, while whatever *is* supplied is still held to the schema's
// rules. Same error shape as validateReportSubmission (an array of message
// strings).
export function validateReportSubmissionPartial(schema, payload) {
  return collectSubmissionErrors(schema, payload, { partial: true });
}

// Returns the full set of field keys declared anywhere in the schema, used
// to reject payload keys the pinned version doesn't recognize.
export function schemaFieldKeys(schema) {
  const keys = new Set();
  for (const section of schema?.sections ?? []) {
    for (const field of section?.fields ?? []) {
      if (field?.key) keys.add(field.key);
    }
  }
  return keys;
}

// Returns the payload's keys that are not declared as fields anywhere in the
// schema, sorted for a stable, deterministic error message regardless of the
// payload's own key order.
export function unknownPayloadKeys(schema, payload) {
  const known = schemaFieldKeys(schema);
  return Object.keys(payload ?? {})
    .filter((key) => !known.has(key))
    .sort();
}

// Finds a field's definition by key anywhere in the schema, or null. Used by
// attachments-routes.mjs to look up a photo field's photo_constraints for the
// field_key an upload targets.
export function findFieldByKey(schema, key) {
  for (const section of schema?.sections ?? []) {
    for (const field of section?.fields ?? []) {
      if (field?.key === key) return field;
    }
  }
  return null;
}
