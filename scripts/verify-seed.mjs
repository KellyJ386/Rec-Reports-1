import { readFileSync } from "node:fs";

const seedUrl = new URL("../supabase/seed.sql", import.meta.url);
const seedSql = readFileSync(seedUrl, "utf8");

const insertBlockPattern = /insert into (\w+) \([^)]*\) values([\s\S]*?)\son conflict\b[\s\S]*?;/g;

function splitTopLevelTuples(valuesText) {
  const tuples = [];
  let depth = 0;
  let inString = false;
  let current = "";
  let awaitingComma = false;
  for (let i = 0; i < valuesText.length; i += 1) {
    const char = valuesText[i];
    if (inString) {
      current += char;
      if (char === "'") {
        if (valuesText[i + 1] === "'") {
          current += valuesText[i + 1];
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === "(") {
      if (depth === 0) {
        if (awaitingComma) {
          throw new Error(
            `Missing comma between tuples before "${current.trim().slice(0, 40)}(..."`
          );
        }
      }
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      current += char;
      if (depth === 0) {
        tuples.push(current.trim());
        current = "";
        awaitingComma = true;
      }
      continue;
    }
    if (depth === 0) {
      if (char === ",") {
        if (!awaitingComma) {
          throw new Error("Unexpected comma outside of a tuple in VALUES list.");
        }
        awaitingComma = false;
        continue;
      }
      if (!/\s/.test(char)) {
        throw new Error(`Unexpected content outside of a tuple in VALUES list: "${char}"`);
      }
      continue;
    }
    current += char;
  }
  if (inString) {
    throw new Error("Unterminated string literal in VALUES list.");
  }
  if (depth !== 0) {
    throw new Error("Unbalanced parentheses in VALUES list.");
  }
  const trailing = current.trim();
  if (trailing.length > 0) {
    throw new Error(`Unexpected trailing content in VALUES list: "${trailing}"`);
  }
  return { tuples };
}

const failures = [];
let blockCount = 0;
let permissionCodes = [];

let match;
while ((match = insertBlockPattern.exec(seedSql)) !== null) {
  const [, tableName, valuesText] = match;
  blockCount += 1;
  let tuples;
  try {
    ({ tuples } = splitTopLevelTuples(valuesText));
  } catch (error) {
    failures.push(`insert into ${tableName}: ${error.message}`);
    continue;
  }
  if (tuples.length === 0) {
    failures.push(`insert into ${tableName}: no tuples found in VALUES list.`);
    continue;
  }
  for (const tuple of tuples) {
    if (!tuple.startsWith("(") || !tuple.endsWith(")")) {
      failures.push(`insert into ${tableName}: malformed tuple "${tuple}".`);
    }
  }
  if (tableName === "permissions") {
    permissionCodes = tuples.map((tuple) => {
      const codeMatch = tuple.match(/^\(\s*'([^']+)'/);
      return codeMatch ? codeMatch[1] : null;
    });
  }
}

if (blockCount === 0) {
  failures.push("No insert ... values ... ; blocks found in seed.sql.");
}

const seenCodes = new Set();
for (const code of permissionCodes) {
  if (code === null) {
    failures.push("Could not parse a permission code from the permissions insert.");
    continue;
  }
  if (seenCodes.has(code)) {
    failures.push(`Duplicate permission code in seed.sql: "${code}".`);
  }
  seenCodes.add(code);
}

if (permissionCodes.length === 0) {
  failures.push("No permission codes found in seed.sql.");
}

if (failures.length > 0) {
  throw new Error(`seed.sql verification failed:\n${failures.join("\n")}`);
}

console.log(`Verified ${blockCount} seed insert block(s) and ${seenCodes.size} unique permission code(s).`);
