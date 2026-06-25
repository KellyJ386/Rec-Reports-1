import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = ["src", "scripts", "test", "supabase"];
const failures = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else {
      const text = readFileSync(path, "utf8");
      if (!text.endsWith("\n")) failures.push(`${path}: missing trailing newline`);
    }
  }
}
roots.forEach(walk);
if (failures.length) throw new Error(failures.join("\n"));
console.log("Format checks passed.");
