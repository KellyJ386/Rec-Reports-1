// Notification delivery worker core (OP-11) -- pure orchestration over an
// injectable PostgREST client (service-role; RLS is bypassed, so every query
// here is already facility-scoped by hand). No HTTP/cron wiring lives here --
// that is OP-13/14's job (scripts/notifications-worker.mjs, the internal
// drain route, vercel.json crons, and outbox draining). This file only knows
// how to claim due notification_jobs rows, resolve their recipients, write
// notification_deliveries, and manage retry/backoff/dead-letter bookkeeping
// added by 0029_delivery_bookkeeping.sql.
//
// Recipient resolution deliberately reuses (never reimplements) the four pure
// helpers in src/lib/admin/notifications.mjs:
//   - resolveRoute            -- picks the live, highest-priority active route
//                                 for the job's event, re-checked at drain
//                                 time (routes/priorities can change between
//                                 enqueue and drain).
//   - expandDistributionList  -- expands a route's target distribution list
//                                 against CURRENT membership (fresher than a
//                                 membership snapshot taken at enqueue time).
//   - buildNotificationJob    -- the same normalization the enqueue path uses
//                                 (e.g. the admin "test send" route), so a
//                                 route-expanded job ends up with exactly the
//                                 same {channels, recipients} shape a job that
//                                 already carried recipients would have.
//   - isWithinQuietHours      -- decides whether "now" falls inside the
//                                 facility's configured quiet-hours window.
//
// A job enqueued with pre-expanded payload_jsonb.recipients (plain employee id
// strings) skips the route/list lookup entirely and delivers directly -- that
// is the common case once real event producers start calling
// buildNotificationJob with a resolved recipient list.

import { pgSelect, pgUpdate, pgInsert } from "../supabase-rest.mjs";
import {
  resolveRoute,
  expandDistributionList,
  isWithinQuietHours,
  buildNotificationJob
} from "../admin/notifications.mjs";
import { configValue } from "../settings-registry.mjs";

const JOB_COLUMNS =
  "id,facility_id,event_type,payload_jsonb,scheduled_for,status,attempts,last_error,next_attempt_at,created_at,updated_at";

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2 * 60 * 1000; // 2 minutes
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// "now" as an "HH:MM" string in UTC. Facility-local quiet hours (via the
// facility's timezone column) are out of scope here -- config.quietHoursStart/
// End are compared against UTC clock time, same as the registry defaults.
function toHHMM(date) {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// The next timestamp at which the quiet-hours window ends, so a deferred job
// wakes up right as it becomes safe to deliver rather than being polled
// arbitrarily. Falls back to a short retry if the configured end time is
// malformed, so a bad config value can't wedge a job forever.
function nextQuietWindowEnd(now, quietEndHHMM) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(quietEndHHMM ?? "");
  if (!match) return new Date(now.getTime() + BASE_BACKOFF_MS);
  const [, hh, mm] = match;
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(hh), Number(mm), 0, 0)
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

// Exponential backoff keyed off the POST-increment attempt count (1-based):
// attempt 1 -> 2m, 2 -> 4m, 3 -> 8m, 4 -> 16m, ... capped at 1 hour.
function computeBackoffMs(attempts) {
  const exponential = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exponential, MAX_BACKOFF_MS);
}

// Re-resolves a job's route + target distribution list at drain time and
// normalizes the result through buildNotificationJob, so the delivered shape
// matches what a directly-recipient-carrying job would already have.
async function resolveRouteRecipients({ client, job, config }) {
  const routes = await pgSelect(client, "notification_routes", {
    filters: { facility_id: job.facility_id, event_code: job.event_type, active: true },
    select: "id,facility_id,event_code,priority,route_jsonb,active"
  });
  const route = resolveRoute(job.event_type, routes ?? []);
  const listId = route?.route_jsonb?.distributionListId ?? null;
  if (!route || !listId) return { recipients: [], channels: [] };

  const [listRows, members, employees] = await Promise.all([
    pgSelect(client, "distribution_lists", {
      filters: { id: listId, facility_id: job.facility_id },
      select: "id,facility_id,name,active",
      limit: 1
    }),
    pgSelect(client, "distribution_list_members", {
      filters: { distribution_list_id: listId, facility_id: job.facility_id },
      select: "id,facility_id,distribution_list_id,member_type,member_ref_id"
    }),
    pgSelect(client, "employees", {
      filters: { facility_id: job.facility_id },
      select: "id"
    })
  ]);
  const list = (listRows ?? [])[0] ?? { id: listId };
  const expanded = expandDistributionList(list, members ?? [], {
    employees: employees ?? [],
    roleAssignments: config?.roleAssignments ?? []
  });
  const rebuilt = buildNotificationJob(job.event_type, route, expanded);
  return {
    recipients: rebuilt.payload_jsonb.recipients,
    channels: rebuilt.payload_jsonb.channels
  };
}

// Resolves {recipients, channels} for a claimed job. A job whose payload
// already carries recipient ids (the buildNotificationJob shape once a
// producer passes a resolved list) is used as-is; otherwise the live route is
// re-expanded (see resolveRouteRecipients above).
async function resolveDelivery({ client, job, config }) {
  const rawRecipients = Array.isArray(job.payload_jsonb?.recipients) ? job.payload_jsonb.recipients : [];
  const directRecipients = [...new Set(rawRecipients.filter((entry) => typeof entry === "string" && entry.length > 0))];
  const payloadChannels = Array.isArray(job.payload_jsonb?.channels) ? job.payload_jsonb.channels : [];

  if (directRecipients.length > 0) {
    return { recipients: directRecipients, channels: payloadChannels.length > 0 ? payloadChannels : ["in_app"] };
  }

  const resolved = await resolveRouteRecipients({ client, job, config });
  const channels = resolved.channels.length > 0 ? resolved.channels : payloadChannels;
  return { recipients: resolved.recipients, channels: channels.length > 0 ? channels : ["in_app"] };
}

// Records a failed attempt: increments attempts, stamps last_error, and
// either schedules an exponential-backoff retry (status back to 'pending' so
// claimDueJobs can reclaim it once next_attempt_at elapses) or dead-letters
// the job once config.maxAttempts is reached.
async function handleFailure({ client, job, now, nowIso, error, maxAttempts }) {
  const attempts = Number(job.attempts ?? 0) + 1;
  const lastError = error?.message ? String(error.message) : String(error);
  const deadLettered = attempts >= maxAttempts;
  const patch = {
    attempts,
    last_error: lastError,
    updated_at: nowIso,
    status: deadLettered ? "dead_letter" : "pending",
    next_attempt_at: deadLettered ? null : toIso(new Date(now.getTime() + computeBackoffMs(attempts)))
  };
  await pgUpdate(client, "notification_jobs", { id: job.id }, patch, { returning: true });
  return {
    outcome: deadLettered ? "dead_letter" : "failed",
    job,
    error: lastError,
    attempts,
    nextAttemptAt: patch.next_attempt_at
  };
}

// Selects due, pending notification_jobs (scheduled_for <= now, or a prior
// failure's next_attempt_at <= now) and claims each with a conditional
// pending -> processing update. Concurrent drains racing on the same job: the
// loser's UPDATE matches zero rows (its WHERE status='pending' no longer
// holds once the winner's UPDATE has landed) and is silently skipped -- no
// double-claim, no double-send.
export async function claimDueJobs({ client, now = new Date(), limit = 25 }) {
  const nowIso = toIso(now);
  const candidates = await pgSelect(client, "notification_jobs", {
    filters: { status: "pending" },
    select: JOB_COLUMNS,
    order: "scheduled_for.asc",
    limit,
    extra: { or: `(scheduled_for.lte.${nowIso},next_attempt_at.lte.${nowIso})` }
  });

  const claimed = [];
  for (const job of candidates ?? []) {
    const updated = await pgUpdate(
      client,
      "notification_jobs",
      { id: job.id, status: "pending" },
      { status: "processing", updated_at: nowIso },
      { returning: true }
    );
    if (Array.isArray(updated) && updated.length > 0) {
      claimed.push(updated[0]);
    }
    // else: lost the race to another concurrent drain for this job -- skip it.
  }
  return claimed;
}

// Processes one already-claimed (status='processing') job: quiet-hours jobs
// are rescheduled (status back to 'pending', next_attempt_at = next window
// end) rather than dropped or failed. Otherwise recipients are resolved, one
// notification_deliveries row is written per recipient per channel (in_app is
// immediately 'sent'; every other channel is written 'queued', awaiting a
// future channel adapter), and the job moves to 'sent'. Any error along the
// way (including "no recipients resolved") is routed through the retry/
// dead-letter failure path instead of throwing.
export async function processJob({ client, job, now = new Date(), config = {} }) {
  const nowIso = toIso(now);
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const quietStart = config.quietHoursStart ?? configValue({}, "reports.quietHoursStart");
  const quietEnd = config.quietHoursEnd ?? configValue({}, "reports.quietHoursEnd");

  if (isWithinQuietHours(toHHMM(now), quietStart, quietEnd)) {
    const nextAttemptAt = nextQuietWindowEnd(now, quietEnd);
    await pgUpdate(
      client,
      "notification_jobs",
      { id: job.id },
      { status: "pending", next_attempt_at: toIso(nextAttemptAt), updated_at: nowIso },
      { returning: true }
    );
    return { outcome: "rescheduled", job, nextAttemptAt };
  }

  try {
    const { recipients, channels } = await resolveDelivery({ client, job, config });
    if (recipients.length === 0) {
      throw new Error(`no recipients resolved for notification job ${job.id}`);
    }

    const deliveryRows = [];
    for (const employeeId of recipients) {
      for (const channel of channels) {
        deliveryRows.push({
          facility_id: job.facility_id,
          job_id: job.id,
          employee_id: employeeId,
          channel,
          status: channel === "in_app" ? "sent" : "queued",
          sent_at: channel === "in_app" ? nowIso : null
        });
      }
    }

    const inserted = await pgInsert(client, "notification_deliveries", deliveryRows, { returning: true });
    await pgUpdate(client, "notification_jobs", { id: job.id }, { status: "sent", updated_at: nowIso }, { returning: true });
    return { outcome: "sent", job, recipients, channels, deliveries: inserted ?? deliveryRows };
  } catch (error) {
    return handleFailure({ client, job, now, nowIso, error, maxAttempts });
  }
}

// Composes claimDueJobs + processJob for a single drain pass, returning a
// summary of what happened. The entry points that actually call this on a
// schedule (local dev loop, the CRON_SECRET-guarded internal route) are
// OP-13/14 -- this function is what they will call.
export async function drainOnce({ client, now = new Date(), limit = 25, config = {} }) {
  const claimed = await claimDueJobs({ client, now, limit });
  const summary = { claimed: claimed.length, sent: 0, rescheduled: 0, failed: 0, deadLettered: 0 };

  for (const job of claimed) {
    const result = await processJob({ client, job, now, config });
    if (result.outcome === "sent") summary.sent += 1;
    else if (result.outcome === "rescheduled") summary.rescheduled += 1;
    else if (result.outcome === "dead_letter") summary.deadLettered += 1;
    else summary.failed += 1;
  }

  return summary;
}
