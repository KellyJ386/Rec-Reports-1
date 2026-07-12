import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const NAV_GROUPS = [
  "Dashboard",
  "Modules &amp; Features",
  "Identity &amp; Permissions",
  "Forms &amp; Fields",
  "Notifications",
  "Facilities &amp; Departments",
  "Certifications",
  "Branding &amp; Documents",
  "Audit &amp; Compliance",
  "Billing &amp; Subscription"
];

test("npm run build produces the admin shell", () => {
  const result = spawnSync(process.execPath, ["scripts/build.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const adminIndexPath = join("dist", "admin", "index.html");
  assert.ok(existsSync(adminIndexPath), "dist/admin/index.html should exist after build");

  const html = readFileSync(adminIndexPath, "utf8");

  // Every <script src="..."> referenced by the admin shell must exist in dist.
  const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  assert.ok(scriptSrcs.length > 0, "expected at least one <script src> in admin/index.html");
  for (const src of scriptSrcs) {
    assert.ok(src.startsWith("/"), `expected an absolute script src, got ${src}`);
    const distPath = join("dist", src);
    assert.ok(existsSync(distPath), `script referenced at ${src} is missing from dist/`);
  }

  // CSP is default-src 'self': no inline <script>...</script> bodies and no
  // inline event-handler attributes anywhere in the shipped HTML.
  const inlineScriptBodies = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
    (match) => match[1].trim().length > 0
  );
  assert.equal(inlineScriptBodies.length, 0, "admin/index.html must not contain inline <script> bodies");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "admin/index.html must not use inline event-handler attributes");

  // The 10 nav groups from the design doc must be present in the shell.
  for (const label of NAV_GROUPS) {
    assert.ok(html.includes(label), `expected nav group "${label}" in admin/index.html`);
  }
});

test("dist/admin ships every JS module the shell transitively imports", () => {
  const jsRoot = join("dist", "admin", "js");
  assert.ok(existsSync(jsRoot), "dist/admin/js should exist after build");

  const visited = new Set();
  function walk(filePath) {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    assert.ok(existsSync(filePath), `imported module missing from dist: ${filePath}`);
    const source = readFileSync(filePath, "utf8");
    const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      walk(join(dirname(filePath), specifier));
    }
  }

  walk(join(jsRoot, "app.js"));
  assert.ok(visited.size >= 8, `expected at least 8 admin JS modules reachable from app.js, found ${visited.size}`);
});
