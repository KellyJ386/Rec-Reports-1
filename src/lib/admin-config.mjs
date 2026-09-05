export function mergeSettings(...layers) {
  return layers.reduce((merged, layer) => deepMerge(merged, layer ?? {}), {});
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function isModuleEnabled(moduleSetting, facilityOverride = {}) {
  if (facilityOverride.enabled !== undefined && facilityOverride.enabled !== null) return facilityOverride.enabled;
  return moduleSetting?.enabled ?? false;
}

export function buildConfigAuditEvent({ facilityId, actorUserId, entityTable, entityId, before, after }) {
  return {
    facility_id: facilityId,
    actor_user_id: actorUserId,
    event_type: "config.changed",
    entity_table: entityTable,
    entity_id: entityId,
    event_payload: { before, after }
  };
}
