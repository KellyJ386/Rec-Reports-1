// Notification delivery worker core (OP-11/OP-14) -- pure orchestration over
// an injectable PostgREST client (service-role; RLS is bypassed, so every
// query here is already facility-scoped by hand). No HTTP/cron wiring lives
// here -- that is OP-13's job (scripts/notifications-worker.mjs and the
// internal drain route in src/lib/http/internal-routes.mjs, plus vercel.json
// crons). This file knows how to:
//   - claim due notification_jobs rows, resolve their recipients, write
//     notification_deliveries, and manage retry/backoff/dead-letter
//     bookkeeping added by 0029_delivery_bookkeeping.sql (OP-11), and
//   - claim due outbox_events rows and translate each into a
//     notification_jobs row via resolveRoute + buildNotificationJob,
//     reusing the same retry/backoff bookkeeping (OP-14). outbox_events has
//     no 'dead_letter' status (0002's check constraint only allows
//     'pending' | 'processing' | 'processed' | 'failed', and 0029 did not
//     extend it), so an outbox row's terminal failure state is 'failed'
//     rather than notification_jobs' 'dead_letter'.
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
import { sendPush } from "./push.mjs";
import { sendEmail } from "./email.mjs";
import { reportError } from "../observability.mjs";

const JOB_COLUMNS =
  "id,facility_id,event_type,payload_jsonb,scheduled_for,status,attempts,last_error,next_attempt_at,created_at,updated_at";

const OUTBOX_COLUMNS =
  "id,facility_id,event_type,payload,status,attempts,available_at,processed_at,last_error,next_attempt_at,created_at";

const DEVICE_TOKEN_COLUMNS = "id,facility_id,employee_id,platform,token,last_seen_at,revoked_at";
const PREFERENCE_COLUMNS =
  "id,facility_id,employee_id,in_app_enabled,email_enabled,sms_enabled,push_enabled,quiet_hours_start,quiet_hours_end";

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
// malformed, so a bad config value can't wedge a job forever. Exported (DR-22):
// src/lib/report-distribution.mjs's quiet-hours reschedule reuses this
// verbatim rather than duplicating the "wake at window end, not by polling"
// logic for its own outbox-event reschedule.
export function nextQuietWindowEnd(now, quietEndHHMM) {
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

// Loads a facility's active routes for one event code and resolves the
// highest-priority one (see resolveRoute in admin/notifications.mjs). Shared
// by job recipient re-resolution (below) and outbox event translation
// (drainOutboxOnce), so both paths pick the identical live route.
async function loadActiveRoute({ client, facilityId, eventCode }) {
  const routes = await pgSelect(client, "notification_routes", {
    filters: { facility_id: facilityId, event_code: eventCode, active: true },
    select: "id,facility_id,event_code,priority,route_jsonb,active"
  });
  return resolveRoute(eventCode, routes ?? []);
}

// Expands a route's target distribution list against CURRENT membership into
// a deduped array of employee ids. Returns [] when the route has no
// distributionListId (nothing to expand). Shared by job recipient
// re-resolution and outbox event translation.
async function expandRouteRecipients({ client, facilityId, route, config }) {
  const listId = route?.route_jsonb?.distributionListId ?? null;
  if (!route || !listId) return [];

  const [listRows, members, employees] = await Promise.all([
    pgSelect(client, "distribution_lists", {
      filters: { id: listId, facility_id: facilityId },
      select: "id,facility_id,name,active",
      limit: 1
    }),
    pgSelect(client, "distribution_list_members", {
      filters: { distribution_list_id: listId, facility_id: facilityId },
      select: "id,facility_id,distribution_list_id,member_type,member_ref_id"
    }),
    pgSelect(client, "employees", {
      filters: { facility_id: facilityId },
      select: "id"
    })
  ]);
  const list = (listRows ?? [])[0] ?? { id: listId };
  return expandDistributionList(list, members ?? [], {
    employees: employees ?? [],
    roleAssignments: config?.roleAssignments ?? []
  });
}

// Re-resolves a job's route + target distribution list at drain time and
// normalizes the result through buildNotificationJob, so the delivered shape
// matches what a directly-recipient-carrying job would already have.
async function resolveRouteRecipients({ client, job, config }) {
  const route = await loadActiveRoute({ client, facilityId: job.facility_id, eventCode: job.event_type });
  if (!route) return { recipients: [], channels: [] };
  const expanded = await expandRouteRecipients({ client, facilityId: job.facility_id, route, config });
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
//
// OP-20: every failed attempt also fires a fire-and-forget error report --
// this is "the worker's failure path" the observability plan calls out.
// Never awaited (see src/lib/observability.mjs); config.dsn is undefined
// unless the caller (the CRON_SECRET-guarded drain route) explicitly passes
// one, so a caller that never wires observability config (e.g. every
// existing worker test) gets the same silent no-op as an unset
// OBSERVABILITY_DSN.
async function handleFailure({ client, job, now, nowIso, error, maxAttempts, config = {} }) {
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
  reportError(error, {
    dsn: config.dsn,
    fetchImpl: config.observabilityFetch,
    route: `notifications.worker/${job.event_type ?? "unknown"}`,
    status: deadLettered ? "dead_letter" : "retry",
    requestId: job.id,
    userId: null
  });
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

// Resolves, for every recipient of a channel='push' delivery, whether they
// are eligible to receive it right now and (if so) which active device
// tokens to send to. Three ways a recipient can be ruled out before a
// provider is ever contacted, each recorded as a distinct `reason` purely
// for in-process bookkeeping (see buildPushDeliveryStatuses -- the
// notification_deliveries row itself has no reason column, see that
// function's comment for why 'failed' is what actually gets persisted):
//   - "opted_out"   -- employee_notification_preferences.push_enabled = false.
//   - "quiet_hours" -- the employee's OWN quiet_hours_start/end override
//     (independent of the facility-wide default processJob already gated
//     the whole job on) says "quiet now". Only consulted when the job is
//     NOT bypassing quiet hours -- an urgent/emergency job's
//     quietHoursBypass overrides a personal preference the same way it
//     overrides the facility default, since the entire point of "urgent"
//     is reaching people who would otherwise be left alone.
//   - "no_token"    -- no active (revoked_at is null) device token on file.
// Recipients that clear all three carry their token list forward for
// sendPush to actually contact.
async function resolvePushPlan({ client, job, recipients, now }) {
  const bypass = job.payload_jsonb?.quietHoursBypass === true;
  const nowHHMM = toHHMM(now);

  const [tokenRows, prefRows] = await Promise.all([
    pgSelect(client, "employee_device_tokens", {
      filters: { facility_id: job.facility_id, employee_id: { in: recipients } },
      select: DEVICE_TOKEN_COLUMNS,
      extra: { revoked_at: "is.null" }
    }),
    pgSelect(client, "employee_notification_preferences", {
      filters: { facility_id: job.facility_id, employee_id: { in: recipients } },
      select: PREFERENCE_COLUMNS
    })
  ]);

  const tokensByEmployee = new Map();
  for (const row of tokenRows ?? []) {
    if (!row?.employee_id || !row?.token) continue;
    if (!tokensByEmployee.has(row.employee_id)) tokensByEmployee.set(row.employee_id, []);
    tokensByEmployee.get(row.employee_id).push(row.token);
  }
  const prefsByEmployee = new Map((prefRows ?? []).map((row) => [row.employee_id, row]));

  const plan = new Map();
  const allTokens = [];
  for (const employeeId of recipients) {
    const pref = prefsByEmployee.get(employeeId) ?? null;
    if (pref?.push_enabled === false) {
      plan.set(employeeId, { eligible: false, reason: "opted_out", tokens: [] });
      continue;
    }
    if (!bypass && pref?.quiet_hours_start && pref?.quiet_hours_end && isWithinQuietHours(nowHHMM, pref.quiet_hours_start, pref.quiet_hours_end)) {
      plan.set(employeeId, { eligible: false, reason: "quiet_hours", tokens: [] });
      continue;
    }
    const tokens = tokensByEmployee.get(employeeId) ?? [];
    if (tokens.length === 0) {
      plan.set(employeeId, { eligible: false, reason: "no_token", tokens: [] });
      continue;
    }
    plan.set(employeeId, { eligible: true, reason: null, tokens });
    allTokens.push(...tokens);
  }

  return { plan, allTokens: [...new Set(allTokens)] };
}

// Builds { employeeId -> { status, sent_at } } for every recipient's push
// delivery row, sending through the adapter (once, batched across every
// eligible recipient's tokens -- one job means one notification, so every
// eligible token gets the identical title/body) and revoking any
// permanently-rejected token as a side effect. Only called when the job's
// resolved channel list actually includes 'push', so a job with no push
// recipients never issues the extra device-token/preferences queries.
//
// Status choice for a ruled-out recipient (opted out / personally in quiet
// hours / no active token): 0006's notification_deliveries.status CHECK
// constraint allows only ('queued', 'sent', 'failed', 'bounced') -- there is
// no 'skipped' value, and the table has no free-text reason column to carry
// one alongside a different status. 'queued' is wrong (it means "an adapter
// will still attempt this," which none will -- there is no retry-by-
// delivery-row mechanism here, only retry-by-job). 'bounced' is reserved
// below for a provider's permanent rejection of a specific token, which is
// a materially different fact (the token itself is bad) from "we chose not
// to contact a token-holder this round." That leaves 'failed': it is the
// closest fit the constraint allows for "this recipient did not receive a
// push this round," and per the CM-07 requirement this must NOT fail the
// notification_jobs row itself -- only the per-recipient delivery row is
// marked 'failed'; resolveDelivery already guarantees recipients.length > 0
// before this runs, so a ruled-out push recipient never becomes "no
// recipients resolved" for the job as a whole.
async function buildPushDeliveryStatuses({ client, job, recipients, channels, now, config }) {
  const statuses = new Map();
  if (!channels.includes("push") || recipients.length === 0) return statuses;

  const nowIso = toIso(now);
  const { plan, allTokens } = await resolvePushPlan({ client, job, recipients, now });

  let outcomeByToken = new Map();
  if (allTokens.length > 0) {
    const sendOptions = config.pushAdapter ? { adapter: config.pushAdapter } : {};
    const title = job.payload_jsonb?.title ?? job.event_type;
    const body = job.payload_jsonb?.body ?? "";
    const result = await sendPush(
      { tokens: allTokens, title, body, data: { jobId: job.id, eventType: job.event_type } },
      sendOptions
    );
    outcomeByToken = new Map(result.results.map((entry) => [entry.token, entry.outcome]));

    if (result.revokeTokens.length > 0) {
      await pgUpdate(
        client,
        "employee_device_tokens",
        { token: { in: result.revokeTokens } },
        { revoked_at: nowIso },
        { returning: true }
      );
    }
  }

  for (const [employeeId, entry] of plan.entries()) {
    if (!entry.eligible) {
      statuses.set(employeeId, { status: "failed", sent_at: null });
      continue;
    }
    const outcomes = entry.tokens.map((token) => outcomeByToken.get(token) ?? "retryable");
    let status;
    if (outcomes.includes("sent")) status = "sent";
    else if (outcomes.includes("retryable")) status = "failed";
    else status = "bounced"; // every token for this recipient was permanently rejected
    statuses.set(employeeId, { status, sent_at: status === "sent" ? nowIso : null });
  }
  return statuses;
}

// Resolves, for every recipient of a channel='email' delivery, whether they
// are eligible to receive it right now and (if so) which address to send to.
// Two ways a recipient can be ruled out before a provider is ever contacted
// (mirrors resolvePushPlan's "reason" bookkeeping -- see buildPushDeliveryStatuses'
// comment for why the notification_deliveries row itself can only ever
// record 'failed' for either):
//   - "opted_out" -- employee_notification_preferences.email_enabled = false.
//   - "no_email"  -- the recipient's employees row has no user_id, or its
//     user_id points at no app_users row, or that row's email is empty. The
//     "employees has no email column; app_users.email is app-written and
//     not-null-unique" resolution the plan calls out: `employees.user_id`
//     is nullable, so a recipient with no linked user_id (or a linked user
//     whose account was hard-deleted, leaving nothing for the embed to
//     return) is exactly the same "nobody to email" case as an active user
//     with an unset email would be, were that ever possible under the
//     not-null constraint.
// ONE service-role select resolves every recipient's email in this job (the
// plan's "one select per job, never one per recipient" requirement): the
// `app_users(email)` embed already proven at admin-routes.mjs's membership
// listing, filtered to this job's recipient ids.
async function resolveEmailPlan({ client, job, recipients }) {
  const [employeeRows, prefRows] = await Promise.all([
    pgSelect(client, "employees", {
      filters: { facility_id: job.facility_id, id: { in: recipients } },
      select: "id,user_id,app_users(email)"
    }),
    pgSelect(client, "employee_notification_preferences", {
      filters: { facility_id: job.facility_id, employee_id: { in: recipients } },
      select: PREFERENCE_COLUMNS
    })
  ]);

  const emailByEmployee = new Map();
  for (const row of employeeRows ?? []) {
    if (!row?.id) continue;
    emailByEmployee.set(row.id, row.app_users?.email ?? null);
  }
  const prefsByEmployee = new Map((prefRows ?? []).map((row) => [row.employee_id, row]));

  const plan = new Map();
  for (const employeeId of recipients) {
    const pref = prefsByEmployee.get(employeeId) ?? null;
    if (pref?.email_enabled === false) {
      plan.set(employeeId, { eligible: false, reason: "opted_out", email: null });
      continue;
    }
    // A recipient this job's `employees` select simply didn't return a row
    // for (id not found -- e.g. the employee record itself was deleted
    // between enqueue and drain) resolves the same as a found row with no
    // email: emailByEmployee.get returns undefined either way, and `?? null`
    // below treats both identically. This is the "a recipient with no
    // app_users row must record failed, never throw the whole job" case.
    const email = emailByEmployee.get(employeeId) ?? null;
    if (!email) {
      plan.set(employeeId, { eligible: false, reason: "no_email", email: null });
      continue;
    }
    plan.set(employeeId, { eligible: true, reason: null, email });
  }
  return plan;
}

// Builds { employeeId -> { status, sent_at, provider_message_id } } for
// every recipient's email delivery row, sending through the adapter (bounded
// concurrency inside sendEmail -- one POST per recipient, never a batch
// endpoint, per CM-14/OP-12) and never throwing the job into handleFailure
// over a single recipient's bad address. Only called when the job's resolved
// channel list actually includes 'email', so a job with no email recipients
// never issues the extra employees/preferences queries. Subject/text are
// derived from the job payload exactly like buildPushDeliveryStatuses
// derives title/body -- see that function for why (a route-produced job
// carries no per-recipient content today, only a shared title/body for the
// whole notification).
async function buildEmailDeliveryStatuses({ client, job, recipients, channels, now, config }) {
  const statuses = new Map();
  if (!channels.includes("email") || recipients.length === 0) return statuses;

  const nowIso = toIso(now);
  const plan = await resolveEmailPlan({ client, job, recipients });
  const eligibleEntries = [...plan.entries()].filter(([, entry]) => entry.eligible);

  let results = [];
  if (eligibleEntries.length > 0) {
    const sendOptions = config.emailAdapter ? { adapter: config.emailAdapter } : {};
    const subject = job.payload_jsonb?.title ?? job.event_type;
    const text = job.payload_jsonb?.body ?? "";
    const html = job.payload_jsonb?.html;
    const messages = eligibleEntries.map(([, entry]) => ({ to: entry.email, subject, text, html }));
    results = await sendEmail({ messages }, sendOptions);
  }

  eligibleEntries.forEach(([employeeId], index) => {
    const result = results[index] ?? { outcome: "retryable", providerMessageId: null };
    let status;
    if (result.outcome === "sent") status = "sent";
    else if (result.outcome === "retryable") status = "failed";
    else status = "bounced"; // provider permanently rejected this address
    statuses.set(employeeId, {
      status,
      sent_at: status === "sent" ? nowIso : null,
      provider_message_id: status === "sent" ? result.providerMessageId ?? null : null
    });
  });

  for (const [employeeId, entry] of plan.entries()) {
    if (!entry.eligible) {
      statuses.set(employeeId, { status: "failed", sent_at: null, provider_message_id: null });
    }
  }
  return statuses;
}

// Processes one already-claimed (status='processing') job: quiet-hours jobs
// are rescheduled (status back to 'pending', next_attempt_at = next window
// end) rather than dropped or failed -- UNLESS the job carries
// quietHoursBypass=true (CM-03 stamps this for urgent/emergency messages via
// shouldBypassQuietHours), in which case delivery proceeds immediately
// regardless of the facility's quiet-hours window; that is the entire
// purpose of the flag CM-03 already computes and stores, previously unread
// by anything. Otherwise recipients are resolved, one notification_deliveries
// row is written per recipient per channel (in_app is immediately 'sent';
// push is resolved synchronously via the adapter -- see
// buildPushDeliveryStatuses; every other channel is still written 'queued',
// awaiting a future channel adapter), and the job moves to 'sent'. Any error
// along the way (including "no recipients resolved") is routed through the
// retry/dead-letter failure path instead of throwing.
export async function processJob({ client, job, now = new Date(), config = {} }) {
  const nowIso = toIso(now);
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const quietStart = config.quietHoursStart ?? configValue({}, "reports.quietHoursStart");
  const quietEnd = config.quietHoursEnd ?? configValue({}, "reports.quietHoursEnd");
  const bypassQuietHours = job.payload_jsonb?.quietHoursBypass === true;

  if (!bypassQuietHours && isWithinQuietHours(toHHMM(now), quietStart, quietEnd)) {
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

    const pushStatuses = await buildPushDeliveryStatuses({ client, job, recipients, channels, now, config });
    const emailStatuses = await buildEmailDeliveryStatuses({ client, job, recipients, channels, now, config });

    const deliveryRows = [];
    for (const employeeId of recipients) {
      for (const channel of channels) {
        if (channel === "push") {
          const resolved = pushStatuses.get(employeeId) ?? { status: "failed", sent_at: null };
          deliveryRows.push({
            facility_id: job.facility_id,
            job_id: job.id,
            employee_id: employeeId,
            channel,
            status: resolved.status,
            sent_at: resolved.sent_at
          });
          continue;
        }
        if (channel === "email") {
          const resolved = emailStatuses.get(employeeId) ?? { status: "failed", sent_at: null, provider_message_id: null };
          deliveryRows.push({
            facility_id: job.facility_id,
            job_id: job.id,
            employee_id: employeeId,
            channel,
            status: resolved.status,
            sent_at: resolved.sent_at,
            provider_message_id: resolved.provider_message_id ?? null
          });
          continue;
        }
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
    return handleFailure({ client, job, now, nowIso, error, maxAttempts, config });
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

// ---------------------------------------------------------------------------
// Outbox draining (OP-14) -- translates outbox_events rows (produced by
// module code elsewhere: cert-expiry, escalation, report-reminder, etc. --
// none of that lives here) into notification_jobs rows that claimDueJobs/
// processJob above can then deliver on a later drain pass.
// ---------------------------------------------------------------------------

// DR-22: outbox_events is a single shared table with a single pending ->
// processing -> processed/failed state machine, and claimDueOutboxEvents
// below used to claim EVERY pending row regardless of event_type. That is
// fine as long as this file is the table's only consumer -- but DR-22 adds a
// second one (src/lib/report-distribution.mjs processReportSubmittedEvents,
// consuming 'report.submitted' rows into report_deliveries instead of
// notification_jobs) that the plan explicitly wires to run in the SAME
// drain invocation, right after this worker (src/lib/http/internal-
// routes.mjs handleDrain). Without this reservation, drainOutboxOnce would
// win the race every time: it claims 'report.submitted' rows just like any
// other type, finds no notification_events catalog entry for them
// (translateOutboxEvent), and marks them 'processed' with a
// "skipped: ..." note -- silently swallowing every report-submission event
// before the report-distribution consumer ever sees one.
//
// RESERVED_OUTBOX_EVENT_TYPES is the fix: event types with their own
// dedicated consumer are excluded from THIS file's claim query, so they
// stay 'pending' for that consumer's own claim (which filters TO the
// reserved type) instead of being swept up generically here. Add a future
// module's own event_type here when it grows a dedicated outbox consumer
// the same way DR-22 does; this file's own claim is the only thing that
// needs to know the exclusion list, since every dedicated consumer filters
// FOR its own type already.
export const RESERVED_OUTBOX_EVENT_TYPES = new Set(["report.submitted"]);

// Selects due, pending outbox_events (available_at <= now, or a prior
// failure's next_attempt_at <= now) and claims each with a conditional
// pending -> processing update, mirroring claimDueJobs' race-safe claim
// (the loser's UPDATE matches zero rows and is silently skipped). Excludes
// RESERVED_OUTBOX_EVENT_TYPES (see comment above) -- those event types are
// claimed by their own dedicated consumer instead.
export async function claimDueOutboxEvents({ client, now = new Date(), limit = 25 }) {
  const nowIso = toIso(now);
  const reserved = [...RESERVED_OUTBOX_EVENT_TYPES];
  const extra = { or: `(available_at.lte.${nowIso},next_attempt_at.lte.${nowIso})` };
  if (reserved.length > 0) {
    extra.event_type = `not.in.(${reserved.join(",")})`;
  }
  const candidates = await pgSelect(client, "outbox_events", {
    filters: { status: "pending" },
    select: OUTBOX_COLUMNS,
    order: "available_at.asc",
    limit,
    extra
  });

  const claimed = [];
  for (const event of candidates ?? []) {
    const updated = await pgUpdate(
      client,
      "outbox_events",
      { id: event.id, status: "pending" },
      { status: "processing" },
      { returning: true }
    );
    if (Array.isArray(updated) && updated.length > 0) {
      claimed.push(updated[0]);
    }
    // else: lost the race to another concurrent drain for this event -- skip it.
  }
  return claimed;
}

// Resolves an outbox event's live route and recipients, matching event_type
// against notification_events (the global catalog -- an event this facility
// never registered a route for, or that isn't in the catalog at all, is
// "unrouteable") and notification_routes (the highest-priority active route
// for that event, same resolveRoute semantics processJob's jobs use). Returns
// either { job } (ready to insert into notification_jobs) or { skip: reason }
// for an event that should be marked processed without ever becoming a job.
async function translateOutboxEvent({ client, event, config }) {
  const knownEvents = await pgSelect(client, "notification_events", {
    filters: { code: event.event_type },
    select: "id,code,severity,module_code,default_channels_jsonb",
    limit: 1
  });
  if (!(knownEvents ?? [])[0]) {
    return { skip: `event type "${event.event_type}" is not in the notification_events catalog` };
  }

  const route = await loadActiveRoute({ client, facilityId: event.facility_id, eventCode: event.event_type });
  if (!route) {
    return { skip: `no active notification_routes entry for "${event.event_type}" at facility ${event.facility_id}` };
  }

  const recipients = await expandRouteRecipients({ client, facilityId: event.facility_id, route, config });
  if (recipients.length === 0) {
    return { skip: `route ${route.id} for "${event.event_type}" resolved with no recipients` };
  }

  const job = buildNotificationJob(event.event_type, route, recipients);
  // Carry the outbox event's id and original payload along so a channel
  // adapter (or a human reading notification_jobs) can trace a delivered
  // notification back to the domain event that produced it, without
  // disturbing the {route_id, priority, channels, recipients} shape every
  // other job producer already relies on.
  job.payload_jsonb = { ...job.payload_jsonb, outbox_event_id: event.id, context: event.payload ?? {} };
  return { job };
}

// Processes one already-claimed (status='processing') outbox event: routed
// events become a notification_jobs row and the outbox row is marked
// 'processed'; unrouteable events are ALSO marked 'processed' (never retried
// forever) with a "skipped: <reason>" note in last_error so an operator can
// see why nothing fired. A genuine error (PostgREST outage, etc.) uses the
// same last_error/next_attempt_at retry bookkeeping as notification_jobs,
// except the terminal state is 'failed' (outbox_events has no 'dead_letter'
// status -- see the file-header note).
async function processOutboxEvent({ client, event, now, config, maxAttempts }) {
  const nowIso = toIso(now);
  try {
    const result = await translateOutboxEvent({ client, event, config });
    if (result.skip) {
      await pgUpdate(
        client,
        "outbox_events",
        { id: event.id },
        { status: "processed", processed_at: nowIso, last_error: `skipped: ${result.skip}` },
        { returning: true }
      );
      return { outcome: "skipped", event, reason: result.skip };
    }

    await pgInsert(client, "notification_jobs", [result.job], { returning: true });
    await pgUpdate(
      client,
      "outbox_events",
      { id: event.id },
      { status: "processed", processed_at: nowIso, last_error: null },
      { returning: true }
    );
    return { outcome: "routed", event, job: result.job };
  } catch (error) {
    const attempts = Number(event.attempts ?? 0) + 1;
    const lastError = error?.message ? String(error.message) : String(error);
    const exhausted = attempts >= maxAttempts;
    const patch = {
      attempts,
      last_error: lastError,
      status: exhausted ? "failed" : "pending",
      next_attempt_at: exhausted ? null : toIso(new Date(now.getTime() + computeBackoffMs(attempts)))
    };
    await pgUpdate(client, "outbox_events", { id: event.id }, patch, { returning: true });
    // OP-20: same fire-and-forget failure report as the notification_jobs
    // path above (handleFailure) -- see its comment for the config.dsn
    // no-op-by-default contract.
    reportError(error, {
      dsn: config.dsn,
      fetchImpl: config.observabilityFetch,
      route: `notifications.worker.outbox/${event.event_type ?? "unknown"}`,
      status: exhausted ? "failed" : "retry",
      requestId: event.id,
      userId: null
    });
    return { outcome: exhausted ? "failed" : "retried", event, error: lastError, attempts };
  }
}

// Composes claimDueOutboxEvents + processOutboxEvent for a single drain pass.
export async function drainOutboxOnce({ client, now = new Date(), limit = 25, config = {} }) {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await claimDueOutboxEvents({ client, now, limit });
  const summary = { claimed: claimed.length, routed: 0, skipped: 0, retried: 0, failed: 0 };

  for (const event of claimed) {
    const result = await processOutboxEvent({ client, event, now, config, maxAttempts });
    if (result.outcome === "routed") summary.routed += 1;
    else if (result.outcome === "skipped") summary.skipped += 1;
    else if (result.outcome === "retried") summary.retried += 1;
    else summary.failed += 1;
  }

  return summary;
}

// One invocation, two queues: drains outbox_events into notification_jobs
// first, then drains notification_jobs for delivery, so an event routed on
// this pass can be delivered on this same pass rather than waiting for the
// next one. Shared by scripts/notifications-worker.mjs (local dev loop) and
// the CRON_SECRET-guarded internal route (src/lib/http/internal-routes.mjs).
export async function drainAll({ client, now = new Date(), limit = 25, config = {} }) {
  const outbox = await drainOutboxOnce({ client, now, limit, config });
  const jobs = await drainOnce({ client, now, limit, config });
  return { outbox, jobs };
}
