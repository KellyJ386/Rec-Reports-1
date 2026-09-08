// IN-21: SLA breach auto-escalation sweep. Runs from the same CRON_SECRET-
// guarded drain cron entry point every other periodic sweep in this codebase
// uses (src/lib/http/internal-routes.mjs's handleDrain, response key
// "incidentSla") and as a standalone local-dev loop
// (scripts/incident-sla-sweep.mjs, same shape as scripts/notifications-worker.mjs).
//
// Two layers, matching this codebase's "pure decision function + I/O
// orchestrator" convention (incidents.mjs's canTransitionIncident /
// incidents-routes.mjs is the model this follows):
//   - decideEscalationSweep: pure. Given one incident_escalations row, its
//     parent incident_reports row, `now`, and `config`, decides whether the
//     escalation should be expired and/or should spawn a next-level
//     escalation, capped by the incidents.maxEscalationLevel setting
//     (settings-registry.mjs).
//   - sweepIncidentEscalations: the I/O orchestrator. Loads overdue pending
//     escalations (service-role client, RLS bypassed -- same shape as
//     notifications/worker.mjs's claimDueJobs/claimDueOutboxEvents), applies
//     the pure decision to each, and performs the writes: expire
//     (pending -> expired, race-safe via a conditional UPDATE), create the
//     next-level escalation row, write an incident_audit_events row, and
//     emit IN-20 notification_jobs for "incident.sla_breached" via the same
//     buildIncidentNotificationJobs + ignoreDuplicates path
//     incidents-routes.mjs uses for submit/escalate.
//
// Idempotent per run: expiring an escalation is a conditional UPDATE
// (`WHERE status = 'pending'`, matching this row's already-loaded state) --
// a second concurrent/re-entrant sweep that raced this one and already
// flipped the row gets back zero updated rows and skips creating a next-
// level escalation for it, so a next-level row is never created twice for
// the same overdue escalation. notification_jobs' dedupe_key closes the
// remaining gap (a next-level escalation created twice across separate runs
// -- which the conditional UPDATE above already prevents in practice --
// would otherwise be able to double-enqueue a notification).
import { pgSelect, pgUpdate, pgInsert } from "./supabase-rest.mjs";
import { nextEscalationLevel, buildIncidentAuditEvent, buildIncidentNotificationJobs } from "./incidents.mjs";
import { configValue } from "./settings-registry.mjs";
import { loadActiveRoute, expandRouteRecipients } from "./notifications/worker.mjs";

const ESCALATION_COLUMNS =
  "id,facility_id,incident_id,escalation_level,reason_code,target_role,target_user_id,status,due_at,acknowledged_at,created_at,updated_at";
const INCIDENT_COLUMNS = "id,facility_id,status,severity,legal_hold";

const NOTIFICATION_EVENT_CODE = "incident.sla_breached";

// Pure. Returns { expire, createNext, nextLevel, reason }:
//   - expire: true when this pending escalation is now overdue and should
//     transition to 'expired'. false (with the other fields also false/null)
//     when the row isn't a candidate at all (not pending, or not yet due).
//   - createNext: true when a new escalation row at `nextLevel` should be
//     created. Always false when expire is false. When expire is true but
//     createNext is false, `reason` names why escalation stops here
//     (the incident already closed, or the level cap is reached).
//   - nextLevel: the level the new escalation would carry (always computed
//     once expire is true, even when createNext ends up false, so callers
//     can report "would have escalated to N but the cap stopped it").
export function decideEscalationSweep(escalation, incident, now = new Date(), config = {}) {
  if (!escalation || escalation.status !== "pending") {
    return { expire: false, createNext: false, nextLevel: null, reason: "not_pending" };
  }
  const dueAt = escalation.due_at ? new Date(escalation.due_at) : null;
  if (!dueAt || Number.isNaN(dueAt.getTime()) || !(now > dueAt)) {
    return { expire: false, createNext: false, nextLevel: null, reason: "not_overdue" };
  }

  const nextLevel = nextEscalationLevel(escalation.escalation_level);

  if (!incident) {
    return { expire: true, createNext: false, nextLevel, reason: "incident_not_found" };
  }
  if (incident.status === "closed") {
    return { expire: true, createNext: false, nextLevel, reason: "incident_closed" };
  }

  const maxLevel = configValue(config, "incidents.maxEscalationLevel");
  if (nextLevel > maxLevel) {
    return { expire: true, createNext: false, nextLevel, reason: "max_level_reached" };
  }

  return { expire: true, createNext: true, nextLevel, reason: "sla_breach" };
}

// I/O orchestrator. `client` is a service-role client (this must see and
// write every facility's escalations, not just one caller's, matching every
// other sweep/drain function in this codebase). `now`/`limit`/`config`
// mirror notifications/worker.mjs's drainOnce signature.
export async function sweepIncidentEscalations(client, { now = new Date(), limit = 25, config = {} } = {}) {
  const summary = { processed: 0, expired: 0, escalated: 0, capped: 0, notified: 0, raced: 0 };

  const escalations = await pgSelect(client, "incident_escalations", {
    filters: { status: "pending", due_at: { lt: now.toISOString() } },
    select: ESCALATION_COLUMNS,
    order: "due_at.asc",
    limit
  });
  if (!escalations || escalations.length === 0) return summary;

  const incidentIds = [...new Set(escalations.map((row) => row.incident_id))];
  const incidents = await pgSelect(client, "incident_reports", {
    filters: { id: { in: incidentIds } },
    select: INCIDENT_COLUMNS
  });
  const incidentsById = new Map((incidents ?? []).map((incident) => [incident.id, incident]));

  for (const escalation of escalations) {
    const incident = incidentsById.get(escalation.incident_id) ?? null;
    const decision = decideEscalationSweep(escalation, incident, now, config);
    if (!decision.expire) continue;
    summary.processed += 1;

    // Race-safe expire: only flips a row still 'pending' (its already-loaded
    // state), so a concurrent sweep (or a human acknowledging the escalation
    // between the SELECT above and this UPDATE) is never overwritten, and
    // this run never double-processes a row another run already claimed.
    const expiredRows = await pgUpdate(
      client,
      "incident_escalations",
      { id: escalation.id, status: "pending" },
      { status: "expired", updated_at: now.toISOString() },
      { returning: true }
    );
    if (!expiredRows || expiredRows.length === 0) {
      summary.raced += 1;
      continue;
    }
    summary.expired += 1;

    let newEscalation = null;
    if (decision.createNext) {
      const slaHours = configValue(config, "incidents.escalationSlaHours");
      const dueAt = new Date(now.getTime() + slaHours * 60 * 60 * 1000).toISOString();
      const newRows = await pgInsert(
        client,
        "incident_escalations",
        [
          {
            facility_id: escalation.facility_id,
            incident_id: escalation.incident_id,
            escalation_level: decision.nextLevel,
            reason_code: "sla_breach_auto_escalate",
            target_role: escalation.target_role,
            target_user_id: null,
            status: "pending",
            due_at: dueAt
          }
        ],
        { returning: true }
      );
      newEscalation = (newRows ?? [])[0] ?? null;
      if (newEscalation) summary.escalated += 1;
    } else if (decision.reason === "max_level_reached") {
      summary.capped += 1;
    }

    await pgInsert(
      client,
      "incident_audit_events",
      [
        buildIncidentAuditEvent({
          facilityId: escalation.facility_id,
          incidentId: escalation.incident_id,
          actorUserId: null,
          eventType: newEscalation ? "incident.escalated" : "incident.escalation_expired",
          payload: newEscalation
            ? {
                auto: true,
                reason: "sla_breach",
                fromLevel: escalation.escalation_level,
                toLevel: decision.nextLevel,
                escalationId: escalation.id,
                newEscalationId: newEscalation.id
              }
            : { auto: true, reason: decision.reason, level: escalation.escalation_level, escalationId: escalation.id }
        })
      ],
      { returning: false }
    );

    if (newEscalation && incident) {
      const notified = await notifySlaBreach(client, { escalation, newEscalation, incident });
      if (notified) summary.notified += 1;
    }
  }

  return summary;
}

// IN-20: same best-effort, never-throws contract as
// incidents-routes.mjs's emitIncidentNotifications -- a notification
// pipeline hiccup must never fail the sweep itself. The escalation's OWN
// target_user_id (the person who missed their SLA window) is folded in as
// an extra recipient alongside the facility's incident.sla_breached route,
// exactly like the escalate route folds in a fresh escalation's target.
async function notifySlaBreach(client, { escalation, newEscalation, incident }) {
  try {
    const route = await loadActiveRoute({ client, facilityId: incident.facility_id, eventCode: NOTIFICATION_EVENT_CODE });
    if (!route) return false;
    const expanded = await expandRouteRecipients({ client, facilityId: incident.facility_id, route });
    const recipients = [...new Set([...(expanded ?? []), escalation.target_user_id])].filter(Boolean);
    if (recipients.length === 0) return false;
    // M3 (security review): newEscalation.id -- the fresh row THIS breach
    // creates, always a new server-generated UUID -- is passed as the
    // dedupe-key discriminator, so the second/third/... breach on the same
    // incident no longer collapses onto the first breach's already-used
    // dedupe_key (see buildIncidentNotificationJobs' own doc comment).
    const jobs = buildIncidentNotificationJobs(
      NOTIFICATION_EVENT_CODE,
      route,
      recipients,
      { id: incident.id, severity: incident.severity },
      newEscalation.id
    );
    if (jobs.length === 0) return false;
    // Fold in the BREACHED escalation's own id (buildIncidentNotificationJobs
    // already stamped payload_jsonb.escalationId = newEscalation.id, the
    // dedupe-key discriminator) as breachedEscalationId, so a channel
    // adapter (or a human reading notification_jobs) can trace the
    // notification back to which prior escalation breached, not just which
    // one replaced it.
    for (const job of jobs) {
      job.payload_jsonb = {
        ...job.payload_jsonb,
        breachedEscalationId: escalation.id
      };
    }
    await pgInsert(client, "notification_jobs", jobs, {
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
      returning: false
    });
    return true;
  } catch (error) {
    console.error(`incident-sla-sweep.notify failed for incident ${incident?.id}:`, error);
    return false;
  }
}
