import test from "node:test";
import assert from "node:assert/strict";
import { validateThemePatch, buildBrandingUpsert } from "../src/lib/admin/branding.mjs";

// --- validateThemePatch ------------------------------------------------------

test("validateThemePatch accepts a full valid patch", () => {
  const result = validateThemePatch({
    name: "North Arena Default",
    primaryColor: "#1c6dd0",
    accentColor: "#9ec5a9",
    logoPath: "/logos/north-arena.png"
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateThemePatch accepts a 3-digit hex color", () => {
  const result = validateThemePatch({ name: "Short Hex", primaryColor: "#fff", accentColor: "#000" });
  assert.equal(result.valid, true);
});

test("validateThemePatch accepts a name-only patch (colors/logo optional)", () => {
  const result = validateThemePatch({ name: "Just a name" });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateThemePatch rejects a non-object patch", () => {
  assert.equal(validateThemePatch(null).valid, false);
  assert.equal(validateThemePatch("nope").valid, false);
  assert.equal(validateThemePatch(undefined).valid, false);
});

test("validateThemePatch requires a non-empty name", () => {
  assert.ok(validateThemePatch({}).errors.includes("name is required"));
  assert.ok(validateThemePatch({ name: "" }).errors.includes("name is required"));
  assert.ok(validateThemePatch({ name: "   " }).errors.includes("name is required"));
});

test("validateThemePatch rejects a primaryColor that isn't a #hex color", () => {
  for (const bad of ["1c6dd0", "#gggggg", "blue", "#12345", "rgb(0,0,0)"]) {
    const result = validateThemePatch({ name: "N", primaryColor: bad });
    assert.equal(result.valid, false, `expected ${bad} to be rejected`);
    assert.ok(result.errors.some((e) => e.includes("primaryColor")));
  }
});

test("validateThemePatch rejects an accentColor that isn't a #hex color", () => {
  const result = validateThemePatch({ name: "N", accentColor: "not-a-color" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("accentColor")));
});

test("validateThemePatch rejects a logoPath with whitespace or a protocol", () => {
  for (const bad of ["  /logos/a.png", "https://evil.example/logo.png", "logo path.png"]) {
    const result = validateThemePatch({ name: "N", logoPath: bad });
    assert.equal(result.valid, false, `expected ${bad} to be rejected`);
    assert.ok(result.errors.some((e) => e.includes("logoPath")));
  }
});

test("validateThemePatch accepts an empty-string logoPath as absent", () => {
  const result = validateThemePatch({ name: "N", logoPath: "" });
  assert.equal(result.valid, true);
});

test("validateThemePatch accumulates multiple errors", () => {
  const result = validateThemePatch({ primaryColor: "nope", accentColor: "nope" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});

// --- buildBrandingUpsert -----------------------------------------------------

test("buildBrandingUpsert shapes a full upsert row", () => {
  const row = buildBrandingUpsert(
    "fac-1",
    { name: "North Arena Default", primaryColor: "#1c6dd0", accentColor: "#9ec5a9", logoPath: "/logos/a.png" },
    "user-1"
  );
  assert.deepEqual(row, {
    facility_id: "fac-1",
    name: "North Arena Default",
    theme_jsonb: { primary: "#1c6dd0", accent: "#9ec5a9" },
    updated_by: "user-1",
    logo_path: "/logos/a.png"
  });
});

test("buildBrandingUpsert omits logo_path when logoPath is absent", () => {
  const row = buildBrandingUpsert("fac-1", { name: "N", primaryColor: "#111111" }, "user-1");
  assert.equal(row.logo_path, undefined);
  assert.deepEqual(row.theme_jsonb, { primary: "#111111" });
});

test("buildBrandingUpsert nulls logo_path when logoPath is explicitly cleared", () => {
  const row = buildBrandingUpsert("fac-1", { name: "N", logoPath: "" }, "user-1");
  assert.equal(row.logo_path, null);
});

test("buildBrandingUpsert defaults updated_by to null when no user is given", () => {
  const row = buildBrandingUpsert("fac-1", { name: "N" });
  assert.equal(row.updated_by, null);
});

test("buildBrandingUpsert sets is_default only when explicitly provided", () => {
  const withoutFlag = buildBrandingUpsert("fac-1", { name: "N" }, "user-1");
  assert.equal(withoutFlag.is_default, undefined);
  const withFlag = buildBrandingUpsert("fac-1", { name: "N", isDefault: true }, "user-1");
  assert.equal(withFlag.is_default, true);
});
