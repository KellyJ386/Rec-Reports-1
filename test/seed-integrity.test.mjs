import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("verify-seed script exits 0", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-seed.mjs"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});

test("seed.sql has no duplicate permission codes", () => {
  const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  const insertMatch = seedSql.match(
    /insert into permissions \(code, description\) values([\s\S]*?)\non conflict \(code\) do nothing;/
  );
  assert.ok(insertMatch, "expected a permissions insert block in seed.sql");
  const codes = [...insertMatch[1].matchAll(/\(\s*'([^']+)'\s*,/g)].map((match) => match[1]);
  assert.ok(codes.length > 0);
  const uniqueCodes = new Set(codes);
  assert.equal(uniqueCodes.size, codes.length);
});
