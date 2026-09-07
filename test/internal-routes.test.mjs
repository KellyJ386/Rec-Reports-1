import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerInternalRoutes } from "../src/lib/http/internal-routes.mjs";
import { computeDbRowHash } from "../src/lib/audit.mjs";

// Routes both PostgREST calls (to https://example.supabase.co) and
// observability reports (to https://observability.example/report) through
// one global fetch stub, recording every call so assertions can inspect
// exactly what each subsystem sent -- same programmable-stub style as
// test/audit-routes.test.mjs and test/notifications-worker.test.mjs.
function stubFetch(
  t,
  {
    facilities = [],
    chains = {},
    sweptAuthThrottleRows = [],
    reportWorkflowEvents = [],
    incidentEscalations = [],
    incidentReports = []
  } = {}
) {
  const captured = { postgrest: [], observability: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "observability.example") {
      const entry = { url: parsed.toString(), body: init.body ? JSON.parse(init.body) : null, headers: init.headers };
      captured.observability.push(entry);
      return { ok: true, status: 200, text: async () => "" };
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.postgrest.push({ table, method, url: parsed, body });
    let data = [];
    if (table === "facilities" && method === "GET") data = facilities;
    else if (table === "audit_events" && method === "GET") {
      const facilityId = parsed.searchParams.get("facility_id")?.replace("eq.", "");
      data = chains[facilityId] ?? [];
    } else if (table === "outbox_events" && method === "GET") data = [];
    else if (table === "notification_jobs" && method === "GET") data = [];
    else if (table === "auth_throttle" && method === "DELETE") data = sweptAuthThrottleRows;
    else if (table === "report_workflow_events" && method === "GET") data = reportWorkflowEvents;
    else if (table === "report_workflow_events" && method === "PATCH" && parsed.searchParams.get("status") === "eq.pending") {
      // Claim step: PostgREST's return=representation on an UPDATE returns
      // the FULL updated row, not a bare status marker -- echo the matching
      // fixture row (with status flipped) so the executor dispatches on its
      // real action, exactly like test/report-workflow-executor.test.mjs's
      // own stubExecutor helper.
      const id = parsed.searchParams.get("id")?.replace("eq.", "");
      const match = reportWorkflowEvents.find((row) => row.id === id);
      data = match ? [{ ...match, status: "processing" }] : [];
    } else if (table === "report_workflow_events" && method === "PATCH") data = [];
    // IN-21: the incident SLA sweep runs on the same drain invocation.
    else if (table === "incident_escalations" && method === "GET") data = incidentEscalations;
    else if (table === "incident_reports" && method === "GET") data = incidentReports;
    else if (table === "incident_escalations" && method === "PATCH") {
      const id = parsed.searchParams.get("id")?.replace("eq.", "");
      const match = incidentEscalations.find((row) => row.id === id && row.status === "pending");
      data = match ? [{ ...match, status: "expired" }] : [];
    } else if (table === "incident_escalations" && method === "POST") {
      data = body.map((row, index) => ({ id: `esc-new-${index}`, ...row }));
    } else if (table === "incident_audit_events" && method === "POST") data = [];
    else if (table === "notification_routes" && method === "GET") data = [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount() {
  const router = createRouter();
  const sent = [];
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  registerInternalRoutes(router, { sendJson });

  async function call(method, path, { headers = {}, env = {} } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    await handler({ url: path, headers }, {}, { env, params });
    return sent[sent.length - 1];
  }

  return { call };
}

const BASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  CRON_SECRET: "correct-cron-secret",
  OBSERVABILITY_DSN: "https://observability.example/report"
};

// A clean, well-formed two-row hash chain for one facility.
function cleanChain(facilityId) {
  const rowA = {
    id: "a",
    chain_seq: 1,
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: null, after: { locale: "en-US" } },
    facility_id: facilityId,
    organization_id: null,
    created_at: "2026-01-01T00:00:00Z",
    prev_hash: null
  };
  rowA.row_hash = computeDbRowHash(rowA);
  const rowB = {
    id: "b",
    chain_seq: 2,
    event_type: "config.changed",
    entity_table: "facility_settings",
    entity_id: "fs-1",
    event_payload: { before: { locale: "en-US" }, after: { locale: "fr-FR" } },
    facility_id: facilityId,
    organization_id: null,
    created_at: "2026-01-01T00:00:01Z",
    prev_hash: rowA.row_hash
  };
  rowB.row_hash = computeDbRowHash(rowB);
  return [rowA, rowB];
}

// A deliberately tampered chain: rowB's payload was mutated after hashing,
// so its stored row_hash no longer matches a recomputation.
function tamperedChain(facilityId) {
  const [rowA, rowB] = cleanChain(facilityId);
  return [rowA, { ...rowB, event_payload: { before: { locale: "en-US" }, after: { locale: "TAMPERED" } } }];
}

test("POST /internal/audit/verify-all: 503 when CRON_SECRET is unset", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: { ...BASE_ENV, CRON_SECRET: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /CRON_SECRET is not configured/);
  assert.equal(captured.postgrest.length, 0, "must reject before any DB work");
});

test("POST /internal/audit/verify-all: 401 on missing bearer token", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", { env: BASE_ENV, headers: {} });
  assert.equal(result.status, 401);
  assert.equal(captured.postgrest.length, 0);
});

test("POST /internal/audit/verify-all: 401 on wrong bearer token", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer totally-wrong-secret" }
  });
  assert.equal(result.status, 401);
  assert.match(result.payload.error, /invalid or missing cron secret/);
  assert.equal(captured.postgrest.length, 0, "must reject before any DB work");
});

test("POST /internal/audit/verify-all: 503 when SUPABASE_SERVICE_ROLE_KEY is unset", async (t) => {
  const captured = stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /SUPABASE_SERVICE_ROLE_KEY is not configured/);
  assert.equal(captured.postgrest.length, 0);
});

test("GET /internal/audit/verify-all also accepts the cron secret (Vercel Cron fires GET)", async (t) => {
  stubFetch(t, { facilities: [{ id: "fac-1" }], chains: { "fac-1": cleanChain("fac-1") } });
  const { call } = mount();
  const result = await call("GET", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.facilitiesChecked, 1);
  assert.deepEqual(result.payload.broken, []);
});

test("a clean chain across multiple facilities reports nothing broken and no observability POST", async (t) => {
  const captured = stubFetch(t, {
    facilities: [{ id: "fac-1" }, { id: "fac-2" }],
    chains: { "fac-1": cleanChain("fac-1"), "fac-2": cleanChain("fac-2") }
  });
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.facilitiesChecked, 2);
  assert.deepEqual(result.payload.broken, []);
  assert.equal(typeof result.payload.durationMs, "number");
  assert.ok(result.payload.durationMs >= 0);

  assert.equal(captured.observability.length, 0, "a clean chain must never trigger an error report");
});

test("a tampered chain fixture produces a broken entry AND a fire-and-forget observability report", async (t) => {
  const captured = stubFetch(t, {
    facilities: [{ id: "fac-1" }, { id: "fac-2" }],
    chains: { "fac-1": cleanChain("fac-1"), "fac-2": tamperedChain("fac-2") }
  });
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.facilitiesChecked, 2);
  assert.equal(result.payload.broken.length, 1);
  assert.equal(result.payload.broken[0].facilityId, "fac-2");
  assert.equal(result.payload.broken[0].brokenAt, 1);
  assert.equal(result.payload.broken[0].checked, 2);

  // reportError is fire-and-forget (never awaited by the route handler), so
  // give its microtask/timer queue a tick to land before asserting on it.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(captured.observability.length, 1, "the broken chain must produce exactly one error report");
  const report = captured.observability[0];
  assert.match(report.body.message, /fac-2/);
  assert.equal(report.body.route, "internal.audit.verify-all");
  assert.equal(report.body.status, "broken_chain");
  assert.equal(report.body.requestId, "fac-2");
  // No secrets/tokens on the wire -- the CRON_SECRET used to authenticate
  // this very request must never appear in the report payload.
  const wire = JSON.stringify(report.body);
  assert.equal(wire.includes("correct-cron-secret"), false);
  assert.equal(wire.includes("service-key"), false);
});

// ---------------------------------------------------------------------------
// S-7: POST/GET /internal/notifications/drain sweeps stale auth_throttle
// rows after each drain and folds the deleted count into the response.
// ---------------------------------------------------------------------------

test("drain: sweeps auth_throttle (lt filter on updated_at) and reports the deleted count", async (t) => {
  const captured = stubFetch(t, { sweptAuthThrottleRows: [{ key: "email:a@b.com" }, { key: "ip:203.0.113.7" }] });
  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.authThrottleSwept, 2);

  const sweepRequest = captured.postgrest.find((req) => req.table === "auth_throttle" && req.method === "DELETE");
  assert.ok(sweepRequest, "expected exactly one DELETE against auth_throttle");
  assert.match(sweepRequest.url.searchParams.get("updated_at"), /^lt\./);
});

test("drain: folds an all-zero incidentSla summary into the response when nothing is overdue", async (t) => {
  stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.incidentSla, {
    processed: 0,
    expired: 0,
    escalated: 0,
    capped: 0,
    notified: 0,
    raced: 0
  });
});

test("drain: incidentSla expires an overdue escalation and auto-escalates to the next level", async (t) => {
  const overdueEscalation = {
    id: "esc-1",
    facility_id: "fac-1",
    incident_id: "inc-1",
    escalation_level: 1,
    reason_code: "user_escalation",
    target_role: "manager",
    target_user_id: null,
    status: "pending",
    due_at: "2020-01-01T00:00:00.000Z" // long overdue relative to `now`
  };
  const captured = stubFetch(t, {
    incidentEscalations: [overdueEscalation],
    incidentReports: [{ id: "inc-1", facility_id: "fac-1", status: "under_review", severity: "high" }]
  });
  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.incidentSla.processed, 1);
  assert.equal(result.payload.incidentSla.expired, 1);
  assert.equal(result.payload.incidentSla.escalated, 1);

  const newEscalationInsert = captured.postgrest.find(
    (req) => req.table === "incident_escalations" && req.method === "POST"
  );
  assert.equal(newEscalationInsert.body[0].escalation_level, 2);
});

test("drain: a sweep failure fails open -- the drain response still succeeds with authThrottleSwept: 0", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    if (table === "auth_throttle" && init.method === "DELETE") {
      throw new Error("postgrest unreachable");
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: { ...BASE_ENV, OBSERVABILITY_DSN: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.authThrottleSwept, 0);
});

// ---------------------------------------------------------------------------
// DR-20: the drain also runs the report workflow ledger's own pass
// (executeReportWorkflowEvents, src/lib/report-workflow-executor.mjs) on the
// same service-role client and reports its summary under `reportWorkflow`.
// ---------------------------------------------------------------------------

test("drain: invokes the report workflow executor and folds its summary into the response", async (t) => {
  const pendingEvent = {
    id: "wf-evt-1",
    facility_id: "fac-1",
    submission_id: "sub-1",
    event_type: "queue_pdf:0",
    action: { type: "queue_pdf", params: {} },
    status: "pending",
    attempts: 0,
    available_at: "2026-01-01T00:00:00Z"
  };
  const captured = stubFetch(t, { reportWorkflowEvents: [pendingEvent] });
  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.reportWorkflow, { claimed: 1, processed: 1, skipped: 0, failed: 0, deadLettered: 0 });

  const claimPatch = captured.postgrest.find(
    (req) => req.table === "report_workflow_events" && req.method === "PATCH" && req.body?.status === "processing"
  );
  assert.ok(claimPatch, "expected the drain to claim the pending report_workflow_events row");

  const pdfPatch = captured.postgrest.find((req) => req.table === "report_submissions" && req.method === "PATCH");
  assert.ok(pdfPatch, "expected queue_pdf to flip report_submissions.pdf_status");
  assert.equal(pdfPatch.body.pdf_status, "queued");
});

test("drain: an empty report_workflow_events queue reports an all-zero summary", async (t) => {
  stubFetch(t, {});
  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: BASE_ENV,
    headers: { authorization: "Bearer correct-cron-secret" }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.reportWorkflow, { claimed: 0, processed: 0, skipped: 0, failed: 0, deadLettered: 0 });
});

test("when OBSERVABILITY_DSN is unset, a broken chain is still reported in the response but no fetch fires", async (t) => {
  const captured = stubFetch(t, {
    facilities: [{ id: "fac-1" }],
    chains: { "fac-1": tamperedChain("fac-1") }
  });
  const { call } = mount();
  const result = await call("POST", "/internal/audit/verify-all", {
    env: { ...BASE_ENV, OBSERVABILITY_DSN: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.broken.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(captured.observability.length, 0, "DSN unset must stay a silent no-op even for a broken chain");
});

// --- DR-23: report_submissions.pdf_status = 'queued' drain wiring -----------
// The shared stubFetch above only handles facilities/audit_events/
// outbox_events/notification_jobs/auth_throttle, so this test builds its own
// inline stub (same style as the "sweep failure fails open" test above) to
// answer the extra tables report-pdf-worker.mjs's processReportPdfJobs
// queries, plus the Storage upload call, and proves the drain route's
// response actually carries processReportPdfJobs' own summary shape.
test("drain: processes a queued report_submissions row and folds the summary into the response as reportPdf", async (t) => {
  const original = globalThis.fetch;
  const submission = {
    id: "sub-1",
    facility_id: "fac-1",
    department_id: null,
    template_id: "tpl-1",
    template_version_id: "ver-1",
    report_date: "2026-07-18",
    shift_ref: "AM",
    status: "submitted",
    submitted_by: "user-1",
    submitted_at: "2026-07-18T20:00:00.000Z",
    payload_json: { supervisor: "Sam" },
    revision_of: null,
    source: "web",
    pdf_status: "queued",
    pdf_storage_path: null,
    pdf_content_hash: null,
    pdf_attempts: 0
  };
  let uploadCalls = 0;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/storage/v1/object/")) {
      uploadCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ Key: "attachments/mock" }) };
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const respond = {
      report_submissions: method === "GET" ? [submission] : [{ ...submission, pdf_status: "generated" }],
      report_templates: [{ id: "tpl-1", name: "Daily Pool Opening", code: "pool_open" }],
      report_template_versions: [
        { id: "ver-1", template_id: "tpl-1", version_number: 1, schema_json: { sections: [] } }
      ],
      facilities: [{ id: "fac-1", name: "Riverside Rec Center" }],
      report_submission_attachments: [],
      auth_throttle: []
    }[table];
    return { ok: true, status: 200, text: async () => JSON.stringify(respond ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: { ...BASE_ENV, OBSERVABILITY_DSN: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.reportPdf, { claimed: 1, generated: 1, reused: 0, retried: 0, failed: 0 });
  assert.equal(uploadCalls, 1);
});

// ---------------------------------------------------------------------------
// WO-19: the drain also runs PM work-order generation and folds its summary
// into the response under `pmGeneration`.
// ---------------------------------------------------------------------------
test("drain: generates a due PM work order and folds the summary into the response as pmGeneration", async (t) => {
  const original = globalThis.fetch;
  // Anchored far in the past with a huge interval so there is exactly ONE
  // occurrence ever (the anchor itself), always due by the time this test
  // runs, regardless of the machine's real wall-clock date -- the drain
  // route always uses `new Date()` for `now`, so the fixture must stay
  // correct at any real run time rather than depending on a fixed "today".
  const plan = {
    id: "plan-1",
    facility_id: "fac-1",
    asset_id: null,
    title: "Pool pump service",
    description: "Quarterly service",
    cadence_type: "interval",
    interval_days: 3650000,
    anchor_date: "2020-01-01",
    season_months: null,
    lead_time_days: 0,
    priority: "medium",
    default_assignee_employee_id: null,
    active: true,
    last_generated_at: null,
    created_at: "2020-01-01T00:00:00.000Z"
  };
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const respond = {
      pm_plans: method === "GET" ? [plan] : [{ id: "plan-1" }],
      pm_plan_occurrences: method === "POST" ? [{ id: "occ-1" }] : [{ id: "occ-1", work_order_id: "wo-1" }],
      work_orders: [{ id: "wo-1" }],
      facilities: [],
      auth_throttle: [],
      outbox_events: [],
      notification_jobs: [],
      report_workflow_events: [],
      report_submissions: []
    }[table];
    return { ok: true, status: 200, text: async () => JSON.stringify(respond ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const { call } = mount();
  const result = await call("POST", "/internal/notifications/drain", {
    env: { ...BASE_ENV, OBSERVABILITY_DSN: undefined },
    headers: { authorization: "Bearer correct-cron-secret" }
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.pmGeneration.plansScanned, 1);
  assert.equal(result.payload.pmGeneration.created, 1);
  assert.deepEqual(result.payload.pmGeneration.errors, []);
});
