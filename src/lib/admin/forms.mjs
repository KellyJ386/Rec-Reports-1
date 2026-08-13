// Boundary validators + shaping helpers for the Forms & Fields (lite) admin
// surface (custom_fields, form_definitions, form_field_bindings; 0015).
// Every validator returns { valid, errors[] } in the report-schema.mjs style so
// the API layer can map failures to a 400 with a stable error list.
//
// Form schema validation delegates to validateReportTemplateSchema from
// report-schema.mjs (the same validator the runtime submission path uses), so a
// form the builder accepts is a form the runtime can render and validate --
// they agree by construction rather than by convention.
//
// buildFormPromotion (DR-06, plans/DAILY_REPORTS_PLAN.md) bridges this
// authoring surface to the parallel report_templates/report_template_versions
// governance store (src/lib/report-templates.mjs): form_definitions stays the
// only place a form is drafted and edited, and "promote" materializes a
// published daily_reports form into that store rather than forking a second
// authoring UI. It reuses nextTemplateVersionNumber from report-templates.mjs
// rather than re-deriving version-numbering semantics.

import {
  validateReportTemplateSchema,
  isSupportedFieldType,
  supportedFieldTypes
} from "../report-schema.mjs";
import { nextTemplateVersionNumber } from "../report-templates.mjs";

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

// Builds the patch for editing a draft version's schema in place, so the
// builder canvas can iterate on a draft without minting a new version per
// save. Only drafts are editable -- published and retired versions are
// immutable history. Returns { error } when the target is not a draft (maps
// to 409), { errors } when the schema fails the shared template validator
// (maps to 400), else { target: { id, patch } }.
export function buildFormDraftUpdate(target, schema) {
  if (!isPlainObject(target)) {
    return { error: "target form definition is required" };
  }
  if (target.status !== "draft") {
    return { error: `only draft forms can be edited (target is ${target.status ?? "unknown"})` };
  }
  const errors = validateReportTemplateSchema(schema).map((schemaError) => `schema: ${schemaError}`);
  if (errors.length > 0) {
    return { errors };
  }
  return { target: { id: target.id, patch: { schema_jsonb: schema } } };
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

// Builds the write plan for promoting a published daily_reports form into the
// report_templates/report_template_versions governance store. Pure mapping --
// the route layer owns the actual reads/writes and permission guards.
//
// Only a published form_definitions row can be promoted (a draft has no
// frozen schema yet), and only one whose module_code is 'daily_reports' --
// this bridge exists solely for that module, not as a general form->template
// converter. Both failures return { error } (the route maps this to 409,
// matching buildFormPublish/buildTemplatePublish's convention for
// state-transition failures).
//
// form_code becomes both the template's code and its name -- form_definitions
// (0015) carries no separate display-name column to promote instead, and
// form_code is already snake_case-validated, which also satisfies
// validateTemplateInput's code shape.
//
// existingTemplate is the report_templates row already at (facility_id, code)
// = (form.facility_id, form.form_code), or null when none exists yet.
// existingVersions is that template's version rows (or bare numbers), used
// with nextTemplateVersionNumber the same way report-templates-routes.mjs's
// POST /report-templates/:id/versions numbers a new version -- so
// re-promoting after a form is re-published always mints version n+1 rather
// than colliding with the last-promoted version.
//
// schema_jsonb is copied byte-identical into versionRow.schema_json (the same
// object/value, no re-shaping) so the promoted version validates and renders
// exactly like the form did.
//
// versionRow deliberately omits template_id: for a brand-new template its id
// only exists after the route's insert returns, and for an existing template
// the route already holds it (templatePatch.id) -- either way template_id is
// the route's to attach, not this pure function's to guess.
//
// Returns:
//   - existingTemplate is null:      { templateRow, versionRow }
//     templateRow is insert data for a new report_templates row, created as a
//     draft; the route publishes it once the version row it creates is
//     itself is_published, then applies the same activation shape below.
//   - existingTemplate is provided:  { templatePatch, versionRow }
//     templatePatch is already the full activation patch (active_version +
//     status), since the target template's id and the new version's number
//     are both known up front -- the route only needs to apply it (after
//     inserting versionRow) rather than compute it itself.
export function buildFormPromotion(form, existingTemplate, existingVersions = []) {
  if (!isPlainObject(form)) {
    return { error: "form definition is required" };
  }
  if (form.status !== "published") {
    return { error: `only a published form can be promoted (form is ${form.status ?? "unknown"})` };
  }
  if (form.module_code !== "daily_reports") {
    return { error: `only daily_reports forms can be promoted (form module is ${form.module_code ?? "unknown"})` };
  }

  const versionNumber = nextTemplateVersionNumber(existingVersions ?? []);
  const versionRow = {
    facility_id: form.facility_id,
    version_number: versionNumber,
    schema_json: form.schema_jsonb,
    is_published: true
  };

  if (isPlainObject(existingTemplate)) {
    return {
      templatePatch: {
        id: existingTemplate.id,
        patch: { active_version: versionNumber, status: "published" }
      },
      versionRow
    };
  }

  return {
    templateRow: {
      facility_id: form.facility_id,
      department_id: null,
      code: form.form_code,
      name: form.form_code,
      description: null,
      status: "draft"
    },
    versionRow
  };
}
