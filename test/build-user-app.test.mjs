import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// P-11 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2A): twin of
// test/build-admin.test.mjs for the user-facing app shell (src/public/*,
// built to dist/js/app.js -- as opposed to dist/admin/js/app.js). Builds
// into its own temp directory (rather than the repo's "dist", which
// build-admin.test.mjs also builds into) so the two tests never race each
// other's rm/mkdir/cp of the same output directory when node --test runs
// files concurrently.

function buildToTempDir() {
  const buildDir = mkdtempSync(join(tmpdir(), "rr-build-user-app-"));
  const result = spawnSync(process.execPath, ["scripts/build.mjs", buildDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return buildDir;
}

test("npm run build produces the user-facing app shell", () => {
  const buildDir = buildToTempDir();
  try {
    const indexPath = join(buildDir, "index.html");
    assert.ok(existsSync(indexPath), "index.html should exist after build");

    const html = readFileSync(indexPath, "utf8");

    // Every <script src="..."> referenced by the app shell must exist in the
    // built output.
    const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"[^>]*>/g)].map((match) => match[1]);
    assert.ok(scriptSrcs.length > 0, "expected at least one <script src> in index.html");
    for (const src of scriptSrcs) {
      assert.ok(src.startsWith("/"), `expected an absolute script src, got ${src}`);
      const builtPath = join(buildDir, src);
      assert.ok(existsSync(builtPath), `script referenced at ${src} is missing from the build output`);
    }

    // CSP is default-src 'self': no inline <script>...</script> bodies and no
    // inline event-handler attributes anywhere in the shipped HTML.
    const inlineScriptBodies = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
      (match) => match[1].trim().length > 0
    );
    assert.equal(inlineScriptBodies.length, 0, "index.html must not contain inline <script> bodies");
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "index.html must not use inline event-handler attributes");
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});

test("dist/js/app.js's import graph resolves entirely inside the build output, and every module exists", () => {
  const buildDir = buildToTempDir();
  try {
    const jsRoot = join(buildDir, "js");
    assert.ok(existsSync(jsRoot), "js/ should exist under the build output after build");

    // resolve()+sep gives an unambiguous prefix check: a relative import
    // like "../../../etc/passwd" resolves to a path that does NOT start
    // with this prefix, which is exactly the "no import resolves outside
    // dist" property this test proves.
    const buildRootPrefix = resolve(buildDir) + sep;

    const visited = new Set();
    function walk(filePath) {
      const resolved = resolve(filePath);
      if (visited.has(resolved)) return;
      visited.add(resolved);
      assert.ok(
        resolved.startsWith(buildRootPrefix),
        `import resolved outside the built output directory: ${resolved}`
      );
      assert.ok(existsSync(resolved), `imported module missing from the build output: ${resolved}`);
      const source = readFileSync(resolved, "utf8");
      const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        walk(join(dirname(resolved), specifier));
      }
    }

    walk(join(jsRoot, "app.js"));
    assert.ok(visited.size >= 7, `expected at least 7 app JS modules reachable from app.js, found ${visited.size}`);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});
