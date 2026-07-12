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

export function validateReportSubmission(schema, payload) {
  const templateErrors = validateReportTemplateSchema(schema);
  if (templateErrors.length > 0) return templateErrors;
  const errors = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const value = payload?.[field.key];
      const empty = isEmptyValue(value);
      if (field.required && empty) {
        errors.push(`${field.label} is required`);
        continue;
      }
      if (empty) continue;

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
    }
  }
  return errors;
}
