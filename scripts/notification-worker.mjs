// One-shot (or --loop) drainer for the notification_jobs queue (0006). Reads
// server env the same way scripts/server.mjs does, selects a batch of due
// jobs, plans + attempts their deliveries through a pluggable transport, and
// writes notification_deliveries rows plus the resulting job state back.
//
// Usage:
//   node scripts/notification-worker.mjs            # drain one batch, exit 0
//   node scripts/notification-worker.mjs --loop      # keep draining forever
//
// Env:
//   NOTIFICATION_TRANSPORT     - "log" (default, safe/no network), "webhook",
//                                or "sendgrid" (email)
//   NOTIFICATION_WEBHOOK_URL   - required when NOTIFICATION_TRANSPORT=webhook
//   SENDGRID_API_KEY           - required when NOTIFICATION_TRANSPORT=sendgrid
//   NOTIFICATION_FROM_EMAIL    - sender address when NOTIFICATION_TRANSPORT=sendgrid
//   NOTIFICATION_BATCH_SIZE    - jobs claimed per batch (default 25)
//   NOTIFICATION_MAX_ATTEMPTS  - attempts before dead-lettering (default 5)
//   NOTIFICATION_LOOP_INTERVAL_MS - sleep between batches in --loop mode (default 5000)
//
// No provider SDK/credentials are hardcoded here -- see
// src/lib/notifications/transports.mjs for the pluggable Transport contract.

import { readServerEnv } from "../src/lib/env.mjs";
import { createClient, pgSelect, pgUpdate, pgInsert } from "../src/lib/supabase-rest.mjs";
import { planJob, classifyResult, nextAttemptAt, DEFAULT_MAX_ATTEMPTS } from "../src/lib/notifications/worker.mjs";
import { selectTransport } from "../src/lib/notifications/transports.mjs";

const JOB_COLUMNS = "id,facility_id,event_type,payload_jsonb,scheduled_for,status,attempts,created_at,updated_at";
const QUIET_HOURS_RECHECK_SECONDS = 15 * 60;

function parseArgs(argv) {
  return { loop: argv.includes("--loop") };
}

function loadConfig(env, argv) {
  const args = parseArgs(argv);
  return {
    loop: args.loop,
    batchSize: Number(env.NOTIFICATION_BATCH_SIZE ?? process.env.NOTIFICATION_BATCH_SIZE ?? 25) || 25,
    maxAttempts:
      Number(env.NOTIFICATION_MAX_ATTEMPTS ?? process.env.NOTIFICATION_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS) ||
      DEFAULT_MAX_ATTEMPTS,
    loopIntervalMs: Number(process.env.NOTIFICATION_LOOP_INTERVAL_MS ?? 5000) || 5000,
    transportName: process.env.NOTIFICATION_TRANSPORT ?? "log",
    webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL,
    sendgridApiKey: process.env.SENDGRID_API_KEY,
    fromEmail: process.env.NOTIFICATION_FROM_EMAIL
  };
}

function buildClient(env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "notification-worker requires SUPABASE_SERVICE_ROLE_KEY (background delivery must bypass per-user RLS)."
    );
  }
  return createClient({ url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
}

async function fetchDueJobs(client, { nowIso, batchSize }) {
  const rows = await pgSelect(client, "notification_jobs", {
    filters: { status: "pending" },
    select: JOB_COLUMNS,
    order: "scheduled_for.asc",
    limit: batchSize,
    extra: { scheduled_for: `lte.${nowIso}` }
  });
  return rows ?? [];
}

// Optimistic claim: only flips status pending -> processing if it is still
// pending, so two worker instances racing on the same batch don't both
// attempt the same job.
async function claimJob(client, job, nowIso) {
  const rows = await pgUpdate(
    client,
    "notification_jobs",
    { id: job.id, status: "pending" },
    { status: "processing", updated_at: nowIso },
    { returning: true }
  );
  return (rows ?? [])[0] ?? null;
}

async function loadContacts(client, employeeIds) {
  const ids = [...new Set(employeeIds)].filter(Boolean);
  if (ids.length === 0) return {};
  try {
    const employees = await pgSelect(client, "employees", {
      select: "id,user_id",
      extra: { id: `in.(${ids.join(",")})` }
    });
    const userIds = [...new Set((employees ?? []).map((employee) => employee.user_id).filter(Boolean))];
    if (userIds.length === 0) return {};
    const users = await pgSelect(client, "app_users", {
      select: "id,email",
      extra: { id: `in.(${userIds.join(",")})` }
    });
    const emailByUserId = new Map((users ?? []).map((user) => [user.id, user.email]));
    const contacts = {};
    for (const employee of employees ?? []) {
      const email = emailByUserId.get(employee.user_id);
      if (email) contacts[employee.id] = { email };
    }
    return contacts;
  } catch (error) {
    console.error("notification-worker: failed to load contacts:", error?.message ?? error);
    return {};
  }
}

async function recordDeliveries(client, job, deliveries, results, nowIso) {
  if (deliveries.length === 0) return;
  const rows = deliveries.map((delivery, index) => ({
    facility_id: job.facility_id,
    job_id: job.id,
    employee_id: delivery.employeeId ?? null,
    channel: delivery.channel,
    status: results[index]?.ok ? "sent" : "failed",
    sent_at: results[index]?.ok ? nowIso : null
  }));
  await pgInsert(client, "notification_deliveries", rows, { returning: false });
}

async function deferJob(client, job, nowIso) {
  const rescheduledFor = nextAttemptAt(0, nowIso, {
    baseSeconds: QUIET_HOURS_RECHECK_SECONDS,
    maxSeconds: QUIET_HOURS_RECHECK_SECONDS
  });
  await pgUpdate(
    client,
    "notification_jobs",
    { id: job.id },
    { status: "pending", scheduled_for: rescheduledFor, updated_at: nowIso },
    { returning: false }
  );
}

async function finalizeJob(client, job, deliveries, results, config, nowIso) {
  const overallOk = deliveries.length > 0 && results.every((result) => result.ok);
  const firstError = results.find((result) => !result.ok)?.error ?? (deliveries.length === 0 ? "no deliverable recipients" : null);
  const classification = classifyResult(
    { ok: overallOk, error: firstError },
    { attempts: job.attempts, maxAttempts: config.maxAttempts, now: nowIso }
  );
  const patch = {
    status: classification.status,
    attempts: classification.attempts,
    updated_at: nowIso
  };
  if (classification.nextAttemptAt) patch.scheduled_for = classification.nextAttemptAt;
  await pgUpdate(client, "notification_jobs", { id: job.id }, patch, { returning: false });
  return classification;
}

// Processes a single due job end-to-end. Wrapped by the caller in try/catch
// so one bad job can never take the rest of the batch down with it.
async function processJob(client, job, transport, config, nowIso) {
  const claimed = await claimJob(client, job, nowIso);
  if (!claimed) return { outcome: "already-claimed" };

  const employeeIds = Array.isArray(claimed.payload_jsonb?.recipients) ? claimed.payload_jsonb.recipients : [];
  const contacts = await loadContacts(client, employeeIds);
  const plan = planJob(claimed, { now: nowIso, contacts });

  if (plan.deferred) {
    await deferJob(client, claimed, nowIso);
    return { outcome: "deferred" };
  }

  const results = [];
  for (const delivery of plan.deliveries) {
    try {
      if (!delivery.target) {
        results.push({ ok: false, error: `no contact target for ${delivery.channel}` });
        continue;
      }
      const result = await transport.send({
        ...delivery,
        jobId: claimed.id,
        facilityId: claimed.facility_id,
        eventType: claimed.event_type
      });
      results.push(result?.ok ? { ok: true } : { ok: false, error: result?.error ?? "delivery failed" });
    } catch (error) {
      results.push({ ok: false, error: error instanceof Error ? error.message : "transport threw" });
    }
  }

  await recordDeliveries(client, claimed, plan.deliveries, results, nowIso);
  const classification = await finalizeJob(client, claimed, plan.deliveries, results, config, nowIso);
  return { outcome: classification.status, deadLettered: classification.deadLettered };
}

async function drainOnce(client, transport, config) {
  const nowIso = new Date().toISOString();
  const jobs = await fetchDueJobs(client, { nowIso, batchSize: config.batchSize });
  let processed = 0;
  let failures = 0;
  for (const job of jobs) {
    try {
      const result = await processJob(client, job, transport, config, nowIso);
      processed += 1;
      console.log(`notification-worker: job ${job.id} -> ${result.outcome}`);
    } catch (error) {
      failures += 1;
      console.error(`notification-worker: job ${job.id} failed unexpectedly:`, error?.message ?? error);
    }
  }
  console.log(`notification-worker: batch complete (${jobs.length} due, ${processed} processed, ${failures} errored).`);
  return jobs.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const env = readServerEnv();
  const config = loadConfig(env, process.argv.slice(2));
  const client = buildClient(env);
  const transport = selectTransport(config.transportName, {
    webhookUrl: config.webhookUrl,
    sendgridApiKey: config.sendgridApiKey,
    fromEmail: config.fromEmail
  });

  if (!config.loop) {
    await drainOnce(client, transport, config);
    return;
  }

  for (;;) {
    await drainOnce(client, transport, config);
    await sleep(config.loopIntervalMs);
  }
}

main().catch((error) => {
  console.error("notification-worker: fatal error:", error?.message ?? error);
  process.exit(1);
});
