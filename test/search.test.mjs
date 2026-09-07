import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeQuery, groupResults, debounce, SEARCH_LEGS } from "../src/public/js/search.mjs";

// --- sanitizeQuery -----------------------------------------------------------
// Mirrors src/lib/http/search-routes.mjs's sanitizeSearchQuery -- see
// test/search-routes.test.mjs for the server-side twin of these cases.

test("sanitizeQuery trims surrounding whitespace", () => {
  assert.equal(sanitizeQuery("  fire  "), "fire");
});

test("sanitizeQuery strips characters PostgREST's filter grammar reserves", () => {
  assert.equal(sanitizeQuery("a,b(c).d*e"), "abcde");
});

test("sanitizeQuery keeps word characters, whitespace, and hyphens", () => {
  assert.equal(sanitizeQuery("smith-jones 12"), "smith-jones 12");
});

test("sanitizeQuery enforces the length bound on the STRIPPED string, not the raw input", () => {
  // 5 raw characters, but only 1 survives stripping -- rejected.
  assert.equal(sanitizeQuery("a,,,,"), null);
});

test("sanitizeQuery accepts exactly the minimum length (2)", () => {
  assert.equal(sanitizeQuery("ab"), "ab");
});

test("sanitizeQuery rejects 1 character", () => {
  assert.equal(sanitizeQuery("a"), null);
});

test("sanitizeQuery accepts exactly the maximum length (64)", () => {
  assert.equal(sanitizeQuery("x".repeat(64)), "x".repeat(64));
});

test("sanitizeQuery rejects 65 characters", () => {
  assert.equal(sanitizeQuery("x".repeat(65)), null);
});

test("sanitizeQuery rejects empty, null, undefined, and non-string input", () => {
  assert.equal(sanitizeQuery(""), null);
  assert.equal(sanitizeQuery(null), null);
  assert.equal(sanitizeQuery(undefined), null);
  assert.equal(sanitizeQuery(42), null);
});

test("sanitizeQuery rejects a query that strips down to nothing", () => {
  assert.equal(sanitizeQuery(",.()*"), null);
});

// --- groupResults --------------------------------------------------------------

test("groupResults returns groups in the fixed SEARCH_LEGS order, not response key order", () => {
  const payload = {
    q: "fire",
    results: {
      messages: [{ id: "m1" }],
      incidents: [{ id: "i1" }],
      workOrders: [{ id: "w1" }]
    }
  };
  const groups = groupResults(payload);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["incidents", "workOrders", "messages"]
  );
});

test("groupResults omits a leg absent from results (no permission)", () => {
  const payload = { q: "fire", results: { incidents: [{ id: "i1" }] } };
  const groups = groupResults(payload);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["incidents"]
  );
});

test("groupResults omits a leg present but empty (no matches)", () => {
  const payload = { q: "fire", results: { incidents: [{ id: "i1" }], workOrders: [] } };
  const groups = groupResults(payload);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["incidents"]
  );
});

test("groupResults carries the label and items through unchanged", () => {
  const item = { id: "i1", incident_no: "2026-001" };
  const groups = groupResults({ results: { incidents: [item] } });
  assert.equal(groups[0].label, "Incidents");
  assert.deepEqual(groups[0].items, [item]);
});

test("groupResults returns [] for a missing/malformed payload", () => {
  assert.deepEqual(groupResults(null), []);
  assert.deepEqual(groupResults(undefined), []);
  assert.deepEqual(groupResults({}), []);
  assert.deepEqual(groupResults({ results: null }), []);
  assert.deepEqual(groupResults({ results: "not an object" }), []);
});

test("groupResults never includes a leg outside SEARCH_LEGS's known keys", () => {
  const groups = groupResults({ results: { incidents: [{ id: "i1" }], somethingElse: [{ id: "x" }] } });
  assert.deepEqual(
    groups.map((g) => g.key),
    ["incidents"]
  );
});

test("SEARCH_LEGS names all four legs in display order", () => {
  assert.deepEqual(
    SEARCH_LEGS.map((l) => l.key),
    ["incidents", "workOrders", "employees", "messages"]
  );
});

// --- debounce --------------------------------------------------------------

test("debounce delays the call until `wait`ms of silence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const debounced = debounce(() => {
    calls += 1;
  }, 300);

  debounced();
  t.mock.timers.tick(299);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
});

test("debounce collapses rapid repeated calls into one trailing call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let lastArg = null;
  const debounced = debounce((arg) => {
    calls += 1;
    lastArg = arg;
  }, 300);

  debounced("a");
  t.mock.timers.tick(100);
  debounced("b");
  t.mock.timers.tick(100);
  debounced("c");
  t.mock.timers.tick(300);

  assert.equal(calls, 1);
  assert.equal(lastArg, "c");
});

test("debounce.cancel() suppresses a pending call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const debounced = debounce(() => {
    calls += 1;
  }, 300);

  debounced();
  debounced.cancel();
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
});

test("debounce.cancel() is a no-op with nothing pending", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const debounced = debounce(() => {});
  assert.doesNotThrow(() => debounced.cancel());
});
