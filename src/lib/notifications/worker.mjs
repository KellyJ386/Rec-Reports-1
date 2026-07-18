// Pure, unit-testable logic for the notification delivery worker. No I/O
// here -- scripts/notification-worker.mjs loads due notification_jobs rows
// (0006), calls into these functions, and does the actual Postgres/transport
// I/O itself, so every function below is a deterministic transform that
// node:test can exercise directly. Never call Date.now()/new Date() with no
// arguments here -- callers always pass the current time in as an ISO string
// so tests stay deterministic.
//
// notification_jobs columns (0006_communications.sql): id, facility_id,
// event_type, payload_jsonb, scheduled_for, status
// (pending/processing/sent/failed/cancelled), attempts, created_at, updated_at.
// notification_deliveries columns: id, facility_id, job_id, employee_id,
// channel (in_app/email/sms/push), status (queued/sent/failed/bounced),
// sent_at, provider_message_id, created_at.
//
// The outbox_events table (0002_daily_reports.sql: status/attempts/
// available_at) uses the same "due row" shape as notification_jobs
// (status/attempts/scheduled_for) and informed the backoff design here, but
// this module only drains notification_jobs -- outbox_events has its own
// consumers elsewhere.

import { resolveRoute, expandDistributionList, isWithinQuietHours } from "../admin/notifications.mjs";

export const CHANNELS = Object.freeze(["in_app", "email", "sms", "push"]);
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_BACKOFF_SECONDS = 60;
export const DEFAULT_MAX_BACKOFF_SECONDS = 3600;

// Exponential backoff: base seconds, doubling on each attempt, capped at
// maxSeconds. attempts=1 (the first failure) schedules the retry base
// seconds out; attempts=2 doubles that; and so on. Returns an ISO timestamp
// string derived from nowIso -- the current time is always supplied by the
// caller, never read from the clock in here.
export function nextAttemptAt(attempts, nowIso, opts = {}) {
  const base = Number.isFinite(opts.baseSeconds) ? opts.baseSeconds : DEFAULT_BASE_BACKOFF_SECONDS;
  const cap = Number.isFinite(opts.maxSeconds) ? opts.maxSeconds : DEFAULT_MAX_BACKOFF_SECONDS;
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error("nextAttemptAt requires a valid ISO timestamp");
  }
  const attemptCount = Math.max(0, Math.trunc(Number(attempts) || 0));
  const exponent = Math.max(0, attemptCount - 1);
  const delaySeconds = Math.min(cap, base * 2 ** exponent);
  return new Date(now.getTime() + delaySeconds * 1000).toISOString();
}

// True once a job has used up its attempt budget and should stop retrying.
export function shouldDeadLetter(attempts, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const attemptCount = Math.max(0, Math.trunc(Number(attempts) || 0));
  const limit = Math.max(1, Math.trunc(Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS));
  return attemptCount >= limit;
}

function localHHMM(nowIso, timeZone) {
  if (typeof nowIso !== "string") return null;
  const date = new Date(nowIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  } catch {
    return null;
  }
}

function normalizeChannel(channel) {
  return typeof channel === "string" && CHANNELS.includes(channel) ? channel : null;
}

// Resolves the delivery target for a channel. in_app deliveries target the
// employee id directly (notification_deliveries.employee_id); other channels
// look the employee up in an optional `contacts` map ({ [employeeId]: {
// email, phone, pushToken } }) supplied by the caller. No target is invented
// when contact info is missing -- the worker treats a null target as an
// immediate delivery failure so the job retries/dead-letters normally rather
// than silently dropping the recipient.
function resolveTarget(employeeId, channel, contacts) {
  if (channel === "in_app") return employeeId ?? null;
  const contact = contacts?.[employeeId];
  if (!contact) return null;
  if (channel === "email") return contact.email ?? null;
  if (channel === "sms") return contact.phone ?? null;
  if (channel === "push") return contact.pushToken ?? contact.push_token ?? null;
  return null;
}

// Builds an execution plan for a due notification_jobs row: which
// (channel, employeeId, target) deliveries to attempt, and whether the job
// should be deferred (left pending, untouched attempts) because it falls
// inside quiet hours. Defensive throughout -- a malformed/partial payload
// degrades to an empty plan rather than throwing.
//
// context:
//   now             - required ISO timestamp for quiet-hours evaluation.
//   timeZone        - IANA zone for quiet-hours evaluation (default UTC).
//   quietStart/End  - "HH:MM" overrides; default to the settings-registry
//                      quiet-hours window via isWithinQuietHours.
//   contacts        - { [employeeId]: { email, phone, pushToken } }.
//   routes, distributionLists, distributionListMembers, employees,
//   roleAssignments - fallback inputs used to (re)resolve channels/recipients
//                      via resolveRoute/expandDistributionList when the job's
//                      payload didn't already carry a resolved recipient list
//                      (buildNotificationJob normally resolves these up
//                      front, so this path is a defensive fallback).
export function planJob(job, context = {}) {
  const {
    now,
    timeZone,
    quietStart,
    quietEnd,
    contacts = {},
    routes = [],
    distributionLists = [],
    distributionListMembers = [],
    employees = [],
    roleAssignments = []
  } = context;

  const payload = job?.payload_jsonb ?? {};
  let channels = Array.isArray(payload.channels) ? payload.channels.map(normalizeChannel).filter(Boolean) : [];
  let recipients = Array.isArray(payload.recipients) ? payload.recipients.filter(Boolean) : [];

  if (recipients.length === 0 && payload.route_id) {
    const route = resolveRoute(job?.event_type, routes);
    if (route) {
      if (channels.length === 0 && Array.isArray(route.route_jsonb?.channels)) {
        channels = route.route_jsonb.channels.map(normalizeChannel).filter(Boolean);
      }
      const listId = route.route_jsonb?.distribution_list_id ?? null;
      const list = (distributionLists ?? []).find((entry) => entry?.id === listId) ?? null;
      if (list) {
        recipients = expandDistributionList(list, distributionListMembers, { employees, roleAssignments });
      }
    }
  }

  if (channels.length === 0) channels = ["in_app"];

  const priority = typeof payload.priority === "string" ? payload.priority : "normal";
  const bypassQuietHours = payload.bypassQuietHours === true || priority === "urgent" || priority === "emergency";
  const localTime = localHHMM(now, timeZone);
  const withinQuietHours = !bypassQuietHours && isWithinQuietHours(localTime, quietStart, quietEnd);

  const deliveries = [];
  if (!withinQuietHours) {
    for (const channel of channels) {
      for (const employeeId of recipients) {
        deliveries.push({
          channel,
          employeeId,
          target: resolveTarget(employeeId, channel, contacts)
        });
      }
    }
  }

  return {
    jobId: job?.id ?? null,
    facilityId: job?.facility_id ?? null,
    eventType: job?.event_type ?? null,
    channels,
    recipients,
    withinQuietHours,
    deferred: withinQuietHours,
    deliveries
  };
}

// Given the outcome of attempting a job's deliveries, returns the next
// notification_jobs state to persist: { status, attempts, nextAttemptAt,
// deadLettered }. attempts/maxAttempts describe the job BEFORE this attempt;
// the returned attempts is the post-attempt count to write back. `now` is
// required whenever the outcome is a retryable failure (it feeds
// nextAttemptAt); success and dead-letter paths never need it.
export function classifyResult({ ok, error } = {}, { attempts = 0, maxAttempts = DEFAULT_MAX_ATTEMPTS, now } = {}) {
  const attemptsAfter = Math.max(0, Math.trunc(Number(attempts) || 0)) + 1;

  if (ok) {
    return { status: "sent", attempts: attemptsAfter, nextAttemptAt: null, deadLettered: false };
  }

  if (shouldDeadLetter(attemptsAfter, maxAttempts)) {
    return { status: "failed", attempts: attemptsAfter, nextAttemptAt: null, deadLettered: true, error: error ?? null };
  }

  return {
    status: "pending",
    attempts: attemptsAfter,
    nextAttemptAt: nextAttemptAt(attemptsAfter, now),
    deadLettered: false,
    error: error ?? null
  };
}
