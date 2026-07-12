import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dbUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
const psqlProbe = spawnSync("psql", ["--version"], { encoding: "utf8" });
const psqlAvailable = psqlProbe.status === 0;

if (!dbUrl || !psqlAvailable) {
  const reason = !dbUrl
    ? "no DATABASE_URL or SUPABASE_DB_URL is set"
    : "psql is not on PATH";
  console.log(`Skipping RLS tests: ${reason}. Set a local Postgres connection to run supabase/tests/*.sql.`);
  process.exit(0);
}

const testDir = new URL("../supabase/tests", import.meta.url);
const files = readdirSync(testDir).filter((file) => file.endsWith(".sql")).sort();

if (files.length === 0) {
  console.log("No RLS test files found in supabase/tests.");
  process.exit(0);
}

let failures = 0;
for (const file of files) {
  console.log(`Running ${file} ...`);
  const result = spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", join(testDir.pathname, file)], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    failures += 1;
  }
}

if (failures > 0) {
  throw new Error(`${failures} RLS test file(s) failed.`);
}

console.log(`Ran ${files.length} RLS test file(s) successfully.`);
