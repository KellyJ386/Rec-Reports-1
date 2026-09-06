import test from "node:test";
import assert from "node:assert/strict";
import {
  findUnusedBindings,
  findDuplicateImports,
  findInnerHtmlInterpolationViolations
} from "../scripts/lint.mjs";

// P-11 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2A): exercises the
// AST-free heuristics in scripts/lint.mjs directly against small fixture
// strings, independent of whatever the real tree currently contains -- so a
// future change to the checker's logic gets caught here even if the tree
// itself stays clean.

test("findUnusedBindings flags an import bound but never referenced again", () => {
  const fixture = 'import { used, unused } from "./helpers.mjs";\nconsole.log(used);\n';
  const findings = findUnusedBindings(fixture, "fixture.mjs");
  assert.equal(findings.length, 1);
  assert.match(findings[0], /fixture\.mjs:1: unused import 'unused'/);
});

test("findUnusedBindings does not flag an import that is referenced elsewhere in the file", () => {
  const fixture = 'import { used } from "./helpers.mjs";\nconsole.log(used);\n';
  assert.deepEqual(findUnusedBindings(fixture, "fixture.mjs"), []);
});

test("findUnusedBindings does not flag a binding used only inside a template-string interpolation", () => {
  const fixture = 'import { name } from "./helpers.mjs";\nconst greeting = `hello ${name}`;\nconsole.log(greeting);\n';
  assert.deepEqual(findUnusedBindings(fixture, "fixture.mjs"), []);
});

test("findUnusedBindings does not flag an unused top-level const that is exported", () => {
  const fixture = "export const READ = \"reports.read\";\n";
  assert.deepEqual(findUnusedBindings(fixture, "fixture.mjs"), []);
});

test("findUnusedBindings does not flag a binding exported later via an export list", () => {
  const fixture = 'const helper = () => 1;\nexport { helper };\n';
  assert.deepEqual(findUnusedBindings(fixture, "fixture.mjs"), []);
});

test("findUnusedBindings flags an unreferenced top-level const", () => {
  const fixture = 'const COLUMNS = "id,name";\nconst OTHER = "id,other";\nconsole.log(OTHER);\n';
  const findings = findUnusedBindings(fixture, "fixture.mjs");
  assert.equal(findings.length, 1);
  assert.match(findings[0], /fixture\.mjs:1: unused const 'COLUMNS'/);
});

test("findDuplicateImports flags a second import statement from the same specifier", () => {
  const fixture = 'import { a } from "./x.mjs";\nimport { b } from "./x.mjs";\nconsole.log(a, b);\n';
  const findings = findDuplicateImports(fixture, "fixture.mjs");
  assert.equal(findings.length, 1);
  assert.match(findings[0], /fixture\.mjs:2: duplicate import of "\.\/x\.mjs"/);
});

test("findDuplicateImports does not flag two imports from different specifiers", () => {
  const fixture = 'import { a } from "./x.mjs";\nimport { b } from "./y.mjs";\nconsole.log(a, b);\n';
  assert.deepEqual(findDuplicateImports(fixture, "fixture.mjs"), []);
});

test("findInnerHtmlInterpolationViolations flags unescaped template-literal interpolation", () => {
  const fixture = 'function render(el, name) {\n  el.innerHTML = `<div>${name}</div>`;\n}\n';
  const findings = findInnerHtmlInterpolationViolations(fixture, "fixture.js");
  assert.equal(findings.length, 1);
  assert.match(findings[0], /fixture\.js:2: innerHTML assigned/);
});

test("findInnerHtmlInterpolationViolations does not flag interpolation wrapped in escapeHtml(...)", () => {
  const fixture = 'function render(el, name) {\n  el.innerHTML = `<div>${escapeHtml(name)}</div>`;\n}\n';
  assert.deepEqual(findInnerHtmlInterpolationViolations(fixture, "fixture.js"), []);
});

test("findInnerHtmlInterpolationViolations ignores a non-template-literal right-hand side", () => {
  const fixture = 'function render(el, html) {\n  el.innerHTML = html;\n}\n';
  assert.deepEqual(findInnerHtmlInterpolationViolations(fixture, "fixture.js"), []);
});

test("findInnerHtmlInterpolationViolations does not flag a plain string with no interpolation", () => {
  const fixture = 'el.innerHTML = `<p>Loading...</p>`;\n';
  assert.deepEqual(findInnerHtmlInterpolationViolations(fixture, "fixture.js"), []);
});

test("findInnerHtmlInterpolationViolations handles += the same as =", () => {
  const fixture = 'function render(el, name) {\n  el.innerHTML += `<div>${name}</div>`;\n}\n';
  const findings = findInnerHtmlInterpolationViolations(fixture, "fixture.js");
  assert.equal(findings.length, 1);
});
