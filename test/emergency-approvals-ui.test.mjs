import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// M-6 (security review, Slice 3E): the emergency-approval queue block was written into the Work
// Orders panel, whose state has no `emergencyLaunches`, so every communications.publish holder got
// a TypeError when that panel rendered -- and the Communications panel, which owns the state and
// the approve/cancel closures, rendered no queue at all (CM-13 approval had no UI).
//
// app.js is one browser script with no DOM-free entry point, so the guarantee is structural: each
// panel IIFE may only touch `state.<key>` for keys its own `const state = {...}` declares, and the
// approval queue lives in the panel that loads it.

const source = await readFile(new URL("../src/public/js/app.js", import.meta.url), "utf8");

// Every top-level `const <name>Panel = (function () { ... })();` block, closed by the first
// column-0 `})();` after it opens (the file's panel IIFEs are all formatted that way).
function panelBlocks() {
  const blocks = new Map();
  const opener = /^const (\w+Panel) = \(function \(\) \{$/gm;
  let match;
  while ((match = opener.exec(source)) !== null) {
    const end = source.indexOf("\n})();", match.index);
    assert.ok(end > match.index, `${match[1]} has no closing })();`);
    blocks.set(match[1], source.slice(match.index, end));
  }
  return blocks;
}

// The top-level keys of a panel's `const state = { ... }` literal.
function declaredStateKeys(block) {
  const start = block.indexOf("const state = {");
  if (start < 0) return null;
  let depth = 0;
  let index = block.indexOf("{", start);
  const open = index;
  for (; index < block.length; index += 1) {
    if (block[index] === "{") depth += 1;
    if (block[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = block.slice(open + 1, index);
  const keys = new Set();
  let level = 0;
  for (const line of literal.split("\n")) {
    if (level === 0) {
      const key = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/) ?? line.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
      if (key) keys.add(key[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") level += 1;
      if (ch === "}" || ch === "]" || ch === ")") level -= 1;
    }
  }
  return keys;
}

test("the panel blocks are found (the structural checks below are not vacuous)", () => {
  const blocks = panelBlocks();
  for (const name of ["workOrdersPanel", "commsPanel", "assetsPanel"]) assert.ok(blocks.has(name), `${name} not found`);
  assert.ok(blocks.size >= 5, `expected several panels, found ${[...blocks.keys()].join(", ")}`);
  const keys = declaredStateKeys(blocks.get("commsPanel"));
  for (const key of ["messages", "emergencyLaunches", "formNotice", "formError"]) assert.ok(keys.has(key), `commsPanel state.${key}`);
  assert.ok(!declaredStateKeys(blocks.get("workOrdersPanel")).has("emergencyLaunches"));
});

test("M-6: every panel reads and writes only the state keys it declares", () => {
  for (const [name, block] of panelBlocks()) {
    const declared = declaredStateKeys(block);
    if (declared === null) continue;
    const used = new Set([...block.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const undeclared = [...used].filter((key) => !declared.has(key));
    assert.deepEqual(undeclared, [], `${name} touches state keys it never declares: ${undeclared.join(", ")}`);
  }
});

test("M-6: the emergency approval queue renders in the Communications panel, and only there", () => {
  const blocks = panelBlocks();
  const comms = blocks.get("commsPanel");
  assert.match(comms, /class: "emergency-approvals"/);
  assert.match(comms, /state\.emergencyLaunches\.length > 0/);
  assert.match(comms, /approveBtn\.addEventListener\("click", \(\) => approveEmergency\(launch\)\)/);
  assert.match(comms, /cancelBtn\.addEventListener\("click", \(\) => cancelEmergency\(launch\)\)/);
  assert.match(comms, /function approveEmergency\(/);
  assert.match(comms, /function cancelEmergency\(/);
  // The queue is drawn by the panel's own render() (which also shows the notice the approval sets).
  const render = comms.slice(comms.indexOf("  function render() {"));
  assert.ok(render.includes("emergency-approvals"), "render() draws the approval queue");
  assert.ok(render.includes("state.formNotice"), "render() shows the 'alert sent' notice");

  for (const [name, block] of blocks) {
    if (name === "commsPanel") continue;
    assert.ok(!block.includes("emergencyLaunches"), `${name} must not read the emergency launch queue`);
    assert.ok(!block.includes("emergency-approvals"), `${name} must not draw the emergency approval queue`);
    assert.ok(!block.includes("approveEmergency"), `${name} must not call approveEmergency`);
  }
});

test("M-3: the approval UI shows the body and the recipient count and refuses a changed message", () => {
  const comms = panelBlocks().get("commsPanel");
  assert.match(comms, /describeEmergencyLaunch\(launch\)/);
  assert.match(comms, /view\.bodyText/);
  assert.match(comms, /view\.recipientLine/);
  assert.match(comms, /window\.confirm\(view\.confirmText\)/);
  assert.match(comms, /if \(!view\.canApprove\) approveBtn\.disabled = true;/);
});
