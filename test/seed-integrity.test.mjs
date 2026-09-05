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

// --- Governance permission expansion role-grant parity (DR-05 + IN-01) -----

const NEW_GOVERNANCE_CODES = [
  "reports.publish",
  "reports.workflow.manage",
  "reports.distribution.manage",
  "incidents.review",
  "incidents.escalate",
  "incidents.tasks.create",
  "incidents.legal_hold.manage",
  "incidents.export.pdf",
  "incidents.audit.view"
];

const SUPERVISOR_TIER_CODES = [
  "incidents.review",
  "incidents.escalate",
  "incidents.tasks.create",
  "reports.publish"
];

function grantedCodesForRole(seedSql, roleId) {
  const rolePattern = new RegExp(`\\(\\s*'${roleId}'\\s*,\\s*'([^']+)'\\s*\\)`, "g");
  return [...seedSql.matchAll(rolePattern)].map((match) => match[1]);
}

test("seed.sql grants all nine new governance codes to the facility/ops admin tier (Tenant Owner, Compliance Admin)", () => {
  const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  for (const roleId of [
    "00000000-0000-0000-0000-000000003201", // Tenant Owner
    "00000000-0000-0000-0000-000000003202" // Compliance Admin
  ]) {
    const granted = grantedCodesForRole(seedSql, roleId);
    for (const code of NEW_GOVERNANCE_CODES) {
      assert.ok(granted.includes(code), `expected role ${roleId} to be granted ${code}`);
    }
  }
});

test("seed.sql grants only the supervisor-tier subset to Ops Admin", () => {
  const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  const granted = grantedCodesForRole(seedSql, "00000000-0000-0000-0000-000000003203");
  for (const code of SUPERVISOR_TIER_CODES) {
    assert.ok(granted.includes(code), `expected Ops Admin to be granted ${code}`);
  }
  const restricted = NEW_GOVERNANCE_CODES.filter((code) => !SUPERVISOR_TIER_CODES.includes(code));
  for (const code of restricted) {
    assert.ok(!granted.includes(code), `expected Ops Admin NOT to be granted ${code}`);
  }
});

test("seed.sql grants none of the new governance codes to the frontline/read-only tier (Read-Only Auditor)", () => {
  const seedSql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  const granted = grantedCodesForRole(seedSql, "00000000-0000-0000-0000-000000003204");
  for (const code of NEW_GOVERNANCE_CODES) {
    assert.ok(!granted.includes(code), `expected Read-Only Auditor NOT to be granted ${code}`);
  }
});
