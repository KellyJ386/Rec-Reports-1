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

// Both employees resolve a deliverable email address via the employees +
// app_users(email) embed (P-4) -- shared by the "drainOnce happy path" test
// below and every email-channel test further down.
const EMPLOYEE_WITH_EMAIL_1 = { id: "emp-1", user_id: "user-1", app_users: { email: "emp1@example.com" } };
const EMPLOYEE_WITH_EMAIL_2 = { id: "emp-2", user_id: "user-2", app_users: { email: "emp2@example.com" } };

test("drainOnce happy path: writes one delivery per recipient per channel and marks the job sent", async (t) => {
  const job = baseJob();
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_jobs" && method === "GET") return [job];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "processing" }];
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1, EMPLOYEE_WITH_EMAIL_2];
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
  // The default (no-op) email adapter marks every resolved recipient sent,
  // same as push's default -- see the dedicated email-channel tests below
  // for opted_out/no_email/provider-id-persisted coverage.
  for (const row of byChannel("email")) {
    assert.equal(row.status, "sent");
    assert.ok(row.sent_at);
    assert.equal(row.provider_message_id, null);
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

// --- CM-07: push delivery channel -------------------------------------------

function basePushJob(overrides = {}) {
  return baseJob({
    event_type: "message.published",
    payload_jsonb: { recipients: ["emp-1"], channels: ["push"] },
    ...overrides
  });
}

const DEVICE_TOKEN_1 = { id: "tok-row-1", facility_id: "fac-1", employee_id: "emp-1", platform: "ios", token: "tok-1", revoked_at: null };

test("processJob delivers push via the default (no-op) adapter and marks the delivery sent", async (t) => {
  const job = basePushJob();
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  assert.equal(insert.body.length, 1);
  assert.equal(insert.body[0].employee_id, "emp-1");
  assert.equal(insert.body[0].channel, "push");
  assert.equal(insert.body[0].status, "sent");
  assert.ok(insert.body[0].sent_at);

  const tokenLookup = captured.find((c) => c.table === "employee_device_tokens" && c.method === "GET");
  assert.equal(tokenLookup.url.searchParams.get("revoked_at"), "is.null");
  assert.equal(tokenLookup.url.searchParams.get("employee_id"), "in.(emp-1)");
  assert.ok(!captured.some((c) => c.table === "employee_device_tokens" && c.method === "PATCH"), "no-op adapter never revokes");
});

test("a push job with no quietHoursBypass reschedules the whole job during quiet hours, without ever querying device tokens", async (t) => {
  const job = basePushJob();
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "pending" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: QUIET });

  assert.equal(result.outcome, "rescheduled");
  assert.ok(!captured.some((c) => c.table === "employee_device_tokens"));
  assert.ok(!captured.some((c) => c.table === "notification_deliveries"));
});

test("quietHoursBypass (set by CM-03 for urgent/emergency) lets a push job proceed instead of rescheduling during quiet hours", async (t) => {
  const job = basePushJob({ payload_jsonb: { recipients: ["emp-1"], channels: ["push"], quietHoursBypass: true } });
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: QUIET });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  assert.equal(insert.body[0].status, "sent");
});

test("a recipient with no active device token is marked failed for push, without failing the job", async (t) => {
  const job = basePushJob({ payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["push"] } });
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1]; // only emp-1 has a token
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "sent");
  assert.equal(byEmployee["emp-2"].status, "failed");
  assert.equal(byEmployee["emp-2"].sent_at, null);
});

test("a permanently rejected token is revoked and its recipient's push delivery marked bounced", async (t) => {
  const job = basePushJob();
  const fakeAdapter = { send: async ({ tokens }) => tokens.map((token) => ({ token, code: "unregistered" })) };
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "employee_device_tokens" && method === "PATCH") return [{ ...DEVICE_TOKEN_1, revoked_at: "2026-08-13T15:00:00.000Z" }];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON, config: { pushAdapter: fakeAdapter } });

  assert.equal(result.outcome, "sent");
  const revokePatch = captured.find((c) => c.table === "employee_device_tokens" && c.method === "PATCH");
  assert.ok(revokePatch, "expected the permanently-rejected token to be revoked");
  assert.equal(revokePatch.url.searchParams.get("token"), "in.(tok-1)");
  assert.ok(revokePatch.body.revoked_at);

  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  assert.equal(insert.body[0].status, "bounced");
  assert.equal(insert.body[0].sent_at, null);
});

test("a recipient's push_enabled=false preference suppresses only their push delivery", async (t) => {
  const job = basePushJob({ payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["push"] } });
  const tokenForEmp2 = { ...DEVICE_TOKEN_1, id: "tok-row-2", employee_id: "emp-2", token: "tok-2" };
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1, tokenForEmp2];
    if (table === "employee_notification_preferences" && method === "GET") {
      return [{ facility_id: "fac-1", employee_id: "emp-1", push_enabled: false }];
    }
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "failed"); // opted out, never contacted
  assert.equal(byEmployee["emp-2"].status, "sent");
});

test("a recipient's personal quiet-hours override suppresses their push even outside the facility's default quiet window", async (t) => {
  const job = basePushJob({ payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["push"] } });
  const tokenForEmp2 = { ...DEVICE_TOKEN_1, id: "tok-row-2", employee_id: "emp-2", token: "tok-2" };
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1, tokenForEmp2];
    if (table === "employee_notification_preferences" && method === "GET") {
      // emp-1's own quiet window (10:00-20:00) covers NOON (15:00 UTC) even
      // though NOON is well outside the facility's default 22:00-06:00 window.
      return [{ facility_id: "fac-1", employee_id: "emp-1", quiet_hours_start: "10:00", quiet_hours_end: "20:00" }];
    }
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "failed"); // personally in quiet hours
  assert.equal(byEmployee["emp-2"].status, "sent");
});

test("a job whose resolved channels do not include push never queries device tokens (email's own preferences/employees queries still run)", async (t) => {
  const job = baseJob(); // channels: ["in_app", "email"]
  const captured = stubFetch(t, (table, method) => {
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    return [];
  });

  await processJob({ client: client(), job, now: NOON });

  // employee_device_tokens is push-only -- never queried when 'push' is not
  // among the job's resolved channels. employee_notification_preferences IS
  // shared with the email path (email_enabled lives on the same row as
  // push_enabled), so it's expected here precisely because this job's
  // channels include 'email'.
  assert.ok(!captured.some((c) => c.table === "employee_device_tokens"));
  assert.ok(captured.some((c) => c.table === "employee_notification_preferences"));
});

// --- P-4: email channel ------------------------------------------------

function baseEmailJob(overrides = {}) {
  return baseJob({
    event_type: "message.published",
    payload_jsonb: { recipients: ["emp-1"], channels: ["email"], title: "Subject line", body: "Body text" },
    ...overrides
  });
}

test("processJob delivers email via the default (no-op) adapter, marks the delivery sent, and queries employees exactly once", async (t) => {
  const job = baseEmailJob();
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  assert.equal(insert.body.length, 1);
  assert.equal(insert.body[0].employee_id, "emp-1");
  assert.equal(insert.body[0].channel, "email");
  assert.equal(insert.body[0].status, "sent");
  assert.ok(insert.body[0].sent_at);
  assert.equal(insert.body[0].provider_message_id, null);

  const employeesLookups = captured.filter((c) => c.table === "employees" && c.method === "GET");
  assert.equal(employeesLookups.length, 1, "expected exactly one employees select per job, not one per recipient");
  assert.equal(employeesLookups[0].url.searchParams.get("select"), "id,user_id,app_users(email)");
  assert.equal(employeesLookups[0].url.searchParams.get("id"), "in.(emp-1)");
});

test("email subject/text are derived from the job payload's title/body, exactly like push derives title/body", async (t) => {
  const job = baseEmailJob({
    payload_jsonb: { recipients: ["emp-1"], channels: ["email"], title: "Subject line", body: "Body text" }
  });
  let seen = null;
  const fakeAdapter = {
    send: async (message) => {
      seen = message;
      return { code: "ok" };
    }
  };
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  await processJob({ client: client(), job, now: NOON, config: { emailAdapter: fakeAdapter } });

  assert.equal(seen.to, "emp1@example.com");
  assert.equal(seen.subject, "Subject line");
  assert.equal(seen.text, "Body text");
  assert.ok(captured.some((c) => c.table === "notification_deliveries" && c.method === "POST"));
});

test("email subject falls back to the job's event_type, and text to '', when the payload carries neither (mirrors push)", async (t) => {
  const job = baseEmailJob({ payload_jsonb: { recipients: ["emp-1"], channels: ["email"] } });
  let seen = null;
  const fakeAdapter = {
    send: async (message) => {
      seen = message;
      return { code: "ok" };
    }
  };
  stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  await processJob({ client: client(), job, now: NOON, config: { emailAdapter: fakeAdapter } });

  assert.equal(seen.subject, job.event_type);
  assert.equal(seen.text, "");
});

test("an email recipient's email_enabled=false preference is recorded failed without ever contacting the adapter", async (t) => {
  const job = baseEmailJob({ payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["email"] } });
  let adapterCalled = false;
  const fakeAdapter = { send: async () => { adapterCalled = true; return { code: "ok" }; } };
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1, EMPLOYEE_WITH_EMAIL_2];
    if (table === "employee_notification_preferences" && method === "GET") {
      return [{ facility_id: "fac-1", employee_id: "emp-1", email_enabled: false }];
    }
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON, config: { emailAdapter: fakeAdapter } });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "failed"); // opted out, never contacted
  assert.equal(byEmployee["emp-1"].sent_at, null);
  assert.equal(byEmployee["emp-2"].status, "sent");
  assert.equal(adapterCalled, true, "expected emp-2's send to still reach the adapter");
});

test("a recipient with no linked app_users email is marked failed (no_email), never failing the whole job", async (t) => {
  const job = baseEmailJob({ payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["email"] } });
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") {
      // emp-1 has a user_id but no linked app_users row (embed comes back
      // null); emp-2 has an app_users row whose email is empty. Both are
      // "nobody to email".
      return [
        { id: "emp-1", user_id: "user-1", app_users: null },
        { id: "emp-2", user_id: "user-2", app_users: { email: "" } }
      ];
    }
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent", "a ruled-out email recipient must never dead-letter/fail the whole job");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "failed");
  assert.equal(byEmployee["emp-1"].sent_at, null);
  assert.equal(byEmployee["emp-2"].status, "failed");
});

test("a recipient whose employees row is missing entirely from the select (deleted employee) is marked failed, never throwing the job into handleFailure", async (t) => {
  const job = baseEmailJob({ payload_jsonb: { recipients: ["emp-1", "emp-ghost"], channels: ["email"] } });
  const captured = stubFetch(t, (table, method) => {
    // Only emp-1 comes back -- emp-ghost has no employees row at all (e.g.
    // deleted between enqueue and drain).
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "sent");
  assert.equal(byEmployee["emp-ghost"].status, "failed");
  assert.ok(!captured.some((c) => c.table === "notification_jobs" && c.method === "PATCH" && c.body.status === "dead_letter"));
});

test("a permanently rejected email address is recorded bounced, and the provider's message id is persisted on a sent delivery", async (t) => {
  const job = baseEmailJob({ payload_jsonb: { recipients: ["emp-1", "emp-2"], channels: ["email"] } });
  const fakeAdapter = {
    send: async ({ to }) =>
      to === "emp1@example.com" ? { code: "ok", providerMessageId: "resend-msg-42" } : { code: "invalid_recipient" }
  };
  const captured = stubFetch(t, (table, method) => {
    if (table === "employees" && method === "GET") return [EMPLOYEE_WITH_EMAIL_1, EMPLOYEE_WITH_EMAIL_2];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }, { id: "delivery-2" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  const result = await processJob({ client: client(), job, now: NOON, config: { emailAdapter: fakeAdapter } });

  assert.equal(result.outcome, "sent");
  const insert = captured.find((c) => c.table === "notification_deliveries" && c.method === "POST");
  const byEmployee = Object.fromEntries(insert.body.map((row) => [row.employee_id, row]));
  assert.equal(byEmployee["emp-1"].status, "sent");
  assert.equal(byEmployee["emp-1"].provider_message_id, "resend-msg-42");
  assert.equal(byEmployee["emp-2"].status, "bounced");
  assert.equal(byEmployee["emp-2"].sent_at, null);
  assert.equal(byEmployee["emp-2"].provider_message_id, null);
});

test("a job whose resolved channels do not include email never queries employees for email resolution", async (t) => {
  const job = basePushJob(); // channels: ["push"]
  const captured = stubFetch(t, (table, method) => {
    if (table === "employee_device_tokens" && method === "GET") return [DEVICE_TOKEN_1];
    if (table === "employee_notification_preferences" && method === "GET") return [];
    if (table === "notification_deliveries" && method === "POST") return [{ id: "delivery-1" }];
    if (table === "notification_jobs" && method === "PATCH") return [{ ...job, status: "sent" }];
    return [];
  });

  await processJob({ client: client(), job, now: NOON });

  assert.ok(!captured.some((c) => c.table === "employees"));
});
