import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import {
  executeReportWorkflowEvents,
  claimDueReportWorkflowEvents,
  resolveManagerRecipients
} from "../src/lib/report-workflow-executor.mjs";

// Same mocked-PostgREST stub-fetch style as test/notifications-worker.test.mjs.
function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body });
    const data = respond(table, method, parsed, body) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

const NOW = new Date("2026-08-13T12:00:00.000Z");

function baseEvent(overrides = {}) {
  return {
    id: "evt-1",
    facility_id: "fac-1",
    submission_id: "sub-1",
    event_type: "queue_pdf:0",
    action: { type: "queue_pdf", params: {} },
    status: "pending",
    attempts: 0,
    last_error: null,
    result: null,
    available_at: "2026-08-13T11:00:00.000Z",
    created_at: "2026-08-13T11:00:00.000Z",
    processed_at: null,
    ...overrides
  };
}

function findPatch(captured, table, predicate) {
  return captured.find((c) => c.table === table && c.method === "PATCH" && predicate(c));
}

// Stubs the two report_workflow_events requests the executor always issues
// (claim GET, claim PATCH pending->processing) around a caller-supplied
// `extra` handler for everything else. Mirrors notifications-worker.test.mjs's
// own convention of echoing `{ ...job, status: "processing" }` from the claim
// PATCH -- PostgREST's `return=representation` on an UPDATE returns the FULL
// updated row (every other column unchanged), not a bare status marker, so
// the stub must preserve `event`'s real action/event_type or the executor
// ends up dispatching on stale/default data.
function stubExecutor(t, event, extra) {
  return stubFetch(t, (table, method, url, body) => {
    if (table === "report_workflow_events" && method === "GET") return [event];
    if (table === "report_workflow_events" && method === "PATCH" && url.searchParams.get("status") === "eq.pending") {
      return [{ ...event, status: "processing" }];
    }
    return extra(table, method, url, body);
  });
}

// --- claimDueReportWorkflowEvents ------------------------------------------

test("claimDueReportWorkflowEvents claims pending, due rows and marks them processing", async (t) => {
  const event = baseEvent({ status: "pending" });
  const captured = stubExecutor(t, event, () => []);
  const claimed = await claimDueReportWorkflowEvents({ client: client(), now: NOW, limit: 25 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].action.type, "queue_pdf");
  const patch = findPatch(captured, "report_workflow_events", () => true);
  assert.equal(patch.body.status, "processing");
});

test("claimDueReportWorkflowEvents skips a row it loses the claim race on", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_workflow_events" && method === "GET") return [baseEvent({ status: "pending" })];
    if (table === "report_workflow_events" && method === "PATCH") return []; // lost the race
    return [];
  });
  const claimed = await claimDueReportWorkflowEvents({ client: client(), now: NOW, limit: 25 });
  assert.equal(claimed.length, 0);
});

// --- executeReportWorkflowEvents: dispatch by action type -------------------

test("queue_pdf sets report_submissions.pdf_status to queued", async (t) => {
  const event = baseEvent({ event_type: "queue_pdf:0", action: { type: "queue_pdf", params: {} } });
  const captured = stubExecutor(t, event, (table, method) => {
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", pdf_status: "queued" }];
    return [];
  });
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.claimed, 1);
  assert.equal(summary.processed, 1);
  assert.equal(summary.failed, 0);

  const pdfPatch = findPatch(captured, "report_submissions", (c) => c.url.searchParams.get("id") === "eq.sub-1");
  assert.equal(pdfPatch.body.pdf_status, "queued");

  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.ok(eventPatch, "expected the claimed event to be marked processed");
});

test("notify resolves manager recipients and inserts a notification_jobs row", async (t) => {
  const event = baseEvent({
    event_type: "notify:0",
    action: { type: "notify", params: { target: "managers", message: "Report filed" } }
  });
  const captured = stubExecutor(t, event, (table, method) => {
    if (table === "notification_jobs" && method === "POST") {
      return [{ id: "job-1", facility_id: "fac-1", event_type: "report.workflow.notify" }];
    }
    return [];
  });
  const adapters = { resolveManagerRecipients: async () => ["emp-1", "emp-2"] };
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25, adapters });
  assert.equal(summary.processed, 1);

  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.ok(insert);
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.deepEqual(insert.body[0].payload_jsonb.recipients, ["emp-1", "emp-2"]);
  assert.equal(insert.body[0].payload_jsonb.target, "managers");
});

test("notify falls back to the built-in DB-backed recipient resolver when no adapter is given", async (t) => {
  const event = baseEvent({ event_type: "notify:0", action: { type: "notify", params: {} } });
  const captured = stubExecutor(t, event, (table) => {
    if (table === "memberships") return [{ user_id: "user-1", role_id: "role-mgr" }];
    if (table === "role_permissions") return [{ role_id: "role-mgr" }];
    if (table === "employees") return [{ id: "emp-9", user_id: "user-1" }];
    if (table === "notification_jobs") return [{ id: "job-2" }];
    return [];
  });
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);
  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.deepEqual(insert.body[0].payload_jsonb.recipients, ["emp-9"]);
});

test("create_incident calls the mint_workflow_incident RPC and records its result", async (t) => {
  const event = baseEvent({
    event_type: "create_incident:0",
    action: { type: "create_incident", params: { severity: "high" } }
  });
  const captured = stubExecutor(t, event, (table, method) => {
    if (table === "rpc/mint_workflow_incident" && method === "POST") {
      return { incident: { id: "inc-1", severity: "high", source_submission_id: "sub-1" }, created: true };
    }
    return [];
  });
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);

  const rpcCall = captured.find((c) => c.table === "rpc/mint_workflow_incident" && c.method === "POST");
  assert.ok(rpcCall, "expected the mint_workflow_incident RPC to be called");
  assert.equal(rpcCall.body.p_submission_id, "sub-1");
  assert.equal(rpcCall.body.p_action.type, "create_incident");

  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.equal(eventPatch.body.result.incident.id, "inc-1");
});

test("create_work_order calls the mint_workflow_work_order RPC", async (t) => {
  const event = baseEvent({
    event_type: "create_work_order:0",
    action: { type: "create_work_order", params: { priority: "high" } }
  });
  const captured = stubExecutor(t, event, (table, method) => {
    if (table === "rpc/mint_workflow_work_order" && method === "POST") {
      return { work_order: { id: "wo-1", priority: "high" }, created: true };
    }
    return [];
  });
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);
  const rpcCall = captured.find((c) => c.table === "rpc/mint_workflow_work_order" && c.method === "POST");
  assert.ok(rpcCall);
  assert.equal(rpcCall.body.p_submission_id, "sub-1");
});

// --- H-1: 'evaluate' events -- server-side action derivation ---------------
// internal.enqueue_report_workflow (0053) inserts exactly one 'evaluate'
// event per submission; THIS is what turns it into the concrete action
// events the rest of this file's tests already dispatch on.

function evaluateEvent(overrides = {}) {
  return baseEvent({
    event_type: "evaluate",
    action: {},
    ...overrides
  });
}

const workflowSubmission = {
  id: "sub-1",
  facility_id: "fac-1",
  department_id: null,
  template_id: "tpl-1",
  template_version_id: "ver-1",
  report_date: "2026-08-13",
  shift_ref: null,
  status: "submitted",
  payload_json: { pool_ready: "pass" },
  submitted_by: "user-1",
  submitted_at: "2026-08-13T11:55:00.000Z"
};

// Stubs the additional lookups executeEvaluate needs beyond the base
// claim/patch pair every test in this file already gets from stubExecutor:
// report_submissions (the submission itself), report_templates (the
// sandbox re-check), report_template_versions (workflow_json), and
// `modules` (loadWorkflowConfig's loadModuleConfig short-circuits to {} the
// moment a module code resolves to no row, so returning [] here is enough
// to keep every config layer at the registry default without also having
// to stub facilities/organization_module_settings/facility_module_overrides).
function stubEvaluate(t, event, { template = { id: "tpl-1", sandbox: false }, version, extra } = {}) {
  const insertedActionEvents = [];
  const captured = stubFetch(t, (table, method, url, body) => {
    if (table === "report_workflow_events" && method === "GET") return [event];
    if (table === "report_workflow_events" && method === "PATCH" && url.searchParams.get("status") === "eq.pending") {
      return [{ ...event, status: "processing" }];
    }
    if (table === "report_submissions" && method === "GET") return [workflowSubmission];
    if (table === "report_templates" && method === "GET") return [template];
    if (table === "report_template_versions" && method === "GET") return [version];
    if (table === "modules" && method === "GET") return [];
    if (table === "report_workflow_events" && method === "POST") {
      insertedActionEvents.push(body[0]);
      return [];
    }
    return extra ? (extra(table, method, url, body) ?? []) : [];
  });
  return { captured, insertedActionEvents };
}

test("an evaluate event derives its action list from workflow_json and inserts one pending event per action", async (t) => {
  const event = evaluateEvent();
  const version = {
    id: "ver-1",
    workflow_json: { on_submit: [{ type: "queue_pdf" }, { type: "notify", params: { message: "hi" } }] }
  };
  const { captured, insertedActionEvents } = stubEvaluate(t, event, { version });

  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.claimed, 1);
  assert.equal(summary.processed, 1);
  assert.equal(summary.failed, 0);

  assert.equal(insertedActionEvents.length, 2);
  assert.deepEqual(
    insertedActionEvents.map((row) => row.event_type),
    ["queue_pdf:0", "notify:1"]
  );
  assert.ok(insertedActionEvents.every((row) => row.status === "pending" && row.submission_id === "sub-1"));

  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.equal(eventPatch.body.result.actions, 2);
  assert.equal(eventPatch.body.result.inserted, 2);
});

test("an evaluate event for a sandbox template produces no action events at all", async (t) => {
  const event = evaluateEvent();
  const version = { id: "ver-1", workflow_json: { on_submit: [{ type: "queue_pdf" }] } };
  const { captured, insertedActionEvents } = stubEvaluate(t, event, {
    template: { id: "tpl-1", sandbox: true },
    version
  });

  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);
  assert.equal(insertedActionEvents.length, 0);

  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.equal(eventPatch.body.result.sandbox, true);
  assert.equal(eventPatch.body.result.actions, 0);
});

test("an evaluate event with an empty workflow_json inserts nothing and still marks processed", async (t) => {
  const event = evaluateEvent();
  const version = { id: "ver-1", workflow_json: {} };
  const { captured, insertedActionEvents } = stubEvaluate(t, event, { version });

  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);
  assert.equal(insertedActionEvents.length, 0);
  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.equal(eventPatch.body.result.actions, 0);
});

// H-1's whole point: nothing about which actions fire is caller-influenced
// any more -- action.type/params on the 'evaluate' event itself (action =
// '{}' per 0053) are irrelevant; only the pinned version's workflow_json
// drives the outcome. A hand-crafted 'evaluate' event carrying an attacker
// action in its own `action` column (impossible through the real RPC, which
// hard-codes '{}', but worth proving the executor itself never reads it)
// produces exactly the template-configured actions, nothing else.
test("an evaluate event's own action payload is ignored -- only the pinned version's workflow_json drives the result", async (t) => {
  const event = evaluateEvent({ action: { type: "create_incident", params: { severity: "critical" } } });
  const version = { id: "ver-1", workflow_json: { on_submit: [{ type: "queue_pdf" }] } };
  const { insertedActionEvents } = stubEvaluate(t, event, { version });

  await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(insertedActionEvents.length, 1);
  assert.equal(insertedActionEvents[0].event_type, "queue_pdf:0");
});

// A 409 (unique violation on report_workflow_events' own unique(submission_id,
// event_type)) on one action insert means a prior pass already landed it --
// treated as a no-op, not a failure, matching ON CONFLICT DO NOTHING.
test("a 409 on one action-event insert is treated as already-enqueued, not a failure", async (t) => {
  const event = evaluateEvent();
  const version = {
    id: "ver-1",
    workflow_json: { on_submit: [{ type: "queue_pdf" }, { type: "notify", params: {} }] }
  };
  let postCount = 0;
  const insertedActionEvents = [];
  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    if (table === "report_workflow_events" && method === "POST") {
      postCount += 1;
      captured.push({ table, method, url: parsed, body });
      if (postCount === 1) {
        // Real PostgREST unique-violation shape, so pgInsert/request()
        // (supabase-rest.mjs) throws a genuine PostgrestError with
        // status 409 -- exactly what the executor's catch checks for.
        return { ok: false, status: 409, text: async () => JSON.stringify({ code: "23505", message: "conflict" }) };
      }
      insertedActionEvents.push(body[0]);
      return { ok: true, status: 201, text: async () => "[]" };
    }
    captured.push({ table, method, url: parsed, body });
    let data = [];
    if (table === "report_workflow_events" && method === "GET") data = [event];
    else if (table === "report_workflow_events" && method === "PATCH" && parsed.searchParams.get("status") === "eq.pending") {
      data = [{ ...event, status: "processing" }];
    } else if (table === "report_workflow_events" && method === "PATCH") data = [event];
    else if (table === "report_submissions" && method === "GET") data = [workflowSubmission];
    else if (table === "report_templates" && method === "GET") data = [{ id: "tpl-1", sandbox: false }];
    else if (table === "report_template_versions" && method === "GET") data = [version];
    else if (table === "modules" && method === "GET") data = [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(insertedActionEvents.length, 1, "the second action still lands even though the first 409'd");
  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.equal(eventPatch.body.result.actions, 2);
  assert.equal(eventPatch.body.result.inserted, 1);
});

// --- Idempotency (re-running never duplicates -- the mint RPC itself is the
// idempotency boundary; the executor just relays whatever it returns) ------

test("re-executing an already-minted create_incident event is a no-op via the RPC's own idempotency", async (t) => {
  const event = baseEvent({ event_type: "create_incident:0", action: { type: "create_incident", params: {} } });
  const captured = stubExecutor(t, event, (table, method) => {
    if (table === "rpc/mint_workflow_incident" && method === "POST") {
      // The RPC's own check-then-insert found an existing row -- created:false.
      return { incident: { id: "inc-existing", source_submission_id: "sub-1" }, created: false };
    }
    return [];
  });
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.failed, 0);
  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "processed");
  assert.equal(eventPatch.body.result.created, false);
});

// --- Failure / backoff / dead-letter ----------------------------------------

// A stub whose rpc/mint_workflow_incident branch returns a PostgREST-style
// error response (ok: false) instead of throwing at the fetch layer --
// pgRpc/request() (supabase-rest.mjs) turns that into a rejected promise the
// same way a real PostgrestError would, exercising the executor's own
// try/catch failure path. The claim PATCH echoes the real event (see
// stubExecutor's own comment above) so attempts/action survive the claim.
function stubFetchWithRpcFailure(t, event, { rpcTable = "rpc/mint_workflow_incident" } = {}) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    if (table === rpcTable) {
      // Not captured -- the failing call itself isn't asserted on, only its
      // effect on report_workflow_events.
      return { ok: false, status: 500, text: async () => JSON.stringify({ message: "boom" }) };
    }
    captured.push({ table, method, url: parsed, body });
    if (table === "report_workflow_events" && method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify([event]) };
    }
    if (table === "report_workflow_events" && method === "PATCH" && parsed.searchParams.get("status") === "eq.pending") {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ ...event, status: "processing" }]) };
    }
    if (table === "report_workflow_events" && method === "PATCH") {
      return { ok: true, status: 200, text: async () => JSON.stringify([event]) };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

test("a failing action increments attempts and reschedules with backoff, staying pending", async (t) => {
  const event = baseEvent({ attempts: 0, action: { type: "create_incident", params: {} } });
  const captured = stubFetchWithRpcFailure(t, event);

  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.failed, 1);
  assert.equal(summary.deadLettered, 0);

  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.attempts === 1);
  assert.equal(eventPatch.body.status, "pending");
  assert.ok(eventPatch.body.last_error);
  // 2-minute base backoff from NOW.
  assert.equal(eventPatch.body.available_at, new Date(NOW.getTime() + 2 * 60 * 1000).toISOString());
});

test("a 5th consecutive failure dead-letters the event (status: failed, terminal)", async (t) => {
  const event = baseEvent({ attempts: 4, action: { type: "create_incident", params: {} } });
  const captured = stubFetchWithRpcFailure(t, event);

  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.deadLettered, 1);
  assert.equal(summary.failed, 0);
  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.attempts === 5);
  assert.equal(eventPatch.body.status, "failed");
});

test("an unknown action type is marked skipped, not failed", async (t) => {
  const event = baseEvent({ action: { type: "self_destruct", params: {} } });
  const captured = stubExecutor(t, event, () => []);
  const summary = await executeReportWorkflowEvents(client(), { now: NOW, limit: 25 });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  const eventPatch = findPatch(captured, "report_workflow_events", (c) => c.body.status === "skipped");
  assert.ok(eventPatch);
  assert.match(eventPatch.body.last_error, /unknown report workflow action type/);
});

// --- resolveManagerRecipients ------------------------------------------

test("resolveManagerRecipients maps role_permissions -> memberships -> employees", async (t) => {
  stubFetch(t, (table) => {
    if (table === "memberships") return [{ user_id: "user-1", role_id: "role-mgr" }, { user_id: "user-2", role_id: "role-staff" }];
    if (table === "role_permissions") return [{ role_id: "role-mgr" }];
    if (table === "employees") return [{ id: "emp-1", user_id: "user-1" }];
    return [];
  });
  const recipients = await resolveManagerRecipients({ client: client(), facilityId: "fac-1" });
  assert.deepEqual(recipients, ["emp-1"]);
});

test("resolveManagerRecipients returns [] when nobody holds the manager-signal permission", async (t) => {
  stubFetch(t, (table) => {
    if (table === "memberships") return [{ user_id: "user-1", role_id: "role-staff" }];
    if (table === "role_permissions") return [];
    return [];
  });
  const recipients = await resolveManagerRecipients({ client: client(), facilityId: "fac-1" });
  assert.deepEqual(recipients, []);
});

test("resolveManagerRecipients returns [] with no facility memberships (no queries beyond the first)", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "memberships") return [];
    return [];
  });
  const recipients = await resolveManagerRecipients({ client: client(), facilityId: "fac-1" });
  assert.deepEqual(recipients, []);
  assert.ok(!captured.some((c) => c.table === "role_permissions"));
});
