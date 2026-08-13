import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { claimDueJobs, processJob, drainOnce } from "../src/lib/notifications/worker.mjs";

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
