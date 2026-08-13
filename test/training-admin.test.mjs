import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCourseInput,
  validateCourseUpdateInput,
  validateCourseModuleInput,
  validateCourseModuleUpdateInput
} from "../src/lib/admin/training.mjs";

test("validateCourseInput requires code and title", () => {
  assert.equal(validateCourseInput({ code: "c1", title: "Course One" }).valid, true);
  const missing = validateCourseInput({});
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => /code/.test(e)));
  assert.ok(missing.errors.some((e) => /title/.test(e)));
});

test("validateCourseInput rejects a bad status but allows a valid one", () => {
  assert.equal(validateCourseInput({ code: "c", title: "t", status: "published" }).valid, true);
  assert.equal(validateCourseInput({ code: "c", title: "t", status: "nope" }).valid, false);
});

test("validateCourseInput rejects a non-string description", () => {
  assert.equal(validateCourseInput({ code: "c", title: "t", description: 5 }).valid, false);
  assert.equal(validateCourseInput({ code: "c", title: "t", description: null }).valid, true);
});

test("validateCourseUpdateInput allows an empty patch and validates present fields", () => {
  assert.equal(validateCourseUpdateInput({}).valid, true);
  assert.equal(validateCourseUpdateInput({ code: "" }).valid, false);
  assert.equal(validateCourseUpdateInput({ title: "" }).valid, false);
  assert.equal(validateCourseUpdateInput({ status: "archived" }).valid, true);
  assert.equal(validateCourseUpdateInput({ status: "bogus" }).valid, false);
});

test("validateCourseModuleInput requires moduleType, title, and a non-negative integer orderNo", () => {
  assert.equal(
    validateCourseModuleInput({ moduleType: "video", title: "Intro", orderNo: 0 }).valid,
    true
  );
  const missing = validateCourseModuleInput({});
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => /moduleType/.test(e)));
  assert.ok(missing.errors.some((e) => /title/.test(e)));
  assert.ok(missing.errors.some((e) => /orderNo/.test(e)));
});

test("validateCourseModuleInput rejects an unknown moduleType", () => {
  assert.equal(
    validateCourseModuleInput({ moduleType: "webinar", title: "t", orderNo: 1 }).valid,
    false
  );
});

test("validateCourseModuleInput rejects a negative or non-integer orderNo", () => {
  assert.equal(validateCourseModuleInput({ moduleType: "pdf", title: "t", orderNo: -1 }).valid, false);
  assert.equal(validateCourseModuleInput({ moduleType: "pdf", title: "t", orderNo: 1.5 }).valid, false);
  assert.equal(validateCourseModuleInput({ moduleType: "pdf", title: "t", orderNo: "1" }).valid, false);
});

test("validateCourseModuleInput requires content to be an object when present", () => {
  assert.equal(
    validateCourseModuleInput({ moduleType: "sop_link", title: "t", orderNo: 1, content: { url: "https://x" } }).valid,
    true
  );
  assert.equal(
    validateCourseModuleInput({ moduleType: "sop_link", title: "t", orderNo: 1, content: "https://x" }).valid,
    false
  );
  assert.equal(
    validateCourseModuleInput({ moduleType: "sop_link", title: "t", orderNo: 1, content: [] }).valid,
    false
  );
});

test("validateCourseModuleInput rejects a non-boolean required flag", () => {
  assert.equal(
    validateCourseModuleInput({ moduleType: "checklist", title: "t", orderNo: 1, required: "yes" }).valid,
    false
  );
  assert.equal(
    validateCourseModuleInput({ moduleType: "checklist", title: "t", orderNo: 1, required: false }).valid,
    true
  );
});

test("validateCourseModuleUpdateInput allows an empty patch and validates present fields", () => {
  assert.equal(validateCourseModuleUpdateInput({}).valid, true);
  assert.equal(validateCourseModuleUpdateInput({ moduleType: "quiz" }).valid, true);
  assert.equal(validateCourseModuleUpdateInput({ moduleType: "bogus" }).valid, false);
  assert.equal(validateCourseModuleUpdateInput({ title: "" }).valid, false);
  assert.equal(validateCourseModuleUpdateInput({ orderNo: -1 }).valid, false);
  assert.equal(validateCourseModuleUpdateInput({ orderNo: 3 }).valid, true);
  assert.equal(validateCourseModuleUpdateInput({ content: [] }).valid, false);
  assert.equal(validateCourseModuleUpdateInput({ required: 1 }).valid, false);
});
