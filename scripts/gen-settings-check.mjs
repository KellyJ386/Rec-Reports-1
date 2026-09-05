import { readFileSync } from "node:fs";
import { settingsRegistry, validateSettingValue } from "../src/lib/settings-registry.mjs";

// Generation-style guard for the Setting Registry, mirroring the permission
// diff in typecheck.mjs. Asserts:
//   1. every definition's `module` maps to a module code in seed.sql's modules insert
//   2. keys are unique
//   3. entries are grouped contiguously by module (sorted-by-module)
//   4. every `default` passes its own validation

const failures = [];

const seedUrl = new URL("../supabase/seed.sql", import.meta.url);
const seedSql = readFileSync(seedUrl, "utf8");
const modulesInsertMatch = seedSql.match(
  /insert into modules \([^)]*\) values([\s\S]*?)\son conflict\b[\s\S]*?;/
);
if (!modulesInsertMatch) {
  failures.push("supabase/seed.sql has no modules insert block.");
}
const moduleCodes = modulesInsertMatch
  ? [...modulesInsertMatch[1].matchAll(/\(\s*'[^']+'\s*,\s*'([^']+)'/g)].map((match) => match[1])
  : [];
const moduleCodeSet = new Set(moduleCodes);

// 1. module references exist in seed.sql
for (const definition of settingsRegistry) {
  if (!moduleCodeSet.has(definition.module)) {
    failures.push(
      `Setting "${definition.key}" references module "${definition.module}" which is not in seed.sql modules (${[...moduleCodeSet].join(", ")}).`
    );
  }
}

// 2. keys unique
const keys = settingsRegistry.map((definition) => definition.key);
const keySet = new Set(keys);
if (keySet.size !== keys.length) {
  const seen = new Set();
  const dupes = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
  failures.push(`Duplicate setting keys: ${[...new Set(dupes)].join(", ")}`);
}

// 3. grouped contiguously by module (a module must not reappear after a break)
const seenModules = new Set();
let previousModule = null;
for (const definition of settingsRegistry) {
  if (definition.module !== previousModule) {
    if (seenModules.has(definition.module)) {
      failures.push(
        `Registry is not grouped by module: "${definition.module}" reappears non-contiguously (at key "${definition.key}").`
      );
    }
    seenModules.add(definition.module);
    previousModule = definition.module;
  }
}

// 4. defaults self-validate
for (const definition of settingsRegistry) {
  const { valid, errors } = validateSettingValue(definition.key, definition.default);
  if (!valid) {
    failures.push(`Default for "${definition.key}" fails validation: ${errors.join("; ")}`);
  }
}

if (failures.length) throw new Error(`Settings registry check failed:\n${failures.join("\n")}`);
console.log(
  `Settings registry check passed: ${settingsRegistry.length} setting(s) across ${seenModules.size} module(s), all defaults valid.`
);
