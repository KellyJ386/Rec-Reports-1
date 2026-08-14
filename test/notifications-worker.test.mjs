import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { claimDueJobs, processJob, drainOnce, drainOutboxOnce } from "../src/lib/notifications/worker.mjs";

// Same mocked-PostgREST stub-fetch style as test/notification-routes.test.mjs
// and test/supabase-rest.test.mjs: `respond(table, method, url, body)` returns
// the JSON payload for a given request; every call is recorded in `captured`
// so assertions can inspect exactly what the worker sent.
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

// A time clear of the default 22:00-06:00 quiet-hours window.
const NOON = new Date("2026-08-13T15:00:00.000Z");
// A time inside the default quiet-hours window.
const QUIET = new Date("2026-08-13T23:00:00.000Z");

function baseJob(overrides = {}) {
  return {
    id: "job-1",
    facility_id: "fac-1",
    event_type: "incident.escalated",
    payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["in_app", "email"] },
    scheduled_for: "2026-08-13T14:00:00.000Z",
    status: "processing",
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    ...overrides
  };
}

function findPatch(captured, table, predicate) {
  return captured.find((c) => c.table === table && c.method === "PATCH" && predicate(c));
}

function baseOutboxEvent(overrides = {}) {
  return {
    id: "outbox-1",
    facility_id: "fac-1",
    event_type: "incident.escalated",
    payload: { incident_id: "inc-1" },
    status: "pending",
    attempts: 0,
    available_at: "2026-08-13T14:00:00.000Z",
    processed_at: null,
    last_error: null,
    next_attempt_at: null,
    created_at: "2026-08-13T14:00:00.000Z",
    ...overrides
  };
}

const ROUTE_1 = {
  id: "route-1",
  facility_id: "fac-1",
  event_code: "incident.escalated",
  priority: 5,
  route_jsonb: { channels: ["in_app"], distributionListId: "list-1" },
  active: true
};

function lastPatch(captured, table) {
  const patches = captured.filter((c) => c.table === table && c.method === "PATCH");
  return patches[patches.length - 1];
}

test("claimDueJobs claims due pending jobs via a conditional pending->processing update", async (t) => {
  const candidates = [
    { ...baseJob({ id: "job-1", status: "pending" }) },
    { ...baseJob({ id: "job-2", status: "pending" }) }
  ];
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "notification_jobs" && method === "GET") return candidates;
    if (table === "notification_jobs" && method === "PATCH") {
      const id = url.searchParams.get("id");
      if (id === "eq.job-1") return [{ ...candidates[0], status: "processing" }];
      return []; // job-2: another drain won the race first.
    }
    return [];
  });

  const claimed = await claimDueJobs({ client: client(), now: NOON, limit: 10 });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, "job-1");
  assert.equal(claimed[0].status, "processing");

  const claimPatches = captured.filter((c) => c.table === "notification_jobs" && c.method === "PATCH");
  assert.equal(claimPatches.length, 2);
  for (const patch of claimPatches) {
    assert.equal(patch.url.searchParams.get("status"), "eq.pending");
    assert.equal(patch.body.status, "processing");
  }

  const getReq = captured.find((c) => c.table === "notification_jobs" && c.method === "GET");
  assert.equal(getReq.url.searchParams.get("status"), "eq.pending");
  const or = getReq.url.searchParams.get("or");
  assert.match(or, /scheduled_for\.lte\./);
  assert.match(or, /next_attempt_at\.lte\./);
});

test("drainOnce happy path: writes one delivery per recipient per channel and marks the job sent", async (t) => {
  const job = baseJob();
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_jobs" && method === "GET") return [job];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "processing" }];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    return [];
  });

  const summary = await drainOnce({ client: client(), now: NOON, limit: 10 });

  assert.deepEqual(summary, { claimed: 1, sent: 1, rescheduled: 0, failed: 0, deadLettered: 0 });

  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  assert.ok(insert, "expected a notification_deliveries insert");
  assert.equal(insert.body.length, 4); // 2 recipients x 2 channels
  const byChannel = (channel) => insert.body.filter((row) => row.channel === channel);
  for (const row of byChannel("in_app")) {
    assert.equal(row.status, "sent");
    assert.ok(row.sent_at);
    assert.equal(row.job_id, "job-1");
    assert.equal(row.facility_id, "fac-1");
  }
  for (const row of byChannel("email")) {
    assert.equal(row.status, "queued");
    assert.equal(row.sent_at, null);
  }
  assert.deepEqual(
    insert.body.map((row) => row.employee_id).sort(),
    ["emp-1", "emp-1", "emp-2", "emp-2"]
  );

  const sentPatch = findPatch(captured, "notification_jobs", (c) => c.body.status === "sent");
  assert.ok(sentPatch);
  assert.equal(sentPatch.url.searchParams.get("id"), "eq.job-1");
});

test("processJob expands recipients via the route's distribution list when the job has none pre-resolved", async (t) => {
  const job = baseJob({ payload_jsonb: {} }); // no pre-expanded recipients/channels
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_routes" && method === "GET") {
      return [
        {
          id: "route-1",
          facility_id: "fac-1",
          event_code: "incident.escalated",
          priority: 5,
          route_jsonb: { channels: ["in_app"], distributionListId: "list-1" },
          active: true
        }
      ];
    }
    if (table === "distribution_lists" && method === "GET") return [{ id: "list-1", facility_id: "fac-1" }];
    if (table === "distribution_list_members" && method === "GET") {
      return [{ distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-9" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-9" }];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  assert.deepEqual(result.recipients, ["emp-9"]);
  assert.deepEqual(result.channels, ["in_app"]);
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  assert.equal(insert.body.length, 1);
  assert.equal(insert.body[0].employee_id, "emp-9");
  assert.equal(insert.body[0].status, "sent");
});

test("processJob retries with exponential backoff on failure (no recipients resolved)", async (t) => {
  const job = baseJob({ payload_jsonb: {}, attempts: 0 });
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_routes" && method === "GET") return []; // no route -> no recipients
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job }];
    return [];
  });

  const first = await processJob({ client: client(), job, now: NOON });
  assert.equal(first.outcome, "failed");
  assert.equal(first.attempts, 1);
  assert.match(first.error, /no recipients resolved/);
  assert.equal(first.nextAttemptAt, new Date(NOON.getTime() + 2 * 60 * 1000).toISOString());

  const patch1 = captured.find((c) => c.table === "notification_jobs" && c.method === "PATCH");
  assert.equal(patch1.body.status, "pending");
  assert.equal(patch1.body.attempts, 1);
  assert.equal(patch1.body.last_error, first.error);
  assert.equal(patch1.body.next_attempt_at, first.nextAttemptAt);

  // A second failure (attempts now 1 going in) should double the backoff.
  const second = await processJob({ client: client(), job: { ...job, attempts: 1 }, now: NOON });
  assert.equal(second.outcome, "failed");
  assert.equal(second.attempts, 2);
  assert.equal(second.nextAttemptAt, new Date(NOON.getTime() + 4 * 60 * 1000).toISOString());
});

test("processJob dead-letters after the configured max attempts", async (t) => {
  const job = baseJob({ payload_jsonb: {}, attempts: 4 }); // 5th failure crosses the default max of 5
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_routes" && method === "GET") return [];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "dead_letter");
  assert.equal(result.attempts, 5);
  assert.equal(result.nextAttemptAt, null);

  const patch = captured.find((c) => c.table === "notification_jobs" && c.method === "PATCH");
  assert.equal(patch.body.status, "dead_letter");
  assert.equal(patch.body.attempts, 5);
  assert.equal(patch.body.next_attempt_at, null);
});

test("processJob respects a configurable max attempts lower than the default", async (t) => {
  const job = baseJob({ payload_jsonb: {}, attempts: 1 });
  stubFetch(t, (table, method) => {
    if (table === "notification_routes" && method === "GET") return [];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON, config: { maxAttempts: 2 } });
  assert.equal(result.outcome, "dead_letter");
  assert.equal(result.attempts, 2);
});

test("processJob reschedules quiet-hours jobs instead of delivering or dropping them", async (t) => {
  const job = baseJob();
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "pending" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: QUIET });

  assert.equal(result.outcome, "rescheduled");
  // Default quiet hours end at 06:00 UTC the next day relative to a 23:00 "now".
  assert.equal(result.nextAttemptAt.toISOString(), "2026-08-14T06:00:00.000Z");

  const patch = captured.find((c) => c.table === "notification_jobs" && c.method === "PATCH");
  assert.equal(patch.body.status, "pending");
  assert.equal(patch.body.next_attempt_at, "2026-08-14T06:00:00.000Z");
  assert.ok(!captured.some((c) => c.table === "notification_deliveries"));
});

test("concurrent claim race: a job whose claim update matches zero rows is skipped with no deliveries", async (t) => {
  const job = baseJob({ status: "pending" });
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_jobs" && method === "GET") return [job];
    if (table === "notification_jobs" && method === "PATCH") return []; // another drain already claimed it
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    return [];
  });

  const summary = await drainOnce({ client: client(), now: NOON, limit: 10 });

  assert.deepEqual(summary, { claimed: 0, sent: 0, rescheduled: 0, failed: 0, deadLettered: 0 });
  assert.ok(!captured.some((c) => c.table === "notification_deliveries"));
});

// --- OP-14: drainOutboxOnce -------------------------------------------------

test("drainOutboxOnce routes a known event through its active route into a notification_jobs row", async (t) => {
  const event = baseOutboxEvent();
  const captured = stubFetch(t, (table, method) => {
    if (table === "outbox_events" && method === "GET") return [event];
    if (table === "outbox_events" && method === "PATCH") return [{ ...event, status: "processing" }];
    if (table === "notification_events" && method === "GET") {
      return [{ code: "incident.escalated", severity: "critical", module_code: "incidents", default_channels_jsonb: ["in_app"] }];
    }
    if (table === "notification_routes" && method === "GET") return [ROUTE_1];
    if (table === "distribution_lists" && method === "GET") return [{ id: "list-1", facility_id: "fac-1" }];
    if (table === "distribution_list_members" && method === "GET") {
      return [{ distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-9" }];
    }
    if (table === "employees" && method === "GET") return [{ id: "emp-9" }];
    if (table === "notification_jobs" && method === "POST") return [{ id: "job-99" }];
    return [];
  });

  const summary = await drainOutboxOnce({ client: client(), now: NOON, limit: 10 });
  assert.deepEqual(summary, { claimed: 1, routed: 1, skipped: 0, retried: 0, failed: 0 });

  const insert = captured.find((c) => c.table === "notification_jobs" && c.method === "POST");
  assert.ok(insert, "expected a notification_jobs insert");
  assert.equal(insert.body.length, 1);
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].event_type, "incident.escalated");
  assert.equal(insert.body[0].status, "pending");
  assert.deepEqual(insert.body[0].payload_jsonb.recipients, ["emp-9"]);
  assert.deepEqual(insert.body[0].payload_jsonb.channels, ["in_app"]);
  assert.equal(insert.body[0].payload_jsonb.route_id, "route-1");
  assert.equal(insert.body[0].payload_jsonb.outbox_event_id, "outbox-1");
  assert.deepEqual(insert.body[0].payload_jsonb.context, { incident_id: "inc-1" });

  const claimPatch = captured.find(
    (c) => c.table === "outbox_events" && c.method === "PATCH" && c.body.status === "processing"
  );
  assert.equal(claimPatch.url.searchParams.get("status"), "eq.pending");

  const donePatch = lastPatch(captured, "outbox_events");
  assert.equal(donePatch.body.status, "processed");
  assert.ok(donePatch.body.processed_at);
  assert.equal(donePatch.body.last_error, null);
});

test("drainOutboxOnce marks an event with no catalog entry processed with a skip note, not failed", async (t) => {
  const event = baseOutboxEvent({ id: "outbox-2", event_type: "mystery.event" });
  const captured = stubFetch(t, (table, method) => {
    if (table === "outbox_events" && method === "GET") return [event];
    if (table === "outbox_events" && method === "PATCH") return [{ ...event, status: "processing" }];
    if (table === "notification_events" && method === "GET") return []; // unknown to the catalog
    return [];
  });

  const summary = await drainOutboxOnce({ client: client(), now: NOON, limit: 10 });
  assert.deepEqual(summary, { claimed: 1, routed: 0, skipped: 1, retried: 0, failed: 0 });

  assert.ok(!captured.some((c) => c.table === "notification_jobs"));
  const donePatch = lastPatch(captured, "outbox_events");
  assert.equal(donePatch.body.status, "processed");
  assert.ok(donePatch.body.processed_at);
  assert.match(donePatch.body.last_error, /^skipped:/);
  assert.match(donePatch.body.last_error, /mystery\.event/);
});

test("drainOutboxOnce marks a known event with no active route processed with a skip note", async (t) => {
  const event = baseOutboxEvent({ id: "outbox-3" });
  const captured = stubFetch(t, (table, method) => {
    if (table === "outbox_events" && method === "GET") return [event];
    if (table === "outbox_events" && method === "PATCH") return [{ ...event, status: "processing" }];
    if (table === "notification_events" && method === "GET") {
      return [{ code: "incident.escalated", severity: "critical", module_code: "incidents", default_channels_jsonb: [] }];
    }
    if (table === "notification_routes" && method === "GET") return []; // no active route for this facility
    return [];
  });

  const summary = await drainOutboxOnce({ client: client(), now: NOON, limit: 10 });
  assert.deepEqual(summary, { claimed: 1, routed: 0, skipped: 1, retried: 0, failed: 0 });

  assert.ok(!captured.some((c) => c.table === "notification_jobs"));
  const donePatch = lastPatch(captured, "outbox_events");
  assert.equal(donePatch.body.status, "processed");
  assert.match(donePatch.body.last_error, /^skipped:/);
  assert.match(donePatch.body.last_error, /no active notification_routes/);
});

test("drainOutboxOnce retries a transient failure with backoff instead of failing terminally", async (t) => {
  const event = baseOutboxEvent({ id: "outbox-4", attempts: 0 });
  const captured = stubFetch(t, (table, method) => {
    if (table === "outbox_events" && method === "GET") return [event];
    if (table === "outbox_events" && method === "PATCH") return [{ ...event, status: "processing" }];
    if (table === "notification_events" && method === "GET") throw new Error("simulated PostgREST outage");
    return [];
  });

  const summary = await drainOutboxOnce({ client: client(), now: NOON, limit: 10 });
  assert.deepEqual(summary, { claimed: 1, routed: 0, skipped: 0, retried: 1, failed: 0 });

  const patch = lastPatch(captured, "outbox_events");
  assert.equal(patch.body.status, "pending");
  assert.equal(patch.body.attempts, 1);
  assert.match(patch.body.last_error, /simulated PostgREST outage/);
  assert.equal(patch.body.next_attempt_at, new Date(NOON.getTime() + 2 * 60 * 1000).toISOString());
});

test("drainOutboxOnce terminally fails an outbox event once max attempts are exhausted (no dead_letter status on outbox_events)", async (t) => {
  const event = baseOutboxEvent({ id: "outbox-5", attempts: 4 }); // 5th failure crosses the default max of 5
  const captured = stubFetch(t, (table, method) => {
    if (table === "outbox_events" && method === "GET") return [event];
    if (table === "outbox_events" && method === "PATCH") return [{ ...event, status: "processing" }];
    if (table === "notification_events" && method === "GET") throw new Error("simulated PostgREST outage");
    return [];
  });

  const summary = await drainOutboxOnce({ client: client(), now: NOON, limit: 10 });
  assert.deepEqual(summary, { claimed: 1, routed: 0, skipped: 0, retried: 0, failed: 1 });

  const patch = lastPatch(captured, "outbox_events");
  assert.equal(patch.body.status, "failed");
  assert.equal(patch.body.attempts, 5);
  assert.equal(patch.body.next_attempt_at, null);
});

test("drainOutboxOnce claims via a conditional pending->processing update, same race semantics as jobs", async (t) => {
  const event = baseOutboxEvent({ id: "outbox-6" });
  const captured = stubFetch(t, (table, method) => {
    if (table === "outbox_events" && method === "GET") return [event];
    if (table === "outbox_events" && method === "PATCH") return []; // another drain already claimed it
    return [];
  });

  const summary = await drainOutboxOnce({ client: client(), now: NOON, limit: 10 });
  assert.deepEqual(summary, { claimed: 0, routed: 0, skipped: 0, retried: 0, failed: 0 });
  assert.ok(!captured.some((c) => c.table === "notification_events"));
});
