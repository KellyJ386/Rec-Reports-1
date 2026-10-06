import test from "node:test";
import assert from "node:assert/strict";
import { sweepAckEscalations, ackEscalationDedupeKey } from "../src/lib/comms-escalation-sweep.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

// CM-10: the escalation sweep against an in-memory PostgREST stand-in. The
// stand-in implements just enough of the real semantics to prove the claims
// the sweep makes: conditional (CAS) PATCHes, ignore-duplicates inserts on
// notification_jobs.dedupe_key and (message_id, level) uniqueness on
// message_escalation_events.

const DUE = "2026-08-10T12:00:00Z";
const H = 3_600_000;
const at = (hoursAfterDue) => new Date(new Date(DUE).getTime() + hoursAfterDue * H);

function baseMessage(overrides = {}) {
  return {
    id: "m-1",
    facility_id: "fac-1",
    channel_id: "ch-1",
    subject: "Pool chemical SOP",
    priority: "normal",
    is_required_ack: true,
    ack_due_at: DUE,
    published_at: "2026-08-08T12:00:00Z",
    ack_escalation_level: 0,
    ack_escalated_at: null,
    ...overrides
  };
}

function makeWorld(overrides = {}) {
  const world = {
    messages: [baseMessage()],
    audiences: [
      { id: "a1", message_id: "m-1", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-1" },
      { id: "a2", message_id: "m-1", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-2" },
      { id: "a3", message_id: "m-1", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-3" }
    ],
    acks: [{ message_id: "m-1", employee_id: "e-2", ack_state: "acknowledged", acknowledged_at: "2026-08-10T09:00:00Z" }],
    employees: [{ id: "e-1" }, { id: "e-2" }, { id: "e-3" }, { id: "boss-1" }, { id: "boss-2" }],
    routes: [
      { id: "r-sup", facility_id: "fac-1", event_code: "message.ack_escalated_supervisor", priority: 0, active: true, route_jsonb: { channels: ["in_app", "email"], distributionListId: "dl-sup" } },
      { id: "r-mgr", facility_id: "fac-1", event_code: "message.ack_escalated_manager", priority: 0, active: true, route_jsonb: { channels: ["in_app", "email", "sms"], distributionListId: "dl-mgr" } }
    ],
    lists: [{ id: "dl-sup", facility_id: "fac-1", active: true }, { id: "dl-mgr", facility_id: "fac-1", active: true }],
    members: [
      { id: "dm-1", facility_id: "fac-1", distribution_list_id: "dl-sup", member_type: "employee", member_ref_id: "boss-1" },
      { id: "dm-2", facility_id: "fac-1", distribution_list_id: "dl-mgr", member_type: "employee", member_ref_id: "boss-2" }
    ],
    jobs: [],
    events: [],
    calls: [],
    failures: { jobInsert: 0, eventInsert: 0, claim: 0, revert: 0 },
    ...overrides
  };
  return world;
}

function rowMatches(row, params, skip = new Set()) {
  for (const [key, expr] of params.entries()) {
    if (skip.has(key)) continue;
    const value = row[key];
    if (expr.startsWith("eq.")) {
      if (String(value ?? "") !== expr.slice(3)) return false;
    } else if (expr.startsWith("lt.")) {
      const bound = expr.slice(3);
      if (value === null || value === undefined) return false;
      const below = typeof value === "number" ? value < Number(bound) : new Date(value).getTime() < new Date(bound).getTime();
      if (!below) return false;
    } else if (expr === "not.is.null") {
      if (value === null || value === undefined) return false;
    } else if (expr === "is.null") {
      if (value !== null && value !== undefined) return false;
    }
  }
  return true;
}

function install(t, world) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    const prefer = init.headers?.Prefer ?? "";
    world.calls.push({ table, method, url: parsed, body });
    const respond = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    const fail = (status = 500) => respond({ message: "boom" }, status);
    const skip = new Set(["select", "order", "limit", "offset"]);

    if (table === "messages" && method === "GET") {
      const rows = world.messages.filter((row) => {
        // numeric lt on ack_escalation_level and timestamp lt on ack_due_at are both handled by rowMatches
        return rowMatches(row, parsed.searchParams, skip);
      });
      return respond(rows);
    }
    if (table === "messages" && method === "PATCH") {
      const isRevert = body.ack_escalation_level < Number(parsed.searchParams.get("ack_escalation_level")?.slice(3));
      if (isRevert && world.failures.revert > 0) {
        world.failures.revert -= 1;
        return fail();
      }
      if (!isRevert && world.failures.claim > 0) {
        world.failures.claim -= 1;
        return fail();
      }
      const matched = world.messages.filter((row) => rowMatches(row, parsed.searchParams, skip));
      for (const row of matched) Object.assign(row, body);
      return respond(matched.map((row) => ({ ...row })));
    }
    if (table === "message_audiences") return respond(world.audiences.filter((row) => row.message_id === parsed.searchParams.get("message_id")?.slice(3)));
    if (table === "message_acknowledgements") return respond(world.acks.filter((row) => row.message_id === parsed.searchParams.get("message_id")?.slice(3)));
    if (table === "notification_routes") {
      return respond(world.routes.filter((row) => row.facility_id === parsed.searchParams.get("facility_id").slice(3) && row.event_code === parsed.searchParams.get("event_code").slice(3)));
    }
    if (table === "distribution_lists") return respond(world.lists.filter((row) => row.id === parsed.searchParams.get("id").slice(3)));
    if (table === "distribution_list_members") {
      return respond(world.members.filter((row) => row.distribution_list_id === parsed.searchParams.get("distribution_list_id").slice(3)));
    }
    if (table === "employees") return respond(world.employees);
    if (table === "notification_jobs" && method === "POST") {
      if (world.failures.jobInsert > 0) {
        world.failures.jobInsert -= 1;
        return fail();
      }
      const inserted = [];
      for (const row of body) {
        const duplicate = row.dedupe_key && world.jobs.some((job) => job.dedupe_key === row.dedupe_key);
        if (duplicate) {
          assert.match(prefer, /ignore-duplicates/, "a duplicate job insert must be an ignore-duplicates upsert");
          continue;
        }
        world.jobs.push({ id: `job-${world.jobs.length + 1}`, ...row });
        inserted.push(world.jobs[world.jobs.length - 1]);
      }
      return respond(inserted, 201);
    }
    if (table === "message_escalation_events" && method === "POST") {
      if (world.failures.eventInsert > 0) {
        world.failures.eventInsert -= 1;
        return fail();
      }
      const inserted = [];
      for (const row of body) {
        if (world.events.some((event) => event.message_id === row.message_id && event.level === row.level)) continue;
        world.events.push(row);
        inserted.push(row);
      }
      return respond(inserted, 201);
    }
    // modules / facilities / org settings: no config rows -> registry defaults.
    return respond([]);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const client = () => createClient({ url: "https://example.supabase.co", key: "service-key" });

test("level 1: reminds only the audience members who have not acknowledged, via a deduped job", async (t) => {
  const world = makeWorld();
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1) });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.escalated, 1);
  assert.deepEqual(summary.byLevel, { 1: 1, 2: 0, 3: 0 });
  assert.equal(summary.jobsEnqueued, 1);
  assert.deepEqual(summary.errors, []);

  assert.equal(world.jobs.length, 1);
  const job = world.jobs[0];
  assert.equal(job.event_type, "message.ack_overdue");
  assert.equal(job.facility_id, "fac-1");
  assert.equal(job.status, "pending");
  assert.deepEqual(job.payload_jsonb.recipients, ["e-1", "e-3"]); // e-2 already acknowledged
  assert.equal(job.payload_jsonb.messageId, "m-1");
  assert.equal(job.payload_jsonb.escalationLevel, 1);
  assert.equal(job.payload_jsonb.tier, "reminder");
  assert.deepEqual(job.payload_jsonb.channels, ["in_app"]); // no route: priority default
  assert.equal(job.dedupe_key, ackEscalationDedupeKey("fac-1", "message.ack_overdue", "m-1", 1));

  assert.equal(world.messages[0].ack_escalation_level, 1);
  assert.equal(world.messages[0].ack_escalated_at, at(1).toISOString());
  assert.equal(world.events.length, 1);
  assert.deepEqual(
    [world.events[0].message_id, world.events[0].level, world.events[0].tier, world.events[0].recipient_count],
    ["m-1", 1, "reminder", 2]
  );
});

test("the claim is a compare-and-set on the level the sweep read, before any side effect", async (t) => {
  const world = makeWorld();
  install(t, world);
  await sweepAckEscalations(client(), { now: at(1) });
  const firstPatch = world.calls.findIndex((c) => c.table === "messages" && c.method === "PATCH");
  const firstJob = world.calls.findIndex((c) => c.table === "notification_jobs");
  assert.ok(firstPatch >= 0 && firstPatch < firstJob, "the claim must precede the job insert");
  const claim = world.calls[firstPatch];
  assert.equal(claim.url.searchParams.get("id"), "eq.m-1");
  assert.equal(claim.url.searchParams.get("ack_escalation_level"), "eq.0");
  assert.equal(claim.body.ack_escalation_level, 1);
});

test("ladder levels advance one tier per pass: reminder -> supervisor -> manager -> done", async (t) => {
  const world = makeWorld();
  install(t, world);

  await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(world.messages[0].ack_escalation_level, 1);

  // Not yet due for level 2: nothing happens.
  const idle = await sweepAckEscalations(client(), { now: at(10) });
  assert.equal(idle.escalated, 0);
  assert.equal(world.events.length, 1);

  const supervisor = await sweepAckEscalations(client(), { now: at(25) });
  assert.deepEqual(supervisor.byLevel, { 1: 0, 2: 1, 3: 0 });
  const supJob = world.jobs.find((job) => job.event_type === "message.ack_escalated_supervisor");
  assert.deepEqual(supJob.payload_jsonb.recipients, ["boss-1"]);
  assert.deepEqual(supJob.payload_jsonb.channels, ["in_app", "email"]);
  assert.equal(supJob.payload_jsonb.outstandingCount, 2);

  const manager = await sweepAckEscalations(client(), { now: at(49) });
  assert.deepEqual(manager.byLevel, { 1: 0, 2: 0, 3: 1 });
  const mgrJob = world.jobs.find((job) => job.event_type === "message.ack_escalated_manager");
  assert.deepEqual(mgrJob.payload_jsonb.recipients, ["boss-2"]);
  assert.equal(world.messages[0].ack_escalation_level, 3);

  // Level 3 messages leave the scan entirely.
  const done = await sweepAckEscalations(client(), { now: at(500) });
  assert.equal(done.scanned, 0);
  assert.deepEqual(world.events.map((event) => event.level), [1, 2, 3]);
});

test("a long outage never skips a level: each pass processes only the next tier", async (t) => {
  const world = makeWorld();
  install(t, world);
  await sweepAckEscalations(client(), { now: at(200) });
  assert.deepEqual(world.events.map((event) => event.level), [1]);
  await sweepAckEscalations(client(), { now: at(200) });
  assert.deepEqual(world.events.map((event) => event.level), [1, 2]);
  await sweepAckEscalations(client(), { now: at(200) });
  assert.deepEqual(world.events.map((event) => event.level), [1, 2, 3]);
});

test("idempotent: re-running a pass at the same instant sends and records nothing more", async (t) => {
  const world = makeWorld();
  install(t, world);
  await sweepAckEscalations(client(), { now: at(1) });
  const again = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(again.escalated, 0);
  assert.equal(again.jobsEnqueued, 0);
  assert.equal(world.jobs.length, 1);
  assert.equal(world.events.length, 1);
});

test("losing the claim race to a concurrent sweep skips the message without side effects", async (t) => {
  const world = makeWorld();
  install(t, world);
  // The concurrent sweep already moved the level by the time ours PATCHes.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init.method === "PATCH") world.messages[0].ack_escalation_level = 1;
    return realFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const summary = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(summary.raced, 1);
  assert.equal(summary.escalated, 0);
  assert.equal(world.jobs.length, 0);
  assert.equal(world.events.length, 0);
});

test("a failed job insert reverts the claim (CAS on the exact stamp) and the next pass retries the tier", async (t) => {
  const world = makeWorld();
  world.failures.jobInsert = 1;
  install(t, world);

  const failed = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(failed.escalated, 0);
  assert.equal(failed.claimed, 0);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0].stage, "notify");
  assert.equal(failed.errors[0].messageId, "m-1");
  assert.equal(world.messages[0].ack_escalation_level, 0, "claim reverted");
  assert.equal(world.messages[0].ack_escalated_at, null);
  assert.equal(world.events.length, 0);

  const revert = world.calls.filter((c) => c.table === "messages" && c.method === "PATCH").at(-1);
  assert.equal(revert.url.searchParams.get("id"), "eq.m-1");
  assert.equal(revert.url.searchParams.get("ack_escalation_level"), "eq.1", "revert is conditional on the level this call stamped");
  assert.equal(revert.url.searchParams.get("ack_escalated_at"), `eq.${at(1).toISOString()}`, "revert is conditional on the exact stamp");
  assert.equal(revert.body.ack_escalation_level, 0);

  const retried = await sweepAckEscalations(client(), { now: at(2) });
  assert.equal(retried.escalated, 1);
  assert.deepEqual(retried.errors, []);
  assert.equal(world.messages[0].ack_escalation_level, 1);
  assert.equal(world.jobs.length, 1);
});

test("a failure AFTER the job landed (event insert fails) reverts, and the retry does not double-send", async (t) => {
  const world = makeWorld();
  world.failures.eventInsert = 1;
  install(t, world);

  const failed = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(failed.errors[0].stage, "notify");
  assert.equal(world.jobs.length, 1, "the job did land");
  assert.equal(world.messages[0].ack_escalation_level, 0);

  const retried = await sweepAckEscalations(client(), { now: at(2) });
  assert.equal(retried.escalated, 1);
  assert.equal(retried.deduped, 1, "the retry's job insert was an ignored duplicate");
  assert.equal(world.jobs.length, 1, "no second job");
  assert.equal(world.events.length, 1);
  assert.equal(world.messages[0].ack_escalation_level, 1);
});

test("one failing candidate never aborts the others, and a failed revert is itself recorded", async (t) => {
  const world = makeWorld({
    messages: [baseMessage(), baseMessage({ id: "m-2", subject: "Second", ack_due_at: "2026-08-10T13:00:00Z" })]
  });
  world.audiences.push({ id: "a9", message_id: "m-2", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-3" });
  world.failures.jobInsert = 1; // m-1 (oldest due) fails...
  world.failures.revert = 1; // ...and its revert fails too
  install(t, world);

  const summary = await sweepAckEscalations(client(), { now: at(2) });
  assert.deepEqual(summary.errors.map((error) => [error.messageId, error.stage]), [
    ["m-1", "notify"],
    ["m-1", "revert"]
  ]);
  assert.equal(summary.escalated, 1, "m-2 still escalated");
  assert.equal(world.messages.find((m) => m.id === "m-2").ack_escalation_level, 1);
  assert.equal(world.jobs.length, 1);
  assert.equal(world.jobs[0].payload_jsonb.messageId, "m-2");
});

test("a failed claim aborts only that candidate", async (t) => {
  const world = makeWorld({
    messages: [baseMessage(), baseMessage({ id: "m-2", ack_due_at: "2026-08-10T13:00:00Z" })]
  });
  world.audiences.push({ id: "a9", message_id: "m-2", facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-3" });
  world.failures.claim = 1;
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(2) });
  assert.deepEqual(summary.errors.map((error) => [error.messageId, error.stage]), [["m-1", "claim"]]);
  assert.equal(summary.escalated, 1);
  assert.equal(world.messages[0].ack_escalation_level, 0);
});

test("quiet-hours bypass is stamped only for urgent/emergency messages", async (t) => {
  const world = makeWorld({
    messages: [
      baseMessage({ id: "m-normal", priority: "normal" }),
      baseMessage({ id: "m-low", priority: "low" }),
      baseMessage({ id: "m-emergency", priority: "emergency" })
    ],
    audiences: ["m-normal", "m-low", "m-emergency"].map((id, index) => ({
      id: `a${index}`, message_id: id, facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-1"
    })),
    acks: []
  });
  install(t, world);
  await sweepAckEscalations(client(), { now: at(1) });
  const bypassByMessage = Object.fromEntries(world.jobs.map((job) => [job.payload_jsonb.messageId, job.payload_jsonb.quietHoursBypass]));
  assert.deepEqual(bypassByMessage, { "m-normal": false, "m-low": false, "m-emergency": true });
  const emergencyJob = world.jobs.find((job) => job.payload_jsonb.messageId === "m-emergency");
  assert.deepEqual(emergencyJob.payload_jsonb.channels, ["in_app", "push", "sms"]);
});

test("a facility that disabled escalation is skipped with no claim and no job", async (t) => {
  const world = makeWorld();
  install(t, world);
  const summary = await sweepAckEscalations(client(), {
    now: at(1),
    loadConfig: async () => ({ "communications.ackEscalationEnabled": false })
  });
  assert.equal(summary.disabled, 1);
  assert.equal(summary.escalated, 0);
  assert.ok(!world.calls.some((c) => c.method === "PATCH"));
  assert.equal(world.jobs.length, 0);
});

test("per-facility ladder offsets are honored (a later reminder offset delays level 1)", async (t) => {
  const world = makeWorld();
  install(t, world);
  const loadConfig = async () => ({
    "communications.ackReminderAfterHours": 5,
    "communications.ackSupervisorAfterHours": 10,
    "communications.ackManagerAfterHours": 20
  });
  assert.equal((await sweepAckEscalations(client(), { now: at(4), loadConfig })).escalated, 0);
  assert.equal((await sweepAckEscalations(client(), { now: at(5), loadConfig })).escalated, 1);
});

test("when everyone has acknowledged, the tier is still recorded but no job is sent", async (t) => {
  const world = makeWorld();
  world.acks = ["e-1", "e-2", "e-3"].map((id) => ({ message_id: "m-1", employee_id: id, ack_state: "acknowledged", acknowledged_at: DUE }));
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(summary.noOutstanding, 1);
  assert.equal(summary.jobsEnqueued, 0);
  assert.equal(world.jobs.length, 0);
  assert.equal(world.events.length, 1);
  assert.equal(world.events[0].recipient_count, 0);
  assert.equal(world.messages[0].ack_escalation_level, 1, "the message still moves through the ladder and leaves the scan");
});

test("a tier with no configured route is recorded as having no recipients, never retried forever", async (t) => {
  const world = makeWorld();
  world.messages[0].ack_escalation_level = 1;
  world.routes = [];
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(25) });
  assert.equal(summary.noRecipients, 1);
  assert.equal(world.jobs.length, 0);
  assert.equal(world.events.length, 1);
  assert.equal(world.events[0].level, 2);
  assert.equal(world.messages[0].ack_escalation_level, 2);
});

test("shift-window audiences are resolved at the message's own published_at", async (t) => {
  const world = makeWorld({
    audiences: [
      { id: "a1", message_id: "m-1", facility_id: "fac-1", audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "current" } }
    ],
    acks: []
  });
  const shifts = [
    { id: "s-then", starts_at: "2026-08-08T10:00:00Z", ends_at: "2026-08-08T18:00:00Z", status: "published", department_id: null },
    { id: "s-now", starts_at: "2026-08-10T10:00:00Z", ends_at: "2026-08-10T18:00:00Z", status: "published", department_id: null }
  ];
  install(t, world);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    if (table === "schedule_shifts") return { ok: true, status: 200, text: async () => JSON.stringify(shifts) };
    if (table === "shift_assignments") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ shift_id: "s-then", employee_id: "e-then" }, { shift_id: "s-now", employee_id: "e-now" }])
      };
    }
    return inner(url, init);
  };
  t.after(() => {
    globalThis.fetch = inner;
  });
  await sweepAckEscalations(client(), { now: at(1) });
  // published_at is 2026-08-08T12:00Z, inside s-then, not s-now.
  assert.deepEqual(world.jobs[0].payload_jsonb.recipients, ["e-then"]);
});
