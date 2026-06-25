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

export function validateReportSubmission(schema, payload) {
  const templateErrors = validateReportTemplateSchema(schema);
  if (templateErrors.length > 0) return templateErrors;
  const errors = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const value = payload?.[field.key];
      if (field.required && (value === undefined || value === null || value === "")) {
        errors.push(`${field.label} is required`);
      }
      if (field.type === "number" && value !== undefined && value !== "" && Number.isNaN(Number(value))) {
        errors.push(`${field.label} must be a number`);
      }
      if (field.type === "select" && value && !field.options.includes(value)) {
        errors.push(`${field.label} must be one of: ${field.options.join(", ")}`);
      }
    }
  }
  return errors;
}
