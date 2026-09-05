// Boundary validators + upsert shaping for the Branding & Documents admin
// surface (branding_profiles, 0008:57). Mirrors the { valid, errors[] } style
// of src/lib/admin/facilities.mjs.

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Path-like: a relative or absolute path made of segments, no protocol, no
// whitespace -- e.g. "/logos/north-arena.png" or "logos/north-arena.png".
// Deliberately permissive about the file extension; storage is the authority
// on whether the asset actually exists.
const LOGO_PATH_RE = /^\/?[\w.\-]+(?:\/[\w.\-]+)*$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validates a branding theme patch: name is required and non-empty,
// primaryColor/accentColor must be #hex colors when present, logoPath (when
// present and non-empty) must look like a storage path.
export function validateThemePatch(patch) {
  const errors = [];
  if (!isPlainObject(patch)) {
    return { valid: false, errors: ["patch must be an object"] };
  }

  if (!isNonEmptyString(patch.name)) {
    errors.push("name is required");
  }

  if (patch.primaryColor !== undefined && patch.primaryColor !== null) {
    if (typeof patch.primaryColor !== "string" || !HEX_COLOR_RE.test(patch.primaryColor)) {
      errors.push("primaryColor must be a #hex color (e.g. #1c6dd0)");
    }
  }

  if (patch.accentColor !== undefined && patch.accentColor !== null) {
    if (typeof patch.accentColor !== "string" || !HEX_COLOR_RE.test(patch.accentColor)) {
      errors.push("accentColor must be a #hex color (e.g. #9ec5a9)");
    }
  }

  if (patch.logoPath !== undefined && patch.logoPath !== null && patch.logoPath !== "") {
    if (typeof patch.logoPath !== "string" || !LOGO_PATH_RE.test(patch.logoPath)) {
      errors.push("logoPath must be a relative or absolute path (e.g. /logos/facility.png)");
    }
  }

  return { valid: errors.length === 0, errors };
}

// Shapes an upsert row for branding_profiles from a validated theme patch.
// name participates in the (facility_id, name) unique key (0008:67), so the
// caller upserts on that conflict target (facility_id,name).
export function buildBrandingUpsert(facilityId, patch, userId) {
  const theme = {};
  if (patch.primaryColor !== undefined && patch.primaryColor !== null) theme.primary = patch.primaryColor;
  if (patch.accentColor !== undefined && patch.accentColor !== null) theme.accent = patch.accentColor;

  const row = {
    facility_id: facilityId,
    name: patch.name,
    theme_jsonb: theme,
    updated_by: userId ?? null
  };
  if (patch.logoPath !== undefined) row.logo_path = patch.logoPath || null;
  if (patch.isDefault !== undefined) row.is_default = Boolean(patch.isDefault);
  return row;
}
