import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// P-11 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2A): real lint checks
// without adding a dependency (no ESLint, no parser) -- everything below is
// regex/text scanning over the raw source, not an AST. That is a deliberate
// trade: every heuristic here has documented blind spots, and per the plan's
// own instruction, a false positive that fails CI is worse than a miss, so
// every check below is written to skip what it cannot resolve with
// confidence rather than guess. Findings this pass actually produced on the
// tree (and what was done with each) are recorded in the Wave 2 slice 2A
// report, not here.

const TEXT_CHECK_ROOTS = ["src", "scripts", "api", "test"];
const TEXT_FILE_RE = /\.(mjs|js|html|css)$/;
const CODE_FILE_RE = /\.(mjs|js)$/;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function escapeForRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countWordOccurrences(text, name) {
  const re = new RegExp(`\\b${escapeForRegex(name)}\\b`, "g");
  return (text.match(re) || []).length;
}

// -----------------------------------------------------------------------
// (a) Unused top-level bindings: import / const / let / function.
//
// "Top-level" is approximated as "written flush left, column 0" -- this
// codebase's exclusive style for module-scope const/let/function/import
// statements (no indented top-level declaration exists in the tree; an
// indented one would simply never be seen by this check -- a miss, not a
// false positive). A binding is "used" if its name appears anywhere else in
// the file via a plain word-boundary text search, which trivially also
// counts a use inside a template-string interpolation (it's just text to a
// regex). A binding is "used" if it is exported, however it's exported:
// `export const/let/function NAME`, `export default function NAME`, or a
// later `export { NAME }` / `export { NAME as other }` list.
//
// Known blind spots (kept narrow on purpose, see the module comment above):
//  - Top-level destructuring (`const { a, b } = x;`) is not recognized as a
//    declaration at all, so such bindings are never checked either way.
//  - A nested (function-scoped) binding that shadows a top-level name
//    inflates the top-level binding's use count, which can hide a
//    genuinely-dead top-level binding. Rare here: module constants are
//    SCREAMING_SNAKE_CASE and locals are camelCase, so collisions are
//    unlikely in practice.
//  - A binding referenced only through computed/dynamic property access
//    (`obj[name]`, a matching string literal elsewhere) is invisible to a
//    word-boundary search either way.
// Any binding this check cannot safely resolve for another reason belongs
// in UNUSED_BINDING_ALLOWLIST below, one entry per (file, name), with the
// reason it can't be resolved -- not a reason it's "probably fine".
// -----------------------------------------------------------------------

const UNUSED_BINDING_ALLOWLIST = new Set([
  // "path:Name" pairs. Empty: nothing in the tree needed one as of this
  // pass -- every finding the check produced was a genuine unused binding
  // and was deleted instead of allow-listed. Add an entry here only when a
  // binding is provably used but this text-based check cannot see how.
]);

// Anchored to the real start of a line (multiline `^`, not `\bimport\b`
// anywhere): this codebase writes every import statement flush left, and
// anchoring this way is also what keeps this check from misfiring on the
// word "import" appearing mid-line in prose -- e.g. inside a test
// description string, or (self-referentially) inside this very file's own
// test/lint-script.test.mjs fixtures, which deliberately contain fixture
// text that *looks* like import statements as JS string literals rather
// than as real, line-initial import statements. Shared by both the
// unused-import-binding check and the duplicate-import check below so
// there is exactly one definition of "what counts as an import statement"
// to get right. `from` is optional so a bare side-effect import
// (`import "./x.mjs";`) is still recognized for duplicate-specifier
// purposes even though it declares no binding.
const IMPORT_STATEMENT_RE =
  /^import\s+(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:from\s*)?["']([^"']+)["']\s*;?/gm;

const TOP_LEVEL_DECL_RE = /^(export\s+)?(?:default\s+)?(?:async\s+)?(const|let|function)\s+([A-Za-z_$][\w$]*)/gm;

const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g;

function collectExportedListNames(text) {
  const names = new Set();
  EXPORT_LIST_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_LIST_RE.exec(text))) {
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      names.add(part.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

function collectDeclaredBindings(text) {
  const bindings = [];

  IMPORT_STATEMENT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_STATEMENT_RE.exec(text))) {
    const line = lineOf(text, m.index);
    if (m[1]) bindings.push({ name: m[1], kind: "import", line, exported: false });
    if (m[2]) bindings.push({ name: m[2], kind: "import", line, exported: false });
    if (m[3]) {
      for (const part of m[3].split(",").map((s) => s.trim()).filter(Boolean)) {
        const local = part.split(/\s+as\s+/).pop().trim();
        if (local) bindings.push({ name: local, kind: "import", line, exported: false });
      }
    }
  }

  TOP_LEVEL_DECL_RE.lastIndex = 0;
  while ((m = TOP_LEVEL_DECL_RE.exec(text))) {
    const line = lineOf(text, m.index);
    bindings.push({ name: m[3], kind: m[2], line, exported: Boolean(m[1]) });
  }

  return bindings;
}

export function findUnusedBindings(text, filePath) {
  const findings = [];
  const exportedViaList = collectExportedListNames(text);
  for (const binding of collectDeclaredBindings(text)) {
    if (binding.exported || exportedViaList.has(binding.name)) continue;
    if (UNUSED_BINDING_ALLOWLIST.has(`${filePath}:${binding.name}`)) continue;
    const count = countWordOccurrences(text, binding.name);
    if (count <= 1) {
      findings.push(`${filePath}:${binding.line}: unused ${binding.kind} '${binding.name}'`);
    }
  }
  return findings;
}

// -----------------------------------------------------------------------
// (b) Duplicate imports: two or more `import ... from "same/specifier"`
// statements in one file (should be a single import statement instead).
//
// Blind spot: only exact-string specifier matches are compared. A relative
// path spelled two different ways that resolves to the same module (e.g.
// "./x.mjs" from one file vs. "../dir/x.mjs" from another context copied in)
// would not be caught -- that needs real path resolution, which this
// AST-free pass deliberately does not attempt.
// -----------------------------------------------------------------------

export function findDuplicateImports(text, filePath) {
  const findings = [];
  const firstSeenAtLine = new Map();
  IMPORT_STATEMENT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_STATEMENT_RE.exec(text))) {
    const specifier = m[4];
    const line = lineOf(text, m.index);
    if (firstSeenAtLine.has(specifier)) {
      findings.push(
        `${filePath}:${line}: duplicate import of "${specifier}" (first imported at line ${firstSeenAtLine.get(specifier)})`
      );
    } else {
      firstSeenAtLine.set(specifier, line);
    }
  }
  return findings;
}

// -----------------------------------------------------------------------
// (c) innerHTML interpolation: `el.innerHTML = ...` / `el.innerHTML += ...`
// whose right-hand side is a template literal containing `${...}`
// interpolation is a live XSS risk in browser-side code. Safe when every
// interpolation in that literal is wrapped by escapeHtml(...) -- this
// codebase's one sanctioned escaping helper -- so `${escapeHtml(x)}` is
// fine and a bare `${x}` is not. Also exempt: any match textually inside
// escapeHtml's own function body (it never needs to escape its own output,
// but a future change to it should not have to fight this check to do so).
//
// Blind spots:
//  - A plain string or bare identifier RHS (`el.innerHTML = html;`, built
//    up safely elsewhere via `html += ...`) has no `${` to find and is out
//    of scope by design -- the plan limited this check to template-literal
//    interpolation, not string concatenation (`"<div>" + x`).
//  - An unterminated template literal (a syntax error node --check would
//    already catch) is scanned to end-of-file rather than failing loudly
//    here; harmless in practice since node --check runs on every file too.
// -----------------------------------------------------------------------

function functionBodyRanges(text, name) {
  const ranges = [];
  const re = new RegExp(`function\\s+${escapeForRegex(name)}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(text))) {
    const braceStart = text.indexOf("{", m.index);
    if (braceStart === -1) continue;
    let depth = 1;
    let i = braceStart + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    ranges.push([braceStart, i]);
  }
  return ranges;
}

// Balanced scan of a template literal starting at text[start] === "`".
// Returns the closing backtick's index and the raw text of each top-level
// ${...} interpolation. A nested string/template inside an interpolation is
// treated as an opaque quoted run (its quote character can't prematurely
// end the outer scan) -- sufficient for every interpolation actually
// written in this codebase (simple expressions and function calls); a
// pathological, deeply-nested interpolation is a known blind spot.
function scanTemplateLiteral(text, start) {
  let i = start + 1;
  const interpolations = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return { end: i, interpolations };
    if (ch === "$" && text[i + 1] === "{") {
      const exprStart = i + 2;
      let depth = 1;
      let j = exprStart;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'" || c === "`") {
          const quote = c;
          j++;
          while (j < text.length && text[j] !== quote) {
            if (text[j] === "\\") j++;
            j++;
          }
        }
        j++;
      }
      interpolations.push(text.slice(exprStart, j - 1));
      i = j;
      continue;
    }
    i++;
  }
  return { end: text.length, interpolations };
}

const INNER_HTML_ASSIGN_RE = /\.innerHTML\s*(\+=|=)(?!=)/g;

export function findInnerHtmlInterpolationViolations(text, filePath) {
  const findings = [];
  const exemptRanges = functionBodyRanges(text, "escapeHtml");
  INNER_HTML_ASSIGN_RE.lastIndex = 0;
  let m;
  while ((m = INNER_HTML_ASSIGN_RE.exec(text))) {
    let i = INNER_HTML_ASSIGN_RE.lastIndex;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "`") continue; // not a template literal RHS: out of scope
    const { end, interpolations } = scanTemplateLiteral(text, i);
    INNER_HTML_ASSIGN_RE.lastIndex = end + 1;
    if (interpolations.length === 0) continue;
    const insideEscapeHtml = exemptRanges.some(([start, stop]) => m.index >= start && m.index < stop);
    if (insideEscapeHtml) continue;
    const allEscaped = interpolations.every((expr) => /^\s*escapeHtml\(/.test(expr));
    if (allEscaped) continue;
    const line = lineOf(text, m.index);
    findings.push(`${filePath}:${line}: innerHTML assigned a template literal with unescaped \${...} interpolation`);
  }
  return findings;
}

// test/lint-script.test.mjs is the one file in this tree whose job is to
// contain, as plain JS string literals, small code snippets that
// deliberately match (or deliberately don't match) the forbidden pattern
// the next check looks for -- that is what it means to unit-test that
// check's function against fixture strings. Line-start anchoring (see
// IMPORT_STATEMENT_RE above) already keeps the import-based checks from
// mistaking that file's prose and fixtures for real code, but the next
// check's target pattern has no such anchor available (a real assignment
// of that shape is legitimately indented inside a function body), so one
// of that file's fixture strings reads, to this raw-text scan, exactly
// like the real violation it exists to test for. This file's own tests for
// that check are the actual proof the check works; skipping the raw-file
// scan here is not skipping coverage, it's avoiding a guaranteed
// self-collision between "code" and "a string that describes code".
const INNER_HTML_SCAN_EXCLUDES = new Set([join("test", "lint-script.test.mjs")]);

// -----------------------------------------------------------------------
// Main: walk the tree, run every check, and report every finding at once.
// -----------------------------------------------------------------------

function collectFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (TEXT_FILE_RE.test(path)) files.push(path);
    }
  }
  TEXT_CHECK_ROOTS.forEach(walk);
  return files;
}

export function runLintChecks() {
  const failures = [];
  const allFiles = collectFiles();
  const codeFiles = allFiles.filter((path) => CODE_FILE_RE.test(path));

  for (const path of allFiles) {
    const text = readFileSync(path, "utf8");
    if (text.includes("\t")) failures.push(`${path}: contains a tab character`);
    if (text.includes("try {\n    await import") || text.includes("try {\n    import")) {
      failures.push(`${path}: import wrapped in try/catch`);
    }
  }

  for (const path of codeFiles) {
    const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(`${path}: failed node --check\n${result.stderr}`);
    }
  }

  for (const path of codeFiles) {
    const text = readFileSync(path, "utf8");
    failures.push(...findUnusedBindings(text, path));
    failures.push(...findDuplicateImports(text, path));
    if (!INNER_HTML_SCAN_EXCLUDES.has(path)) {
      failures.push(...findInnerHtmlInterpolationViolations(text, path));
    }
  }

  return { failures, fileCount: codeFiles.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { failures, fileCount } = runLintChecks();
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    `Lint checks passed (parsed ${fileCount} code file(s) across ${TEXT_CHECK_ROOTS.join(", ")}).`
  );
}
