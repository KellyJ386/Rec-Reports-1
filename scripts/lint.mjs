import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "test"];
const failures = [];
const mjsFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(mjs|js|html|css)$/.test(path)) {
      const text = readFileSync(path, "utf8");
      if (text.includes("\t")) failures.push(`${path}: contains a tab character`);
      if (text.includes("try {\n    await import") || text.includes("try {\n    import")) failures.push(`${path}: import wrapped in try/catch`);
      if (path.endsWith(".mjs")) mjsFiles.push(path);
    }
  }
}
roots.forEach(walk);

const parseCheckRoots = ["scripts", "src/lib", "test"];
const parseCheckFiles = mjsFiles.filter((path) =>
  parseCheckRoots.some((root) => path === root || path.startsWith(`${root}/`))
);
for (const path of parseCheckFiles) {
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${path}: failed node --check\n${result.stderr}`);
  }
}

if (failures.length) throw new Error(failures.join("\n"));
console.log(`Lint checks passed (parsed ${parseCheckFiles.length} .mjs file(s)).`);
