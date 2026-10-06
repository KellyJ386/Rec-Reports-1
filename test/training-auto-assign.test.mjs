import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { runTrainingAutoAssign } from "../src/lib/training-auto-assign.mjs";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const FAC_A = "fac-a";
const FAC_B = "fac-b";

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

// A small in-memory PostgREST: just enough of the filter grammar the
// evaluator uses (eq / neq / in / gte / lte / is.null, ON CONFLICT DO
// NOTHING on a column list) to prove idempotency across two real passes.
function matches(row, column, expression) {
  const value = row[column];
  if (expression === "is.null") return value === null || value === undefined;
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot);
  const operand = expression.slice(dot + 1);
  switch (op) {
    case "eq":
      return String(value) === operand;
    case "neq":
      return String(value) !== operand;
    case "gte":
      return String(value) >= operand;
    case "lte":
      return String(value) <= operand;
    case "in":
      return operand.slice(1, -1).split(",").includes(String(value));
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

function makeDb(initial) {
  const tables = structuredClone(initial);
  const log = [];
  return { tables, log };
}

function stubDb(t, db) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    db.log.push({ table, method, url: parsed, body });
    const rows = db.tables[table] ?? (db.tables[table] = []);
    const reserved = new Set(["select", "order", "limit", "offset", "on_conflict"]);
    const filter = (row) =>
      [...parsed.searchParams.entries()].every(([column, expression]) => reserved.has(column) || matches(row, column, expression));
    if (method === "GET") {
      let result = rows.filter(filter);
      const limit = parsed.searchParams.get("limit");
      if (limit) result = result.slice(0, Number(limit));
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    }
    if (method === "POST") {
      const conflict = parsed.searchParams.get("on_conflict")?.split(",");
      const inserted = [];
      for (const row of body) {
        if (conflict && rows.some((existing) => conflict.every((column) => (existing[column] ?? null) === (row[column] ?? null)))) continue;
        const stored = { id: `${table}-${rows.length + 1}`, ...row };
        rows.push(stored);
        inserted.push(stored);
      }
      return { ok: true, status: 201, text: async () => JSON.stringify(inserted) };
    }
    if (method === "PATCH") {
      const touched = rows.filter(filter);
      for (const row of touched) Object.assign(row, body);
      return { ok: true, status: 200, text: async () => JSON.stringify(touched) };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const TYPE = "type-cpr";
const ROLE = "role-guard";

function baseTables(overrides = {}) {
  return {
    training_assignment_rules: [
      { id: "rule-role", facility_id: FAC_A, rule_type: "role", certification_type_id: null, role_id: ROLE, course_id: "course-a", gap_statuses: ["missing"], due_days: 14, active: true, last_evaluated_at: null }
    ],
    courses: [
      { id: "course-a", facility_id: FAC_A, status: "published", deleted_at: null },
      { id: "course-b", facility_id: FAC_B, status: "published", deleted_at: null },
      { id: "course-draft", facility_id: FAC_A, status: "draft", deleted_at: null }
    ],
    memberships: [
      { user_id: "u1", facility_id: FAC_A, role_id: ROLE, status: "active" },
      { user_id: "u2", facility_id: FAC_A, role_id: ROLE, status: "active" },
      { user_id: "u3", facility_id: FAC_A, role_id: ROLE, status: "disabled" },
      { user_id: "u4", facility_id: FAC_A, role_id: "role-other", status: "active" },
      { user_id: "u5", facility_id: FAC_B, role_id: ROLE, status: "active" }
    ],
    employees: [
      { id: "e1", facility_id: FAC_A, user_id: "u1", status: "active", deleted_at: null },
      { id: "e2", facility_id: FAC_A, user_id: "u2", status: "active", deleted_at: null },
      { id: "e3", facility_id: FAC_A, user_id: "u3", status: "active", deleted_at: null },
      { id: "e4", facility_id: FAC_A, user_id: "u4", status: "active", deleted_at: null },
      { id: "e5", facility_id: FAC_B, user_id: "u5", status: "active", deleted_at: null },
      { id: "e-inactive", facility_id: FAC_A, user_id: "u2", status: "inactive", deleted_at: null }
    ],
    training_assignments: [],
    certification_role_requirements: [],
    employee_certifications: [],
    certification_types: [{ id: TYPE, facility_id: FAC_A, renewal_window_days: 30 }],
    ...overrides
  };
}

test("role rule: assigns every active employee holding the role, in the rule's facility only, with the rule as source", async (t) => {
  const db = makeDb(baseTables());
  stubDb(t, db);
  const summary = await runTrainingAutoAssign(client(), { now: NOW, limit: 10 });
  assert.equal(summary.created, 2);
  assert.deepEqual(summary.errors, []);
  const assignments = db.tables.training_assignments;
  assert.deepEqual(assignments.map((a) => a.employee_id).sort(), ["e1", "e2"]);
  for (const assignment of assignments) {
    assert.equal(assignment.facility_id, FAC_A);
    assert.equal(assignment.course_id, "course-a");
    assert.equal(assignment.source_type, "role_rule");
    assert.equal(assignment.source_ref_id, "rule-role");
    assert.equal(assignment.due_at, "2026-07-20T12:00:00.000Z"); // rule due_days 14
    assert.equal(assignment.assigned_by, null);
  }
  // facility B's employee, the disabled membership and the other role are never selected
  assert.equal(assignments.some((a) => ["e3", "e4", "e5", "e-inactive"].includes(a.employee_id)), false);
  // every read the evaluator issued for facility data was facility-scoped
  for (const call of db.log.filter((c) => ["memberships", "employees"].includes(c.table))) {
    assert.equal(call.url.searchParams.get("facility_id"), `eq.${FAC_A}`);
  }
  assert.equal(db.tables.training_assignment_rules[0].last_evaluated_at, NOW.toISOString());
});

test("idempotency: a second pass creates nothing, attempts no insert, and a late joiner is the only new row", async (t) => {
  const db = makeDb(baseTables());
  stubDb(t, db);
  await runTrainingAutoAssign(client(), { now: NOW });
  const insertsAfterFirst = db.log.filter((c) => c.table === "training_assignments" && c.method === "POST").length;

  const second = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(second.created, 0);
  assert.equal(second.deduped, 2);
  assert.equal(db.tables.training_assignments.length, 2);
  assert.equal(db.log.filter((c) => c.table === "training_assignments" && c.method === "POST").length, insertsAfterFirst);

  // a new employee gaining the role gets exactly one assignment
  db.tables.memberships.push({ user_id: "u6", facility_id: FAC_A, role_id: ROLE, status: "active" });
  db.tables.employees.push({ id: "e6", facility_id: FAC_A, user_id: "u6", status: "active", deleted_at: null });
  const third = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(third.created, 1);
  assert.deepEqual(db.tables.training_assignments.map((a) => a.employee_id).sort(), ["e1", "e2", "e6"]);
});

test("a concurrent pass that already inserted the rows is a no-op (ON CONFLICT DO NOTHING), not a duplicate or an error", async (t) => {
  const db = makeDb(baseTables());
  stubDb(t, db);
  // the pre-read sees no rows (the race window), but they exist by insert time
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/training_assignments") && init.method === "POST") {
      db.tables.training_assignments = [
        { id: "x1", facility_id: FAC_A, employee_id: "e1", course_id: "course-a", source_type: "role_rule", source_ref_id: "rule-role" },
        { id: "x2", facility_id: FAC_A, employee_id: "e2", course_id: "course-a", source_type: "role_rule", source_ref_id: "rule-role" }
      ];
    }
    return realFetch(url, init);
  };
  const summary = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(summary.created, 0);
  assert.equal(summary.deduped, 2);
  assert.deepEqual(summary.errors, []);
  assert.equal(db.tables.training_assignments.length, 2);
});

test("certification rule: only employees with a missing/expired/expiring gap for the type, honoring gap_statuses", async (t) => {
  const db = makeDb(
    baseTables({
      training_assignment_rules: [
        { id: "rule-cert", facility_id: FAC_A, rule_type: "certification", certification_type_id: TYPE, role_id: ROLE, course_id: "course-a", gap_statuses: ["missing", "expired"], due_days: null, active: true, last_evaluated_at: null }
      ],
      employee_certifications: [
        { id: "c1", facility_id: FAC_A, employee_id: "e1", certification_type_id: TYPE, expires_at: "2028-01-01", status: "active", deleted_at: null },
        { id: "c2", facility_id: FAC_A, employee_id: "e2", certification_type_id: TYPE, expires_at: "2026-07-20", status: "active", deleted_at: null }
      ]
    })
  );
  stubDb(t, db);
  // e1 holds a valid cert (no gap); e2's cert is only EXPIRING and the rule does not list 'expiring' -> nobody to assign
  let summary = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(summary.created, 0);

  // listing 'expiring' picks up e2; e2's old cert lapsing instead would be 'expired'
  db.tables.training_assignment_rules[0].gap_statuses = ["expiring"];
  db.tables.training_assignment_rules[0].last_evaluated_at = null;
  summary = await runTrainingAutoAssign(client(), { now: NOW });
  assert.deepEqual(db.tables.training_assignments.map((a) => [a.employee_id, a.source_type, a.reason_code]), [
    ["e2", "certification_rule", "auto_certification_rule:expiring"]
  ]);
  assert.equal(db.tables.training_assignments[0].due_at, "2026-08-05T12:00:00.000Z"); // facility default 30 days
});

test("certification rule without a role scopes candidates to the roles of the type's active requirements", async (t) => {
  const db = makeDb(
    baseTables({
      training_assignment_rules: [
        { id: "rule-cert", facility_id: FAC_A, rule_type: "certification", certification_type_id: TYPE, role_id: null, course_id: "course-a", gap_statuses: ["missing"], due_days: null, active: true, last_evaluated_at: null }
      ],
      certification_role_requirements: [
        { facility_id: FAC_A, certification_type_id: TYPE, role_id: ROLE, active: true }
      ]
    })
  );
  stubDb(t, db);
  const summary = await runTrainingAutoAssign(client(), { now: NOW });
  // e1 and e2 hold the required role and have no cert -> missing gap; e4 (other role) is not a candidate
  assert.deepEqual(db.tables.training_assignments.map((a) => a.employee_id).sort(), ["e1", "e2"]);
  assert.equal(summary.candidates, 2);

  // with NO requirement rows there is nobody whose role needs the cert -> nothing assigned
  const empty = makeDb(
    baseTables({
      training_assignment_rules: [
        { id: "rule-cert", facility_id: FAC_A, rule_type: "certification", certification_type_id: TYPE, role_id: null, course_id: "course-a", gap_statuses: ["missing"], due_days: null, active: true, last_evaluated_at: null }
      ]
    })
  );
  stubDb(t, empty);
  await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(empty.tables.training_assignments.length, 0);
});

test("facility scoping: a rule's course in another facility or a draft course assigns nothing and is counted", async (t) => {
  const db = makeDb(
    baseTables({
      training_assignment_rules: [
        { id: "rule-x", facility_id: FAC_A, rule_type: "role", certification_type_id: null, role_id: ROLE, course_id: "course-b", gap_statuses: ["missing"], due_days: null, active: true, last_evaluated_at: null },
        { id: "rule-draft", facility_id: FAC_A, rule_type: "role", certification_type_id: null, role_id: ROLE, course_id: "course-draft", gap_statuses: ["missing"], due_days: null, active: true, last_evaluated_at: null }
      ]
    })
  );
  stubDb(t, db);
  const summary = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(summary.skippedCourse, 2);
  assert.equal(summary.created, 0);
  assert.equal(db.tables.training_assignments.length, 0);
});

test("a facility that turns training.autoAssignEnabled off is skipped", async (t) => {
  const db = makeDb(
    baseTables({
      modules: [{ id: "mod-training", code: "training" }],
      facilities: [{ id: FAC_A, organization_id: "org-1" }],
      organization_module_settings: [],
      facility_module_overrides: [{ facility_id: FAC_A, module_id: "mod-training", config_patch_jsonb: { "training.autoAssignEnabled": false } }]
    })
  );
  stubDb(t, db);
  const summary = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(summary.skippedDisabled, 1);
  assert.equal(summary.created, 0);
});

test("rules are evaluated least-recently-evaluated first and limited, so the tail is never starved", async (t) => {
  const db = makeDb(baseTables());
  stubDb(t, db);
  await runTrainingAutoAssign(client(), { now: NOW, limit: 7 });
  const ruleQuery = db.log.find((c) => c.table === "training_assignment_rules" && c.method === "GET");
  assert.equal(ruleQuery.url.searchParams.get("order"), "last_evaluated_at.asc.nullsfirst");
  assert.equal(ruleQuery.url.searchParams.get("limit"), "7");
  assert.equal(ruleQuery.url.searchParams.get("active"), "eq.true");
});

test("one rule failing is recorded and does not stop the next rule", async (t) => {
  const db = makeDb(
    baseTables({
      training_assignment_rules: [
        { id: "rule-bad", facility_id: FAC_A, rule_type: "role", certification_type_id: null, role_id: "role-boom", course_id: "course-a", gap_statuses: ["missing"], due_days: null, active: true, last_evaluated_at: null },
        { id: "rule-role", facility_id: FAC_A, rule_type: "role", certification_type_id: null, role_id: ROLE, course_id: "course-a", gap_statuses: ["missing"], due_days: null, active: true, last_evaluated_at: null }
      ]
    })
  );
  stubDb(t, db);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (decodeURIComponent(String(url)).includes("role_id=in.(role-boom)")) return { ok: false, status: 500, text: async () => JSON.stringify({ message: "boom" }) };
    return realFetch(url, init);
  };
  const summary = await runTrainingAutoAssign(client(), { now: NOW });
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].ruleId, "rule-bad");
  assert.equal(summary.created, 2);
  assert.equal(summary.rulesEvaluated, 1);
});
