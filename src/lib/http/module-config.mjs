// Shared effective-config loader for the end-user `/api/v1` routes.
//
// Mirrors the resolution already used by admin-routes.mjs's
// GET /facilities/:facilityId/modules/:moduleCode/config and by
// scheduling-routes.mjs's loadSchedulingConfig: resolve the `modules` row for
// `moduleCode`, then the organization layer (organization_module_settings.
// config_jsonb, keyed by the facility's organization_id + module_id), then
// the facility layer (facility_module_overrides.config_patch_jsonb, keyed by
// facility_id + module_id), and fold both through settings-registry's
// effectiveConfig() so facility overrides win over organization over the
// registry default.
//
// Any lookup failure -- module row missing, facility row missing, a rejected
// fetch, a non-2xx PostgrestError -- degrades to `{}` rather than throwing.
// `effectiveConfig`'s `configValue` already fills registry defaults for an
// empty map, so callers see the shipped behavior instead of a 500.
import { pgSelect } from "../supabase-rest.mjs";
import { settingsForModule, effectiveConfig } from "../settings-registry.mjs";

async function loadModuleByCode(client, code) {
  const rows = await pgSelect(client, "modules", {
    filters: { code },
    select: "id,code",
    limit: 1
  });
  return (rows ?? [])[0] ?? null;
}

async function loadFacilityOrgId(client, facilityId) {
  const rows = await pgSelect(client, "facilities", {
    filters: { id: facilityId },
    select: "id,organization_id",
    limit: 1
  });
  return (rows ?? [])[0] ?? null;
}

// Resolve the facility's effective config for one module (flat key -> value
// map, registry defaults filled in). Never throws.
export async function loadModuleConfig({ client, facilityId, moduleCode }) {
  try {
    const module = await loadModuleByCode(client, moduleCode);
    if (!module) return {};

    const facility = await loadFacilityOrgId(client, facilityId);

    let orgLayer = {};
    if (facility?.organization_id) {
      const orgRows = await pgSelect(client, "organization_module_settings", {
        filters: { organization_id: facility.organization_id, module_id: module.id },
        select: "config_jsonb",
        limit: 1
      });
      orgLayer = (orgRows ?? [])[0]?.config_jsonb ?? {};
    }

    const facRows = await pgSelect(client, "facility_module_overrides", {
      filters: { facility_id: facilityId, module_id: module.id },
      select: "config_patch_jsonb",
      limit: 1
    });
    const facilityLayer = (facRows ?? [])[0]?.config_patch_jsonb ?? {};

    const definitions = settingsForModule(moduleCode);
    return effectiveConfig({ orgLayer, facilityLayer, definitions });
  } catch {
    return {};
  }
}

// Per-request memoization: routes that need the same {facilityId,
// moduleCode} config more than once within a single request (or that share
// a client across a Promise.all of independent lookups) should build one
// loader via makeConfigLoader(client) and call it repeatedly -- concurrent
// calls for the same key share a single in-flight lookup rather than firing
// duplicate fetches.
export function makeConfigLoader(client) {
  const cache = new Map();
  return function loadConfig({ facilityId, moduleCode }) {
    const key = `${facilityId}::${moduleCode}`;
    if (!cache.has(key)) {
      cache.set(key, loadModuleConfig({ client, facilityId, moduleCode }));
    }
    return cache.get(key);
  };
}
