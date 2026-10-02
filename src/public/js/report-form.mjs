// Pure, DOM-free helpers behind the schema-driven report entry UI (DR-13) and
// the manager review inbox's detail pane (DR-14). Everything here operates on
// plain data -- no `document`, no fetch -- so it is importable and testable
// under node:test without a browser, and so app.js's DOM-construction code
// stays a thin, easily-audited layer on top of these three functions.
//
// The three exports mirror the request/response lifecycle of one field-level
// interaction:
//   fieldDescriptors  -- schema_json (as stored on report_template_versions,
//                        see src/lib/report-schema.mjs) -> a flat, ordered
//                        list of per-field descriptors carrying their section
//                        grouping, so app.js can render a stepper without
//                        re-deriving structure from the raw schema shape.
//   collectPayload    -- the in-memory form state (one raw value per field
//                        key, as read straight off form controls) -> the
//                        typed payload object the reports API expects,
//                        coercing per-field-type and dropping empty answers
//                        so partial (draft) validation on the server treats
//                        them as "not yet answered" rather than "answered
//                        wrong".
//   applyServerErrors -- the flat array of message strings the reports API
//                        returns on a 422 (src/lib/http/reports-routes.mjs
//                        forwards src/lib/report-schema.mjs's
//                        `${field.label} ...` messages verbatim) -> a
//                        {fieldErrors, formErrors} split so app.js can show
//                        each error inline under the field it belongs to,
//                        falling back to a form-level banner for anything
//                        that isn't about one specific field (e.g. the
//                        "unknown keys" message, or a plain {error} string).

// Builds the ordered, flattened list of field descriptors for a template
// version's schema_json. Each descriptor carries everything app.js needs to
// render one field's control and to place it correctly in a stepper:
//   key, label, type, required, options (select/multiselect only),
//   helpText (tolerated as either `helpText` or `help_text`, since the field
//   attribute isn't validated/normalized by report-schema.mjs yet),
//   sectionIndex, sectionTitle, fieldIndex (position within its section),
//   order (position across the whole schema, section by section).
// A missing/malformed schema (no `sections` array) yields an empty list
// rather than throwing -- callers render "no fields" instead of crashing.
export function fieldDescriptors(schemaJson) {
  const sections = Array.isArray(schemaJson?.sections) ? schemaJson.sections : [];
  const descriptors = [];
  let order = 0;
  sections.forEach((section, sectionIndex) => {
    const fields = Array.isArray(section?.fields) ? section.fields : [];
    fields.forEach((field, fieldIndex) => {
      descriptors.push({
        key: field?.key,
        label: field?.label,
        type: field?.type,
        required: !!field?.required,
        options: Array.isArray(field?.options) ? [...field.options] : undefined,
        helpText: field?.helpText ?? field?.help_text ?? undefined,
        // DR-16: counter's optional step and rating's required scale, passed
        // through so the runtime <input> can carry the matching min/max/step
        // attributes (buildFieldInput, app.js) instead of rendering a bare
        // unconstrained number box.
        step: typeof field?.step === "number" ? field.step : undefined,
        scale: typeof field?.scale === "number" ? field.scale : undefined,
        sectionIndex,
        sectionTitle: section?.title,
        fieldIndex,
        order: order++
      });
    });
  });
  return descriptors;
}

// A value counts as "not yet answered" the same way
// src/lib/report-schema.mjs's isEmptyValue does, except strings are trimmed
// first so whitespace-only input (a user tapping into a field and back out)
// doesn't get treated as a real answer.
function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// Coerces one field's raw form-state value to the type the server-side
// validator (src/lib/report-schema.mjs) expects. Deliberately mirrors that
// validator's own coercion (`Number(value)`) rather than pre-validating here:
// a non-numeric "number" value is passed through as the original trimmed
// string instead of being turned into NaN/null, so the server's
// `${label} must be a number` error still fires correctly instead of a
// wrong-looking `${label} is required`.
function coerceFieldValue(descriptor, raw) {
  if (raw === undefined || raw === null) return raw;
  switch (descriptor.type) {
    // counter/rating are both whole-number types answered through the same
    // <input type="number">-shaped control as "number" -- same coercion.
    case "number":
    case "counter":
    case "rating": {
      if (typeof raw === "number") return raw;
      const trimmed = String(raw).trim();
      if (trimmed === "") return "";
      const asNumber = Number(trimmed);
      return Number.isFinite(asNumber) ? asNumber : trimmed;
    }
    case "checkbox":
      return typeof raw === "boolean" ? raw : raw === "true";
    case "multiselect":
      return Array.isArray(raw) ? raw.filter((entry) => entry !== "" && entry !== null && entry !== undefined) : raw;
    default:
      return raw;
  }
}

// Turns raw form state (one entry per field key, as read straight off DOM
// controls: strings from text/number/date/time/select inputs, booleans from
// checkboxes, arrays from multiselect) into the payload object the reports
// API's create/PATCH routes accept. Only keys present in `formState` are
// considered (so a field the user hasn't touched this session is simply
// absent, matching the server's partial-validation semantics), and any
// value that coerces to empty is dropped rather than sent as "" -- an empty
// answer must look identical to no answer, both to the server's partial
// validator and to a subsequent full validator run at submit time.
export function collectPayload(descriptors, formState) {
  const payload = {};
  if (!formState) return payload;
  for (const descriptor of descriptors) {
    if (!descriptor?.key) continue;
    if (!Object.prototype.hasOwnProperty.call(formState, descriptor.key)) continue;
    const value = coerceFieldValue(descriptor, formState[descriptor.key]);
    if (isEmpty(value)) continue;
    payload[descriptor.key] = value;
  }
  return payload;
}

// Maps the reports API's 422 error strings back onto the fields they
// describe. Every per-field message src/lib/report-schema.mjs emits starts
// with the field's exact label (`${field.label} is required`, `${field.label}
// must be a number`, ...), so a message is attributed to a field when it
// equals that field's label or starts with `${label} ` -- checked longest
// label first so one field's label being a prefix of another's (e.g. "Pool"
// vs. "Pool ready") can't steal a match that belongs to the more specific
// field. Anything that doesn't match any field's label (the unknown-payload-
// keys message, a bare {error: "..."} string, etc.) is returned as a
// form-level error instead of being silently dropped.
export function applyServerErrors(descriptors, errors) {
  const messages = Array.isArray(errors) ? errors : typeof errors === "string" ? [errors] : [];
  const byLabelLengthDesc = [...(descriptors ?? [])]
    .filter((descriptor) => typeof descriptor?.label === "string" && descriptor.label.length > 0)
    .sort((a, b) => b.label.length - a.label.length);

  const fieldErrors = {};
  const formErrors = [];

  for (const message of messages) {
    if (typeof message !== "string" || message.trim() === "") continue;
    const match = byLabelLengthDesc.find(
      (descriptor) => message === descriptor.label || message.startsWith(`${descriptor.label} `)
    );
    if (match) {
      if (!fieldErrors[match.key]) fieldErrors[match.key] = [];
      fieldErrors[match.key].push(message);
    } else {
      formErrors.push(message);
    }
  }

  return { fieldErrors, formErrors };
}
