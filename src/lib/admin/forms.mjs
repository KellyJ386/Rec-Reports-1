// Boundary validators + shaping helpers for the Forms & Fields (lite) admin
// surface (custom_fields, form_definitions, form_field_bindings; 0015).
// Every validator returns { valid, errors[] } in the report-schema.mjs style so
// the API layer can map failures to a 400 with a stable error list.
//
// Form schema validation delegates to validateReportTemplateSchema from
// report-schema.mjs (the same validator the runtime submission path uses), so a
// form the builder accepts is a form the runtime can render and validate --
// they agree by construction rather than by convention.

import {
  validateReportTemplateSchema,
  isSupportedFieldType,
  supportedFieldTypes
} from "../report-schema.mjs";

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validates a custom-field registry entry: key must be snake_case, data_type
// must be one of the shared supported field types, label is required.
export function validateCustomFieldInput(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ["input must be an object"] };
  }
  if (!isNonEmptyString(input.key) || !SNAKE_CASE_RE.test(input.key)) {
    errors.push("key must be snake_case (lowercase letters, digits, underscores)");
  }
  if (!isNonEmptyString(input.label)) {
    errors.push("label is required");
  }
  if (!isSupportedFieldType(input.dataType)) {
    errors.push(`dataType must be one of: ${supportedFieldTypes.join(", ")}`);
  }
  if (input.validation !== undefined && input.validation !== null && !isPlainObject(input.validation)) {
    errors.push("validation must be an object");
  }
  if (input.entityType !== undefined && input.entityType !== null && !isNonEmptyString(input.entityType)) {
    errors.push("entityType must be a non-empty string when provided");
  }
  return { valid: errors.length === 0, errors };
}

// Validates a form definition: moduleCode + formCode are required (formCode
// snake_case so it can key a version series), and the schema is validated by
// the shared report-template validator.
export function validateFormDefinition({ moduleCode, formCode, schema } = {}) {
  const errors = [];
  if (!isNonEmptyString(moduleCode)) {
    errors.push("moduleCode is required");
  }
  if (!isNonEmptyString(formCode) || !SNAKE_CASE_RE.test(formCode)) {
    errors.push("formCode must be snake_case (lowercase letters, digits, underscores)");
  }
  for (const schemaError of validateReportTemplateSchema(schema)) {
    errors.push(`schema: ${schemaError}`);
  }
  return { valid: errors.length === 0, errors };
}

// Given the existing versions of a form_code (rows carrying version_no, or bare
// numbers), returns the next version number: max + 1, or 1 when there are none.
export function nextVersionNo(existing = []) {
  let max = 0;
  for (const entry of existing ?? []) {
    const value = typeof entry === "number" ? entry : Number(entry?.version_no);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

// Builds the patch list for publishing a draft form version. Transitions the
// target draft -> published and retires every currently-published sibling
// version of the same form_code. Returns { error } when the target is not a
// draft (only drafts can be published). publishedSiblings is the list of other
// form_definition rows with the same form_code whose status is 'published'.
export function buildFormPublish(target, publishedSiblings = []) {
  if (!isPlainObject(target)) {
    return { error: "target form definition is required" };
  }
  if (target.status !== "draft") {
    return { error: `only draft forms can be published (target is ${target.status ?? "unknown"})` };
  }
  const retirements = [];
  for (const sibling of publishedSiblings ?? []) {
    if (!sibling || sibling.id === target.id) continue;
    if (sibling.status !== "published") continue;
    retirements.push({ id: sibling.id, patch: { status: "retired" } });
  }
  return {
    target: { id: target.id, patch: { status: "published" } },
    retirements
  };
}
