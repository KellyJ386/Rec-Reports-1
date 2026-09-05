import { isModuleEnabled, mergeSettings } from "../admin-config.mjs";
import { validateModuleTogglePayload } from "../http/validate.mjs";

// Re-export the boundary validator so admin callers depend on a single source of
// truth for the module-toggle payload shape (no duplicated logic).
export { validateModuleTogglePayload };

function hasEnabledFlag(layer) {
  return layer != null && layer.enabled !== undefined && layer.enabled !== null;
}

function layerConfig(layer, ...keys) {
  if (layer == null) return {};
  for (const key of keys) {
    if (layer[key] && typeof layer[key] === "object") return layer[key];
  }
  return {};
}

// Resolve the effective on/off state and merged config for a module, following
// the precedence facility override > org default > module default. Reuses
// isModuleEnabled (enabled precedence) and mergeSettings (deep config merge)
// from admin-config.mjs so resolution stays consistent with the rest of the app.
export function resolveEffectiveModuleState(orgSetting, facilityOverride) {
  const enabled = isModuleEnabled(orgSetting, facilityOverride ?? {});
  const orgConfig = layerConfig(orgSetting, "config", "config_jsonb");
  const facilityConfig = layerConfig(facilityOverride, "config", "configPatch", "config_patch_jsonb");
  const config = mergeSettings(orgConfig, facilityConfig);

  let source;
  if (hasEnabledFlag(facilityOverride)) {
    source = "facility-override";
  } else if (hasEnabledFlag(orgSetting)) {
    source = "org-default";
  } else {
    source = "module-default";
  }

  return { enabled, config, source };
}

// Human-readable summary of the blast radius of flipping a module, used to warn
// an admin before a toggle write (design 2.2-B).
export function impactSummary(moduleName, enabling, affectedDepartmentCount) {
  const verb = enabling ? "Enabling" : "Disabling";
  const count = Number.isFinite(affectedDepartmentCount) ? affectedDepartmentCount : 0;
  const noun = count === 1 ? "department" : "departments";
  return `${verb} ${moduleName} affects ${count} ${noun}.`;
}
