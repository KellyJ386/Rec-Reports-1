// WO-20: end-user API for preventive-maintenance plans -- reuses the
// work_orders.read / work_orders.manage codes (pm_plans/pm_plan_occurrences
// are part of the work-orders module, 0061), same shape as
// work-orders-routes.mjs (facility from the :facilityId path on list/create,
// facility from the loaded row on every by-id route -- never trusted from
// the request body).
import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { makeGuards } from "./guard.mjs";
import { WORK_ORDER_PRIORITIES } from "../work-orders.mjs";
import { occurrencesInWindow } from "../preventive-maintenance.mjs";

const READ = "work_orders.read";
const MANAGE = "work_orders.manage";

const PM_PLAN_COLUMNS =
  "id,facility_id,asset_id,title,description,cadence_type,interval_days,anchor_date,season_months,lead_time_days,priority,default_assignee_employee_id,active,last_generated_at,created_by,created_at,updated_at";

const PM_PLAN_OCCURRENCE_COLUMNS = "id,facility_id,pm_plan_id,scheduled_for,work_order_id,generated_at,created_at";

const CADENCE_TYPES = new Set(["interval", "seasonal"]);
const PRIORITY_SET = new Set(WORK_ORDER_PRIORITIES);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_OCCURRENCE_WINDOW_DAYS = 56; // 8 weeks -- WO-20's "upcoming-occurrences strip"
// H-2 (security review, wave3-slice-3c): ?from=/?to= previously had no
// maximum span -- a work_orders.read holder could request e.g.
// 2026-09-07..9999-12-31 against a daily (interval_days=1) plan and force
// occurrencesInWindow to materialize millions of dates in-process (2.9M
// dates, ~335MB heap, ~5.3s blocking CPU measured against a single such
// request -- the DoS this bound closes), then have the route sort and
// JSON-serialize that. 400 comfortably covers WO-20's own 8-week default
// plus any reasonable manual widening (a year-plus of daily occurrences
// still exceeds any UI's practical use) while keeping a single request's
// work bounded. preventive-maintenance.mjs's own MAX_OCCURRENCES is the
// second, independent line of defense -- see that module's comment -- so a
// future caller of occurrencesInWindow that bypasses this route-level check
// entirely still cannot force unbounded materialization.
const MAX_OCCURRENCE_WINDOW_DAYS = 400;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function todayDateStr(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function addDaysToDateStr(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function planRowToDomain(row) {
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

// Validates a COMPLETE candidate plan (snake_case, DB-shaped). Both the
// create route and the PATCH route (which first merges the request body
// onto the existing row -- see mergePlanPatch below) call this against a
// fully-populated object, so there is exactly one validation path and a
// PATCH that switches cadence_type can never reach the DB's own CHECK
// constraints (0061's pm_plans_interval_shape / pm_plans_seasonal_shape) as
// an opaque 500 -- an inconsistent cadence/field combination is caught here
// first.
function validatePlanShape(candidate) {
  const errors = [];
  if (typeof candidate.title !== "string" || !candidate.title.trim()) errors.push("title is required");
  if (candidate.description !== null && candidate.description !== undefined && typeof candidate.description !== "string") {
    errors.push("description must be a string");
  }
  if (!CADENCE_TYPES.has(candidate.cadence_type)) {
    errors.push("cadence_type must be one of: interval, seasonal");
  } else if (candidate.cadence_type === "interval") {
    if (!Number.isInteger(candidate.interval_days) || candidate.interval_days < 1) {
      errors.push("interval_days must be an integer >= 1");
    }
  } else if (candidate.cadence_type === "seasonal") {
    const months = candidate.season_months;
    if (
      !Array.isArray(months) ||
      months.length === 0 ||
      !months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)
    ) {
      errors.push("season_months must be a non-empty array of integers 1-12");
    }
  }
  if (typeof candidate.anchor_date !== "string" || !DATE_PATTERN.test(candidate.anchor_date)) {
    errors.push("anchor_date is required and must be YYYY-MM-DD");
  }
  if (!Number.isInteger(candidate.lead_time_days) || candidate.lead_time_days < 0) {
    errors.push("lead_time_days must be a non-negative integer");
  }
  if (!PRIORITY_SET.has(candidate.priority)) errors.push(`unknown priority: ${candidate.priority}`);
  if (typeof candidate.active !== "boolean") errors.push("active must be a boolean");
  return errors;
}

// Merges a PATCH body onto the existing plan row, producing a complete
// candidate for validatePlanShape/the actual UPDATE. Switching cadence_type
// clears the other cadence field's stale value (mirrors the create route
// never accepting both interval_days and season_months for the same plan).
function mergePlanPatch(plan, payload) {
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;
  const merged = {
    title: has("title") ? payload.title : plan.title,
    description: has("description") ? payload.description : plan.description,
    cadence_type: has("cadence_type") ? payload.cadence_type : plan.cadence_type,
    interval_days: has("interval_days") ? payload.interval_days : plan.interval_days,
    season_months: has("season_months") ? payload.season_months : plan.season_months,
    anchor_date: has("anchor_date") ? payload.anchor_date : plan.anchor_date,
    lead_time_days: has("lead_time_days") ? payload.lead_time_days : plan.lead_time_days,
    priority: has("priority") ? payload.priority : plan.priority,
    asset_id: has("asset_id") ? payload.asset_id : plan.asset_id,
    default_assignee_employee_id: has("default_assignee_employee_id")
      ? payload.default_assignee_employee_id
      : plan.default_assignee_employee_id,
    active: has("active") ? payload.active : plan.active
  };
  if (merged.cadence_type === "interval") merged.season_months = null;
  if (merged.cadence_type === "seasonal") merged.interval_days = null;
  return merged;
}

export function registerPmPlanRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams, parseListLimitOffset } = guards;
  const requireRead = guards.requireRead(READ);

  async function loadPlan(client, id) {
    const rows = await pgSelect(client, "pm_plans", {
      filters: { id },
      extra: { deleted_at: "is.null" },
      select: PM_PLAN_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  const FACILITY_REF_TABLES = {
    asset_id: { table: "assets", label: "asset_id" },
    default_assignee_employee_id: { table: "employees", label: "default_assignee_employee_id" }
  };

  async function resolveFacilityRef(client, field, id, facilityId) {
    if (id === undefined || id === null) return { ok: true };
    const { table, label } = FACILITY_REF_TABLES[field];
    const rows = await pgSelect(client, table, { filters: { id }, select: "id,facility_id", limit: 1 });
    const row = (rows ?? [])[0];
    if (!row) return { ok: false, status: 404, error: `${label} not found` };
    if (row.facility_id !== facilityId) return { ok: false, status: 400, error: `${label} does not belong to this facility` };
    return { ok: true };
  }

  async function resolveFacilityRefs(client, facilityId, refs) {
    for (const [field, id] of Object.entries(refs)) {
      const result = await resolveFacilityRef(client, field, id, facilityId);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  // --- List / create ----------------------------------------------------

  router.register(
    "GET",
    "/facilities/:facilityId/pm-plans",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const activeParam = qp.get("active");
        if (activeParam === "true") filters.active = true;
        else if (activeParam === "false") filters.active = false;
        else if (activeParam !== null) return sendJson(response, 400, { error: "active must be true or false" });

        const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIST_LIMIT, maxLimit: MAX_LIST_LIMIT });
        if (!paging.ok) return sendJson(response, 400, { error: paging.error });

        const rows = await pgSelect(auth.client, "pm_plans", {
          filters,
          extra: { deleted_at: "is.null" },
          select: PM_PLAN_COLUMNS,
          order: "created_at.desc",
          limit: paging.limit,
          offset: paging.offset
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a plan. A body-supplied facility_id is never read -- facility_id
  // always comes from the :facilityId path param. Creating a plan never
  // backfills history: this route only ever inserts the pm_plans row itself
  // -- occurrence/work-order generation is entirely the generation job's
  // job (WO-19), which never looks earlier than the row's own created_at,
  // however far in the past anchor_date is.
  router.register(
    "POST",
    "/facilities/:facilityId/pm-plans",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const payload = body.payload;
        const candidate = {
          title: payload.title,
          description: payload.description ?? null,
          cadence_type: payload.cadence_type,
          interval_days: payload.cadence_type === "interval" ? payload.interval_days : null,
          season_months: payload.cadence_type === "seasonal" ? payload.season_months : null,
          anchor_date: payload.anchor_date,
          lead_time_days: payload.lead_time_days ?? 0,
          priority: payload.priority ?? "medium",
          active: true
        };
        const errors = validatePlanShape(candidate);
        if (errors.length > 0) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const refCheck = await resolveFacilityRefs(auth.client, params.facilityId, {
          asset_id: payload.asset_id,
          default_assignee_employee_id: payload.default_assignee_employee_id
        });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

        const row = {
          facility_id: params.facilityId,
          asset_id: payload.asset_id ?? null,
          title: candidate.title.trim(),
          description: candidate.description,
          cadence_type: candidate.cadence_type,
          interval_days: candidate.interval_days,
          anchor_date: candidate.anchor_date,
          season_months: candidate.season_months,
          lead_time_days: candidate.lead_time_days,
          priority: candidate.priority,
          default_assignee_employee_id: payload.default_assignee_employee_id ?? null,
          active: true,
          created_by: auth.claims.sub
        };
        const rows = await pgInsert(auth.client, "pm_plans", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // --- By-id: read / update ------------------------------------------------

  router.register(
    "GET",
    "/pm-plans/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const plan = await loadPlan(auth.client, params.id);
        if (!plan) return sendJson(response, 404, { error: "pm plan not found" });
        if (!requireRead(auth, plan.facility_id, response)) return;
        return sendJson(response, 200, plan);
      })
  );

  router.register(
    "PATCH",
    "/pm-plans/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const plan = await loadPlan(auth.client, params.id);
        if (!plan) return sendJson(response, 404, { error: "pm plan not found" });
        if (!requirePerm(auth, plan.facility_id, MANAGE, response)) return;

        const merged = mergePlanPatch(plan, body.payload);
        const errors = validatePlanShape(merged);
        if (errors.length > 0) return sendJson(response, 400, { errors });

        const refCheck = await resolveFacilityRefs(auth.client, plan.facility_id, {
          asset_id: merged.asset_id,
          default_assignee_employee_id: merged.default_assignee_employee_id
        });
        if (!refCheck.ok) return sendJson(response, refCheck.status, { error: refCheck.error });

        const patch = { ...merged, title: merged.title.trim(), updated_at: new Date().toISOString() };
        const rows = await pgUpdate(auth.client, "pm_plans", { id: params.id }, patch, { returning: true });
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Deactivates a plan: sets active=false only. Stops future generation
  // (WO-19 only ever queries active=true plans) but never touches, cancels,
  // or deletes any work order the plan already generated.
  router.register(
    "POST",
    "/pm-plans/:id/deactivate",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const plan = await loadPlan(auth.client, params.id);
        if (!plan) return sendJson(response, 404, { error: "pm plan not found" });
        if (!requirePerm(auth, plan.facility_id, MANAGE, response)) return;

        const rows = await pgUpdate(
          auth.client,
          "pm_plans",
          { id: params.id },
          { active: false, updated_at: new Date().toISOString() },
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Occurrences: stored ledger rows + a computed preview -----------------
  // Returns every STORED pm_plan_occurrences row in [from, to] (a real
  // generation pass already claimed that date, whether or not it has a
  // linked work order yet) PLUS a computed preview -- via the same pure
  // occurrencesInWindow the generation job itself uses -- for any date in
  // the window the ledger has no row for yet, each flagged `preview: true`
  // so the UI can render "already generated" vs. "upcoming" differently.
  // ?from/?to default to today..today+56 days (8 weeks), matching WO-20's
  // "upcoming-occurrences strip".
  router.register(
    "GET",
    "/pm-plans/:id/occurrences",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const plan = await loadPlan(auth.client, params.id);
        if (!plan) return sendJson(response, 404, { error: "pm plan not found" });
        if (!requireRead(auth, plan.facility_id, response)) return;

        const qp = queryParams(request);
        const today = todayDateStr();
        const fromParam = qp.get("from");
        const toParam = qp.get("to");
        if (fromParam !== null && !DATE_PATTERN.test(fromParam)) {
          return sendJson(response, 400, { error: "from must be YYYY-MM-DD" });
        }
        if (toParam !== null && !DATE_PATTERN.test(toParam)) {
          return sendJson(response, 400, { error: "to must be YYYY-MM-DD" });
        }
        const from = fromParam ?? today;
        const to = toParam ?? addDaysToDateStr(from, DEFAULT_OCCURRENCE_WINDOW_DAYS);
        if (to < from) return sendJson(response, 400, { error: "to must not be before from" });
        // H-2: reject an over-wide window before occurrencesInWindow ever
        // runs (see MAX_OCCURRENCE_WINDOW_DAYS above). Both from/to are
        // already known to be valid YYYY-MM-DD strings at this point, so
        // millisecond arithmetic on `new Date(...)` is exact/DST-safe here.
        const spanDays = Math.round(
          (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / 86400000
        );
        if (spanDays > MAX_OCCURRENCE_WINDOW_DAYS) {
          return sendJson(response, 400, {
            error: `window (from..to) must not exceed ${MAX_OCCURRENCE_WINDOW_DAYS} days`
          });
        }

        const storedRows = await pgSelect(auth.client, "pm_plan_occurrences", {
          filters: { pm_plan_id: plan.id, scheduled_for: { gte: from, lte: to } },
          select: PM_PLAN_OCCURRENCE_COLUMNS,
          order: "scheduled_for.asc"
        });
        const stored = (storedRows ?? []).map((row) => ({
          id: row.id,
          scheduledFor: row.scheduled_for,
          workOrderId: row.work_order_id,
          generatedAt: row.generated_at,
          preview: false
        }));
        const storedDates = new Set(stored.map((row) => row.scheduledFor));

        const computed = occurrencesInWindow(planRowToDomain(plan), from, to)
          .filter((occurrence) => !storedDates.has(occurrence.scheduledFor))
          .map((occurrence) => ({
            scheduledFor: occurrence.scheduledFor,
            generationDate: occurrence.generationDate,
            preview: true
          }));

        const combined = [...stored, ...computed].sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : 1));
        return sendJson(response, 200, combined);
      })
  );

  return router;
}
