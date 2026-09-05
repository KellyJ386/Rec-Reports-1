// Boundary validators + shaping helpers for the Daily Reports template
// management surface (report_templates / report_template_versions; 0002,
// write RLS added by 0028). Every validator returns { valid, errors[] } in
// the report-schema.mjs style so the API layer can map failures to a 400 with
// a stable error list -- mirroring src/lib/admin/forms.mjs, which does the
// same job for the parallel form_definitions surface.
//
// Version schema validation delegates to validateReportTemplateSchema from
// report-schema.mjs (the same validator the runtime submission path uses), so
// a template version this lib accepts is a template version the runtime can
// render and validate against -- they agree by construction, not convention.

import { validateReportTemplateSchema } from "./report-schema.mjs";

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validates the shape of a new/edited report template: code must be
// snake_case (it keys the (facility_id, code) unique constraint from 0002),
// name is required, departmentId is optional but must be a non-empty string
// when provided.
export function validateTemplateInput({ code, name, departmentId } = {}) {
  const errors = [];
  if (!isNonEmptyString(code) || !SNAKE_CASE_RE.test(code)) {
    errors.push("code must be snake_case (lowercase letters, digits, underscores)");
  }
  if (!isNonEmptyString(name)) {
    errors.push("name is required");
  }
  if (departmentId !== undefined && departmentId !== null && !isNonEmptyString(departmentId)) {
    errors.push("departmentId must be a non-empty string when provided");
  }
  return { valid: errors.length === 0, errors };
}

// Given the existing versions of a template (rows carrying version_number, or
// bare numbers), returns the next version number: max + 1, or 1 when there
// are none. Numbering starts at 1, same as forms.mjs's nextVersionNo.
export function nextTemplateVersionNumber(existing = []) {
  let max = 0;
  for (const entry of existing ?? []) {
    const value = typeof entry === "number" ? entry : Number(entry?.version_number);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

// Builds the patch for editing a draft version's schema in place, so a
// template author can iterate on a draft without minting a new version per
// save. Only a not-yet-published version is editable -- published versions
// are immutable history (enforced again, independently, by 0028's
// fn_report_template_version_immutable trigger). Returns { error } when the
// target is already published (maps to 409), { errors } when the schema
// fails the shared template validator (maps to 400), else
// { target: { id, patch } }.
export function buildTemplateDraftUpdate(version, schema) {
  if (!isPlainObject(version)) {
    return { error: "target template version is required" };
  }
  if (version.is_published) {
    return { error: `only a draft version can be edited (version ${version.id ?? "unknown"} is already published)` };
  }
  const errors = validateReportTemplateSchema(schema).map((schemaError) => `schema: ${schemaError}`);
  if (errors.length > 0) {
    return { errors };
  }
  return { target: { id: version.id, patch: { schema_json: schema } } };
}

// Builds the patch pair for publishing a draft version: the version itself
// flips is_published -> true, and its parent template's active_version/status
// move to point at it. Returns { error } when the version is not a draft
// (already published -- only drafts can be published), or when the version
// does not belong to the given template. Both patches are returned together
// (versionPatch, templatePatch) so the route layer applies them as one
// logical publish operation.
export function buildTemplatePublish(template, version) {
  if (!isPlainObject(template)) {
    return { error: "target template is required" };
  }
  if (!isPlainObject(version)) {
    return { error: "target template version is required" };
  }
  if (version.template_id !== undefined && version.template_id !== template.id) {
    return { error: "template version does not belong to the target template" };
  }
  if (version.is_published) {
    return { error: `only a draft version can be published (version ${version.id ?? "unknown"} is already published)` };
  }
  return {
    versionPatch: { id: version.id, patch: { is_published: true } },
    templatePatch: {
      id: template.id,
      patch: { active_version: version.version_number, status: "published" }
    }
  };
}
