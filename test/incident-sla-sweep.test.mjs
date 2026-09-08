import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { decideEscalationSweep, sweepIncidentEscalations } from "../src/lib/incident-sla-sweep.mjs";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function escalation(overrides = {}) {
  return {
    id: "esc-1",
    facility_id: "fac-1",
    incident_id: "inc-1",
    escalation_level: 1,
    reason_code: "user_escalation",
    target_role: "manager",
    target_user_id: null,
    status: "pending",
    due_at: "2026-08-13T08:00:00.000Z", // 4h before NOW -- overdue
    acknowledged_at: null,
    ...overrides
  };
}

function incident(overrides = {}) {
  return { id: "inc-1", facility_id: "fac-1", status: "under_review", severity: "high", legal_hold: false, ...overrides };
}

// --- decideEscalationSweep (pure) --------------------------------------------

test("decideEscalationSweep skips a non-pending escalation", () => {
  const decision = decideEscalationSweep(escalation({ status: "acknowledged" }), incident(), NOW);
  assert.deepEqual(decision, { expire: false, createNext: false, nextLevel: null, reason: "not_pending" });
});

test("decideEscalationSweep skips an escalation that is not yet overdue", () => {
  const decision = decideEscalationSweep(escalation({ due_at: "2026-08-13T18:00:00.000Z" }), incident(), NOW);
  assert.deepEqual(decision, { expire: false, createNext: false, nextLevel: null, reason: "not_overdue" });
});

test("decideEscalationSweep skips an escalation with no due_at at all", () => {
  const decision = decideEscalationSweep(escalation({ due_at: null }), incident(), NOW);
  assert.equal(decision.expire, false);
});

test("decideEscalationSweep expires but does not re-escalate when the incident is missing", () => {
  const decision = decideEscalationSweep(escalation(), null, NOW);
  assert.equal(decision.expire, true);
  assert.equal(decision.createNext, false);
  assert.equal(decision.reason, "incident_not_found");
  assert.equal(decision.nextLevel, 2);
});

test("decideEscalationSweep expires but does not re-escalate a closed incident", () => {
  const decision = decideEscalationSweep(escalation(), incident({ status: "closed" }), NOW);
  assert.equal(decision.expire, true);
  assert.equal(decision.createNext, false);
  assert.equal(decision.reason, "incident_closed");
});

test("decideEscalationSweep expires and creates the next level for an open incident under the cap", () => {
  const decision = decideEscalationSweep(escalation({ escalation_level: 2 }), incident(), NOW);
  assert.equal(decision.expire, true);
  assert.equal(decision.createNext, true);
  assert.equal(decision.nextLevel, 3);
  assert.equal(decision.reason, "sla_breach");
});

test("decideEscalationSweep honors incidents.maxEscalationLevel default (5): level 5 -> 6 is capped", () => {
  const decision = decideEscalationSweep(escalation({ escalation_level: 5 }), incident(), NOW);
  assert.equal(decision.expire, true);
  assert.equal(decision.createNext, false);
  assert.equal(decision.nextLevel, 6);
  assert.equal(decision.reason, "max_level_reached");
});

test("decideEscalationSweep honors a caller-supplied incidents.maxEscalationLevel override", () => {
  const config = { "incidents.maxEscalationLevel": 2 };
  const underCap = decideEscalationSweep(escalation({ escalation_level: 1 }), incident(), NOW, config);
  assert.equal(underCap.createNext, true);
  assert.equal(underCap.nextLevel, 2);

  const atCap = decideEscalationSweep(escalation({ escalation_level: 2 }), incident(), NOW, config);
  assert.equal(atCap.createNext, false);
  assert.equal(atCap.reason, "max_level_reached");
});

// --- sweepIncidentEscalations (I/O orchestrator) -----------------------------

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body, headers: init.headers });
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

test("sweepIncidentEscalations is a no-op when nothing is overdue", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [];
    return [];
  });
  const summary = await sweepIncidentEscalations(client(), { now: NOW });
  assert.deepEqual(summary, { processed: 0, expired: 0, escalated: 0, capped: 0, notified: 0, raced: 0 });
  // No incident_reports lookup fires when there is nothing to decide against.
  assert.ok(!captured.some((c) => c.table === "incident_reports"));
});

test("sweepIncidentEscalations expires an overdue escalation and creates the next level for an open incident", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "incident_escalations" && method === "GET") return [escalation({ escalation_level: 1 })];
    if (table === "incident_reports" && method === "GET") return [incident()];
    if (table === "incident_escalations" && method === "PATCH") {
      return [escalation({ escalation_level: 1, status: "expired" })];
    }
    if (table === "incident_escalations" && method === "POST") {
      return [escalation({ id: "esc-2", escalation_level: 2, status: "pending" })];
    }
    if (table === "incident_audit_events" && method === "POST") return [];
    if (table === "notification_routes" && method === "GET") return []; // no route configured -> no notification
    return [];
  });

  const summary = await sweepIncidentEscalations(client(), { now: NOW });
  assert.equal(summary.processed, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.escalated, 1);
  assert.equal(summary.capped, 0);
  assert.equal(summary.raced, 0);
  assert.equal(summary.notified, 0);

  const expirePatch = captured.find((c) => c.table === "incident_escalations" && c.method === "PATCH");
  assert.match(expirePatch.url.search, /status=eq\.pending/);
  assert.equal(expirePatch.body.status, "expired");

  const newEscalationInsert = captured.find((c) => c.table === "incident_escalations" && c.method === "POST");
  assert.equal(newEscalationInsert.body[0].escalation_level, 2);
  assert.equal(newEscalationInsert.body[0].reason_code, "sla_breach_auto_escalate");
  assert.equal(newEscalationInsert.body[0].status, "pending");

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInsert.body[0].event_type, "incident.escalated");
  assert.equal(auditInsert.body[0].event_payload.auto, true);
  assert.equal(auditInsert.body[0].event_payload.fromLevel, 1);
  assert.equal(auditInsert.body[0].event_payload.toLevel, 2);
});

test("sweepIncidentEscalations expires without re-escalating a closed incident, and logs incident.escalation_expired", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [escalation()];
    if (table === "incident_reports" && method === "GET") return [incident({ status: "closed" })];
    if (table === "incident_escalations" && method === "PATCH") return [escalation({ status: "expired" })];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });

  const summary = await sweepIncidentEscalations(client(), { now: NOW });
  assert.equal(summary.expired, 1);
  assert.equal(summary.escalated, 0);
  assert.ok(!captured.some((c) => c.table === "incident_escalations" && c.method === "POST"));

  const auditInsert = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInsert.body[0].event_type, "incident.escalation_expired");
  assert.equal(auditInsert.body[0].event_payload.reason, "incident_closed");
});

test("sweepIncidentEscalations skips creating a next level when the cap is reached, but still expires", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [escalation({ escalation_level: 5 })];
    if (table === "incident_reports" && method === "GET") return [incident()];
    if (table === "incident_escalations" && method === "PATCH") return [escalation({ escalation_level: 5, status: "expired" })];
    if (table === "incident_audit_events" && method === "POST") return [];
    return [];
  });

  const summary = await sweepIncidentEscalations(client(), { now: NOW });
  assert.equal(summary.expired, 1);
  assert.equal(summary.capped, 1);
  assert.equal(summary.escalated, 0);
  assert.ok(!captured.some((c) => c.table === "incident_escalations" && c.method === "POST"));
});

test("sweepIncidentEscalations is idempotent per run: a raced expire (0 rows updated) creates no next-level row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [escalation()];
    if (table === "incident_reports" && method === "GET") return [incident()];
    if (table === "incident_escalations" && method === "PATCH") return []; // another process already expired it
    return [];
  });

  const summary = await sweepIncidentEscalations(client(), { now: NOW });
  assert.equal(summary.processed, 1);
  assert.equal(summary.expired, 0);
  assert.equal(summary.raced, 1);
  assert.equal(summary.escalated, 0);
  assert.ok(!captured.some((c) => c.table === "incident_escalations" && c.method === "POST"));
  assert.ok(!captured.some((c) => c.table === "incident_audit_events"));
});

test("sweepIncidentEscalations emits an incident.sla_breached notification job with dedupe_key when a route is configured", async (t) => {
  const route = {
    id: "route-1",
    facility_id: "fac-1",
    event_code: "incident.sla_breached",
    priority: 5,
    route_jsonb: { channels: ["in_app"], distributionListId: "list-1" },
    active: true
  };
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_escalations" && method === "GET") return [escalation({ target_user_id: "emp-target" })];
    if (table === "incident_reports" && method === "GET") return [incident()];
    if (table === "incident_escalations" && method === "PATCH") return [escalation({ status: "expired" })];
    if (table === "incident_escalations" && method === "POST") return [escalation({ id: "esc-2", escalation_level: 2 })];
    if (table === "incident_audit_events" && method === "POST") return [];
    if (table === "notification_routes" && method === "GET") return [route];
    if (table === "distribution_lists" && method === "GET") return [{ id: "list-1", facility_id: "fac-1", active: true }];
    if (table === "distribution_list_members" && method === "GET") {
      return [{ distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-1" }, { id: "emp-target" }];
    if (table === "notification_jobs" && method === "POST") return [];
    return [];
  });

  const summary = await sweepIncidentEscalations(client(), { now: NOW });
  assert.equal(summary.notified, 1);

  const jobsInsert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.ok(jobsInsert, "expected a notification_jobs insert");
  assert.match(jobsInsert.url.search, /on_conflict=dedupe_key/);
  assert.match(jobsInsert.headers.Prefer, /resolution=ignore-duplicates/);
  // M3: the dedupe key now carries the FRESH escalation's own id (esc-2,
  // newEscalation -- the row this specific breach created), not just
  // incidentId:eventCode:recipientId, so a second breach on the same
  // incident/recipient (a different newEscalation id) no longer collides
  // with this one's key.
  const dedupeKeys = jobsInsert.body.map((job) => job.dedupe_key).sort();
  assert.deepEqual(dedupeKeys, [
    "inc-1:incident.sla_breached:esc-2:emp-1",
    "inc-1:incident.sla_breached:esc-2:emp-target"
  ]);
  for (const job of jobsInsert.body) {
    assert.equal(job.payload_jsonb.escalationId, "esc-2");
    assert.equal(job.payload_jsonb.breachedEscalationId, "esc-1");
    assert.equal(job.payload_jsonb.quietHoursBypass, true); // incident() defaults to severity: 'high'
  }
});
