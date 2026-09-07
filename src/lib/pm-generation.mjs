// WO-19: the PM generation job. Turns each active pm_plans row into
// work_orders + pm_plan_occurrences rows for every occurrence whose
// generation date (scheduled_for - lead_time_days) has arrived and whose
// scheduled_for falls within workOrders.pmHorizonDays of `now`. Runs from
// the CRON_SECRET-guarded drain (src/lib/http/internal-routes.mjs, response
// key `pmGeneration`) and standalone as scripts/pm-generate.mjs, always
// against a service-role client (RLS is bypassed here the same way the
// notifications worker bypasses it -- there is no single caller identity
// behind a scheduled job).
//
// Idempotency, and a deliberate deviation from the plan's prose summary
// ("insert the work order then the occurrence row"): this module claims the
// (pm_plan_id, scheduled_for) slot by inserting the pm_plan_occurrences row
// FIRST (work_order_id still null), THEN mints the work order and links it
// back. Minting the work order first cannot be made idempotent under a
// retried or concurrent pass -- by the time a second pass discovered the
// occurrence-table conflict, it would already have inserted its own
// (duplicate) work order, and "running twice creates one work order" would
// fail. Claiming the occurrence slot first means the unique index
// (pm_plan_id, scheduled_for) -- added by 0061 -- is the single point every
// concurrent/retried pass serializes on, before either ever writes to
// work_orders:
//
//   - INSERT into pm_plan_occurrences succeeds -> this pass owns the slot;
//     mint the work order, then UPDATE the occurrence row with its id.
//   - INSERT conflicts (409, unique_violation) -> someone already claimed
//     this date. Fetch the existing row:
//       - work_order_id already set  -> fully generated already; skip.
//       - work_order_id still null   -> an earlier pass claimed the slot but
//         crashed/failed before minting+linking a work order (or is doing so
//         concurrently, best-effort only -- this is not safe against two
//         generation runs racing on the SAME already-claimed-but-unlinked
//         row at the same instant). Repair it: mint the work order now and
//         link it to the existing occurrence row.
//
// Never backfills: the occurrence window's lower bound is always
// max(anchor-derived start, the plan's own created_at date) -- see
// preventive-maintenance.mjs's occurrencesInWindow for why an anchor_date
// earlier than created_at otherwise WOULD produce a flood of past
// occurrences on a plan's very first generation pass.
import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "./supabase-rest.mjs";
import { occurrencesInWindow, workOrderFromPlan } from "./preventive-maintenance.mjs";
import { configValue } from "./settings-registry.mjs";

const PM_PLAN_COLUMNS =
  "id,facility_id,asset_id,title,description,cadence_type,interval_days,anchor_date,season_months,lead_time_days,priority,default_assignee_employee_id,active,last_generated_at,created_at";

const DEFAULT_PLAN_LIMIT = 50;

function mapPlanRow(row) {
  return {
    id: row.id,
    facilityId: row.facility_id,
    assetId: row.asset_id,
    title: row.title,
    description: row.description,
    cadenceType: row.cadence_type,
    intervalDays: row.interval_days,
    anchorDate: row.anchor_date,
    seasonMonths: row.season_months,
    leadTimeDays: row.lead_time_days,
    priority: row.priority,
    defaultAssigneeEmployeeId: row.default_assignee_employee_id,
    active: row.active,
    createdAt: row.created_at
  };
}

function dateOnly(value) {
  return String(value).slice(0, 10);
}

function addDaysToDate(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isConflict(error) {
  return error instanceof PostgrestError && error.status === 409;
}

async function findExistingOccurrence(client, pmPlanId, scheduledFor) {
  const rows = await pgSelect(client, "pm_plan_occurrences", {
    filters: { pm_plan_id: pmPlanId, scheduled_for: scheduledFor },
    select: "id,work_order_id",
    limit: 1
  });
  return (rows ?? [])[0] ?? null;
}

// Attempts to claim the (pm_plan_id, scheduled_for) slot. Returns
// { claimed: true, occurrenceId } when this call created the row (fresh
// generation), { claimed: true, occurrenceId, repair: true } when an
// earlier pass claimed it but never linked a work order, or
// { claimed: false } when it is already fully generated.
async function claimOccurrenceSlot(client, plan, occurrence) {
  try {
    const [inserted] = await pgInsert(
      client,
      "pm_plan_occurrences",
      [
        {
          facility_id: plan.facilityId,
          pm_plan_id: plan.id,
          scheduled_for: occurrence.scheduledFor,
          work_order_id: null,
          generated_at: null
        }
      ],
      { returning: true }
    );
    return { claimed: true, occurrenceId: inserted.id };
  } catch (error) {
    if (!isConflict(error)) throw error;
    const existing = await findExistingOccurrence(client, plan.id, occurrence.scheduledFor);
    if (!existing) throw error; // conflict, but the row is gone -- surface the original error
    if (existing.work_order_id) return { claimed: false };
    return { claimed: true, occurrenceId: existing.id, repair: true };
  }
}

async function mintWorkOrder(client, plan, occurrenceId, occurrence, config, now) {
  const domainRow = workOrderFromPlan(plan, occurrence, config);
  const dbRow = {
    facility_id: domainRow.facilityId,
    department_id: null,
    asset_id: domainRow.assetId,
    source_type: domainRow.sourceType,
    source_id: null,
    source_pm_plan_id: domainRow.sourcePmPlanId,
    source_pm_occurrence_id: occurrenceId,
    title: domainRow.title,
    description: domainRow.description,
    priority: domainRow.priority,
    status: domainRow.status,
    assigned_to_employee_id: domainRow.assignedToEmployeeId,
    due_at: domainRow.dueAt,
    created_by: null
  };
  const [workOrder] = await pgInsert(client, "work_orders", [dbRow], { returning: true });
  await pgUpdate(
    client,
    "pm_plan_occurrences",
    { id: occurrenceId },
    { work_order_id: workOrder.id, generated_at: now.toISOString() }
  );
  return workOrder;
}

// Generates due PM work orders for every active plan. `config` is a flat
// settings map (settings-registry's effectiveConfig shape) -- reads
// workOrders.pmHorizonDays; `limit` bounds how many pm_plans rows are
// scanned in one pass (mirrors drainOnce/drainOutboxOnce's own `limit`).
export async function generatePmWorkOrders(client, { now = new Date(), config = {}, limit = DEFAULT_PLAN_LIMIT } = {}) {
  const summary = { plansScanned: 0, created: 0, skipped: 0, repaired: 0, errors: [] };
  const horizonDays = configValue(config, "workOrders.pmHorizonDays");
  const nowDate = dateOnly(now.toISOString());
  const windowTo = dateOnly(addDaysToDate(now, horizonDays).toISOString());

  const planRows = await pgSelect(client, "pm_plans", {
    filters: { active: true },
    extra: { deleted_at: "is.null" },
    select: PM_PLAN_COLUMNS,
    limit
  });

  for (const planRow of planRows ?? []) {
    summary.plansScanned += 1;
    const plan = mapPlanRow(planRow);
    const windowFrom = dateOnly(plan.createdAt ?? plan.anchorDate);

    let occurrences;
    try {
      occurrences = occurrencesInWindow(plan, windowFrom, windowTo).filter((o) => o.generationDate <= nowDate);
    } catch (error) {
      summary.errors.push({ planId: plan.id, error: error.message });
      continue;
    }

    let planTouched = false;
    for (const occurrence of occurrences) {
      try {
        const claim = await claimOccurrenceSlot(client, plan, occurrence);
        if (!claim.claimed) {
          summary.skipped += 1;
          continue;
        }
        await mintWorkOrder(client, plan, claim.occurrenceId, occurrence, config, now);
        summary.created += 1;
        if (claim.repair) summary.repaired += 1;
        planTouched = true;
      } catch (error) {
        summary.errors.push({ planId: plan.id, scheduledFor: occurrence.scheduledFor, error: error.message });
      }
    }

    if (planTouched) {
      await pgUpdate(client, "pm_plans", { id: plan.id }, { last_generated_at: now.toISOString() });
    }
  }

  return summary;
}
