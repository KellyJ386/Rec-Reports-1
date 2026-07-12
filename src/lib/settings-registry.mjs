// Setting Registry — the canonical, code-side catalog of tenant-controllable
// settings. Each definition anchors its `default` to the behavior the module
// libs shipped with (see the per-key comment for the constant it generalizes),
// so a facility that has configured nothing behaves exactly as before.
//
// Layout invariant (enforced by scripts/gen-settings-check.mjs): entries are
// grouped contiguously by `module`, `key`s are unique, `module` maps to a
// module code present in supabase/seed.sql, and every `default` passes its own
// validation.

const TIME_OF_DAY_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";

export const settingsRegistry = Object.freeze(
  [
    // --- Scheduling (module code: scheduling) ------------------------------
    {
      key: "scheduling.publishCadenceDays",
      module: "scheduling",
      label: "Publish cadence (days)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 7, // SCHEDULING_SYSTEM_DESIGN.md:233 ("publish cadence (weekly)")
      validation: { min: 1, max: 30 },
      permission: "admin.manage"
    },
    {
      key: "scheduling.requireApprovalBeforePublish",
      module: "scheduling",
      label: "Require manager approval before publish",
      dataType: "boolean",
      scopes: ["organization", "facility"],
      default: true, // SCHEDULING_SYSTEM_DESIGN.md:234 ("approval requirements")
      validation: {},
      permission: "admin.manage"
    },
    {
      key: "scheduling.conflictCheckEnabled",
      module: "scheduling",
      label: "Enable double-booking conflict checks",
      dataType: "boolean",
      scopes: ["organization", "facility"],
      default: true, // scheduling.mjs findDoubleBookings always runs today
      validation: {},
      permission: "admin.manage"
    },
    {
      key: "scheduling.certEnforcementMode",
      module: "scheduling",
      label: "Certification enforcement",
      dataType: "enum",
      scopes: ["organization", "facility"],
      default: "hard-block", // scheduling.mjs summarizeScheduleReadiness blocks publish on missing certs
      validation: { values: ["hard-block", "warning"] },
      permission: "admin.manage"
    },
    {
      key: "scheduling.openShiftClaimWindowHours",
      module: "scheduling",
      label: "Open-shift claim window (hours)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 48, // SCHEDULING_SYSTEM_DESIGN.md:237 ("open-shift claim window")
      validation: { min: 1, max: 336 },
      permission: "admin.manage"
    },

    // --- Incidents (module code: incidents) --------------------------------
    {
      key: "incidents.escalationSlaHours",
      module: "incidents",
      label: "Escalation acknowledgement SLA (hours)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 4, // INCIDENT_ACCIDENT_REPORTING_SYSTEM.md:270 (SLA timers, high severity)
      validation: { min: 1, max: 168 },
      permission: "admin.manage"
    },
    {
      key: "incidents.severityAutoEscalate",
      module: "incidents",
      label: "Auto-escalate on severity",
      dataType: "boolean",
      scopes: ["organization", "facility"],
      default: true, // incidents.mjs escalationSeverities set escalates high/critical today
      validation: {},
      permission: "admin.manage"
    },

    // --- Work orders (module code: work_orders) ----------------------------
    {
      key: "workOrders.defaultPriority",
      module: "work_orders",
      label: "Default work-order priority",
      dataType: "enum",
      scopes: ["organization", "facility"],
      default: "medium", // work-orders.mjs:29 createWorkOrderFromIncident fallback priority
      validation: { values: ["low", "medium", "high", "urgent"] },
      permission: "admin.manage"
    },
    {
      key: "workOrders.slaHoursUrgent",
      module: "work_orders",
      label: "SLA for urgent/high work orders (hours)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 24, // new control; no prior constant (dueAt was caller-supplied)
      validation: { min: 1, max: 720 },
      permission: "admin.manage"
    },
    {
      key: "workOrders.slaHoursRoutine",
      module: "work_orders",
      label: "SLA for routine (low/medium) work orders (hours)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 72, // new control; no prior constant (dueAt was caller-supplied)
      validation: { min: 1, max: 2160 },
      permission: "admin.manage"
    },

    // --- Daily reports (module code: daily_reports) ------------------------
    {
      key: "reports.dailyReportDueHour",
      module: "daily_reports",
      label: "Daily report due hour (0-23)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 18, // supabase/seed.sql:220 facility_settings reporting.dailyReportDueHour
      validation: { min: 0, max: 23 },
      permission: "admin.manage"
    },
    {
      key: "reports.quietHoursStart",
      module: "daily_reports",
      label: "Quiet hours start (HH:MM)",
      dataType: "timeRange",
      scopes: ["organization", "facility"],
      default: "22:00", // supabase/seed.sql:220 notifications.quietHoursStart
      validation: { pattern: TIME_OF_DAY_PATTERN },
      permission: "admin.manage"
    },
    {
      key: "reports.quietHoursEnd",
      module: "daily_reports",
      label: "Quiet hours end (HH:MM)",
      dataType: "timeRange",
      scopes: ["organization", "facility"],
      default: "06:00", // supabase/seed.sql:220 notifications.quietHoursEnd
      validation: { pattern: TIME_OF_DAY_PATTERN },
      permission: "admin.manage"
    },

    // --- Communications (module code: communications) ----------------------
    {
      key: "communications.requireAckDefault",
      module: "communications",
      label: "Require acknowledgement by default",
      dataType: "boolean",
      scopes: ["organization", "facility"],
      default: false, // communications.mjs acknowledgementState treats unset isRequiredAck as not required
      validation: {},
      permission: "admin.manage"
    },

    // --- Training (module code: training) ----------------------------------
    {
      key: "training.recertWindowDays",
      module: "training",
      label: "Recertification reminder window (days)",
      dataType: "integer",
      scopes: ["organization", "facility"],
      default: 30, // training.mjs:6 renewalWindowDays ?? 30
      validation: { min: 1, max: 365 },
      permission: "admin.manage"
    }
  ].map((definition) => Object.freeze({ ...definition, validation: Object.freeze({ ...definition.validation }) }))
);

const definitionsByKey = new Map(settingsRegistry.map((definition) => [definition.key, definition]));

export function getDefinition(key) {
  return definitionsByKey.get(key) ?? null;
}

export function settingsForModule(module) {
  return settingsRegistry.filter((definition) => definition.module === module);
}

// Validate a candidate value for a setting against its dataType + validation.
// Returns { valid, errors } in the same shape as the http/validate.mjs helpers.
export function validateSettingValue(key, value) {
  const definition = getDefinition(key);
  if (!definition) {
    return { valid: false, errors: [`unknown setting: ${key}`] };
  }
  const errors = [];
  const { dataType, validation, label } = definition;

  if (dataType === "boolean") {
    if (typeof value !== "boolean") errors.push(`${label} must be a boolean`);
  } else if (dataType === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`${label} must be an integer`);
    } else {
      if (validation.min !== undefined && value < validation.min) {
        errors.push(`${label} must be >= ${validation.min}`);
      }
      if (validation.max !== undefined && value > validation.max) {
        errors.push(`${label} must be <= ${validation.max}`);
      }
    }
  } else if (dataType === "enum") {
    if (!Array.isArray(validation.values) || !validation.values.includes(value)) {
      errors.push(`${label} must be one of: ${(validation.values ?? []).join(", ")}`);
    }
  } else if (dataType === "string" || dataType === "timeRange") {
    if (typeof value !== "string") {
      errors.push(`${label} must be a string`);
    } else if (validation.pattern && !new RegExp(validation.pattern).test(value)) {
      errors.push(`${label} is not in the expected format`);
    }
  } else {
    errors.push(`${label} has an unsupported dataType: ${dataType}`);
  }

  return { valid: errors.length === 0, errors };
}

// Resolve the effective value + provenance for each setting given the
// organization and facility configuration layers (flat maps of key -> value,
// as stored in organization_module_settings.config_jsonb and
// facility_module_overrides.config_patch_jsonb). Generalizes mergeSettings:
// facility overrides win, then organization, then the registry default.
export function resolveEffectiveSettings({ orgLayer = {}, facilityLayer = {}, definitions = settingsRegistry } = {}) {
  const resolved = {};
  for (const definition of definitions) {
    const { key } = definition;
    if (hasValue(facilityLayer, key)) {
      resolved[key] = { value: facilityLayer[key], source: "facility" };
    } else if (hasValue(orgLayer, key)) {
      resolved[key] = { value: orgLayer[key], source: "organization" };
    } else {
      resolved[key] = { value: definition.default, source: "default" };
    }
  }
  return resolved;
}

// Convenience for the module libs: collapse a resolved map (or the layers) into
// a plain key -> value config object, filling defaults for anything unset.
export function effectiveConfig({ orgLayer = {}, facilityLayer = {}, definitions = settingsRegistry } = {}) {
  const resolved = resolveEffectiveSettings({ orgLayer, facilityLayer, definitions });
  const config = {};
  for (const [key, entry] of Object.entries(resolved)) config[key] = entry.value;
  return config;
}

// Read a single setting from a flat config map, falling back to the registry
// default when the key is unset. The backbone of the backward-compatible
// `config` parameter every module lib accepts: pass {} (or nothing) and every
// key resolves to the shipped default, so behavior is unchanged.
export function configValue(config, key) {
  const definition = getDefinition(key);
  const fallback = definition ? definition.default : undefined;
  if (hasValue(config, key)) return config[key];
  return fallback;
}

function hasValue(layer, key) {
  return layer !== null && typeof layer === "object" && Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined && layer[key] !== null;
}
