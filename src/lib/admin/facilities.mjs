// Boundary validators for the facilities/departments admin surface. Every
// validator returns { valid, errors[] } in the report-schema.mjs style so the
// API layer can map failures to a 400 with a stable error list.

const LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/;
// IANA-ish: "Area/Location" (optionally deeper, e.g. America/Argentina/Salta),
// or a bare zone like "UTC". Deliberately permissive — the DB is the authority.
const TIMEZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFacilityInput(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ["input must be an object"] };
  }
  if (!isNonEmptyString(input.name)) {
    errors.push("name is required");
  }
  if (input.timezone !== undefined && input.timezone !== null) {
    if (typeof input.timezone !== "string" || !TIMEZONE_RE.test(input.timezone)) {
      errors.push("timezone must be an IANA time zone string (e.g. America/New_York)");
    }
  }
  if (input.locale !== undefined && input.locale !== null) {
    if (typeof input.locale !== "string" || !LOCALE_RE.test(input.locale)) {
      errors.push("locale must look like xx-XX (e.g. en-US)");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateDepartmentInput(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ["input must be an object"] };
  }
  if (!isNonEmptyString(input.name)) {
    errors.push("name is required");
  }
  return { valid: errors.length === 0, errors };
}

// Shape-checks the subset of facility_settings.settings_jsonb the admin UI edits
// (the fields seed.sql populates): locale, reporting.dailyReportDueHour, and
// notifications.quietHoursStart/quietHoursEnd. Unknown keys are left alone — the
// patch is merged onto the current settings, so this only guards known fields.
export function validateFacilitySettingsPatch(patch) {
  const errors = [];
  if (!isPlainObject(patch)) {
    return { valid: false, errors: ["settingsPatch must be an object"] };
  }

  if (patch.locale !== undefined && patch.locale !== null) {
    if (typeof patch.locale !== "string" || !LOCALE_RE.test(patch.locale)) {
      errors.push("locale must look like xx-XX (e.g. en-US)");
    }
  }

  if (patch.reporting !== undefined && patch.reporting !== null) {
    if (!isPlainObject(patch.reporting)) {
      errors.push("reporting must be an object");
    } else {
      const hour = patch.reporting.dailyReportDueHour;
      if (hour !== undefined && hour !== null) {
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          errors.push("reporting.dailyReportDueHour must be an integer between 0 and 23");
        }
      }
    }
  }

  if (patch.notifications !== undefined && patch.notifications !== null) {
    if (!isPlainObject(patch.notifications)) {
      errors.push("notifications must be an object");
    } else {
      for (const key of ["quietHoursStart", "quietHoursEnd"]) {
        const value = patch.notifications[key];
        if (value !== undefined && value !== null) {
          if (typeof value !== "string" || !TIME_RE.test(value)) {
            errors.push(`notifications.${key} must be an "HH:MM" time`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
