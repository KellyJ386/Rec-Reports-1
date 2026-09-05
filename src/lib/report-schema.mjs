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
  "signature"
]);

// The shared set of supported field/data types, exported so the Forms & Fields
// builder (src/lib/admin/forms.mjs) validates custom-field data types against
// exactly the same vocabulary the runtime submission validator enforces.
export const supportedFieldTypes = Object.freeze([...allowedFieldTypes]);

export function isSupportedFieldType(type) {
  return allowedFieldTypes.has(type);
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
    }
  }
  return errors;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isEmptyValue(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function isValidCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
  if ((field.type === "photo" || field.type === "signature") && !(typeof value === "string" && value.trim().length > 0)) {
    errors.push(`${field.label} must reference an uploaded file`);
  }
  return errors;
}

// Shared driver for the full and partial submission validators. When
// `partial` is true, fields whose key is absent from `payload` (not merely
// empty) are skipped entirely instead of being flagged as missing/required —
// this is what makes partial validation safe to run on in-progress drafts.
function collectSubmissionErrors(schema, payload, { partial }) {
  const templateErrors = validateReportTemplateSchema(schema);
  if (templateErrors.length > 0) return templateErrors;
  const errors = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
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
