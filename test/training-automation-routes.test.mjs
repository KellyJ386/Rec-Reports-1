import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerTrainingAutomationRoutes } from "../src/lib/http/training-automation-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const FAC = "fac-1";
const COURSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TYPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MANAGER = [{ facilityId: FAC, status: "active", permissions: ["training.read", "training.manage"] }];
const READER = [{ facilityId: FAC, status: "active", permissions: ["training.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["training.read", "training.manage"] }];

function errorResponse(status, body = {}) {
  return { __stubStatus: status, __stubBody: body };
}

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const entry = { table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null };
    captured.push(entry);
    const data = respond(table, method, parsed, entry.body) ?? [];
    if (data && typeof data === "object" && "__stubStatus" in data) {
      return { ok: data.__stubStatus < 400, status: data.__stubStatus, text: async () => JSON.stringify(data.__stubBody) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = MANAGER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerTrainingAutomationRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    await handler({ url: path, __body: body === undefined ? undefined : JSON.stringify(body) }, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

const RULE = {
  id: "rule-1", facility_id: FAC, rule_type: "certification", certification_type_id: TYPE, role_id: null, course_id: COURSE,
  gap_statuses: ["missing", "expired", "expiring"], due_days: null, active: true, last_evaluated_at: null
};

// --- rules ----------------------------------------------------------------
test("GET training-rules: a reader lists, a non-member is 403", async (t) => {
  stubFetch(t, (table) => (table === "training_assignment_rules" ? [RULE] : []));
  const ok = await mount({ memberships: READER }).call("GET", `/facilities/${FAC}/training-rules`);
  assert.equal(ok.status, 200);
  assert.equal(ok.payload[0].id, "rule-1");
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", `/facilities/${FAC}/training-rules`)).status, 403);
});

test("POST training-rules validates before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  assert.equal((await call("POST", `/facilities/${FAC}/training-rules`, { ruleType: "role", courseId: COURSE })).status, 400);
  assert.equal(captured.length, 0);
});

test("POST training-rules denies a reader and a non-member", async (t) => {
  stubFetch(t, () => []);
  const body = { ruleType: "role", roleId: ROLE, courseId: COURSE };
  assert.equal((await mount({ memberships: READER }).call("POST", `/facilities/${FAC}/training-rules`, body)).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", `/facilities/${FAC}/training-rules`, body)).status, 403);
});

test("POST training-rules 400s when a referenced course / cert type / role is not in this facility, and writes nothing", async (t) => {
  const captured = stubFetch(t, () => []); // every existence lookup returns no row
  const result = await mount().call("POST", `/facilities/${FAC}/training-rules`, { ruleType: "certification", certificationTypeId: TYPE, courseId: COURSE });
  assert.equal(result.status, 400);
  assert.match(result.payload.errors[0], /courseId was not found/);
  assert.equal(captured.some((c) => c.method === "POST"), false);
});

test("POST training-rules creates a certification rule scoped to the URL facility and maps a duplicate to 409", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (method === "GET") return [{ id: "x" }];
    if (table === "training_assignment_rules" && method === "POST") return [RULE];
    return [];
  });
  const result = await mount().call("POST", `/facilities/${FAC}/training-rules`, {
    ruleType: "certification", certificationTypeId: TYPE, courseId: COURSE, dueDays: 14, gapStatuses: ["expired"]
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "training_assignment_rules" && c.method === "POST");
  assert.deepEqual(
    { ...insert.body[0], created_by: undefined },
    {
      facility_id: FAC, rule_type: "certification", certification_type_id: TYPE, role_id: null, course_id: COURSE,
      due_days: 14, created_by: undefined, gap_statuses: ["expired"]
    }
  );
  // every existence lookup was scoped to the URL facility
  for (const lookup of captured.filter((c) => c.method === "GET")) assert.equal(lookup.url.searchParams.get("facility_id"), `eq.${FAC}`);

  stubFetch(t, (table, method) => {
    if (method === "GET") return [{ id: "x" }];
    if (table === "training_assignment_rules" && method === "POST") return errorResponse(409, { code: "23505" });
    return [];
  });
  const dup = await mount().call("POST", `/facilities/${FAC}/training-rules`, { ruleType: "role", roleId: ROLE, courseId: COURSE });
  assert.equal(dup.status, 409);
});

test("PATCH training-rules: 400 shape, 404, 403 for a reader/outsider, 200 deactivate", async (t) => {
  let captured = stubFetch(t, () => []);
  assert.equal((await mount().call("PATCH", "/training-rules/rule-1", { active: "no" })).status, 400);
  assert.equal(captured.length, 0);
  assert.equal((await mount().call("PATCH", "/training-rules/rule-1", { active: false })).status, 404);

  stubFetch(t, (table) => (table === "training_assignment_rules" ? [RULE] : []));
  assert.equal((await mount({ memberships: READER }).call("PATCH", "/training-rules/rule-1", { active: false })).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("PATCH", "/training-rules/rule-1", { active: false })).status, 403);

  captured = stubFetch(t, (table) => (table === "training_assignment_rules" ? [RULE] : []));
  const ok = await mount().call("PATCH", "/training-rules/rule-1", { active: false, dueDays: 10 });
  assert.equal(ok.status, 200);
  const patch = captured.find((c) => c.method === "PATCH");
  assert.equal(patch.body.active, false);
  assert.equal(patch.body.due_days, 10);
  assert.equal(patch.url.searchParams.get("facility_id"), `eq.${FAC}`);
  assert.equal((await mount().call("PATCH", "/training-rules/rule-1", {})).status, 400);
});

test("PATCH training-rules refuses gapStatuses on a role rule", async (t) => {
  stubFetch(t, (table) => (table === "training_assignment_rules" ? [{ ...RULE, rule_type: "role" }] : []));
  assert.equal((await mount().call("PATCH", "/training-rules/rule-1", { gapStatuses: ["missing"] })).status, 400);
});

// --- incident training triggers ---------------------------------------------
const TRIGGER_CERT = {
  id: "trig-1", facility_id: FAC, incident_id: "inc-1", employee_id: "emp-1", target: { certificationTypeId: TYPE },
  reason: "Refresh CPR", created_by: "u", created_at: "2026-07-01T00:00:00Z"
};
const TRIGGER_MODULE = { ...TRIGGER_CERT, id: "trig-2", target: { trainingModuleId: "mod-1" }, reason: "Review hazards" };
const ASSIGNMENT = {
  id: "assign-1", facility_id: FAC, employee_id: "emp-1", course_id: COURSE, assigned_by: "user-1", assigned_at: "x", due_at: null,
  reason_code: "incident_training_trigger", source_type: "incident_rule", source_ref_id: "trig-1"
};

test("GET incident-training-triggers requires training.manage (reader 403, outsider 403)", async (t) => {
  stubFetch(t, () => []);
  assert.equal((await mount({ memberships: READER }).call("GET", `/facilities/${FAC}/incident-training-triggers`)).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("GET", `/facilities/${FAC}/incident-training-triggers`)).status, 403);
});

test("GET incident-training-triggers rejects an unknown state filter (400)", async (t) => {
  stubFetch(t, () => []);
  assert.equal((await mount().call("GET", `/facilities/${FAC}/incident-training-triggers?state=bogus`)).status, 400);
});

test("GET incident-training-triggers defaults to pending: an already-assigned or converted trigger is filtered out", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_training_triggers") return [TRIGGER_CERT, TRIGGER_MODULE, { ...TRIGGER_CERT, id: "trig-3" }];
    if (table === "incident_training_trigger_conversions") return [{ id: "c1", trigger_id: "trig-3", assignment_id: "assign-3" }];
    if (table === "training_assignments") return [ASSIGNMENT]; // 3B's route already assigned trig-1
    if (table === "employees") return [{ id: "emp-1", first_name: "Ada", last_name: "Lovelace" }];
    if (table === "certification_types") return [{ id: TYPE, code: "CPR", name: "CPR" }];
    return [];
  });
  const pending = await mount().call("GET", `/facilities/${FAC}/incident-training-triggers`);
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.payload.map((row) => row.id), ["trig-2"]);
  assert.equal(pending.payload[0].employeeName, "Ada Lovelace");

  const all = await mount().call("GET", `/facilities/${FAC}/incident-training-triggers?state=all`);
  assert.deepEqual(all.payload.map((row) => [row.id, row.state]), [["trig-1", "assigned"], ["trig-2", "pending"], ["trig-3", "assigned"]]);
  assert.equal(all.payload[0].certificationTypeName, "CPR");
  assert.equal(all.payload[0].assignmentId, "assign-1");
});

test("POST assign: 404 unknown trigger, 403 reader/outsider, 400 bad dueAt", async (t) => {
  stubFetch(t, () => []);
  assert.equal((await mount().call("POST", "/incident-training-triggers/trig-1/assign", {})).status, 404);
  stubFetch(t, (table) => (table === "incident_training_triggers" ? [TRIGGER_CERT] : []));
  assert.equal((await mount({ memberships: READER }).call("POST", "/incident-training-triggers/trig-1/assign", {})).status, 403);
  assert.equal((await mount({ memberships: OUTSIDER }).call("POST", "/incident-training-triggers/trig-1/assign", {})).status, 403);
  assert.equal((await mount().call("POST", "/incident-training-triggers/trig-1/assign", { dueAt: "garbage" })).status, 400);
});

test("POST assign (module target): resolves the course from the module, inserts the incident_rule assignment, then the conversion", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_training_triggers") return [TRIGGER_MODULE];
    if (table === "course_modules") return [{ id: "mod-1", course_id: COURSE }];
    if (table === "courses" || table === "employees") return [{ id: "ok" }];
    if (table === "training_assignments" && method === "POST") return [{ ...ASSIGNMENT, source_ref_id: "trig-2" }];
    if (table === "incident_training_trigger_conversions" && method === "POST") return [{ id: "conv-1", trigger_id: "trig-2", assignment_id: "assign-1" }];
    return [];
  });
  const result = await mount().call("POST", "/incident-training-triggers/trig-2/assign", { dueAt: "2026-09-01T00:00:00Z" });
  assert.equal(result.status, 201);
  assert.equal(result.payload.created, true);
  const assignment = captured.find((c) => c.table === "training_assignments" && c.method === "POST");
  assert.deepEqual(
    { ...assignment.body[0], assigned_by: undefined },
    {
      facility_id: FAC, employee_id: "emp-1", course_id: COURSE, assigned_by: undefined, due_at: "2026-09-01T00:00:00Z",
      reason_code: "incident_training_trigger", source_type: "incident_rule", source_ref_id: "trig-2"
    }
  );
  const conversion = captured.find((c) => c.table === "incident_training_trigger_conversions" && c.method === "POST");
  assert.equal(conversion.body[0].trigger_id, "trig-2");
  assert.equal(conversion.body[0].assignment_id, "assign-1");
  assert.equal(conversion.body[0].facility_id, FAC);
});

test("POST assign (certification target): needs a course or a certification rule (409), accepts courseId, and falls back to an active rule", async (t) => {
  stubFetch(t, (table) => (table === "incident_training_triggers" ? [TRIGGER_CERT] : []));
  const none = await mount().call("POST", "/incident-training-triggers/trig-1/assign", {});
  assert.equal(none.status, 409);
  assert.match(none.payload.error, /no course is linked/);

  // explicit courseId
  const writes = (captured) => captured.filter((c) => c.method === "POST");
  let captured = stubFetch(t, (table, method) => {
    if (table === "incident_training_triggers") return [TRIGGER_CERT];
    if (table === "courses" || table === "employees") return [{ id: "ok" }];
    if (table === "training_assignments" && method === "POST") return [ASSIGNMENT];
    if (table === "incident_training_trigger_conversions" && method === "POST") return [{ id: "conv-1" }];
    return [];
  });
  assert.equal((await mount().call("POST", "/incident-training-triggers/trig-1/assign", { courseId: COURSE })).status, 201);
  assert.equal(captured.find((c) => c.table === "training_assignments" && c.method === "POST").body[0].course_id, COURSE);

  // via an active certification rule for the type
  captured = stubFetch(t, (table, method) => {
    if (table === "incident_training_triggers") return [TRIGGER_CERT];
    if (table === "training_assignment_rules") return [RULE];
    if (table === "courses" || table === "employees") return [{ id: "ok" }];
    if (table === "training_assignments" && method === "POST") return [ASSIGNMENT];
    if (table === "incident_training_trigger_conversions" && method === "POST") return [{ id: "conv-1" }];
    return [];
  });
  assert.equal((await mount().call("POST", "/incident-training-triggers/trig-1/assign", {})).status, 201);
  assert.equal(captured.find((c) => c.table === "training_assignments" && c.method === "POST").body[0].course_id, COURSE);
  assert.equal(writes(captured).length, 2);
});

test("POST assign is idempotent: an existing conversion answers 200 created:false and writes nothing", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "incident_training_triggers") return [TRIGGER_CERT];
    if (table === "incident_training_trigger_conversions") return [{ id: "conv-1", trigger_id: "trig-1", assignment_id: "assign-1" }];
    if (table === "training_assignments") return [ASSIGNMENT];
    return [];
  });
  const result = await mount().call("POST", "/incident-training-triggers/trig-1/assign", {});
  assert.equal(result.status, 200);
  assert.equal(result.payload.created, false);
  assert.equal(result.payload.assignment.id, "assign-1");
  assert.equal(captured.some((c) => c.method === "POST"), false);
});

test("POST assign reuses the incident_rule assignment 3B's route already created and only records the conversion", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_training_triggers") return [TRIGGER_CERT];
    if (table === "incident_training_trigger_conversions" && method === "GET") return [];
    if (table === "training_assignments" && method === "GET") return [ASSIGNMENT];
    if (table === "incident_training_trigger_conversions" && method === "POST") return [{ id: "conv-1", assignment_id: "assign-1" }];
    return [];
  });
  const result = await mount().call("POST", "/incident-training-triggers/trig-1/assign", {});
  assert.equal(result.status, 200);
  assert.equal(result.payload.created, false);
  assert.equal(captured.some((c) => c.table === "training_assignments" && c.method === "POST"), false);
  assert.ok(captured.some((c) => c.table === "incident_training_trigger_conversions" && c.method === "POST"));
});

test("POST assign recovers from losing the assignment race (409 -> re-read) and the conversion race", async (t) => {
  let assignmentReads = 0;
  stubFetch(t, (table, method) => {
    if (table === "incident_training_triggers") return [TRIGGER_MODULE];
    if (table === "course_modules") return [{ id: "mod-1", course_id: COURSE }];
    if (table === "courses" || table === "employees") return [{ id: "ok" }];
    if (table === "training_assignments" && method === "GET") {
      assignmentReads += 1;
      return assignmentReads === 1 ? [] : [{ ...ASSIGNMENT, source_ref_id: "trig-2" }];
    }
    if (table === "training_assignments" && method === "POST") return errorResponse(409, { code: "23505" });
    if (table === "incident_training_trigger_conversions" && method === "POST") return errorResponse(409, { code: "23505" });
    if (table === "incident_training_trigger_conversions" && method === "GET") {
      return assignmentReads >= 2 ? [{ id: "conv-9", trigger_id: "trig-2", assignment_id: "assign-1" }] : [];
    }
    return [];
  });
  const result = await mount().call("POST", "/incident-training-triggers/trig-2/assign", {});
  assert.equal(result.status, 200);
  assert.equal(result.payload.created, false);
  assert.equal(result.payload.conversion.id, "conv-9");
});
