import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkflow, actionEventType } from "../src/lib/report-workflow.mjs";

const NOW = new Date("2026-08-13T12:00:00.000Z");

test("evaluateWorkflow returns no actions/warnings for empty workflow_json", () => {
  const result = evaluateWorkflow({ version: { workflow_json: {} }, payload: {}, now: NOW });
  assert.deepEqual(result, { actions: [], warnings: [] });
});

test("evaluateWorkflow returns no actions/warnings when workflow_json is absent", () => {
  const result = evaluateWorkflow({ payload: {}, now: NOW });
  assert.deepEqual(result, { actions: [], warnings: [] });
});

// --- Seeded string-array shape ----------------------------------------------

test("evaluateWorkflow maps the seeded string-array shape (queue_pdf, notify_managers)", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: ["queue_pdf", "notify_managers"] } },
    payload: {},
    now: NOW
  });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions[0], { type: "queue_pdf", params: {} });
  assert.equal(result.actions[1].type, "notify");
  assert.equal(result.actions[1].params.target, "managers");
});

test("evaluateWorkflow records a warning for an unknown string action, never throws", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: ["queue_pdf", "self_destruct"] } },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, "queue_pdf");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /unknown workflow action "self_destruct"/);
});

// --- Object-array shape + conditions -----------------------------------------

test("evaluateWorkflow fires an unconditioned object-shape action", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: [{ type: "queue_pdf" }] } },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, "queue_pdf");
});

test("evaluateWorkflow records a warning for an unknown object action type", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: [{ type: "launch_missiles" }] } },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /unknown or missing action type/);
});

test("evaluateWorkflow evaluates an eq condition and fires only when it matches", () => {
  const workflow_json = {
    on_submit: [{ type: "create_incident", when: [{ field: "pool_ready", op: "eq", value: "fail" }] }]
  };
  const fired = evaluateWorkflow({ version: { workflow_json }, payload: { pool_ready: "fail" }, now: NOW });
  assert.equal(fired.actions.length, 1);
  assert.equal(fired.actions[0].type, "create_incident");

  const notFired = evaluateWorkflow({ version: { workflow_json }, payload: { pool_ready: "pass" }, now: NOW });
  assert.equal(notFired.actions.length, 0);
  assert.equal(notFired.warnings.length, 0);
});

test("evaluateWorkflow AND-combines multiple when conditions", () => {
  const workflow_json = {
    on_submit: [
      {
        type: "notify",
        when: [
          { field: "pool_ready", op: "eq", value: "fail" },
          { field: "attendance", op: "gt", value: 100 }
        ]
      }
    ]
  };
  const bothMatch = evaluateWorkflow({
    version: { workflow_json },
    payload: { pool_ready: "fail", attendance: 150 },
    now: NOW
  });
  assert.equal(bothMatch.actions.length, 1);

  const onlyOneMatches = evaluateWorkflow({
    version: { workflow_json },
    payload: { pool_ready: "fail", attendance: 10 },
    now: NOW
  });
  assert.equal(onlyOneMatches.actions.length, 0);
});

test("evaluateWorkflow supports neq/in/lt operators", () => {
  const workflow_json = {
    on_submit: [
      { type: "notify", when: [{ field: "status", op: "neq", value: "ok" }], params: { target: "a" } },
      { type: "queue_pdf", when: [{ field: "shift", op: "in", value: ["am", "pm"] }] },
      { type: "notify", when: [{ field: "count", op: "lt", value: 5 }], params: { target: "b" } }
    ]
  };
  const result = evaluateWorkflow({
    version: { workflow_json },
    payload: { status: "warn", shift: "pm", count: 2 },
    now: NOW
  });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.actions.length, 3);
});

test("evaluateWorkflow warns and skips a malformed when condition (unknown op)", () => {
  const workflow_json = {
    on_submit: [{ type: "queue_pdf", when: [{ field: "x", op: "regex", value: ".*" }] }]
  };
  const result = evaluateWorkflow({ version: { workflow_json }, payload: { x: "y" }, now: NOW });
  assert.equal(result.actions.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /malformed "when" condition/);
});

test("evaluateWorkflow warns and skips when `in`'s operand isn't an array", () => {
  const workflow_json = {
    on_submit: [{ type: "queue_pdf", when: [{ field: "x", op: "in", value: "not-an-array" }] }]
  };
  const result = evaluateWorkflow({ version: { workflow_json }, payload: { x: "y" }, now: NOW });
  assert.equal(result.actions.length, 0);
  assert.equal(result.warnings.length, 1);
});

test("evaluateWorkflow warns on a non-object/non-string rule entry", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: [42] } },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions.length, 0);
  assert.match(result.warnings[0], /rule must be a string or an object/);
});

// --- create_incident param derivation (incidents.mjs helpers) --------------

test("evaluateWorkflow derives create_incident params with defaults", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: [{ type: "create_incident" }] } },
    payload: {},
    now: NOW
  });
  const action = result.actions[0];
  assert.equal(action.type, "create_incident");
  assert.equal(action.params.severity, "medium");
  assert.equal(action.params.reportType, "incident");
  assert.equal(action.params.requiresOshaReview, false);
  assert.equal(action.params.escalate, false);
});

test("evaluateWorkflow derives requiresOshaReview through incidents.mjs's classifyOshaReview", () => {
  const result = evaluateWorkflow({
    version: {
      workflow_json: {
        on_submit: [
          { type: "create_incident", params: { reportType: "accident", outcomes: ["lost_time"] } }
        ]
      }
    },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions[0].params.requiresOshaReview, true);
});

test("evaluateWorkflow's create_incident escalate hint honors incidents.severityAutoEscalate config", () => {
  const rule = { type: "create_incident", params: { severity: "high" } };
  const withDefault = evaluateWorkflow({
    version: { workflow_json: { on_submit: [rule] } },
    payload: {},
    now: NOW
  });
  assert.equal(withDefault.actions[0].params.escalate, true);

  const withAutoEscalateOff = evaluateWorkflow({
    version: { workflow_json: { on_submit: [rule] } },
    payload: {},
    now: NOW,
    config: { "incidents.severityAutoEscalate": false }
  });
  assert.equal(withAutoEscalateOff.actions[0].params.escalate, false);
});

test("evaluateWorkflow falls back to a safe severity/reportType for an invalid value", () => {
  const result = evaluateWorkflow({
    version: {
      workflow_json: {
        on_submit: [{ type: "create_incident", params: { severity: "catastrophic", reportType: "oops" } }]
      }
    },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions[0].params.severity, "medium");
  assert.equal(result.actions[0].params.reportType, "incident");
});

// --- create_work_order param derivation (work-orders.mjs helpers) ----------

test("evaluateWorkflow derives create_work_order priority/SLA/dueAt through work-orders.mjs", () => {
  const result = evaluateWorkflow({
    version: {
      workflow_json: { on_submit: [{ type: "create_work_order", params: { severity: "critical" } }] }
    },
    payload: {},
    now: NOW
  });
  const action = result.actions[0];
  assert.equal(action.type, "create_work_order");
  assert.equal(action.params.priority, "urgent");
  assert.equal(action.params.slaHours, 24); // workOrders.slaHoursUrgent default
  assert.equal(action.params.dueAt, new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString());
});

test("evaluateWorkflow's create_work_order falls back to the configured default priority", () => {
  const result = evaluateWorkflow({
    version: { workflow_json: { on_submit: [{ type: "create_work_order" }] } },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions[0].params.priority, "medium");
  assert.equal(result.actions[0].params.slaHours, 72); // workOrders.slaHoursRoutine default
});

test("evaluateWorkflow honors an explicit valid create_work_order priority over severity mapping", () => {
  const result = evaluateWorkflow({
    version: {
      workflow_json: {
        on_submit: [{ type: "create_work_order", params: { severity: "low", priority: "urgent" } }]
      }
    },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions[0].params.priority, "urgent");
});

test("evaluateWorkflow ignores an invalid create_work_order priority and falls back to derivation", () => {
  const result = evaluateWorkflow({
    version: {
      workflow_json: { on_submit: [{ type: "create_work_order", params: { priority: "asap" } }] }
    },
    payload: {},
    now: NOW
  });
  assert.equal(result.actions[0].params.priority, "medium");
});

// --- Multiple ordered actions -------------------------------------------

test("evaluateWorkflow preserves rule order in the returned actions", () => {
  const result = evaluateWorkflow({
    version: {
      workflow_json: {
        on_submit: [{ type: "notify" }, { type: "create_incident" }, { type: "queue_pdf" }]
      }
    },
    payload: {},
    now: NOW
  });
  assert.deepEqual(
    result.actions.map((a) => a.type),
    ["notify", "create_incident", "queue_pdf"]
  );
});

// --- actionEventType ---------------------------------------------------

test("actionEventType composes type:index", () => {
  assert.equal(actionEventType({ type: "create_incident" }, 0), "create_incident:0");
  assert.equal(actionEventType({ type: "notify" }, 3), "notify:3");
  assert.equal(actionEventType(undefined, 1), "unknown:1");
});
