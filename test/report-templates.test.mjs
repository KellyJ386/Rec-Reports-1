import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTemplateInput,
  nextTemplateVersionNumber,
  buildTemplateDraftUpdate,
  buildTemplatePublish
} from "../src/lib/report-templates.mjs";

const VALID_SCHEMA = {
  sections: [
    { title: "Fields", fields: [{ key: "pool_ready", label: "Pool ready", type: "text", required: true }] }
  ]
};

test("validateTemplateInput accepts a snake_case code and a name", () => {
  const result = validateTemplateInput({ code: "opening_checklist", name: "Opening Checklist" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateTemplateInput rejects a non-snake_case code", () => {
  const result = validateTemplateInput({ code: "OpeningChecklist", name: "Opening Checklist" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /snake_case/.test(e)));
});

test("validateTemplateInput requires a name", () => {
  const result = validateTemplateInput({ code: "opening_checklist", name: "  " });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("name is required"));
});

test("validateTemplateInput allows a missing departmentId but rejects an empty one", () => {
  const withoutDept = validateTemplateInput({ code: "opening_checklist", name: "Opening" });
  assert.equal(withoutDept.valid, true);

  const emptyDept = validateTemplateInput({ code: "opening_checklist", name: "Opening", departmentId: "  " });
  assert.equal(emptyDept.valid, false);
  assert.ok(emptyDept.errors.some((e) => /departmentId/.test(e)));
});

test("nextTemplateVersionNumber returns 1 when there are no existing versions", () => {
  assert.equal(nextTemplateVersionNumber([]), 1);
  assert.equal(nextTemplateVersionNumber(), 1);
});

test("nextTemplateVersionNumber returns max + 1 from rows or bare numbers", () => {
  assert.equal(nextTemplateVersionNumber([{ version_number: 1 }, { version_number: 3 }, { version_number: 2 }]), 4);
  assert.equal(nextTemplateVersionNumber([1, 5, 2]), 6);
});

test("buildTemplateDraftUpdate shapes a schema_json patch for a non-published version", () => {
  const plan = buildTemplateDraftUpdate({ id: "v-2", is_published: false }, VALID_SCHEMA);
  assert.ok(!plan.error);
  assert.ok(!plan.errors);
  assert.deepEqual(plan.target, { id: "v-2", patch: { schema_json: VALID_SCHEMA } });
});

test("buildTemplateDraftUpdate refuses to edit a published version", () => {
  const plan = buildTemplateDraftUpdate({ id: "v-1", is_published: true }, VALID_SCHEMA);
  assert.ok(plan.error);
  assert.ok(/already published/.test(plan.error));
  assert.ok(!plan.target);
});

test("buildTemplateDraftUpdate rejects an invalid schema with prefixed errors", () => {
  const plan = buildTemplateDraftUpdate({ id: "v-2", is_published: false }, { sections: [] });
  assert.ok(Array.isArray(plan.errors));
  assert.ok(plan.errors.length > 0);
  assert.ok(plan.errors.every((error) => error.startsWith("schema: ")));
  assert.ok(!plan.target);
});

test("buildTemplateDraftUpdate requires a target object", () => {
  const plan = buildTemplateDraftUpdate(null, VALID_SCHEMA);
  assert.ok(plan.error);
});

test("buildTemplatePublish shapes the version patch and the template patch", () => {
  const template = { id: "t-1" };
  const version = { id: "v-2", template_id: "t-1", version_number: 2, is_published: false };
  const plan = buildTemplatePublish(template, version);
  assert.ok(!plan.error);
  assert.deepEqual(plan.versionPatch, { id: "v-2", patch: { is_published: true } });
  assert.deepEqual(plan.templatePatch, { id: "t-1", patch: { active_version: 2, status: "published" } });
});

test("buildTemplatePublish refuses to publish an already-published version", () => {
  const plan = buildTemplatePublish({ id: "t-1" }, { id: "v-1", template_id: "t-1", version_number: 1, is_published: true });
  assert.ok(plan.error);
  assert.ok(/already published/.test(plan.error));
  assert.ok(!plan.versionPatch);
  assert.ok(!plan.templatePatch);
});

test("buildTemplatePublish refuses a version that does not belong to the template", () => {
  const plan = buildTemplatePublish(
    { id: "t-1" },
    { id: "v-2", template_id: "t-2", version_number: 1, is_published: false }
  );
  assert.ok(plan.error);
  assert.ok(!plan.versionPatch);
  assert.ok(!plan.templatePatch);
});

test("buildTemplatePublish requires target and version objects", () => {
  assert.ok(buildTemplatePublish(null, { id: "v-1" }).error);
  assert.ok(buildTemplatePublish({ id: "t-1" }, null).error);
});
