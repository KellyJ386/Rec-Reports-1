// WO-16 (plans/WORK_ORDERS_PLAN.md) -- overdue-SLA detection -> notification
// enqueue. Runs from the CRON_SECRET-guarded drain (src/lib/http/
// internal-routes.mjs, response key `workOrderSla`) and as a standalone
// script (scripts/work-order-sla-scan.mjs) so it works with or without the
// platform notification worker, exactly like every other scan/drain
// function in this codebase (report-workflow-executor.mjs,
// report-distribution.mjs) -- injectable service-role client, no HTTP
// wiring here.
//
// What it does, per pass:
//   1. Claims (race-safe, CAS-style -- see claimBreach below) open work
//      orders (src/lib/work-orders.mjs OPEN_STATUSES) whose sla_due_at has
//      passed and whose sla_breached_at is still null, stamping
//      sla_breached_at = now. This is the ONLY place in the codebase that
//      sets sla_breached_at (0060's DB trigger is the backstop that rejects
//      any authenticated-session write to it).
//   2. For each newly-breached work order, resolves the facility's live
//      'work_order.overdue' notification_routes entry (resolveRoute) and
//      expands its target distribution list (expandDistributionList) --
//      composing the exact same pure helpers src/lib/notifications/
//      worker.mjs's outbox-event translation already uses, per WO-16's own
//      acceptance criterion. A facility with no active route for the event
//      still gets its work order stamped breached; it just enqueues nothing
//      (mirrors translateOutboxEvent's "no route -> skip" precedent).
//   3. Enqueues ONE notification_jobs row per (work order, recipient) --
//      not one job with many recipients -- because de-duplication has to be
//      per-recipient: `dedupeKey` is
//      `<work_order_id>:overdue:<sla_due_at ISO>:<recipient employee id>`,
//      checked against any EXISTING job carrying the same
//      payload_jsonb.dedupeKey before inserting (a parallel builder is
//      adding a `dedupe_key` COLUMN in 0058 -- once that lands, switch this
//      lookup from the jsonb text-extraction filter below to a plain
//      `dedupe_key=eq.<value>` filter; the payload-carried key itself never
//      needs to change, only where it's indexed/queried from).
//   4. Quiet hours (reports.quietHoursStart/End, same registry keys/
//      isWithinQuietHours every other drain consumer already reuses) defer
//      a job's scheduled_for to the window's end -- UNLESS the work order's
//      own priority is 'urgent', which bypasses quiet hours entirely
//      (payload_jsonb.quietHoursBypass = true, the same flag worker.mjs's
//      processJob already knows how to honor -- mirrors
//      shouldBypassQuietHours's urgent/emergency rule in
//      src/lib/communications.mjs).
import { pgSelect, pgInsert, pgUpdate } from "./supabase-rest.mjs";
import { resolveRoute, expandDistributionList, isWithinQuietHours, buildNotificationJob } from "./admin/notifications.mjs";
import { nextQuietWindowEnd } from "./notifications/worker.mjs";
import { configValue } from "./settings-registry.mjs";
import { OPEN_STATUSES } from "./work-orders.mjs";

const EVENT_CODE = "work_order.overdue";

const WORK_ORDER_COLUMNS = "id,facility_id,title,priority,status,sla_due_at,sla_breached_at";

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toHHMM(date) {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// Selects open work orders past their sla_due_at with no sla_breached_at
// yet, ordered so the longest-overdue rows are claimed first when `limit`
// truncates a large backlog.
async function selectBreachCandidates(client, now, limit) {
  const rows = await pgSelect(client, "work_orders", {
    filters: { status: { in: OPEN_STATUSES } },
    select: WORK_ORDER_COLUMNS,
    order: "sla_due_at.asc",
    limit,
    // sla_due_at < now naturally excludes null sla_due_at rows (a NULL
    // comparison is never true in Postgres) -- no separate is-not-null
    // filter needed.
    extra: { sla_due_at: `lt.${toIso(now)}`, sla_breached_at: "is.null" }
  });
  return rows ?? [];
}

// Race-safe CAS claim, mirroring claimDueJobs/claimDueOutboxEvents
// (notifications/worker.mjs) and claimDueReportWorkflowEvents
// (report-workflow-executor.mjs): a conditional UPDATE gated on the column
// still being null. A concurrent scan's loser UPDATE matches zero rows and
// is silently skipped -- no double-stamp, no double-enqueue.
async function claimBreach(client, workOrder, now) {
  const updated = await pgUpdate(
    client,
    "work_orders",
    { id: workOrder.id },
    { sla_breached_at: toIso(now) },
    { returning: true, extra: { sla_breached_at: "is.null" } }
  );
  return (updated ?? [])[0] ?? null;
}

// Resolves a facility's live 'work_order.overdue' route + expanded
// recipients. Duplicates (rather than imports) worker.mjs's private
// loadActiveRoute/expandRouteRecipients shape -- the same "documented in
// both places" convention report-workflow-executor.mjs already uses for its
// own backoff algorithm, since neither is exported from that module.
async function resolveRecipients(client, facilityId) {
  const routes = await pgSelect(client, "notification_routes", {
    filters: { facility_id: facilityId, event_code: EVENT_CODE, active: true },
    select: "id,facility_id,event_code,priority,route_jsonb,active"
  });
  const route = resolveRoute(EVENT_CODE, routes ?? []);
  const listId = route?.route_jsonb?.distributionListId ?? null;
  if (!route || !listId) return { route, recipients: [] };

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
    pgSelect(client, "employees", { filters: { facility_id: facilityId }, select: "id" })
  ]);
  const list = (listRows ?? [])[0] ?? { id: listId };
  const recipients = expandDistributionList(list, members ?? [], { employees: employees ?? [] });
  return { route, recipients };
}

function dedupeKeyFor(workOrder, recipientId) {
  return `${workOrder.id}:overdue:${workOrder.sla_due_at}:${recipientId}`;
}

// Checks for an existing notification_jobs row already carrying this exact
// dedupeKey, scoped to the facility (a jsonb text-extraction filter --
// `payload_jsonb->>dedupeKey=eq.<value>` -- since notification_jobs has no
// dedicated column for this yet; see the module header's note on the
// upcoming 0058 `dedupe_key` column).
async function alreadyEnqueued(client, facilityId, dedupeKey) {
  const rows = await pgSelect(client, "notification_jobs", {
    filters: { facility_id: facilityId },
    select: "id",
    limit: 1,
    extra: { "payload_jsonb->>dedupeKey": `eq.${dedupeKey}` }
  });
  return (rows ?? []).length > 0;
}

// scanWorkOrderSla(client, { now, config, limit }) -> summary.
//
// `config` carries the same optional quiet-hours overrides every other scan/
// drain consumer accepts (config.quietHoursStart/End, falling back to the
// reports.quietHoursStart/End registry defaults) plus `config.dsn`/
// `config.observabilityFetch` are accepted for shape-compatibility with the
// drain's shared config object but are not used here (no partial-failure
// path in this scan needs a fire-and-forget report -- a per-row failure
// simply is not counted as breached/enqueued and the next pass retries it,
// since sla_breached_at is only ever stamped on a successful claim).
export async function scanWorkOrderSla(client, { now = new Date(), config = {}, limit = 25 } = {}) {
  const summary = { scanned: 0, breached: 0, enqueued: 0, deduped: 0, noRoute: 0 };

  const candidates = await selectBreachCandidates(client, now, limit);
  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  const quietStart = config.quietHoursStart ?? configValue({}, "reports.quietHoursStart");
  const quietEnd = config.quietHoursEnd ?? configValue({}, "reports.quietHoursEnd");
  const nowHHMM = toHHMM(now);
  const nowIso = toIso(now);

  const routeCache = new Map(); // facilityId -> Promise<{route, recipients}>
  function recipientsFor(facilityId) {
    if (!routeCache.has(facilityId)) routeCache.set(facilityId, resolveRecipients(client, facilityId));
    return routeCache.get(facilityId);
  }

  for (const candidate of candidates) {
    const claimed = await claimBreach(client, candidate, now);
    if (!claimed) continue; // lost the race to a concurrent scan -- skip.
    summary.breached += 1;

    const { route, recipients } = await recipientsFor(claimed.facility_id);
    if (!route || recipients.length === 0) {
      summary.noRoute += 1;
      continue;
    }

    // Urgent work orders bypass quiet hours entirely -- same rule
    // src/lib/communications.mjs's shouldBypassQuietHours already applies
    // for urgent/emergency messages.
    const bypass = claimed.priority === "urgent";
    const deferred = !bypass && isWithinQuietHours(nowHHMM, quietStart, quietEnd);
    const scheduledFor = deferred ? toIso(nextQuietWindowEnd(now, quietEnd)) : nowIso;

    for (const recipientId of recipients) {
      const dedupeKey = dedupeKeyFor(claimed, recipientId);
      if (await alreadyEnqueued(client, claimed.facility_id, dedupeKey)) {
        summary.deduped += 1;
        continue;
      }

      const base = buildNotificationJob(EVENT_CODE, route, [recipientId]);
      const job = {
        ...base,
        scheduled_for: scheduledFor,
        payload_jsonb: {
          ...base.payload_jsonb,
          quietHoursBypass: bypass,
          dedupeKey,
          title: `Work order overdue: ${claimed.title}`,
          body: `Work order "${claimed.title}" passed its SLA deadline (${claimed.sla_due_at}).`,
          work_order_id: claimed.id
        }
      };
      await pgInsert(client, "notification_jobs", [job], { returning: true });
      summary.enqueued += 1;
    }
  }

  return summary;
}
