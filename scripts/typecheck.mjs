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

// DR-21 fix: both has_permission patterns below used to require the bare
// `auth.uid()` call as the literal first argument, which silently missed
// every 0049+ policy written with the InitPlan-caching `(select auth.uid())`
// wrapper that migration's own header made the go-forward convention (see
// 0050's header: "every auth.uid() is wrapped (select auth.uid())... for new
// policies from here forward"). That gap was invisible until now because
// every 0049-0053 code with a wrapped-only call already had an EARLIER,
// unwrapped has_permission(...) literal satisfying the uncoveredCodes check
// below -- 0054's reports.distribution.manage is the first code whose only
// RLS wiring is a wrapped call, which is what surfaced this. Both patterns
// now accept either form.
const hasPermissionPattern = /has_permission\(\s*(?:\(select auth\.uid\(\)\)|auth\.uid\(\))\s*,\s*[^,]+,\s*'([^']+)'\s*\)/g;
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

// Slice 1C, S-5 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md): every permission
// code in the catalog must be wired into at least one has_permission(...)
// literal somewhere in supabase/migrations/*.sql -- i.e. actually enforced by
// RLS, not merely gated at the HTTP layer -- EXCEPT the codes below, which
// are BFF-only by design (documented in src/lib/permissions.mjs's own
// comments): incidents.export.pdf has no DB write beyond an audit event
// already covered by another code's policy; reports.workflow.manage stays
// BFF-only even after DR-18/19/20 (0053_report_workflow_events.sql) --
// workflow evaluation is pure, the submit-time enqueue RPC is gated on
// reports.submit, and execution runs entirely under the service-role drain
// client, so no authenticated-role route or policy predicate needs it; it
// remains reserved for a future template-workflow CONFIGURATION surface.
// reports.distribution.manage graduated out of this set in 0054 (DR-21): it
// now gates report_distribution_lists' INSERT/UPDATE/DELETE policy directly
// and is picked up by the anyMigrationCodes scan below. Any other code that
// stops appearing in a migration (or a new code that's added without one)
// is a real regression of the kind S-5 itself fixed for
// incidents.escalate/tasks.create/legal_hold.manage/audit.view and
// reports.publish.
const bffOnlyPermissionCodes = new Set(["incidents.export.pdf", "reports.workflow.manage"]);

// Broader than hasPermissionPattern above (which only matches the 3-arg
// has_permission(auth.uid(), X, 'code') shape): this also matches the 4-arg
// has_permission(auth.uid(), facility_id, department_id, 'code') overload
// (0023) and internal.has_permission(...) (0042) alike, since the permission
// code is always the literal, quoted, LAST argument immediately before the
// closing paren in every call site in this codebase. Accepts either
// auth.uid() form -- see the DR-21 comment above hasPermissionPattern.
const anyHasPermissionPattern = /has_permission\(\s*(?:\(select auth\.uid\(\)\)|auth\.uid\(\))\s*,\s*[^']*'([^']+)'\s*\)/g;
const anyMigrationCodes = new Set();
let anyMatch;
while ((anyMatch = anyHasPermissionPattern.exec(combinedMigrationSql)) !== null) {
  anyMigrationCodes.add(anyMatch[1]);
}

const uncoveredCodes = libCodes.filter(
  (code) => !bffOnlyPermissionCodes.has(code) && !anyMigrationCodes.has(code)
);
if (uncoveredCodes.length > 0) {
  failures.push(
    `Permission codes with no has_permission(...) literal in any migration and not in bffOnlyPermissionCodes: ${uncoveredCodes.join(", ")}`
  );
}

const unknownBffOnlyCodes = [...bffOnlyPermissionCodes].filter((code) => !libCodeSet.has(code));
if (unknownBffOnlyCodes.length > 0) {
  failures.push(
    `scripts/typecheck.mjs's bffOnlyPermissionCodes lists codes outside the permission vocabulary: ${unknownBffOnlyCodes.join(", ")}`
  );
}

// P-11 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2A): every permission
// code the HTTP layer actually checks a caller against must be a code that
// exists in the permissions.mjs catalog -- catches a typo'd or
// since-renamed code in a guard call silently always denying (or, worse,
// silently always allowing were the typo to collide with something else).
//
// This is a regex scan, not an AST: for each of the guard-call names below,
// every call site's third argument (0-based index 2 -- the "code" position
// in requireAuthPermission(auth, facilityId, code) /
// hasPermission(memberships, facilityId, code), and in every local
// requirePerm(auth, facilityId, code, ...) wrapper these route files define
// with the same argument order) is checked when it is either:
//   - a string literal ("training.read"), checked directly, or
//   - a bare identifier (READ, MANAGE, PUBLISH, ...) resolved against that
//     same file's own top-level `const NAME = "literal";` assignments.
// Anything else at that position -- a function parameter threaded through a
// wrapper (requirePerm's own `code` parameter), a member expression
// (attachments-routes.mjs's config.writePermission/readPermission), or a
// call result (workflow-routes.mjs's permissionForTable(...) return value)
// -- cannot be resolved by a regex pass and is skipped rather than guessed
// at. Known, accepted blind spots as of this check's introduction:
//   - attachments-routes.mjs: config.writePermission / config.readPermission
//     are themselves object-literal permission strings a few lines up in
//     the same file (already valid catalog codes) -- just not
//     const-resolvable by this pass.
//   - workflow-routes.mjs: requiredCode comes from admin/export.mjs's
//     permissionForTable(...), outside the two directories this check reads.
// A call whose arguments span multiple lines is also out of scope (every
// call site in this codebase today is single-line).
const GUARD_CALL_NAMES = ["requireAuthPermission", "requirePerm", "requireRead", "hasPermission", "has_permission"];
const TOP_LEVEL_STRING_CONST_RE = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:(?!\2)[^\\]|\\.)*)\2\s*;?\s*$/gm;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const STRING_LITERAL_RE = /^(["'])((?:(?!\1)[^\\]|\\.)*)\1$/;

function topLevelStringConsts(text) {
  const consts = new Map();
  TOP_LEVEL_STRING_CONST_RE.lastIndex = 0;
  let m;
  while ((m = TOP_LEVEL_STRING_CONST_RE.exec(text))) {
    consts.set(m[1], m[3]);
  }
  return consts;
}

// Finds every call to `name(` in text and returns each call's raw argument
// list text plus the 1-based line it starts on. Scans char-by-char with
// paren/string-aware balancing (rather than a single regex) so a call whose
// arguments themselves contain parens, brackets, or quoted strings -- e.g.
// `hasPermission(memberships ?? [], facilityId, "admin.manage")` -- is not
// truncated at the first inner `)`.
function findCallArgLists(text, name) {
  const calls = [];
  const nameRe = new RegExp(`\\b${name}\\s*\\(`, "g");
  let m;
  while ((m = nameRe.exec(text))) {
    const argStart = nameRe.lastIndex;
    let i = argStart;
    let depth = 1;
    let inStr = null;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === inStr) inStr = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push({ argsText: text.slice(argStart, i - 1), line: text.slice(0, m.index).split("\n").length });
  }
  return calls;
}

// Splits a call's argument-list text on top-level commas, respecting
// nested (), [], {}, and quoted strings.
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let current = "";
  let inStr = null;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (inStr) {
      current += ch;
      if (ch === "\\") {
        current += argsText[++i] ?? "";
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current);
  return args.map((s) => s.trim());
}

function permissionLiteralFindings(text, filePath) {
  const findings = [];
  const localConsts = topLevelStringConsts(text);
  for (const name of GUARD_CALL_NAMES) {
    for (const call of findCallArgLists(text, name)) {
      const args = splitTopLevelArgs(call.argsText);
      const codeArg = args[2];
      if (!codeArg) continue;
      let code = null;
      const literalMatch = codeArg.match(STRING_LITERAL_RE);
      if (literalMatch) {
        code = literalMatch[2];
      } else if (IDENTIFIER_RE.test(codeArg) && localConsts.has(codeArg)) {
        code = localConsts.get(codeArg);
      } else {
        continue; // not resolvable by this regex pass -- documented blind spot above
      }
      if (!libCodeSet.has(code)) {
        findings.push(`${filePath}:${call.line}: unknown permission code '${code}' passed to ${name}(...)`);
      }
    }
  }
  return findings;
}

const permissionCallDirs = ["src/lib/http"];
const permissionCallFiles = [];
for (const dir of permissionCallDirs) {
  const dirUrl = new URL(`../${dir}/`, import.meta.url);
  for (const entry of readdirSync(dirUrl)) {
    if (entry.endsWith(".mjs")) permissionCallFiles.push(`${dir}/${entry}`);
  }
}
for (const entry of readdirSync(new URL("../src/lib/", import.meta.url), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".mjs")) permissionCallFiles.push(`src/lib/${entry.name}`);
}

for (const filePath of permissionCallFiles) {
  const text = readFileSync(new URL(`../${filePath}`, import.meta.url), "utf8");
  failures.push(...permissionLiteralFindings(text, filePath));
}

if (failures.length) throw new Error(failures.join("\n"));
console.log(
  `Type contract checks passed: ${libCodeSet.size} permission code(s) consistent across permissions.mjs, seed.sql, and migrations.`
);
