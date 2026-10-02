#!/usr/bin/env node
// P-7 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2D): verifies every
// text/background pair drawn from src/public/styles.css's --rr-* palette
// meets WCAG AA (4.5:1 for normal text). The math lives in
// src/public/js/a11y.mjs (unit-tested in test/a11y.test.mjs); this script
// just reads the CSS variables' actual values straight out of styles.css
// (rather than hardcoding hex values a second time, which would drift the
// moment someone edits the palette) and pairs them up the same way the
// rendered UI does -- see PAIRS below, one entry per place in the app a
// --rr-*-text (or similar) token is actually painted onto a --rr-*-bg token.
//
// Run on demand: `node scripts/contrast-check.mjs`. Exits non-zero (and
// prints which pairs fail) if the palette ever regresses below AA -- not
// wired into `npm test`/CI since it's a design-review tool, not a
// behavioral regression test, but cheap enough to run before any palette
// change.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkContrastPairs } from "../src/public/js/a11y.mjs";

const stylesPath = fileURLToPath(new URL("../src/public/styles.css", import.meta.url));
const css = readFileSync(stylesPath, "utf8");

// Every `--rr-name: #hexvalue;` declaration in the file. styles.css defines
// its whole palette once, in a single :root block (no dark-mode override),
// so a plain global scan is exact -- no need to scope it to a specific rule.
const varPattern = /--(rr-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g;
const vars = {};
for (const match of css.matchAll(varPattern)) {
  vars[`--${match[1]}`] = match[2];
}

function v(name) {
  const value = vars[name];
  if (!value) throw new Error(`contrast-check: CSS variable ${name} not found in styles.css`);
  return value;
}

// One row per text/background pair the rendered app actually paints,
// named after the rule in styles.css it comes from.
const PAIRS = [
  { name: "body text on page background", fg: v("--rr-text"), bg: v("--rr-bg") },
  { name: ".eyebrow accent text on surface", fg: v("--rr-accent"), bg: v("--rr-surface") },
  { name: ".home-tile-title/.home-tile-hint on tile background", fg: v("--rr-text-muted"), bg: v("--rr-surface-muted") },
  { name: ".home-tile-value.is-unavailable on tile background", fg: v("--rr-text-faint"), bg: v("--rr-surface-muted") },
  { name: ".incident-card span on incident background", fg: v("--rr-danger-text"), bg: v("--rr-danger-bg") },
  { name: ".work-order-card span on work-order background", fg: v("--rr-success-text"), bg: v("--rr-success-bg") },
  { name: ".message-card span on message background", fg: v("--rr-info-text"), bg: v("--rr-info-bg") },
  { name: ".training-card span on training background", fg: v("--rr-teal-text"), bg: v("--rr-teal-bg") },
  { name: ".admin-card span on admin background", fg: v("--rr-warning-text"), bg: v("--rr-warning-bg") },
  { name: "button text on button background", fg: v("--rr-accent-strong"), bg: v("--rr-surface-alt") },
  { name: "button.primary / a.primary / chip.active text on accent background", fg: v("--rr-accent-contrast"), bg: v("--rr-accent") },
  { name: ".user-info / .item-subtitle muted text on surface", fg: v("--rr-text-muted"), bg: v("--rr-surface") },
  { name: ".rr-error on surface", fg: v("--rr-danger"), bg: v("--rr-surface") },
  { name: ".rr-error on danger background (e.g. .report-form-banner)", fg: v("--rr-danger"), bg: v("--rr-danger-bg") },
  { name: ".badge-danger text on background", fg: v("--rr-badge-danger-text"), bg: v("--rr-badge-danger-bg") },
  { name: ".badge-warning text on background", fg: v("--rr-badge-warning-text"), bg: v("--rr-badge-warning-bg") },
  { name: ".badge-success text on background", fg: v("--rr-badge-success-text"), bg: v("--rr-badge-success-bg") },
  { name: ".badge-info text on background", fg: v("--rr-badge-info-text"), bg: v("--rr-badge-info-bg") },
  { name: ".validation-success on validation background", fg: v("--rr-validation-success-text"), bg: v("--rr-validation-bg") },
  { name: ".validation-error on validation background", fg: v("--rr-validation-error-text"), bg: v("--rr-validation-bg") },
  { name: ":focus-visible outline on surface (non-text, 3:1 min)", fg: v("--rr-focus"), bg: v("--rr-surface"), large: true }
];

const results = checkContrastPairs(PAIRS);
let anyFail = false;
for (const r of results) {
  const status = r.pass ? "PASS" : "FAIL";
  if (!r.pass) anyFail = true;
  console.log(`${status}  ${r.ratio.toFixed(2)}:1  (need ${r.threshold}:1)  ${r.name}  [${r.fg} on ${r.bg}]`);
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} pairs pass WCAG AA.`);
if (anyFail) {
  console.error("\nOne or more text/background pairs fail WCAG AA 4.5:1. Fix the offending --rr-* value(s) in styles.css.");
  process.exit(1);
}
