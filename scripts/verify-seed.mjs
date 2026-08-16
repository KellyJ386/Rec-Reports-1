import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const seedUrl = new URL("../supabase/seed.sql", import.meta.url);
const seedSql = readFileSync(seedUrl, "utf8");
const seedFilePath = seedUrl.pathname;

const insertBlockPattern = /insert into (\w+) \([^)]*\) values([\s\S]*?)\son conflict\b[\s\S]*?;/g;

function splitTopLevelTuples(valuesText) {
  const tuples = [];
  let depth = 0;
  let inString = false;
  let current = "";
  let awaitingComma = false;
  for (let i = 0; i < valuesText.length; i += 1) {
    const char = valuesText[i];
    if (inString) {
      current += char;
      if (char === "'") {
        if (valuesText[i + 1] === "'") {
          current += valuesText[i + 1];
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === "(") {
      if (depth === 0) {
        if (awaitingComma) {
          throw new Error(
            `Missing comma between tuples before "${current.trim().slice(0, 40)}(..."`
          );
        }
      }
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      current += char;
      if (depth === 0) {
        tuples.push(current.trim());
        current = "";
        awaitingComma = true;
      }
      continue;
    }
    if (depth === 0) {
      if (char === ",") {
        if (!awaitingComma) {
          throw new Error("Unexpected comma outside of a tuple in VALUES list.");
        }
        awaitingComma = false;
        continue;
      }
      if (!/\s/.test(char)) {
        throw new Error(`Unexpected content outside of a tuple in VALUES list: "${char}"`);
      }
      continue;
    }
    current += char;
  }
  if (inString) {
    throw new Error("Unterminated string literal in VALUES list.");
  }
  if (depth !== 0) {
    throw new Error("Unbalanced parentheses in VALUES list.");
  }
  const trailing = current.trim();
  if (trailing.length > 0) {
    throw new Error(`Unexpected trailing content in VALUES list: "${trailing}"`);
  }
  return { tuples };
}

const failures = [];
let blockCount = 0;
let permissionCodes = [];

let match;
while ((match = insertBlockPattern.exec(seedSql)) !== null) {
  const [, tableName, valuesText] = match;
  blockCount += 1;
  let tuples;
  try {
    ({ tuples } = splitTopLevelTuples(valuesText));
  } catch (error) {
    failures.push(`insert into ${tableName}: ${error.message}`);
    continue;
  }
  if (tuples.length === 0) {
    failures.push(`insert into ${tableName}: no tuples found in VALUES list.`);
    continue;
  }
  for (const tuple of tuples) {
    if (!tuple.startsWith("(") || !tuple.endsWith(")")) {
      failures.push(`insert into ${tableName}: malformed tuple "${tuple}".`);
    }
  }
  if (tableName === "permissions") {
    permissionCodes = tuples.map((tuple) => {
      const codeMatch = tuple.match(/^\(\s*'([^']+)'/);
      return codeMatch ? codeMatch[1] : null;
    });
  }
}

if (blockCount === 0) {
  failures.push("No insert ... values ... ; blocks found in seed.sql.");
}

const seenCodes = new Set();
for (const code of permissionCodes) {
  if (code === null) {
    failures.push("Could not parse a permission code from the permissions insert.");
    continue;
  }
  if (seenCodes.has(code)) {
    failures.push(`Duplicate permission code in seed.sql: "${code}".`);
  }
  seenCodes.add(code);
}

if (permissionCodes.length === 0) {
  failures.push("No permission codes found in seed.sql.");
}

if (failures.length > 0) {
  throw new Error(`seed.sql verification failed:\n${failures.join("\n")}`);
}

console.log(`Verified ${blockCount} seed insert block(s) and ${seenCodes.size} unique permission code(s).`);

// ===========================================================================
// Executable verification: the checks above are purely textual (regex over
// seed.sql's source) -- they can never catch a seed statement that is
// syntactically fine but violates a real constraint/trigger once actually
// run against a migrated schema (e.g. a BEFORE INSERT trigger added by a
// later migration). When a database is reachable, actually apply
// scripts/ci/rls-bootstrap-pre.sql, every supabase/migrations/*.sql file in
// order, scripts/ci/rls-bootstrap-post.sql, and finally supabase/seed.sql
// itself to a disposable scratch database and fail on the first error --
// exactly the sequence .github/workflows/ci.yml's bootstrap steps run
// against the real CI Postgres service, just self-contained here so a
// broken seed fails db:verify:seed directly instead of only surfacing later
// (misleadingly) as an unrelated RLS test failure. Mirrors
// scripts/run-rls-tests.mjs's skip-when-unavailable contract exactly: no
// DATABASE_URL/SUPABASE_DB_URL, or no psql on PATH, skips cleanly (exit 0)
// rather than failing -- this must stay a no-op for local devs without a
// Postgres connection.
// ===========================================================================

const dbUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
const psqlProbe = spawnSync("psql", ["--version"], { encoding: "utf8" });
const psqlAvailable = psqlProbe.status === 0;

if (!dbUrl || !psqlAvailable) {
  const reason = !dbUrl
    ? "no DATABASE_URL or SUPABASE_DB_URL is set"
    : "psql is not on PATH";
  console.log(
    `Skipping executable seed verification: ${reason}. Set a local Postgres connection to actually apply bootstrap + migrations + seed.sql.`
  );
  process.exit(0);
}

function runPsql(connectionUrl, args, label) {
  const result = spawnSync("psql", [connectionUrl, "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${label} failed:\n${output}`);
  }
  return result;
}

const scratchDbName = `seed_verify_${Date.now()}_${process.pid}`;
const parsedUrl = new URL(dbUrl);
const maintenanceUrl = new URL(dbUrl);
maintenanceUrl.pathname = "/postgres";
const scratchUrl = new URL(dbUrl);
scratchUrl.pathname = `/${scratchDbName}`;

console.log(`Applying bootstrap + migrations + seed.sql to scratch database "${scratchDbName}" ...`);
runPsql(maintenanceUrl.toString(), ["-c", `create database "${scratchDbName}";`], "Creating scratch database");

try {
  const preBootstrap = new URL("./ci/rls-bootstrap-pre.sql", import.meta.url).pathname;
  runPsql(scratchUrl.toString(), ["-f", preBootstrap], "Bootstrap (rls-bootstrap-pre.sql)");

  const migrationDir = new URL("../supabase/migrations", import.meta.url);
  const migrationFiles = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort();
  if (migrationFiles.length === 0) {
    throw new Error("No Supabase migrations found in supabase/migrations.");
  }
  for (const file of migrationFiles) {
    runPsql(scratchUrl.toString(), ["-f", join(migrationDir.pathname, file)], `Migration ${file}`);
  }

  const postBootstrap = new URL("./ci/rls-bootstrap-post.sql", import.meta.url).pathname;
  runPsql(scratchUrl.toString(), ["-f", postBootstrap], "Bootstrap (rls-bootstrap-post.sql)");

  runPsql(scratchUrl.toString(), ["-f", seedFilePath], "supabase/seed.sql");

  // Re-apply the seed a second time in the same scratch database to prove
  // it is idempotent (every insert must use "on conflict ... do nothing" or
  // equivalent) -- a fresh install only ever runs it once, but CI and local
  // dev workflows re-run it against an already-seeded database routinely.
  runPsql(scratchUrl.toString(), ["-f", seedFilePath], "supabase/seed.sql (second, idempotency check)");

  console.log(
    `Executable seed verification passed: bootstrap + ${migrationFiles.length} migration(s) + seed.sql (twice) applied cleanly to "${scratchDbName}".`
  );
} finally {
  const dropResult = spawnSync(
    "psql",
    [maintenanceUrl.toString(), "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists "${scratchDbName}" with (force);`],
    { encoding: "utf8" }
  );
  if (dropResult.status !== 0) {
    console.warn(
      `Warning: failed to drop scratch database "${scratchDbName}". Connected as: ${parsedUrl.hostname}. Manual cleanup may be required.\n${dropResult.stderr ?? ""}`
    );
  }
}
