import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  meetsContrastAA,
  checkContrastPairs,
  AA_NORMAL_TEXT_MIN,
  AA_LARGE_TEXT_MIN,
  accessibleName,
  hasAccessibleName,
  meetsMinTapTarget,
  MIN_TAP_TARGET_PX
} from "../src/public/js/a11y.mjs";

// --- parseHexColor -----------------------------------------------------------

test("parseHexColor reads a 6-digit hex color", () => {
  assert.deepEqual(parseHexColor("#172033"), { r: 0x17, g: 0x20, b: 0x33 });
});

test("parseHexColor reads a 3-digit shorthand hex color", () => {
  assert.deepEqual(parseHexColor("#fff"), { r: 255, g: 255, b: 255 });
});

test("parseHexColor ignores an 8-digit color's alpha channel", () => {
  assert.deepEqual(parseHexColor("#ffffff80"), { r: 255, g: 255, b: 255 });
});

test("parseHexColor works without a leading #", () => {
  assert.deepEqual(parseHexColor("000000"), { r: 0, g: 0, b: 0 });
});

test("parseHexColor throws on garbage input", () => {
  assert.throws(() => parseHexColor("not-a-color"));
  assert.throws(() => parseHexColor("#12"));
  assert.throws(() => parseHexColor(123));
});

// --- relativeLuminance / contrastRatio ---------------------------------------

test("relativeLuminance: black is 0, white is 1", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#ffffff"), 1);
});

test("contrastRatio: black on white is the maximum, 21:1", () => {
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.001);
});

test("contrastRatio: a color against itself is 1:1", () => {
  assert.ok(Math.abs(contrastRatio("#1c6dd0", "#1c6dd0") - 1) < 0.001);
});

test("contrastRatio is symmetric in its two arguments", () => {
  const a = contrastRatio("#172033", "#f4f7fb");
  const b = contrastRatio("#f4f7fb", "#172033");
  assert.equal(a, b);
});

// --- meetsContrastAA ---------------------------------------------------------

test("meetsContrastAA: black on white passes the normal-text threshold", () => {
  assert.equal(meetsContrastAA("#000000", "#ffffff"), true);
});

test("meetsContrastAA: a pair just under 4.5:1 fails for normal text but can pass for large text", () => {
  // #949494 on #ffffff is right around 3.0:1 -- fails normal (4.5), passes large (3.0).
  assert.equal(meetsContrastAA("#949494", "#ffffff"), false);
  assert.equal(meetsContrastAA("#949494", "#ffffff", { large: true }), true);
});

test("AA thresholds are the WCAG-documented values", () => {
  assert.equal(AA_NORMAL_TEXT_MIN, 4.5);
  assert.equal(AA_LARGE_TEXT_MIN, 3.0);
});

// --- checkContrastPairs -------------------------------------------------------

test("checkContrastPairs reports pass/fail and a rounded ratio per pair", () => {
  const results = checkContrastPairs([
    { name: "ink on white", fg: "#000000", bg: "#ffffff" },
    { name: "white on white", fg: "#ffffff", bg: "#ffffff" }
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].pass, true);
  assert.equal(results[0].ratio, 21);
  assert.equal(results[1].pass, false);
  assert.equal(results[1].ratio, 1);
});

test("checkContrastPairs never mutates its input", () => {
  const pairs = [{ name: "x", fg: "#000000", bg: "#ffffff" }];
  const frozen = JSON.parse(JSON.stringify(pairs));
  checkContrastPairs(pairs);
  assert.deepEqual(pairs, frozen);
});

// --- accessibleName / hasAccessibleName --------------------------------------

test("accessibleName prefers aria-labelledby over every other source", () => {
  const result = accessibleName(
    { ariaLabelledby: "lbl1", ariaLabel: "ignored", labelText: "also ignored", placeholder: "and this" },
    { idToText: { lbl1: "Search incidents" } }
  );
  assert.deepEqual(result, { name: "Search incidents", source: "aria-labelledby" });
});

test("accessibleName joins multiple aria-labelledby ids in order", () => {
  const result = accessibleName(
    { ariaLabelledby: "a b" },
    { idToText: { a: "Active", b: "facility" } }
  );
  assert.equal(result.name, "Active facility");
});

test("accessibleName falls back to aria-label when aria-labelledby resolves to nothing", () => {
  const result = accessibleName({ ariaLabelledby: "missing-id", ariaLabel: "Sign out" });
  assert.deepEqual(result, { name: "Sign out", source: "aria-label" });
});

test("accessibleName falls back to an associated <label>'s text", () => {
  const result = accessibleName({ labelText: "Incident type" });
  assert.deepEqual(result, { name: "Incident type", source: "label" });
});

test("accessibleName falls back to placeholder when nothing else is present", () => {
  const result = accessibleName({ placeholder: "Full name" });
  assert.deepEqual(result, { name: "Full name", source: "placeholder" });
});

test("accessibleName falls back to title as a last resort", () => {
  const result = accessibleName({ title: "Close" });
  assert.deepEqual(result, { name: "Close", source: "title" });
});

test("accessibleName returns an empty name when nothing is present", () => {
  assert.deepEqual(accessibleName({}), { name: "", source: "none" });
  assert.deepEqual(accessibleName(null), { name: "", source: "none" });
});

test("accessibleName treats a whitespace-only source as absent and keeps falling through", () => {
  const result = accessibleName({ ariaLabel: "   ", labelText: "Real label" });
  assert.deepEqual(result, { name: "Real label", source: "label" });
});

test("hasAccessibleName is a boolean view of accessibleName", () => {
  assert.equal(hasAccessibleName({ ariaLabel: "Sign out" }), true);
  assert.equal(hasAccessibleName({}), false);
});

// --- meetsMinTapTarget ---------------------------------------------------------

test("meetsMinTapTarget: exactly 44x44 passes", () => {
  assert.equal(meetsMinTapTarget({ width: 44, height: 44 }), true);
});

test("meetsMinTapTarget: fails when either dimension is under 44", () => {
  assert.equal(meetsMinTapTarget({ width: 43.9, height: 44 }), false);
  assert.equal(meetsMinTapTarget({ width: 44, height: 43.9 }), false);
});

test("meetsMinTapTarget: a missing box fails", () => {
  assert.equal(meetsMinTapTarget(null), false);
  assert.equal(meetsMinTapTarget(undefined), false);
});

test("meetsMinTapTarget honors a custom minimum", () => {
  assert.equal(meetsMinTapTarget({ width: 24, height: 24 }, 24), true);
  assert.equal(meetsMinTapTarget({ width: 24, height: 24 }, MIN_TAP_TARGET_PX), false);
});
