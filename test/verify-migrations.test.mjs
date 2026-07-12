import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("verify-migrations script exits 0 and reports success", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-migrations.mjs"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified/);
});

test("requiredRlsTables has no duplicate entries", () => {
  const source = readFileSync(new URL("../scripts/verify-migrations.mjs", import.meta.url), "utf8");
  const arrayMatch = source.match(/const requiredRlsTables = \[([\s\S]*?)\];/);
  assert.ok(arrayMatch, "expected a requiredRlsTables array in verify-migrations.mjs");
  const tables = [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const uniqueTables = new Set(tables);
  assert.equal(uniqueTables.size, tables.length);
});
