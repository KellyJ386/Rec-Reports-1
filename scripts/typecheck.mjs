import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { permissions } from "../src/lib/permissions.mjs";

const failures = [];

const libCodes = [...permissions];
const libCodeSet = new Set(libCodes);
if (libCodeSet.size !== libCodes.length) {
  failures.push("src/lib/permissions.mjs contains duplicate permission codes.");
}

const seedUrl = new URL("../supabase/seed.sql", import.meta.url);
const seedSql = readFileSync(seedUrl, "utf8");
const seedInsertMatch = seedSql.match(
  /insert into permissions \(code, description\) values([\s\S]*?)\son conflict\b[\s\S]*?;/
);
if (!seedInsertMatch) {
  failures.push("supabase/seed.sql has no permissions insert block.");
}
const seedCodes = seedInsertMatch
  ? [...seedInsertMatch[1].matchAll(/\(\s*'([^']+)'\s*,/g)].map((match) => match[1])
  : [];
const seedCodeSet = new Set(seedCodes);
if (seedCodeSet.size !== seedCodes.length) {
  failures.push("supabase/seed.sql contains duplicate permission codes.");
}

const missingFromSeed = libCodes.filter((code) => !seedCodeSet.has(code));
const missingFromLib = seedCodes.filter((code) => !libCodeSet.has(code));
if (missingFromSeed.length > 0) {
  failures.push(
    `Permission codes in permissions.mjs but not in seed.sql: ${missingFromSeed.join(", ")}`
  );
}
if (missingFromLib.length > 0) {
  failures.push(
    `Permission codes in seed.sql but not in permissions.mjs: ${missingFromLib.join(", ")}`
  );
}

const migrationDir = new URL("../supabase/migrations", import.meta.url);
const migrationFiles = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort();
const combinedMigrationSql = migrationFiles
  .map((file) => readFileSync(join(migrationDir.pathname, file), "utf8"))
  .join("\n");

const hasPermissionPattern = /has_permission\(\s*auth\.uid\(\)\s*,\s*[^,]+,\s*'([^']+)'\s*\)/g;
const migrationCodes = new Set();
let match;
while ((match = hasPermissionPattern.exec(combinedMigrationSql)) !== null) {
  migrationCodes.add(match[1]);
}
if (migrationCodes.size === 0) {
  failures.push("No has_permission(...) literals found in supabase/migrations/*.sql.");
}

const unknownMigrationCodes = [...migrationCodes].filter((code) => !libCodeSet.has(code));
if (unknownMigrationCodes.length > 0) {
  failures.push(
    `Migrations call has_permission with codes outside the permission vocabulary: ${unknownMigrationCodes.join(", ")}`
  );
}

if (failures.length) throw new Error(failures.join("\n"));
console.log(
  `Type contract checks passed: ${libCodeSet.size} permission code(s) consistent across permissions.mjs, seed.sql, and migrations.`
);
