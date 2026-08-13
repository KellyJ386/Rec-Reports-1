import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCustomFieldInput,
  validateFormDefinition,
  buildFormDraftUpdate,
  nextVersionNo,
  buildFormPublish,
  buildFormPromotion
} from "../src/lib/admin/forms.mjs";

const VALID_SCHEMA = {
  sections: [
    { title: "Fields", fields: [{ key: "pool_ready", label: "Pool ready", type: "text", required: true }] }
  ]
};

test("validateCustomFieldInput accepts a snake_case key with a supported type", () => {
  const result = validateCustomFieldInput({ key: "pool_ready", label: "Pool ready", dataType: "select" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateCustomFieldInput rejects a non-snake_case key", () => {
  const result = validateCustomFieldInput({ key: "PoolReady", label: "Pool", dataType: "text" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /snake_case/.test(e)));
});

test("validateCustomFieldInput rejects an unsupported data type", () => {
  const result = validateCustomFieldInput({ key: "ok_key", label: "OK", dataType: "wysiwyg" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /dataType must be one of/.test(e)));
});

test("validateCustomFieldInput requires a label", () => {
  const result = validateCustomFieldInput({ key: "ok_key", label: "  ", dataType: "text" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("label is required"));
});

test("validateFormDefinition delegates schema validation to the shared validator", () => {
  const ok = validateFormDefinition({ moduleCode: "daily_reports", formCode: "opening", schema: VALID_SCHEMA });
  assert.equal(ok.valid, true);

  const bad = validateFormDefinition({ moduleCode: "daily_reports", formCode: "opening", schema: { sections: [] } });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /^schema:/.test(e)));
});

test("validateFormDefinition requires moduleCode and snake_case formCode", () => {
  const result = validateFormDefinition({ moduleCode: "", formCode: "Not-Snake", schema: VALID_SCHEMA });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("moduleCode is required"));
  assert.ok(result.errors.some((e) => /formCode must be snake_case/.test(e)));
});

test("nextVersionNo returns 1 when there are no existing versions", () => {
  assert.equal(nextVersionNo([]), 1);
  assert.equal(nextVersionNo(), 1);
});

test("nextVersionNo returns max + 1 from rows or bare numbers", () => {
  assert.equal(nextVersionNo([{ version_no: 1 }, { version_no: 3 }, { version_no: 2 }]), 4);
  assert.equal(nextVersionNo([1, 5, 2]), 6);
});

test("buildFormPublish transitions the draft and retires published siblings", () => {
  const target = { id: "f-3", status: "draft", form_code: "opening" };
  const siblings = [
    { id: "f-1", status: "published" },
    { id: "f-2", status: "retired" },
    { id: "f-3", status: "draft" }
  ];
  const plan = buildFormPublish(target, siblings);
  assert.deepEqual(plan.target, { id: "f-3", patch: { status: "published" } });
  assert.deepEqual(plan.retirements, [{ id: "f-1", patch: { status: "retired" } }]);
});

test("buildFormPublish refuses to publish a non-draft target", () => {
  const plan = buildFormPublish({ id: "f-1", status: "published" }, []);
  assert.ok(plan.error);
  assert.ok(!plan.target);
});

test("buildFormDraftUpdate shapes a schema patch for a draft target", () => {
  const plan = buildFormDraftUpdate({ id: "f-2", status: "draft" }, VALID_SCHEMA);
  assert.ok(!plan.error);
  assert.ok(!plan.errors);
  assert.deepEqual(plan.target, { id: "f-2", patch: { schema_jsonb: VALID_SCHEMA } });
});

test("buildFormDraftUpdate refuses to edit a non-draft target", () => {
  const plan = buildFormDraftUpdate({ id: "f-1", status: "published" }, VALID_SCHEMA);
  assert.ok(plan.error);
  assert.ok(/only draft/.test(plan.error));
  assert.ok(!plan.target);
});

test("buildFormDraftUpdate rejects an invalid schema with prefixed errors", () => {
  const plan = buildFormDraftUpdate({ id: "f-2", status: "draft" }, { sections: [] });
  assert.ok(Array.isArray(plan.errors));
  assert.ok(plan.errors.length > 0);
  assert.ok(plan.errors.every((error) => error.startsWith("schema: ")));
  assert.ok(!plan.target);
});

test("buildFormDraftUpdate requires a target object", () => {
  const plan = buildFormDraftUpdate(null, VALID_SCHEMA);
  assert.ok(plan.error);
});

// --- buildFormPromotion (DR-06) ---------------------------------------------

const PUBLISHED_FORM = {
  id: "form-1",
  facility_id: "fac-1",
  module_code: "daily_reports",
  form_code: "opening_checklist",
  status: "published",
  schema_jsonb: VALID_SCHEMA
};

test("buildFormPromotion creates a new template + first version when none exists yet", () => {
  const plan = buildFormPromotion(PUBLISHED_FORM, null, []);
  assert.ok(!plan.error);
  assert.deepEqual(plan.templateRow, {
    facility_id: "fac-1",
    department_id: null,
    code: "opening_checklist",
    name: "opening_checklist",
    description: null,
    status: "draft"
  });
  assert.equal(plan.versionRow.version_number, 1);
  assert.equal(plan.versionRow.is_published, true);
  assert.equal(plan.versionRow.facility_id, "fac-1");
  // schema_jsonb must be copied byte-identical (same value, not a re-shaped copy).
  assert.strictEqual(plan.versionRow.schema_json, PUBLISHED_FORM.schema_jsonb);
  assert.deepEqual(plan.versionRow.schema_json, VALID_SCHEMA);
});

test("buildFormPromotion mints version n+1 and moves active_version when a template already exists", () => {
  const existingTemplate = { id: "tpl-1", facility_id: "fac-1", code: "opening_checklist" };
  const existingVersions = [{ version_number: 1 }, { version_number: 2 }];
  const plan = buildFormPromotion(PUBLISHED_FORM, existingTemplate, existingVersions);
  assert.ok(!plan.error);
  assert.ok(!plan.templateRow);
  assert.deepEqual(plan.templatePatch, {
    id: "tpl-1",
    patch: { active_version: 3, status: "published" }
  });
  assert.equal(plan.versionRow.version_number, 3);
  assert.equal(plan.versionRow.is_published, true);
  assert.strictEqual(plan.versionRow.schema_json, PUBLISHED_FORM.schema_jsonb);
});

test("buildFormPromotion re-promoting after a re-publish mints the next version again", () => {
  const existingTemplate = { id: "tpl-1", facility_id: "fac-1", code: "opening_checklist" };
  const firstPromotion = buildFormPromotion(PUBLISHED_FORM, existingTemplate, []);
  assert.equal(firstPromotion.versionRow.version_number, 1);

  const secondPromotion = buildFormPromotion(PUBLISHED_FORM, existingTemplate, [{ version_number: 1 }]);
  assert.equal(secondPromotion.versionRow.version_number, 2);
  assert.deepEqual(secondPromotion.templatePatch.patch, { active_version: 2, status: "published" });
  // Byte-identity holds across re-promotion too.
  assert.deepEqual(secondPromotion.versionRow.schema_json, PUBLISHED_FORM.schema_jsonb);
});

test("buildFormPromotion refuses to promote a draft form", () => {
  const plan = buildFormPromotion({ ...PUBLISHED_FORM, status: "draft" }, null, []);
  assert.ok(plan.error);
  assert.ok(/published/.test(plan.error));
  assert.ok(!plan.templateRow);
  assert.ok(!plan.versionRow);
});

test("buildFormPromotion refuses to promote a form outside module_code daily_reports", () => {
  const plan = buildFormPromotion({ ...PUBLISHED_FORM, module_code: "incidents" }, null, []);
  assert.ok(plan.error);
  assert.ok(/daily_reports/.test(plan.error));
  assert.ok(!plan.templateRow);
});

test("buildFormPromotion requires a form object", () => {
  const plan = buildFormPromotion(null, null, []);
  assert.ok(plan.error);
});
