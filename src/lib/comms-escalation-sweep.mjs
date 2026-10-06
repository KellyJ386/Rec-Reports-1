// CM-10 (plans/COMMUNICATIONS_PLAN.md) -- required-acknowledgement escalation
// ladder. Runs from the CRON_SECRET-guarded drain (src/lib/http/
// internal-routes.mjs, response key `commsEscalation`) and as a standalone
// script (scripts/comms-escalation-sweep.mjs), exactly like
// work-order-sla-scan.mjs: an injectable service-role client, no HTTP wiring.
//
// What one pass does:
//   1. Selects published, required-ack messages that are READY: their stored
//      next-look time (messages.ack_next_escalation_at, 0064) has passed and
//      their recorded ladder level (messages.ack_escalation_level) is below the
//      maximum (3). Selecting by readiness rather than by the oldest due date is
//      what keeps one tenant from starving the others (M-5): a message the pass
//      skips -- escalation switched off for its facility, or waiting out the
//      gap before its next tier -- is pushed to the instant it can next matter,
//      so it leaves the candidate set instead of occupying one of its slots on
//      every pass. A pass keeps reading pages until it has processed `limit`
//      messages or the ready set is exhausted (bounded by MAX_SCAN).
//   2. For each, resolves the facility's effective communications config
//      (communications.ackEscalationEnabled and the three
//      ack*AfterHours offsets) and asks the pure ladder
//      (communications.mjs nextAckEscalationStep) which single tier is next.
//      The ladder is anchored on the later of the message's due time and its
//      publish time (L-1):
//        level 1 "reminder"   -> the audience members who have not acked,
//        level 2 "supervisor" -> the facility's message.ack_escalated_supervisor
//                                 route's distribution list,
//        level 3 "manager"    -> the message.ack_escalated_manager route's list.
//      One tier per message per pass, never skipping a level, so each level
//      gets its own event after an outage.
//   3. CLAIMS the tier -- a conditional UPDATE moving ack_escalation_level
//      from N-1 to N (stamping ack_escalated_at and the time the next tier
//      comes due) -- BEFORE any side effect, so a concurrent sweep that lost the
//      race matches zero rows and skips. This is the only writer of those
//      columns (0064's trigger rejects every authenticated session).
//   4. Enqueues ONE notification_jobs row per (message, level), carrying the
//      resolved recipients, with a dedupe_key the 0064 trigger recomputes
//      server-side from (facility, event, messageId, escalationLevel) --
//      inserted with ignore-duplicates, so a retried tier never double-sends.
//      payload.quietHoursBypass is true for an EMERGENCY message only (L-1):
//      an overdue acknowledgement is not time-critical, so an urgent message's
//      reminder waits out the facility's quiet hours in the worker. When the
//      insert is deduped (0 rows), the existing row is checked to be this
//      tier's own job (same facility, event, message, level, not cancelled); a
//      row this sweep did not create holding the key is an error and the claim
//      is reverted (M-1) -- the tier is never recorded as sent on the strength
//      of a foreign row.
//   5. Records the tier in message_escalation_events (append-only, UNIQUE
//      (message_id, level)) -- the permanent record and the second
//      idempotency gate.
//
// Failure isolation (the work-order-sla-scan M-3 discipline): every candidate
// runs in its own try/catch. A failure of the claim itself aborts only that
// candidate; a failure AFTER a successful claim (audience/route resolution,
// the job insert, the event insert) reverts the claim -- compare-and-set on
// the exact (level, ack_escalated_at) this call stamped -- and is recorded in
// summary.errors, so a later pass retries the tier instead of the row being
// stamped with nothing sent. The reverted row is queued ERROR_RETRY_MS ahead,
// not for the very next pass, so a message that fails persistently cannot
// occupy the pass's slots forever. Because the job insert is idempotent on its
// dedupe_key, a retry after a late failure (the job landed, the event row did
// not) cannot send twice.
import { pgSelect, pgInsert, pgUpdate } from "./supabase-rest.mjs";
import { buildNotificationJob } from "./admin/notifications.mjs";
import { loadActiveRoute, expandRouteRecipients } from "./notifications/worker.mjs";
import { makeConfigLoader } from "./http/module-config.mjs";
import { configValue } from "./settings-registry.mjs";
import {
  MAX_ACK_ESCALATION_LEVEL,
  ackEscalationNextDueAt,
  buildAckEscalationLadder,
  channelsForPriority,
  nextAckEscalationStep,
  outstandingAckEmployeeIds,
  resolveMessageAudience,
  shouldBypassQuietHoursForEscalation
} from "./communications.mjs";
import { loadAudienceResolutionContext, resolutionContextFrom } from "./communications-audience.mjs";

const MESSAGE_COLUMNS =
  "id,facility_id,channel_id,subject,priority,is_required_ack,ack_due_at,published_at,ack_escalation_level,ack_escalated_at,ack_next_escalation_at";
const AUDIENCE_COLUMNS = "id,facility_id,message_id,audience_type,audience_ref_id,rule_jsonb";
const MAX_LISTED_EMPLOYEES = 50;
const HOUR_MS = 3_600_000;
// A message of a facility whose escalation is switched off is looked at again
// after this long (so switching it back on takes effect within the hour).
const DISABLED_RECHECK_MS = HOUR_MS;
// A message whose tier failed after the claim is retried this long after the
// failure, so a persistent failure cannot occupy the pass's slots every pass.
const ERROR_RETRY_MS = 5 * 60_000;
// Most distinct messages one pass will examine, however many it skips.
const MAX_SCAN = 1000;
const MAX_PAGE = 200;
// Ids per deferral write (a PostgREST in.(...) list rides in the URL).
const DEFER_BATCH = 100;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// The key the 0064 trigger will recompute for this row; computed here too so
// the event row records it and a reader can correlate the two.
export function ackEscalationDedupeKey(facilityId, eventCode, messageId, level) {
  return `${facilityId}:${eventCode}:${messageId}:${level}`;
}

// The messages whose next-look time has come, oldest first (M-5).
async function selectReadyCandidates(client, now, pageSize) {
  const rows = await pgSelect(client, "messages", {
    filters: {
      is_required_ack: true,
      ack_next_escalation_at: { lte: toIso(now) },
      ack_escalation_level: { lt: MAX_ACK_ESCALATION_LEVEL }
    },
    select: MESSAGE_COLUMNS,
    order: "ack_next_escalation_at.asc",
    limit: pageSize,
    extra: {
      published_at: "not.is.null",
      deleted_at: "is.null"
    }
  });
  return rows ?? [];
}

// Race-safe CAS claim: only moves the level if it still holds the value this
// pass read. A concurrent pass's loser UPDATE matches zero rows. The same
// write queues the message for the instant its next tier comes due.
async function claimTier(client, message, level, nowIso, nextLookIso) {
  const updated = await pgUpdate(
    client,
    "messages",
    { id: message.id, ack_escalation_level: Number(message.ack_escalation_level ?? 0) },
    { ack_escalation_level: level, ack_escalated_at: nowIso, ack_next_escalation_at: nextLookIso },
    { returning: true }
  );
  return (updated ?? [])[0] ?? null;
}

// Reverts a claim, compare-and-set on the exact value this call stamped: a row
// that has since moved on (another pass advanced it) is left alone. The row is
// queued for a retry ERROR_RETRY_MS from now.
async function revertTier(client, message, level, nowIso, retryIso) {
  await pgUpdate(
    client,
    "messages",
    { id: message.id, ack_escalation_level: level },
    {
      ack_escalation_level: Number(message.ack_escalation_level ?? 0),
      ack_escalated_at: message.ack_escalated_at ?? null,
      ack_next_escalation_at: retryIso
    },
    { extra: { ack_escalated_at: `eq.${nowIso}` } }
  );
}

// Pushes messages the pass is NOT going to act on out of the candidate set.
// `ids` of one deferral instant go in one write; the level guard (when given)
// keeps a concurrent claim's own queue time from being overwritten.
async function deferMessages(client, ids, untilIso, level = null) {
  for (let offset = 0; offset < ids.length; offset += DEFER_BATCH) {
    const chunk = ids.slice(offset, offset + DEFER_BATCH);
    const filters = chunk.length === 1 ? { id: chunk[0] } : { id: { in: chunk } };
    if (level !== null) filters.ack_escalation_level = level;
    await pgUpdate(client, "messages", filters, { ack_next_escalation_at: untilIso }, { returning: false });
  }
}

// M-1: after a deduped insert, the row holding the key must be this tier's own
// job. 0064 stops a client from holding a (message, level) key at all, so this
// is the sweep's own check that it is not about to record a tier as sent on the
// strength of somebody else's row.
async function dedupedJobIsOurs(client, message, step, dedupeKey) {
  const rows =
    (await pgSelect(client, "notification_jobs", {
      filters: { dedupe_key: dedupeKey },
      select: "id,facility_id,event_type,status,payload_jsonb",
      limit: 1
    })) ?? [];
  const existing = rows[0];
  if (!existing) return false;
  const payload = existing.payload_jsonb ?? {};
  return (
    existing.facility_id === message.facility_id &&
    existing.event_type === step.eventCode &&
    existing.status !== "cancelled" &&
    payload.messageId === message.id &&
    Number(payload.escalationLevel) === step.level &&
    payload.tier === step.tier
  );
}

function tierCopy(step, message, outstandingCount) {
  const subject = String(message.subject ?? "").slice(0, 200);
  const due = message.ack_due_at ? new Date(message.ack_due_at).toISOString() : "";
  if (step.level === 1) {
    return {
      title: `Acknowledgement overdue: ${subject}`,
      body: `Please acknowledge "${subject}" -- it was due ${due}.`
    };
  }
  const who = outstandingCount === 1 ? "1 recipient has" : `${outstandingCount} recipients have`;
  return {
    title: `${step.level === 3 ? "Manager escalation" : "Supervisor alert"}: overdue acknowledgements for ${subject}`,
    body: `${who} not acknowledged "${subject}" (due ${due}).`
  };
}

// sweepAckEscalations(client, { now, limit, loadConfig }) -> summary.
//
// `loadConfig({ facilityId, moduleCode })` resolves a facility's effective
// module config (defaults to module-config.mjs's makeConfigLoader over the
// same client, which degrades to {} -- registry defaults -- on any lookup
// failure and memoizes per facility for the pass). `limit` is the number of
// messages one pass will act on (claim a tier for).
export async function sweepAckEscalations(client, { now = new Date(), limit = 25, loadConfig = null } = {}) {
  const summary = {
    scanned: 0,
    claimed: 0,
    escalated: 0,
    byLevel: { 1: 0, 2: 0, 3: 0 },
    jobsEnqueued: 0,
    deduped: 0,
    noOutstanding: 0,
    noRecipients: 0,
    disabled: 0,
    waiting: 0,
    raced: 0,
    errors: []
  };
  const nowIso = toIso(now);
  const configFor = loadConfig ?? makeConfigLoader(client);
  const maxActions = Math.max(limit, 1);

  const routeCache = new Map(); // `${facilityId}:${eventCode}` -> Promise<{route, recipients}>
  function routeFor(facilityId, eventCode) {
    const key = `${facilityId}:${eventCode}`;
    if (!routeCache.has(key)) {
      routeCache.set(
        key,
        (async () => {
          const route = await loadActiveRoute({ client, facilityId, eventCode });
          const recipients = route ? await expandRouteRecipients({ client, facilityId, route, config: {} }) : [];
          return { route, recipients };
        })()
      );
    }
    return routeCache.get(key);
  }

  // Messages this pass skips are pushed out of the candidate set (M-5). Writes
  // are collected per instant and per kind and flushed after each page; a
  // failed deferral is recorded and never aborts the pass.
  let deferrals = new Map(); // `${untilIso}|${level ?? ""}` -> { untilIso, level, ids }
  function defer(message, until, { guardLevel = false } = {}) {
    const untilIso = toIso(until);
    const level = guardLevel ? Number(message.ack_escalation_level ?? 0) : null;
    const key = `${untilIso}|${level ?? ""}`;
    if (!deferrals.has(key)) deferrals.set(key, { untilIso, level, ids: [] });
    deferrals.get(key).ids.push(message.id);
  }
  async function flushDeferrals() {
    const pending = [...deferrals.values()];
    deferrals = new Map();
    for (const { untilIso, level, ids } of pending) {
      try {
        await deferMessages(client, ids, untilIso, level);
      } catch (error) {
        summary.errors.push({ messageId: ids[0], level: null, stage: "defer", error: error.message });
      }
    }
  }

  const seen = new Set();
  let processed = 0;
  let pageSize = Math.min(maxActions * 4, MAX_PAGE);

  while (processed < maxActions && seen.size < MAX_SCAN) {
    const ready = await selectReadyCandidates(client, now, pageSize);
    const fresh = ready.filter((message) => !seen.has(message.id));
    if (fresh.length === 0) {
      // Nothing new: either the ready set is exhausted, or the page is full of
      // messages this pass already handled that stay ready (a tier that is due
      // again immediately). Widen the window once more before giving up.
      if (ready.length < pageSize || pageSize >= MAX_SCAN) break;
      pageSize = Math.min(pageSize * 2, MAX_SCAN);
      continue;
    }

    for (const message of fresh) {
      if (processed >= maxActions) break;
      seen.add(message.id);
      summary.scanned += 1;

      let step;
      let ladder;
      try {
        const facilityConfig = (await configFor({ facilityId: message.facility_id, moduleCode: "communications" })) ?? {};
        if (configValue(facilityConfig, "communications.ackEscalationEnabled") === false) {
          summary.disabled += 1;
          defer(message, new Date(now.getTime() + DISABLED_RECHECK_MS));
          continue;
        }
        ladder = buildAckEscalationLadder(facilityConfig);
        step = nextAckEscalationStep(message, now, ladder);
      } catch (error) {
        summary.errors.push({ messageId: message.id, level: null, stage: "config", error: error.message });
        defer(message, new Date(now.getTime() + ERROR_RETRY_MS));
        continue;
      }
      if (!step) {
        // Not yet due for its next tier: look at it again when it is.
        summary.waiting += 1;
        const nextDue = ackEscalationNextDueAt(message, ladder);
        defer(message, nextDue && nextDue.getTime() > now.getTime() ? nextDue : new Date(now.getTime() + DISABLED_RECHECK_MS), {
          guardLevel: true
        });
        continue;
      }
      processed += 1;

      const nextLook = ackEscalationNextDueAt(message, ladder, step.level);
      let claimed;
      try {
        claimed = await claimTier(client, message, step.level, nowIso, nextLook ? toIso(nextLook) : null);
      } catch (error) {
        summary.errors.push({ messageId: message.id, level: step.level, stage: "claim", error: error.message });
        continue;
      }
      if (!claimed) {
        summary.raced += 1; // lost the race to a concurrent sweep -- skip.
        continue;
      }
      summary.claimed += 1;

      try {
        // Who is still outstanding. Shift windows are evaluated at the message's
        // own published_at so the audience matches what the publish snapshot saw.
        const publishedAt = new Date(message.published_at);
        const audiences =
          (await pgSelect(client, "message_audiences", {
            filters: { message_id: message.id },
            select: AUDIENCE_COLUMNS,
            extra: { deleted_at: "is.null" }
          })) ?? [];
        const loaded = await loadAudienceResolutionContext(client, message.facility_id, audiences, { now: publishedAt });
        const audienceIds = resolveMessageAudience(
          { audiences: loaded.resolvableAudiences },
          resolutionContextFrom(loaded, publishedAt)
        );
        const acks =
          (await pgSelect(client, "message_acknowledgements", {
            filters: { message_id: message.id },
            select: "employee_id,ack_state,acknowledged_at"
          })) ?? [];
        const outstanding = outstandingAckEmployeeIds(audienceIds, acks);

        const { route, recipients: routeRecipients } = await routeFor(message.facility_id, step.eventCode);
        const recipients = step.level === 1 ? outstanding : routeRecipients;
        const bypass = shouldBypassQuietHoursForEscalation(message);

        const dedupeKey = ackEscalationDedupeKey(message.facility_id, step.eventCode, message.id, step.level);
        let jobEnqueued = false;
        let deduped = false;
        if (outstanding.length === 0) {
          summary.noOutstanding += 1;
        } else if (recipients.length === 0) {
          summary.noRecipients += 1;
        } else {
          const base = buildNotificationJob(step.eventCode, route ?? { facility_id: message.facility_id }, recipients);
          const channels = base.payload_jsonb.channels.length > 0 ? base.payload_jsonb.channels : channelsForPriority(message.priority);
          const copy = tierCopy(step, message, outstanding.length);
          const job = {
            ...base,
            facility_id: message.facility_id,
            status: "pending",
            scheduled_for: nowIso,
            dedupe_key: dedupeKey,
            payload_jsonb: {
              ...base.payload_jsonb,
              channels,
              recipients,
              messageId: message.id,
              escalationLevel: step.level,
              tier: step.tier,
              quietHoursBypass: bypass,
              outstandingCount: outstanding.length,
              outstandingEmployeeIds: outstanding.slice(0, MAX_LISTED_EMPLOYEES),
              ...copy
            }
          };
          const inserted = await pgInsert(client, "notification_jobs", [job], {
            onConflict: "dedupe_key",
            ignoreDuplicates: true,
            returning: true
          });
          if ((inserted ?? []).length > 0) {
            jobEnqueued = true;
            summary.jobsEnqueued += 1;
          } else {
            // Deduped: only a retry of this very tier (the job landed on an
            // earlier attempt, the ledger row did not) is acceptable. A row this
            // sweep did not create holding the key would silently suppress the
            // escalation, so it is an error and the claim is reverted (M-1).
            if (!(await dedupedJobIsOurs(client, message, step, dedupeKey))) {
              throw new Error(`dedupe key ${dedupeKey} is held by a job this sweep did not create`);
            }
            deduped = true;
            summary.deduped += 1;
          }
        }

        await pgInsert(
          client,
          "message_escalation_events",
          [
            {
              facility_id: message.facility_id,
              message_id: message.id,
              level: step.level,
              tier: step.tier,
              event_code: step.eventCode,
              recipient_count: jobEnqueued || deduped ? recipients.length : 0,
              dedupe_key: dedupeKey,
              details_jsonb: {
                outstanding: outstanding.length,
                routeId: route?.id ?? null,
                jobEnqueued,
                deduped,
                quietHoursBypass: bypass
              }
            }
          ],
          { onConflict: "message_id,level", ignoreDuplicates: true, returning: true }
        );

        summary.escalated += 1;
        summary.byLevel[step.level] += 1;
      } catch (error) {
        summary.claimed -= 1;
        summary.errors.push({ messageId: message.id, level: step.level, stage: "notify", error: error.message });
        try {
          await revertTier(client, message, step.level, nowIso, toIso(new Date(now.getTime() + ERROR_RETRY_MS)));
        } catch (revertError) {
          summary.errors.push({ messageId: message.id, level: step.level, stage: "revert", error: revertError.message });
        }
      }
    }
    await flushDeferrals();
  }
  await flushDeferrals();

  return summary;
}
