// CM-10 (plans/COMMUNICATIONS_PLAN.md) -- required-acknowledgement escalation
// ladder. Runs from the CRON_SECRET-guarded drain (src/lib/http/
// internal-routes.mjs, response key `commsEscalation`) and as a standalone
// script (scripts/comms-escalation-sweep.mjs), exactly like
// work-order-sla-scan.mjs: an injectable service-role client, no HTTP wiring.
//
// What one pass does:
//   1. Selects published, required-ack messages whose ack_due_at has passed
//      and whose recorded ladder level (messages.ack_escalation_level, 0064)
//      is below the maximum (3).
//   2. For each, resolves the facility's effective communications config
//      (communications.ackEscalationEnabled and the three
//      ack*AfterHours offsets) and asks the pure ladder
//      (communications.mjs nextAckEscalationStep) which single tier is next:
//        level 1 "reminder"   -> the audience members who have not acked,
//        level 2 "supervisor" -> the facility's message.ack_escalated_supervisor
//                                 route's distribution list,
//        level 3 "manager"    -> the message.ack_escalated_manager route's list.
//      One tier per message per pass, never skipping a level, so each level
//      gets its own event after an outage.
//   3. CLAIMS the tier -- a conditional UPDATE moving ack_escalation_level
//      from N-1 to N (and stamping ack_escalated_at) -- BEFORE any side
//      effect, so a concurrent sweep that lost the race matches zero rows and
//      skips. This is the only writer of those two columns (0064's trigger
//      rejects every authenticated session).
//   4. Enqueues ONE notification_jobs row per (message, level), carrying the
//      resolved recipients, with a dedupe_key the 0064 trigger recomputes
//      server-side from (facility, event, messageId, escalationLevel) --
//      inserted with ignore-duplicates, so a retried tier never double-sends.
//      payload.quietHoursBypass is shouldBypassQuietHours(message) (urgent /
//      emergency only): an ordinary message's reminder waits out the
//      facility's quiet hours in the worker, an emergency one does not.
//   5. Records the tier in message_escalation_events (append-only, UNIQUE
//      (message_id, level)) -- the permanent record and the second
//      idempotency gate.
//
// Failure isolation (the work-order-sla-scan M-3 discipline): every candidate
// runs in its own try/catch. A failure of the claim itself aborts only that
// candidate; a failure AFTER a successful claim (audience/route resolution,
// the job insert, the event insert) reverts the claim -- compare-and-set on
// the exact (level, ack_escalated_at) this call stamped -- and is recorded in
// summary.errors, so the next pass retries the tier instead of the row being
// stamped with nothing sent. Because the job insert is idempotent on its
// dedupe_key, a retry after a late failure (the job landed, the event row did
// not) cannot send twice.
import { pgSelect, pgInsert, pgUpdate } from "./supabase-rest.mjs";
import { buildNotificationJob } from "./admin/notifications.mjs";
import { loadActiveRoute, expandRouteRecipients } from "./notifications/worker.mjs";
import { makeConfigLoader } from "./http/module-config.mjs";
import { configValue } from "./settings-registry.mjs";
import {
  MAX_ACK_ESCALATION_LEVEL,
  buildAckEscalationLadder,
  channelsForPriority,
  nextAckEscalationStep,
  outstandingAckEmployeeIds,
  resolveMessageAudience,
  shouldBypassQuietHours
} from "./communications.mjs";
import { loadAudienceResolutionContext, resolutionContextFrom } from "./communications-audience.mjs";

const MESSAGE_COLUMNS =
  "id,facility_id,channel_id,subject,priority,is_required_ack,ack_due_at,published_at,ack_escalation_level,ack_escalated_at";
const AUDIENCE_COLUMNS = "id,facility_id,message_id,audience_type,audience_ref_id,rule_jsonb";
const MAX_LISTED_EMPLOYEES = 50;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// The key the 0064 trigger will recompute for this row; computed here too so
// the event row records it and a reader can correlate the two.
export function ackEscalationDedupeKey(facilityId, eventCode, messageId, level) {
  return `${facilityId}:${eventCode}:${messageId}:${level}`;
}

async function selectCandidates(client, now, limit) {
  const rows = await pgSelect(client, "messages", {
    filters: { is_required_ack: true },
    select: MESSAGE_COLUMNS,
    order: "ack_due_at.asc",
    limit,
    extra: {
      published_at: "not.is.null",
      deleted_at: "is.null",
      ack_due_at: `lt.${toIso(now)}`,
      ack_escalation_level: `lt.${MAX_ACK_ESCALATION_LEVEL}`
    }
  });
  return rows ?? [];
}

// Race-safe CAS claim: only moves the level if it still holds the value this
// pass read. A concurrent pass's loser UPDATE matches zero rows.
async function claimTier(client, message, level, nowIso) {
  const updated = await pgUpdate(
    client,
    "messages",
    { id: message.id, ack_escalation_level: Number(message.ack_escalation_level ?? 0) },
    { ack_escalation_level: level, ack_escalated_at: nowIso },
    { returning: true }
  );
  return (updated ?? [])[0] ?? null;
}

// Reverts a claim, compare-and-set on the exact value this call stamped: a row
// that has since moved on (another pass advanced it) is left alone.
async function revertTier(client, message, level, nowIso) {
  await pgUpdate(
    client,
    "messages",
    { id: message.id, ack_escalation_level: level },
    { ack_escalation_level: Number(message.ack_escalation_level ?? 0), ack_escalated_at: message.ack_escalated_at ?? null },
    { extra: { ack_escalated_at: `eq.${nowIso}` } }
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
// failure and memoizes per facility for the pass).
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
    raced: 0,
    errors: []
  };
  const nowIso = toIso(now);
  const configFor = loadConfig ?? makeConfigLoader(client);

  const candidates = await selectCandidates(client, now, Math.min(Math.max(limit, 1) * 4, 400));
  summary.scanned = candidates.length;

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

  let processed = 0;
  for (const message of candidates) {
    if (processed >= limit) break;

    let step;
    try {
      const facilityConfig = (await configFor({ facilityId: message.facility_id, moduleCode: "communications" })) ?? {};
      if (configValue(facilityConfig, "communications.ackEscalationEnabled") === false) {
        summary.disabled += 1;
        continue;
      }
      step = nextAckEscalationStep(message, now, buildAckEscalationLadder(facilityConfig));
    } catch (error) {
      summary.errors.push({ messageId: message.id, level: null, stage: "config", error: error.message });
      continue;
    }
    if (!step) continue; // not yet due for its next tier
    processed += 1;

    let claimed;
    try {
      claimed = await claimTier(client, message, step.level, nowIso);
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
            quietHoursBypass: shouldBypassQuietHours(message),
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
              quietHoursBypass: shouldBypassQuietHours(message)
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
        await revertTier(client, message, step.level, nowIso);
      } catch (revertError) {
        summary.errors.push({ messageId: message.id, level: step.level, stage: "revert", error: revertError.message });
      }
    }
  }

  return summary;
}
