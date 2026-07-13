import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCustomFieldInput,
  validateFormDefinition,
  buildFormDraftUpdate,
  nextVersionNo,
  buildFormPublish
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
