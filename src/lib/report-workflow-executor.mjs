// DR-20 -- report workflow execution. Runs inside the CRON_SECRET-guarded
// internal drain (src/lib/http/internal-routes.mjs), using the SAME
// service-role client the notifications worker (src/lib/notifications/
// worker.mjs) already uses: RLS is bypassed, so every query here is already
// facility-scoped by hand, exactly like that module's own header comment
// says of itself.
//
// Claims pending report_workflow_events rows (0053) and dispatches each on
// action.type:
//   - create_incident / create_work_order: go through the two SECURITY
//     DEFINER RPCs 0053 grants ONLY to service_role
//     (internal.mint_workflow_incident / internal.mint_workflow_work_order,
//     reached here through their public.* PostgREST wrappers) -- this is
//     the module boundary the Opus review is for: a submitter without
//     incidents.manage/work_orders.manage ends up with a row minted this
//     way, but can never reach either RPC directly (0053 revokes execute
//     from authenticated/public on both).
//   - notify / queue_pdf: no elevated privilege needed -- the service-role
//     client already bypasses RLS for a plain insert/update, so these are
//     plain pgInsert/pgUpdate calls.
//
// Idempotency is enforced at the DB layer (0053: report_workflow_events'
// own unique(submission_id, event_type), and a UNIQUE partial index on
// incident_reports.source_submission_id / work_orders.source_submission_id
// that the two mint RPCs check-then-insert against) -- this module claims
// events by row (never re-derives "has this already happened" itself), and
// simply re-executes an event's action on a retry, trusting the DB-side
// idempotency to make that a no-op when it already landed.
//
// Backoff mirrors notifications/worker.mjs's own algorithm exactly
// (attempt 1 -> 2m, 2 -> 4m, 3 -> 8m, ... capped at 1h; terminal 'failed' at
// 5 attempts) -- duplicated here (rather than imported) because
// report_workflow_events is a distinct table/queue from notification_jobs/
// outbox_events with its own status vocabulary ('skipped' has no
// notification-worker equivalent), not because the algorithm itself
// differs.
import { pgSelect, pgInsert, pgUpdate, pgRpc } from "./supabase-rest.mjs";

const EVENT_COLUMNS =
  "id,facility_id,submission_id,event_type,action,status,attempts,last_error,result,available_at,created_at,processed_at";

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2 * 60 * 1000; // 2 minutes
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

// The permission code that stands in for "manager" for the `notify` action's
// recipient resolution. There is no formal "manager" role concept in this
// schema yet (incident_escalations.target_role, 0004, is a free-text label
// with no resolution behind it either) -- DR-21 (report distribution lists)
// is where a facility gets to configure this for real. Until then,
// reports.export is the closest existing signal: the permission a facility
// grants to whoever reviews/exports submitted reports, deliberately
// narrower than reports.submit (which every filer holds) or reports.read
// (which every viewer holds).
const MANAGER_SIGNAL_PERMISSION = "reports.export";

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Exponential backoff keyed off the POST-increment attempt count (1-based),
// identical to notifications/worker.mjs's computeBackoffMs.
function computeBackoffMs(attempts) {
  const exponential = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exponential, MAX_BACKOFF_MS);
}

// Selects due, pending report_workflow_events (available_at <= now) and
// claims each with a conditional pending -> processing update -- the same
// race-safe claim shape as claimDueJobs/claimDueOutboxEvents
// (notifications/worker.mjs): a concurrent drain's loser UPDATE matches zero
// rows and is silently skipped.
export async function claimDueReportWorkflowEvents({ client, now = new Date(), limit = 25 }) {
  const nowIso = toIso(now);
  const candidates = await pgSelect(client, "report_workflow_events", {
    filters: { status: "pending" },
    select: EVENT_COLUMNS,
    order: "available_at.asc",
    limit,
    extra: { available_at: `lte.${nowIso}` }
  });

  const claimed = [];
  for (const event of candidates ?? []) {
    const updated = await pgUpdate(
      client,
      "report_workflow_events",
      { id: event.id, status: "pending" },
      { status: "processing" },
      { returning: true }
    );
    if (Array.isArray(updated) && updated.length > 0) {
      claimed.push(updated[0]);
    }
    // else: lost the race to another concurrent drain for this event -- skip.
  }
  return claimed;
}

// Resolves "managers" to notify for the `notify` action: active facility
// memberships whose role holds MANAGER_SIGNAL_PERMISSION, mapped to their
// linked employees row (notification_deliveries/notification_jobs address
// employees, not app_users). See the constant's own comment for why this
// permission and not a dedicated role. Returns [] (never throws) when
// nothing resolves, so a facility with no such role simply gets a job with
// zero recipients rather than a failed drain.
export async function resolveManagerRecipients({ client, facilityId }) {
  const memberships = await pgSelect(client, "memberships", {
    filters: { facility_id: facilityId, status: "active" },
    select: "user_id,role_id"
  });
  if (!memberships || memberships.length === 0) return [];

  const roleIds = [...new Set(memberships.map((membership) => membership.role_id).filter(Boolean))];
  if (roleIds.length === 0) return [];

  const rolePermissions = await pgSelect(client, "role_permissions", {
    filters: { role_id: { in: roleIds }, permission_code: MANAGER_SIGNAL_PERMISSION },
    select: "role_id"
  });
  const managerRoleIds = new Set((rolePermissions ?? []).map((row) => row.role_id));
  if (managerRoleIds.size === 0) return [];

  const managerUserIds = [
    ...new Set(memberships.filter((membership) => managerRoleIds.has(membership.role_id)).map((membership) => membership.user_id))
  ];
  if (managerUserIds.length === 0) return [];

  const employees = await pgSelect(client, "employees", {
    filters: { facility_id: facilityId, user_id: { in: managerUserIds } },
    select: "id,user_id"
  });
  return [...new Set((employees ?? []).map((employee) => employee.id).filter(Boolean))];
}

async function executeCreateIncident({ client, event }) {
  const result = await pgRpc(client, "mint_workflow_incident", {
    p_submission_id: event.submission_id,
    p_action: event.action
  });
  return result;
}

async function executeCreateWorkOrder({ client, event }) {
  const result = await pgRpc(client, "mint_workflow_work_order", {
    p_submission_id: event.submission_id,
    p_action: event.action
  });
  return result;
}

async function executeNotify({ client, event, now, adapters }) {
  const resolve = adapters?.resolveManagerRecipients ?? resolveManagerRecipients;
  const recipients = await resolve({ client, facilityId: event.facility_id, event });
  const target = event.action?.params?.target ?? "managers";
  const message = event.action?.params?.message ?? null;
  const rows = await pgInsert(
    client,
    "notification_jobs",
    [
      {
        facility_id: event.facility_id,
        event_type: "report.workflow.notify",
        status: "pending",
        payload_jsonb: {
          target,
          message,
          submission_id: event.submission_id,
          recipients: recipients ?? []
        }
      }
    ],
    { returning: true }
  );
  return { notification_job: (rows ?? [])[0] ?? null, recipient_count: (recipients ?? []).length };
}

async function executeQueuePdf({ client, event, now }) {
  const rows = await pgUpdate(
    client,
    "report_submissions",
    { id: event.submission_id },
    { pdf_status: "queued", updated_at: toIso(now) },
    { returning: true }
  );
  return { report_submission: (rows ?? [])[0] ?? null };
}

// Executes one claimed (status='processing') event's action. Returns
// { outcome: 'processed' | 'skipped', result } on success/no-op, or throws
// on a genuine execution failure -- the caller (executeReportWorkflowEvents)
// converts a throw into the attempts/backoff/dead-letter bookkeeping below.
async function executeAction({ client, event, now, adapters }) {
  const type = event.action?.type;
  switch (type) {
    case "create_incident":
      return { outcome: "processed", result: await executeCreateIncident({ client, event }) };
    case "create_work_order":
      return { outcome: "processed", result: await executeCreateWorkOrder({ client, event }) };
    case "notify":
      return { outcome: "processed", result: await executeNotify({ client, event, now, adapters }) };
    case "queue_pdf":
      return { outcome: "processed", result: await executeQueuePdf({ client, event, now }) };
    default:
      // Not a retryable failure -- report-workflow.mjs never emits an
      // unknown action type, so a row like this can only come from stale/
      // hand-inserted data. 'skipped' is terminal, same as an unrouteable
      // outbox event (notifications/worker.mjs's own precedent).
      return { outcome: "skipped", reason: `unknown report workflow action type "${type}"` };
  }
}

async function markProcessed({ client, event, now, result }) {
  await pgUpdate(
    client,
    "report_workflow_events",
    { id: event.id },
    { status: "processed", processed_at: toIso(now), result: result ?? {}, last_error: null },
    { returning: true }
  );
}

async function markSkipped({ client, event, now, reason }) {
  await pgUpdate(
    client,
    "report_workflow_events",
    { id: event.id },
    { status: "skipped", processed_at: toIso(now), last_error: reason },
    { returning: true }
  );
}

async function markFailure({ client, event, now, error, maxAttempts }) {
  const attempts = Number(event.attempts ?? 0) + 1;
  const lastError = error?.message ? String(error.message) : String(error);
  const deadLettered = attempts >= maxAttempts;
  const patch = {
    attempts,
    last_error: lastError,
    status: deadLettered ? "failed" : "pending",
    available_at: deadLettered ? event.available_at : toIso(new Date(now.getTime() + computeBackoffMs(attempts)))
  };
  await pgUpdate(client, "report_workflow_events", { id: event.id }, patch, { returning: true });
  return deadLettered;
}

// Processes one already-claimed event, routing success/failure into the
// ledger bookkeeping above. Never throws -- every outcome (processed,
// skipped, retried, dead-lettered) is reported back for the summary.
async function processReportWorkflowEvent({ client, event, now, adapters, maxAttempts }) {
  try {
    const { outcome, result, reason } = await executeAction({ client, event, now, adapters });
    if (outcome === "skipped") {
      await markSkipped({ client, event, now, reason });
      return { outcome: "skipped", event, reason };
    }
    await markProcessed({ client, event, now, result });
    return { outcome: "processed", event, result };
  } catch (error) {
    const deadLettered = await markFailure({ client, event, now, error, maxAttempts });
    return { outcome: deadLettered ? "dead_letter" : "failed", event, error: error?.message ?? String(error) };
  }
}

// Composes claim + process for a single drain pass, called from the
// CRON_SECRET-guarded internal route (src/lib/http/internal-routes.mjs)
// alongside notifications/worker.mjs's drainAll. `adapters` lets a caller
// (tests, or a future channel adapter) override recipient resolution
// (adapters.resolveManagerRecipients) without touching the DB-shaped
// default above. `client` is a positional argument (not part of the options
// bag) to match the injectable-service-role-client shape every other
// drain/worker entry point in this codebase takes.
export async function executeReportWorkflowEvents(client, { now = new Date(), limit = 25, adapters = {} } = {}) {
  const maxAttempts = adapters?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await claimDueReportWorkflowEvents({ client, now, limit });
  const summary = { claimed: claimed.length, processed: 0, skipped: 0, failed: 0, deadLettered: 0 };

  for (const event of claimed) {
    const result = await processReportWorkflowEvent({ client, event, now, adapters, maxAttempts });
    if (result.outcome === "processed") summary.processed += 1;
    else if (result.outcome === "skipped") summary.skipped += 1;
    else if (result.outcome === "dead_letter") summary.deadLettered += 1;
    else summary.failed += 1;
  }

  return summary;
}
