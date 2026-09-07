// P-7 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2D): pure, DOM-free
// accessibility helpers shared by the automated check (scripts/a11y-check.mjs,
// which drives a real browser) and this file's own node:test unit tests
// (test/a11y.test.mjs) -- exactly the same split as src/public/js/search.mjs:
// no I/O, no DOM, so the underlying math/logic is covered by fast unit tests
// even on a CI box that never launches Playwright.

// --- WCAG 2.x contrast ---------------------------------------------------
// https://www.w3.org/TR/WCAG21/#contrast-minimum -- relative luminance per
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance, then the standard
// (L1 + 0.05) / (L2 + 0.05) ratio with L1 the lighter of the two.

// Parses "#rgb", "#rgba", "#rrggbb", or "#rrggbbaa" into a {r,g,b} triple
// (0-255 each). An alpha channel, if present, is accepted but ignored --
// every color this module is asked to check is an opaque UI color, and a
// caller compositing a translucent color onto its actual background should
// resolve that to an opaque hex first. Throws on anything else so a typo'd
// hex value in a contrast table fails loudly (in the check script or a
// test) rather than silently comparing against black.
export function parseHexColor(hex) {
  if (typeof hex !== "string") throw new Error(`parseHexColor: expected a string, got ${typeof hex}`);
  const value = hex.trim().replace(/^#/, "");
  const expand = (s) => s.split("").map((c) => c + c).join("");
  let normalized;
  if (value.length === 3 || value.length === 4) normalized = expand(value.slice(0, 3));
  else if (value.length === 6 || value.length === 8) normalized = value.slice(0, 6);
  else throw new Error(`parseHexColor: not a recognized hex color: "${hex}"`);
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) throw new Error(`parseHexColor: not a recognized hex color: "${hex}"`);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16)
  };
}

function srgbChannelToLinear(channel255) {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Relative luminance in [0, 1] -- WCAG's own weighting (0.2126R + 0.7152G +
// 0.0722B on the linearized channels; sRGB's luma weights are close but not
// identical, and the spec's exact coefficients are what the 4.5:1 threshold
// is calibrated against).
export function relativeLuminance(hex) {
  const { r, g, b } = parseHexColor(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

// Contrast ratio between two colors, in [1, 21]. Order of the two arguments
// never matters -- the lighter one is always divided by the darker one.
export function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// WCAG 2.x AA thresholds. "Large" text is >=18pt (24px), or >=14pt (18.66px)
// bold -- see https://www.w3.org/TR/WCAG21/#dfn-large-scale. Every text/
// background pair this module's callers check is normal-weight body text
// (labels, values, status text) unless explicitly marked large, so the
// default threshold is the stricter 4.5:1.
export const AA_NORMAL_TEXT_MIN = 4.5;
export const AA_LARGE_TEXT_MIN = 3.0;
// Non-text UI components (focus outlines, control borders) -- WCAG 1.4.11.
export const AA_UI_COMPONENT_MIN = 3.0;

export function meetsContrastAA(hexForeground, hexBackground, { large = false } = {}) {
  return contrastRatio(hexForeground, hexBackground) >= (large ? AA_LARGE_TEXT_MIN : AA_NORMAL_TEXT_MIN);
}

// Evaluates a list of { name, fg, bg, large? } pairs, returning one result
// row per pair with the computed ratio (rounded to 2 decimals, the
// precision the check script's report prints) and pass/fail against AA.
// Pure and total: never throws for a caller that already validated its hex
// values with parseHexColor, and never mutates `pairs`.
export function checkContrastPairs(pairs) {
  return pairs.map(({ name, fg, bg, large = false }) => {
    const ratio = contrastRatio(fg, bg);
    return {
      name,
      fg,
      bg,
      ratio: Math.round(ratio * 100) / 100,
      threshold: large ? AA_LARGE_TEXT_MIN : AA_NORMAL_TEXT_MIN,
      pass: ratio >= (large ? AA_LARGE_TEXT_MIN : AA_NORMAL_TEXT_MIN)
    };
  });
}

// --- Accessible name detection --------------------------------------------
// A minimal, DOM-free re-implementation of the parts of the accessible-name
// computation (https://www.w3.org/TR/accname-1.2/) this app's forms actually
// exercise, in priority order:
//   1. aria-labelledby (space-separated ids resolved against `idToText`)
//   2. aria-label
//   3. a <label> associated by `for`/id, or by wrapping the control
//   4. placeholder (HTML-AAM's documented fallback for text-like inputs --
//      still accepted here so a control the app deliberately labels only via
//      placeholder isn't flagged, but scripts/a11y-check.mjs's live-browser
//      check additionally records which controls relied on this fallback so
//      a reviewer can see it, since it's a weaker source than a real label)
//   5. title
// Takes a plain-object "control description" rather than a real DOM node so
// it can be unit-tested without a browser; the live check adapts a real
// <input>/<select>/<textarea> element into this same shape before calling
// it, so both paths run the identical priority logic.
//
// Shape of `control`:
//   { ariaLabelledby, ariaLabel, labelText, placeholder, title }
// Every field is optional; a field that doesn't apply to this control (e.g.
// no wrapping/`for` label exists) should be omitted or null, not "".
export function accessibleName(control, { idToText = {} } = {}) {
  const c = control || {};

  if (c.ariaLabelledby) {
    const resolved = c.ariaLabelledby
      .split(/\s+/)
      .map((id) => idToText[id])
      .filter((text) => typeof text === "string" && text.trim().length > 0)
      .join(" ")
      .trim();
    if (resolved) return { name: resolved, source: "aria-labelledby" };
  }

  if (typeof c.ariaLabel === "string" && c.ariaLabel.trim()) {
    return { name: c.ariaLabel.trim(), source: "aria-label" };
  }

  if (typeof c.labelText === "string" && c.labelText.trim()) {
    return { name: c.labelText.trim(), source: "label" };
  }

  if (typeof c.placeholder === "string" && c.placeholder.trim()) {
    return { name: c.placeholder.trim(), source: "placeholder" };
  }

  if (typeof c.title === "string" && c.title.trim()) {
    return { name: c.title.trim(), source: "title" };
  }

  return { name: "", source: "none" };
}

// True when `control` has SOME accessible name (any of the sources above).
// The one-line predicate the a11y check's per-control assertion actually
// wants; kept separate from accessibleName so a caller that only needs the
// boolean doesn't have to destructure.
export function hasAccessibleName(control, opts) {
  return accessibleName(control, opts).name.length > 0;
}

// --- Tap target sizing -----------------------------------------------------
// WCAG 2.5.5/2.5.8: an interactive control's bounding box (CSS pixels, i.e.
// already divided by devicePixelRatio) must be at least 44x44 (AAA 2.5.5) /
// 24x24 with sufficient spacing (AA 2.5.8) -- this app targets the stricter
// 44x44 uniformly, per the plan's explicit "44x44 minimum tap targets", so a
// single check covers both.
export const MIN_TAP_TARGET_PX = 44;

// `box` is a plain {width, height} (a live check passes getBoundingClientRect
// output, or an equivalent plain object in a test). Zero-size boxes (e.g. an
// element that isn't actually rendered/visible) are treated as failing, not
// skipped -- callers that only care about visible controls should filter
// those out themselves before calling this.
export function meetsMinTapTarget(box, minPx = MIN_TAP_TARGET_PX) {
  return !!box && box.width >= minPx && box.height >= minPx;
}
