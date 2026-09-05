import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("verify-migrations script exits 0 and reports success", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-migrations.mjs"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified/);
});

// OP-05 (0042): the six internal scope/permission helpers must never be
// redefined back into `public` (bare or `public.`-qualified) by a later
// migration -- that would silently reopen them to PostgREST and to PUBLIC's
// default EXECUTE grant. Prove the guard by dropping a violating migration
// file into supabase/migrations, running the real script against it, and
// cleaning up afterward regardless of outcome.
test("verify-migrations rejects a >=0043 migration that redefines an internal helper outside internal", () => {
  const badFile = new URL("../supabase/migrations/9999_bad_internal_helper_redefine.sql", import.meta.url);
  writeFileSync(
    badFile,
    "create or replace function has_permission(check_user_id uuid, check_facility_id uuid, permission_code text)\nreturns boolean\nlanguage sql\nas $$ select true; $$;\n"
  );
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-migrations.mjs"], {
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0, "expected verify-migrations to fail on an unqualified helper redefinition");
    assert.match(result.stderr, /redefines an internal helper outside the internal schema/);
  } finally {
    unlinkSync(badFile);
  }
});

test("verify-migrations accepts an internal.-qualified helper redefinition at >=0043", () => {
  const goodFile = new URL("../supabase/migrations/9999_ok_internal_helper_redefine.sql", import.meta.url);
  writeFileSync(
    goodFile,
    "create or replace function internal.has_permission(check_user_id uuid, check_facility_id uuid, permission_code text)\nreturns boolean\nlanguage sql\nas $$ select true; $$;\n"
  );
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-migrations.mjs"], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    unlinkSync(goodFile);
  }
});

test("requiredRlsTables has no duplicate entries", () => {
  const source = readFileSync(new URL("../scripts/verify-migrations.mjs", import.meta.url), "utf8");
  const arrayMatch = source.match(/const requiredRlsTables = \[([\s\S]*?)\];/);
  assert.ok(arrayMatch, "expected a requiredRlsTables array in verify-migrations.mjs");
  const tables = [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const uniqueTables = new Set(tables);
  assert.equal(uniqueTables.size, tables.length);
});
