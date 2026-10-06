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
  const message = {
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
  // The queue column 0064 maintains: first look at the later of the due time and the publish time.
  if (!("ack_next_escalation_at" in overrides)) {
    message.ack_next_escalation_at = new Date(
      Math.max(new Date(message.ack_due_at).getTime(), new Date(message.published_at).getTime())
    ).toISOString();
  }
  return message;
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
    } else if (expr.startsWith("in.(")) {
      const list = expr.slice(4, -1).split(",");
      if (!list.includes(String(value ?? ""))) return false;
    } else if (expr.startsWith("lte.")) {
      const bound = expr.slice(4);
      if (value === null || value === undefined) return false;
      const atOrBelow = typeof value === "number" ? value <= Number(bound) : new Date(value).getTime() <= new Date(bound).getTime();
      if (!atOrBelow) return false;
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
      // The ready set: filters evaluated by rowMatches (lte on ack_next_escalation_at, lt on the level),
      // ordered by the queue column, then limited -- like PostgREST.
      const rows = world.messages
        .filter((row) => rowMatches(row, parsed.searchParams, skip))
        .sort((a, b) => String(a.ack_next_escalation_at).localeCompare(String(b.ack_next_escalation_at)));
      const limit = parsed.searchParams.get("limit");
      return respond(limit ? rows.slice(0, Number(limit)) : rows);
    }
    if (table === "messages" && method === "PATCH") {
      const isDeferral = Object.keys(body).length === 1 && "ack_next_escalation_at" in body;
      const isRevert = !isDeferral && body.ack_escalation_level < Number(parsed.searchParams.get("ack_escalation_level")?.slice(3));
      if (isRevert && world.failures.revert > 0) {
        world.failures.revert -= 1;
        return fail();
      }
      if (!isRevert && !isDeferral && world.failures.claim > 0) {
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
    if (table === "notification_jobs" && method === "GET") {
      return respond(world.jobs.filter((job) => job.dedupe_key === parsed.searchParams.get("dedupe_key")?.slice(3)));
    }
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
  // M-5: the same write queues the message for the instant its NEXT tier comes due (supervisor: due + 24 h).
  assert.equal(claim.body.ack_next_escalation_at, at(24).toISOString());
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
  // The reverted message is retried a few minutes later, not on every pass (so a persistent failure cannot occupy the slots).
  assert.equal(revert.body.ack_next_escalation_at, new Date(at(1).getTime() + 5 * 60_000).toISOString());
  const tooSoon = await sweepAckEscalations(client(), { now: new Date(at(1).getTime() + 60_000) });
  assert.equal(tooSoon.scanned, 0, "not retried before the retry delay");

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

test("L-1: quiet-hours bypass is stamped for EMERGENCY messages only; an urgent message's escalation waits out quiet hours", async (t) => {
  const world = makeWorld({
    messages: [
      baseMessage({ id: "m-normal", priority: "normal" }),
      baseMessage({ id: "m-low", priority: "low" }),
      baseMessage({ id: "m-urgent", priority: "urgent" }),
      baseMessage({ id: "m-emergency", priority: "emergency" })
    ],
    audiences: ["m-normal", "m-low", "m-urgent", "m-emergency"].map((id, index) => ({
      id: `a${index}`, message_id: id, facility_id: "fac-1", audience_type: "employee", audience_ref_id: "e-1"
    })),
    acks: []
  });
  install(t, world);
  await sweepAckEscalations(client(), { now: at(1) });
  const bypassByMessage = Object.fromEntries(world.jobs.map((job) => [job.payload_jsonb.messageId, job.payload_jsonb.quietHoursBypass]));
  assert.deepEqual(bypassByMessage, { "m-normal": false, "m-low": false, "m-urgent": false, "m-emergency": true });
  const emergencyJob = world.jobs.find((job) => job.payload_jsonb.messageId === "m-emergency");
  assert.deepEqual(emergencyJob.payload_jsonb.channels, ["in_app", "push", "sms"]);
  // The ledger records the same decision.
  const urgentEvent = world.events.find((event) => event.message_id === "m-urgent");
  assert.equal(urgentEvent.details_jsonb.quietHoursBypass, false);

  // The supervisor and manager tiers follow the same rule.
  await sweepAckEscalations(client(), { now: at(25) });
  await sweepAckEscalations(client(), { now: at(49) });
  const tierJobs = world.jobs.filter((job) => job.payload_jsonb.escalationLevel > 1);
  assert.ok(tierJobs.length > 0 || world.routes.length > 0);
  for (const job of tierJobs) {
    assert.equal(job.payload_jsonb.quietHoursBypass, job.payload_jsonb.messageId === "m-emergency", job.event_type);
  }
});

test("L-1: the ladder never starts before the message was published, whatever its due time says", async (t) => {
  // Due ten days BEFORE it was published: without the anchor the reminder, supervisor and manager
  // tiers would all be overdue the moment it goes out and fire on three consecutive passes.
  const publishedAt = "2026-08-10T12:00:00Z";
  const world = makeWorld({
    messages: [baseMessage({ ack_due_at: "2026-07-31T12:00:00Z", published_at: publishedAt })]
  });
  install(t, world);
  assert.equal(world.messages[0].ack_next_escalation_at, new Date(publishedAt).toISOString(), "queued at the publish time, not the stale due time");
  const published = new Date(publishedAt);
  const first = await sweepAckEscalations(client(), { now: published });
  assert.deepEqual(first.byLevel, { 1: 1, 2: 0, 3: 0 });
  const second = await sweepAckEscalations(client(), { now: new Date(published.getTime() + 3_600_000) });
  assert.equal(second.escalated, 0, "no supervisor tier one hour after publish");
  const third = await sweepAckEscalations(client(), { now: new Date(published.getTime() + 25 * 3_600_000) });
  assert.deepEqual(third.byLevel, { 1: 0, 2: 1, 3: 0 });
});

test("a facility that disabled escalation is skipped with no claim and no job, and is looked at again an hour later", async (t) => {
  const world = makeWorld();
  install(t, world);
  const loadConfig = async () => ({ "communications.ackEscalationEnabled": false });
  const summary = await sweepAckEscalations(client(), { now: at(1), loadConfig });
  assert.equal(summary.disabled, 1);
  assert.equal(summary.escalated, 0);
  assert.equal(summary.claimed, 0);
  assert.equal(world.jobs.length, 0);
  assert.equal(world.messages[0].ack_escalation_level, 0, "the level is untouched");
  // The only write is the deferral that takes the message out of the candidate set.
  const patches = world.calls.filter((c) => c.table === "messages" && c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0].body), ["ack_next_escalation_at"]);
  assert.equal(world.messages[0].ack_next_escalation_at, new Date(at(1).getTime() + 3_600_000).toISOString());

  // Not rescanned until the hour is up; switching escalation back on takes effect then.
  const quiet = await sweepAckEscalations(client(), { now: at(1.5), loadConfig });
  assert.equal(quiet.scanned, 0);
  const later = await sweepAckEscalations(client(), { now: at(2.5) });
  assert.equal(later.escalated, 1);
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

// --- M-5: one tenant cannot starve the others ----------------------------------

function manyMessages(count, facilityId, prefix, overrides = {}) {
  return Array.from({ length: count }, (_, index) =>
    baseMessage({
      id: `${prefix}-${index}`,
      facility_id: facilityId,
      ack_due_at: new Date(new Date(DUE).getTime() - (200 - index) * 3_600_000).toISOString(),
      published_at: "2026-07-01T00:00:00Z",
      ...overrides
    })
  );
}

test("M-5 (review probe): 100 overdue messages of a facility with escalation off do not starve another facility", async (t) => {
  const world = makeWorld({
    messages: [
      ...manyMessages(100, "fac-X", "x"),
      baseMessage({ id: "y-1", facility_id: "fac-Y", ack_due_at: new Date(new Date(DUE).getTime() - 72 * 3_600_000).toISOString(), published_at: "2026-07-01T00:00:00Z" })
    ],
    audiences: [],
    acks: [],
    routes: [],
    lists: [],
    members: []
  });
  install(t, world);
  const loadConfig = async ({ facilityId }) => (facilityId === "fac-X" ? { "communications.ackEscalationEnabled": false } : {});

  const first = await sweepAckEscalations(client(), { now: at(1), limit: 25, loadConfig });
  assert.equal(first.disabled, 100);
  assert.equal(first.claimed, 1, "facility Y's message is reached in the very first pass");
  assert.equal(world.messages.find((m) => m.id === "y-1").ack_escalation_level, 1);
  assert.ok(world.messages.filter((m) => m.facility_id === "fac-X").every((m) => m.ack_escalation_level === 0));

  // The skipped rows left the candidate set: the next pass does not scan them again.
  const second = await sweepAckEscalations(client(), { now: at(1.5), limit: 25, loadConfig });
  assert.equal(second.disabled, 0, "facility X's disabled messages are not rescanned within the hour");
  assert.ok(second.scanned <= 1, "only facility Y's next tier is looked at");
  // ...and the deferral writes were batched (100 ids, not 100 writes).
  const deferrals = world.calls.filter((c) => c.table === "messages" && c.method === "PATCH" && c.url.searchParams.get("id")?.startsWith("in."));
  assert.ok(deferrals.length >= 1 && deferrals.length <= 2);
});

test("M-5: messages waiting out the gap between tiers do not occupy slots either", async (t) => {
  // 60 messages already at level 1 (supervisor tier due 24 h after their due time) and one fresh one in another facility.
  const waiting = manyMessages(60, "fac-X", "w", { ack_escalation_level: 1 }).map((m) => ({
    ...m,
    ack_next_escalation_at: new Date(new Date(m.ack_due_at).getTime()).toISOString() // stale: due long ago, tier 2 not yet due for these
  }));
  // Tier 2 is due ack_due_at + 24 h; make these due only 2 h ago so they are NOT yet due for tier 2... but the
  // queue column says "look now" (as after a reverted claim or a stale value).
  for (const message of waiting) message.ack_due_at = new Date(at(-1).getTime()).toISOString();
  const world = makeWorld({
    messages: [...waiting, baseMessage({ id: "y-1", facility_id: "fac-Y", ack_due_at: "2026-08-01T00:00:00Z", published_at: "2026-07-01T00:00:00Z" })],
    audiences: [],
    acks: [],
    routes: [],
    lists: [],
    members: []
  });
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1), limit: 10 });
  assert.equal(summary.waiting, 60);
  assert.equal(summary.claimed, 1);
  assert.equal(world.messages.find((m) => m.id === "y-1").ack_escalation_level, 1);
  // Each waiting message was queued for the instant its next tier comes due (due + 24 h), not for "later".
  for (const message of world.messages.filter((m) => m.id.startsWith("w-"))) {
    assert.equal(message.ack_next_escalation_at, new Date(new Date(message.ack_due_at).getTime() + 24 * 3_600_000).toISOString());
  }
  const again = await sweepAckEscalations(client(), { now: at(2), limit: 10 });
  assert.equal(again.waiting, 0, "the waiting messages are not looked at again until their tier is due");
});

test("M-5: `limit` counts messages acted on, not messages skipped; the rest wait for the next pass", async (t) => {
  const world = makeWorld({
    messages: manyMessages(30, "fac-1", "a"),
    audiences: [],
    acks: [],
    routes: [],
    lists: [],
    members: []
  });
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1), limit: 5 });
  assert.equal(summary.claimed, 5);
  assert.equal(world.messages.filter((m) => m.ack_escalation_level === 1).length, 5);
  const next = await sweepAckEscalations(client(), { now: at(1), limit: 5 });
  assert.equal(next.claimed, 5, "the following pass continues where this one stopped");
});

test("M-5: a pass terminates when the ready set only holds messages it already handled", async (t) => {
  // Every message stays ready after its claim (all tiers long overdue); the pass must still stop.
  const world = makeWorld({
    messages: manyMessages(8, "fac-1", "z"),
    audiences: [],
    acks: [],
    routes: [],
    lists: [],
    members: []
  });
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1000), limit: 50 });
  assert.equal(summary.claimed, 8);
  assert.equal(summary.scanned, 8);
});

// --- M-1: a dedupe hit must be the sweep's own job ------------------------------

test("M-1: a deduped insert whose key is held by a foreign row is an error: the claim is reverted, nothing is recorded", async (t) => {
  const world = makeWorld();
  const key = ackEscalationDedupeKey("fac-1", "message.ack_overdue", "m-1", 1);
  // A row that holds the key but is NOT this tier's job: cancelled, written by someone else.
  world.jobs.push({
    id: "job-foreign",
    facility_id: "fac-1",
    event_type: "message.ack_overdue",
    status: "cancelled",
    dedupe_key: key,
    payload_jsonb: { messageId: "m-1", escalationLevel: 1, tier: "reminder" }
  });
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(summary.escalated, 0);
  assert.equal(summary.deduped, 0);
  assert.equal(summary.claimed, 0);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].stage, "notify");
  assert.match(summary.errors[0].error, /did not create/);
  assert.equal(world.messages[0].ack_escalation_level, 0, "claim reverted: the tier is not recorded as escalated");
  assert.equal(world.events.length, 0, "no ledger row for a tier that was never sent");
});

test("M-1: a key held by a row for another message, level, facility or event is equally foreign", async (t) => {
  const key = ackEscalationDedupeKey("fac-1", "message.ack_overdue", "m-1", 1);
  const bases = [
    { payload_jsonb: { messageId: "m-other", escalationLevel: 1, tier: "reminder" } },
    { payload_jsonb: { messageId: "m-1", escalationLevel: 2, tier: "reminder" } },
    { payload_jsonb: { messageId: "m-1", escalationLevel: 1, tier: "supervisor" } },
    { payload_jsonb: { messageId: "m-1", escalationLevel: 1, tier: "reminder" }, facility_id: "fac-2" },
    { payload_jsonb: { messageId: "m-1", escalationLevel: 1, tier: "reminder" }, event_type: "message.ack_escalated_manager" }
  ];
  for (const override of bases) {
    const world = makeWorld();
    world.jobs.push({ id: "job-x", facility_id: "fac-1", event_type: "message.ack_overdue", status: "pending", dedupe_key: key, ...override });
    install(t, world);
    const summary = await sweepAckEscalations(client(), { now: at(1) });
    assert.equal(summary.escalated, 0, JSON.stringify(override));
    assert.match(summary.errors[0].error, /did not create/, JSON.stringify(override));
  }
});

test("M-1: a deduped insert whose key is held by this tier's own pending job is the harmless retry", async (t) => {
  const world = makeWorld();
  const key = ackEscalationDedupeKey("fac-1", "message.ack_overdue", "m-1", 1);
  world.jobs.push({
    id: "job-own",
    facility_id: "fac-1",
    event_type: "message.ack_overdue",
    status: "pending",
    dedupe_key: key,
    payload_jsonb: { messageId: "m-1", escalationLevel: 1, tier: "reminder" }
  });
  install(t, world);
  const summary = await sweepAckEscalations(client(), { now: at(1) });
  assert.equal(summary.deduped, 1);
  assert.equal(summary.escalated, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(world.jobs.length, 1);
});
