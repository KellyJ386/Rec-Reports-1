import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "scripts", "test"];
const failures = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(mjs|js|html|css)$/.test(path)) {
      const text = readFileSync(path, "utf8");
      if (text.includes("\t")) failures.push(`${path}: contains a tab character`);
      if (text.includes("try {\n    await import") || text.includes("try {\n    import")) failures.push(`${path}: import wrapped in try/catch`);
    }
  }
}
roots.forEach(walk);
if (failures.length) throw new Error(failures.join("\n"));
console.log("Lint checks passed.");
