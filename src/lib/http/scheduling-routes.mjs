import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { makeGuards } from "./guard.mjs";
import {
  summarizeScheduleReadiness,
  canTransitionPeriod,
  validateTemplateInput,
  expandTemplates,
  shiftNaturalKey,
  canTransitionAssignment,
  ASSIGNMENT_STATUSES,
  shiftsOverlap,
  buildChangeSummary
} from "../scheduling.mjs";
import { settingsForModule, effectiveConfig, configValue } from "../settings-registry.mjs";

const READ = "schedule.read";
const MANAGE = "schedule.manage";
const PUBLISH = "schedule.publish";

const PERIOD_COLUMNS =
  "id,facility_id,department_id,week_start_date,week_end_date,status,publish_version,metadata,created_at,updated_at";
const SHIFT_COLUMNS =
  "id,facility_id,schedule_period_id,department_id,role_code,shift_date,starts_at,ends_at,source,status,required_certification_ids,notes,created_at,updated_at";
const ASSIGNMENT_COLUMNS =
  "id,facility_id,shift_id,employee_id,assignment_type,status,assigned_by,created_at,updated_at";
const CERT_TYPE_COLUMNS = "id,facility_id,code,name,renewal_window_days,created_at,updated_at";
const EMPLOYEE_CERT_COLUMNS = "id,facility_id,employee_id,certification_type_id,issued_at,expires_at,evidence_path,status,created_at,updated_at";
const ROLE_REQUIREMENT_COLUMNS =
  "id,facility_id,certification_type_id,role_id,required_level,enforcement_mode,active,created_at,updated_at";
const SHIFT_TEMPLATE_COLUMNS =
  "id,facility_id,department_id,role_code,recurrence_rule,start_time_local,end_time_local,days_of_week,required_certification_ids,active,created_at,updated_at";
const EMPLOYEE_COLUMNS =
  "id,facility_id,department_id,user_id,employee_no,first_name,last_name,status,created_at,updated_at";
const PUBLICATION_COLUMNS =
  "id,facility_id,schedule_period_id,publish_version,published_at,published_by,change_summary";
const PERIOD_STATUS_VALUES = ["draft", "review", "published", "archived"];
const SHIFT_STATUS_VALUES = ["draft", "open", "assigned", "published", "cancelled"];
const ASSIGNMENT_TYPE_VALUES = ["primary", "cover"];
// Statuses whose assignment still occupies the employee's calendar for
// conflict-check purposes (0003_scheduling.sql shift_assignments.status);
// 'declined'/'cancelled' assignments are no longer live bookings.
const ACTIVE_ASSIGNMENT_STATUSES = ["pending", "approved"];
// Periods a generate-from-templates run may target; published/archived
// periods are already locked (SC-03).
const GENERATABLE_PERIOD_STATUSES = ["draft", "review"];
const SCHEDULING_MODULE_CODE = "scheduling";
const SCHEDULING_SETTING_DEFINITIONS = settingsForModule(SCHEDULING_MODULE_CODE);

// Registers the end-user Scheduling API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require schedule.read; writes require schedule.manage. All routes
// operate within the authenticated user's facility scope.
export function registerSchedulingRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams } = guards;
  const requireRead = guards.requireRead(READ);

  async function loadPeriod(client, periodId) {
    const rows = await pgSelect(client, "schedule_periods", {
      filters: { id: periodId },
      select: PERIOD_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadShiftTemplate(client, templateId) {
    const rows = await pgSelect(client, "shift_templates", {
      filters: { id: templateId },
      select: SHIFT_TEMPLATE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadShift(client, shiftId) {
    const rows = await pgSelect(client, "schedule_shifts", {
      filters: { id: shiftId },
      select: SHIFT_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Effective scheduling config (mirrors admin-routes.mjs GET
  // /facilities/:facilityId/modules/:moduleCode/config resolution: org layer
  // from organization_module_settings, facility layer from
  // facility_module_overrides, facility overrides winning over org winning
  // over the registry default) ------------------------------------------------
  async function loadModuleByCode(client, code) {
    const rows = await pgSelect(client, "modules", {
      filters: { code },
      select: "id,code",
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Selects timezone alongside organization_id so the SC-03 generate route can
  // reuse this same lookup for expandTemplates' DST-safe local->UTC conversion
  // instead of issuing a second facilities query.
  async function loadFacilityOrgId(client, facilityId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { id: facilityId },
      select: "id,organization_id,timezone",
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadAssignment(client, assignmentId) {
    const rows = await pgSelect(client, "shift_assignments", {
      filters: { id: assignmentId },
      select: ASSIGNMENT_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolve the facility's effective scheduling config (flat key -> value map,
  // registry defaults filled in) so summarizeScheduleReadiness's
  // conflictCheckEnabled/certEnforcementMode reflect live admin settings
  // instead of the hard-coded defaults. Any lookup failure (module row
  // missing, facility missing) degrades to {} -- summarizeScheduleReadiness's
  // configValue() already falls back to registry defaults for an empty map, so
  // this stays backward compatible rather than failing the request.
  async function loadSchedulingConfig(client, facilityId) {
    const module = await loadModuleByCode(client, SCHEDULING_MODULE_CODE);
    if (!module) return {};
    const facility = await loadFacilityOrgId(client, facilityId);

    let orgLayer = {};
    if (facility?.organization_id) {
      const orgRows = await pgSelect(client, "organization_module_settings", {
        filters: { organization_id: facility.organization_id, module_id: module.id },
        select: "config_jsonb",
        limit: 1
      });
      orgLayer = (orgRows ?? [])[0]?.config_jsonb ?? {};
    }
    const facRows = await pgSelect(client, "facility_module_overrides", {
      filters: { facility_id: facilityId, module_id: module.id },
      select: "config_patch_jsonb",
      limit: 1
    });
    const facilityLayer = (facRows ?? [])[0]?.config_patch_jsonb ?? {};

    return effectiveConfig({ orgLayer, facilityLayer, definitions: SCHEDULING_SETTING_DEFINITIONS });
  }

  // Adapts a raw schedule_shifts/shift_assignments row into buildChangeSummary's
  // domain shape (SC-07). Kept separate from the summarizeScheduleReadiness
  // adaptation below (domainAssignments) because the two consumers need
  // different fields off the same rows.
  function toShiftDiffRow(row) {
    return {
      id: row.id,
      roleCode: row.role_code,
      shiftDate: row.shift_date,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      departmentId: row.department_id ?? null
    };
  }

  function toAssignmentDiffRow(row) {
    return {
      id: row.id,
      shiftId: row.shift_id,
      employeeId: row.employee_id,
      assignmentType: row.assignment_type,
      status: row.status
    };
  }

  // Shared by POST /schedule/validate and POST .../publish (SC-07): loads the
  // facility's shifts (optionally scoped to one schedule period),
  // assignments, certifications, live scheduling config, and active
  // per-requirement cert-policy overrides, adapts them into
  // summarizeScheduleReadiness's input shapes, and calls it exactly once.
  // Callers that also need the raw rows (the publish route, to build its
  // change summary) get them back alongside the readiness result rather than
  // re-querying.
  async function computeScheduleReadiness(client, facilityId, { periodId } = {}) {
    const shiftFilters = { facility_id: facilityId };
    if (periodId) shiftFilters.schedule_period_id = periodId;

    // Load shifts (period-scoped when periodId given), assignments,
    // certifications, certification types, the facility's effective
    // scheduling config, and active per-requirement cert-policy overrides.
    // shift_assignments carries no schedule_period_id column of its own, so
    // it is loaded facility-wide and scoped to the period implicitly below
    // via shiftById (an assignment whose shift fell outside the period-
    // scoped shifts query is dropped as "orphaned").
    const [shiftsRows, assignmentsRows, certsRows, certTypesRows, config, roleRequirementRows] = await Promise.all([
      pgSelect(client, "schedule_shifts", {
        filters: shiftFilters,
        select: SHIFT_COLUMNS
      }),
      pgSelect(client, "shift_assignments", {
        filters: { facility_id: facilityId },
        select: ASSIGNMENT_COLUMNS
      }),
      pgSelect(client, "employee_certifications", {
        filters: { facility_id: facilityId },
        select: EMPLOYEE_CERT_COLUMNS
      }),
      pgSelect(client, "certification_types", {
        filters: { facility_id: facilityId },
        select: CERT_TYPE_COLUMNS
      }),
      loadSchedulingConfig(client, facilityId),
      pgSelect(client, "certification_role_requirements", {
        filters: { facility_id: facilityId },
        select: ROLE_REQUIREMENT_COLUMNS
      })
    ]);

    const shifts = shiftsRows ?? [];
    const assignments = assignmentsRows ?? [];
    const certs = certsRows ?? [];
    const certTypes = certTypesRows ?? [];

    // Build a map from certification ID to code.
    const certIdToCode = new Map();
    for (const ct of certTypes) {
      certIdToCode.set(ct.id, ct.code);
    }

    // Adapt certification_role_requirements (0017) rows -- keyed by
    // certification_type_id -- into the { certificationCode,
    // enforcement_mode } shape summarizeScheduleReadiness's roleRequirements
    // expects, dropping inactive rows and any pointing at an unknown cert
    // type (mirrors cert-policy.mjs certGaps' active-row filtering).
    const roleRequirements = [];
    for (const requirement of roleRequirementRows ?? []) {
      if (requirement.active === false) continue;
      const certificationCode = certIdToCode.get(requirement.certification_type_id);
      if (!certificationCode) continue;
      roleRequirements.push({ certificationCode, enforcement_mode: requirement.enforcement_mode });
    }

    // Build a map from employee ID to array of certification codes.
    const certificationsByEmployee = {};
    for (const cert of certs) {
      if (cert.status !== "active") continue;
      const code = certIdToCode.get(cert.certification_type_id);
      if (!code) continue;
      if (!certificationsByEmployee[cert.employee_id]) {
        certificationsByEmployee[cert.employee_id] = [];
      }
      certificationsByEmployee[cert.employee_id].push(code);
    }

    // Build a map from shift ID to shift for easy lookup.
    const shiftById = new Map();
    for (const shift of shifts) {
      shiftById.set(shift.id, shift);
    }

    // Transform assignments to domain shape: employeeId, shiftId, startsAt, endsAt, requiredCertificationCodes.
    const domainAssignments = [];
    for (const assignment of assignments) {
      const shift = shiftById.get(assignment.shift_id);
      if (!shift) continue; // Orphaned assignment, skip.
      const requiredCodes = [];
      for (const certId of shift.required_certification_ids ?? []) {
        const code = certIdToCode.get(certId);
        if (code) requiredCodes.push(code);
      }
      domainAssignments.push({
        employeeId: assignment.employee_id,
        shiftId: assignment.shift_id,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        requiredCertificationCodes: requiredCodes
      });
    }

    // Call the domain function once -- it already computes doubleBookings
    // internally (gated on config's conflictCheckEnabled), so a separate
    // findDoubleBookings call here would just duplicate that work.
    const readiness = summarizeScheduleReadiness(domainAssignments, certificationsByEmployee, config, {
      roleRequirements
    });

    // Assignments actually inside this period's shifts (the same "orphaned
    // assignment" narrowing domainAssignments already applies above),
    // adapted to buildChangeSummary's shape for the publish route.
    const periodAssignmentRows = assignments.filter((assignment) => shiftById.has(assignment.shift_id));

    return {
      readiness,
      shiftRows: shifts,
      assignmentRows: periodAssignmentRows
    };
  }

  // --- Schedule Periods -------------------------------------------------------
  // Lists all schedule periods for a facility.
  router.register(
    "GET",
    "/facilities/:facilityId/schedule-periods",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "schedule_periods", {
          filters: { facility_id: params.facilityId },
          select: PERIOD_COLUMNS,
          order: "week_start_date.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a new schedule period in 'draft' status. Validates shape (and the
  // same week_start_date <= week_end_date bound schedule_periods_week_range_check
  // enforces at the DB layer, 0009_rls_hardening.sql) before guarding, so a bad
  // payload never reaches PostgREST. The (facility_id, department_id,
  // week_start_date) unique constraint (0003_scheduling.sql) is left to the DB;
  // a violation surfaces here as 409 rather than the generic 500 an uncaught
  // PostgrestError would produce.
  router.register(
    "POST",
    "/facilities/:facilityId/schedule-periods",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { weekStartDate, weekEndDate } = body.payload;
        const shape = [];
        if (!weekStartDate) shape.push("weekStartDate is required");
        if (!weekEndDate) shape.push("weekEndDate is required");
        if (weekStartDate && weekEndDate && weekStartDate > weekEndDate) {
          shape.push("weekStartDate must not be after weekEndDate");
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.departmentId ?? null,
          week_start_date: weekStartDate,
          week_end_date: weekEndDate,
          status: "draft",
          publish_version: 0,
          metadata: body.payload.metadata ?? {}
        };
        try {
          const rows = await pgInsert(auth.client, "schedule_periods", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, {
              error: "a schedule period already exists for this facility, department, and week"
            });
          }
          throw err;
        }
      })
  );

  // Transitions a schedule period's status via the pure canTransitionPeriod
  // legal-transition graph. Order of checks: request shape (400) -> period
  // exists (404) -> period belongs to the facility in the URL (403) ->
  // schedule.manage (403) -> transition is legal (400).
  router.register(
    "PATCH",
    "/facilities/:facilityId/schedule-periods/:periodId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const targetStatus = body.payload?.status;
        if (!targetStatus || !PERIOD_STATUS_VALUES.includes(targetStatus)) {
          return sendJson(response, 400, {
            error: `status is required and must be one of ${PERIOD_STATUS_VALUES.join(", ")}`
          });
        }

        const period = await loadPeriod(auth.client, params.periodId);
        if (!period) return sendJson(response, 404, { error: "schedule period not found" });
        if (period.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "schedule period does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        if (!canTransitionPeriod(period.status, targetStatus)) {
          return sendJson(response, 400, {
            error: `cannot transition schedule period from '${period.status}' to '${targetStatus}'`
          });
        }

        const rows = await pgUpdate(
          auth.client,
          "schedule_periods",
          { id: params.periodId, facility_id: params.facilityId },
          { status: targetStatus, updated_at: new Date().toISOString() },
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Shift Templates ---------------------------------------------------------
  // CRUD for shift_templates (0003_scheduling.sql). Writes validate shape via
  // the pure validateTemplateInput BEFORE any fetch, so an invalid payload
  // never reaches PostgREST or the permission check.
  //
  // Soft-delete decision (SC-02): 0026_soft_delete_policy_hardening.sql
  // tightened "schedule managers can manage shift templates" so its USING
  // clause requires deleted_at is null; Postgres then refuses any client
  // UPDATE whose resulting row would be invisible under that same policy, so
  // a plain client-authenticated UPDATE can no longer set deleted_at on this
  // table (see that migration's header for the full mechanism/repro).
  // shift_templates already carries its own `active boolean` column
  // (0003_scheduling.sql) independent of deleted_at, so the "delete" endpoint
  // below deactivates the template (active=false) instead of hard soft-
  // deleting it -- that is sufficient for what consumers actually need
  // (stop generating/showing the template). A true deleted_at soft delete
  // needs the future SECURITY DEFINER RPC noted in 0026's header.
  router.register(
    "GET",
    "/facilities/:facilityId/shift-templates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const activeParam = qp.get("active");
        if (activeParam !== null) filters.active = activeParam === "true";
        const rows = await pgSelect(auth.client, "shift_templates", {
          filters,
          select: SHIFT_TEMPLATE_COLUMNS,
          order: "role_code.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/shift-templates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const validation = validateTemplateInput(body.payload);
        if (!validation.valid) return sendJson(response, 400, { errors: validation.errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          department_id: body.payload.departmentId ?? null,
          role_code: body.payload.roleCode,
          recurrence_rule: body.payload.recurrenceRule ?? "weekly",
          start_time_local: body.payload.startTimeLocal,
          end_time_local: body.payload.endTimeLocal,
          days_of_week: body.payload.daysOfWeek,
          required_certification_ids: body.payload.requiredCertificationIds ?? [],
          active: true
        };
        const rows = await pgInsert(auth.client, "shift_templates", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  router.register(
    "PATCH",
    "/facilities/:facilityId/shift-templates/:templateId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const validation = validateTemplateInput(body.payload, { partial: true });
        if (!validation.valid) return sendJson(response, 400, { errors: validation.errors });

        const template = await loadShiftTemplate(auth.client, params.templateId);
        if (!template) return sendJson(response, 404, { error: "shift template not found" });
        if (template.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "shift template does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const p = body.payload;
        const patch = {};
        if (p.departmentId !== undefined) patch.department_id = p.departmentId;
        if (p.roleCode !== undefined) patch.role_code = p.roleCode;
        if (p.recurrenceRule !== undefined) patch.recurrence_rule = p.recurrenceRule;
        if (p.startTimeLocal !== undefined) patch.start_time_local = p.startTimeLocal;
        if (p.endTimeLocal !== undefined) patch.end_time_local = p.endTimeLocal;
        if (p.daysOfWeek !== undefined) patch.days_of_week = p.daysOfWeek;
        if (p.requiredCertificationIds !== undefined) patch.required_certification_ids = p.requiredCertificationIds;
        if (p.active !== undefined) patch.active = p.active;
        if (Object.keys(patch).length === 0) {
          return sendJson(response, 400, { error: "nothing to update" });
        }
        patch.updated_at = new Date().toISOString();

        const rows = await pgUpdate(
          auth.client,
          "shift_templates",
          { id: params.templateId, facility_id: params.facilityId },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Soft-DELETE -- see the family comment above the GET route: this
  // deactivates (active=false) rather than setting deleted_at.
  router.register(
    "DELETE",
    "/facilities/:facilityId/shift-templates/:templateId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const template = await loadShiftTemplate(auth.client, params.templateId);
        if (!template) return sendJson(response, 404, { error: "shift template not found" });
        if (template.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "shift template does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const rows = await pgUpdate(
          auth.client,
          "shift_templates",
          { id: params.templateId, facility_id: params.facilityId },
          { active: false, updated_at: new Date().toISOString() },
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Generate shifts from templates (SC-03) ---------------------------------
  // POST .../schedule-periods/:periodId/generate expands the facility's active
  // shift_templates over the period's week (expandTemplates, DST-safe) and
  // inserts the resulting rows as source='template' schedule_shifts. Idempotent:
  // a template/date pair that already produced a shift (matched via
  // shiftNaturalKey against the period's existing source='template' shifts) is
  // skipped rather than re-inserted, so re-running the same generate call is
  // always safe. Only legal on periods still open for editing (draft/review);
  // published/archived periods are locked (GENERATABLE_PERIOD_STATUSES).
  router.register(
    "POST",
    "/facilities/:facilityId/schedule-periods/:periodId/generate",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const period = await loadPeriod(auth.client, params.periodId);
        if (!period) return sendJson(response, 404, { error: "schedule period not found" });
        if (period.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "schedule period does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        if (!GENERATABLE_PERIOD_STATUSES.includes(period.status)) {
          return sendJson(response, 409, {
            error: `cannot generate shifts for a schedule period in status '${period.status}'`
          });
        }

        const [templateRows, existingShiftRows, facility] = await Promise.all([
          pgSelect(auth.client, "shift_templates", {
            filters: { facility_id: params.facilityId, active: true },
            select: SHIFT_TEMPLATE_COLUMNS
          }),
          pgSelect(auth.client, "schedule_shifts", {
            filters: { facility_id: params.facilityId, schedule_period_id: params.periodId, source: "template" },
            select: SHIFT_COLUMNS
          }),
          loadFacilityOrgId(auth.client, params.facilityId)
        ]);

        const timeZone = facility?.timezone || "America/New_York";
        const existingKeys = new Set(
          (existingShiftRows ?? []).map((shift) =>
            shiftNaturalKey(shift.department_id, shift.role_code, shift.shift_date, shift.starts_at, shift.ends_at)
          )
        );

        const expanded = expandTemplates(templateRows ?? [], period.week_start_date, timeZone);
        const toInsert = expanded.filter(
          (row) =>
            !existingKeys.has(shiftNaturalKey(row.departmentId, row.roleCode, row.shiftDate, row.startsAt, row.endsAt))
        );

        if (toInsert.length === 0) {
          return sendJson(response, 200, { inserted: [] });
        }

        const rows = toInsert.map((row) => ({
          facility_id: params.facilityId,
          schedule_period_id: params.periodId,
          department_id: row.departmentId,
          role_code: row.roleCode,
          shift_date: row.shiftDate,
          starts_at: row.startsAt,
          ends_at: row.endsAt,
          source: "template",
          status: "draft",
          required_certification_ids: row.requiredCertificationIds,
          notes: null
        }));

        const inserted = await pgInsert(auth.client, "schedule_shifts", rows, { returning: true });
        return sendJson(response, 201, { inserted: inserted ?? [] });
      })
  );

  // --- Employees (read-only, for the future board's assignee picker; SC-09) --
  // No employees listing route existed anywhere in src/lib/http/ before this
  // (grepped for pgSelect(..., "employees", ...) and any /employees route --
  // communications-routes.mjs only resolves a single caller's own employee id,
  // it does not list). Gated on schedule.read per the plan, not the employees
  // table's own broader "members can read employees" RLS reader policy.
  router.register(
    "GET",
    "/facilities/:facilityId/employees",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        if (status) filters.status = status;
        const rows = await pgSelect(auth.client, "employees", {
          filters,
          select: EMPLOYEE_COLUMNS,
          order: "last_name.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // --- Schedule Shifts --------------------------------------------------------
  // Lists all schedule shifts for a facility. Optional ?period_id= filters by
  // schedule_period_id.
  router.register(
    "GET",
    "/facilities/:facilityId/shifts",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const periodId = qp.get("period_id");
        if (periodId) filters.schedule_period_id = periodId;
        const rows = await pgSelect(auth.client, "schedule_shifts", {
          filters,
          select: SHIFT_COLUMNS,
          order: "shift_date.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a new schedule shift. Validates minimal shape before guarding
  // (no fetch on validation failure). The shift is inserted with status='draft'.
  router.register(
    "POST",
    "/facilities/:facilityId/shifts",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { schedulePeriodId, roleCode, shiftDate, startsAt, endsAt } = body.payload;
        const shape = [];
        if (!schedulePeriodId) shape.push("schedulePeriodId is required");
        if (!roleCode) shape.push("roleCode is required");
        if (!shiftDate) shape.push("shiftDate is required");
        if (!startsAt) shape.push("startsAt is required");
        if (!endsAt) shape.push("endsAt is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const row = {
          facility_id: params.facilityId,
          schedule_period_id: schedulePeriodId,
          department_id: body.payload.departmentId ?? null,
          role_code: roleCode,
          shift_date: shiftDate,
          starts_at: startsAt,
          ends_at: endsAt,
          source: body.payload.source ?? "manual",
          status: "draft",
          required_certification_ids: body.payload.requiredCertificationIds ?? [],
          notes: body.payload.notes ?? null
        };
        const rows = await pgInsert(auth.client, "schedule_shifts", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Edits a schedule shift: times, role, notes, and status (including
  // 'open'/'cancelled'). Always requires schedule.manage. When the shift
  // belongs to a period whose status is 'published', it is already visible to
  // staff, so the edit additionally requires a non-empty `reason`, which gets
  // appended to the shift's notes as a timestamped line -- there is no
  // separate audit table for scheduling yet, so notes is the record.
  // pgUpdate's filter carries both id and facility_id, so the write itself is
  // facility-scoped even though the row was already loaded/verified above.
  router.register(
    "PATCH",
    "/facilities/:facilityId/shifts/:shiftId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const shift = await loadShift(auth.client, params.shiftId);
        if (!shift) return sendJson(response, 404, { error: "shift not found" });
        if (shift.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "shift does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const p = body.payload;
        if (p.status !== undefined && !SHIFT_STATUS_VALUES.includes(p.status)) {
          return sendJson(response, 400, { error: `status must be one of ${SHIFT_STATUS_VALUES.join(", ")}` });
        }

        const patch = {};
        if (p.startsAt !== undefined) patch.starts_at = p.startsAt;
        if (p.endsAt !== undefined) patch.ends_at = p.endsAt;
        if (p.roleCode !== undefined) patch.role_code = p.roleCode;
        if (p.notes !== undefined) patch.notes = p.notes;
        if (p.status !== undefined) patch.status = p.status;
        if (Object.keys(patch).length === 0) {
          return sendJson(response, 400, { error: "nothing to update" });
        }

        const period = await loadPeriod(auth.client, shift.schedule_period_id);
        if (period?.status === "published") {
          const reason = typeof p.reason === "string" ? p.reason.trim() : "";
          if (!reason) {
            return sendJson(response, 400, {
              error: "reason is required to edit a shift in a published period"
            });
          }
          const baseNotes = patch.notes !== undefined ? patch.notes : shift.notes;
          const reasonLine = `[${new Date().toISOString()}] edited (published period): ${reason}`;
          patch.notes = baseNotes ? `${baseNotes}\n${reasonLine}` : reasonLine;
        }

        patch.updated_at = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "schedule_shifts",
          { id: params.shiftId, facility_id: params.facilityId },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Shift Assignments (SC-05) -----------------------------------------------
  // Assigns an employee to a shift. When the facility's
  // scheduling.conflictCheckEnabled setting is on (the default), the employee's
  // other still-live assignments (status in ACTIVE_ASSIGNMENT_STATUSES -- a
  // declined/cancelled assignment no longer occupies their calendar) are
  // checked for a time overlap against this shift via the pure shiftsOverlap;
  // an overlap blocks the assignment with 409 and a conflict payload instead of
  // reaching the DB. The shift itself (same shift_id) is excluded from that
  // comparison so a second assignment_type ('cover') on the same shift is never
  // flagged as a self-conflict. A unique-constraint violation on
  // (shift_id, employee_id, assignment_type) -- i.e. the employee is already
  // assigned to this shift with this assignment type -- is still caught and
  // surfaced as a clean 409 rather than an uncaught PostgrestError.
  router.register(
    "POST",
    "/facilities/:facilityId/shifts/:shiftId/assignments",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { employeeId } = body.payload;
        const assignmentType = body.payload.assignmentType ?? "primary";
        const shape = [];
        if (!employeeId) shape.push("employeeId is required");
        if (!ASSIGNMENT_TYPE_VALUES.includes(assignmentType)) {
          shape.push(`assignmentType must be one of ${ASSIGNMENT_TYPE_VALUES.join(", ")}`);
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const shift = await loadShift(auth.client, params.shiftId);
        if (!shift) return sendJson(response, 404, { error: "shift not found" });
        if (shift.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "shift does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        const config = await loadSchedulingConfig(auth.client, params.facilityId);
        const conflictCheckEnabled = configValue(config, "scheduling.conflictCheckEnabled");

        if (conflictCheckEnabled) {
          const otherAssignments = await pgSelect(auth.client, "shift_assignments", {
            filters: {
              facility_id: params.facilityId,
              employee_id: employeeId,
              status: { in: ACTIVE_ASSIGNMENT_STATUSES }
            },
            select: ASSIGNMENT_COLUMNS
          });
          const liveOthers = (otherAssignments ?? []).filter((a) => a.shift_id !== params.shiftId);

          if (liveOthers.length > 0) {
            const otherShiftIds = [...new Set(liveOthers.map((a) => a.shift_id))];
            const otherShiftRows = await pgSelect(auth.client, "schedule_shifts", {
              filters: { id: { in: otherShiftIds } },
              select: SHIFT_COLUMNS
            });
            const otherShiftById = new Map((otherShiftRows ?? []).map((s) => [s.id, s]));

            const conflicts = [];
            for (const other of liveOthers) {
              const otherShift = otherShiftById.get(other.shift_id);
              if (!otherShift) continue;
              if (
                shiftsOverlap(
                  { startsAt: otherShift.starts_at, endsAt: otherShift.ends_at },
                  { startsAt: shift.starts_at, endsAt: shift.ends_at }
                )
              ) {
                conflicts.push({ employeeId, shiftIds: [otherShift.id, shift.id], assignmentId: other.id });
              }
            }
            if (conflicts.length > 0) {
              return sendJson(response, 409, {
                error: "employee already has an overlapping shift assignment",
                conflicts
              });
            }
          }
        }

        const row = {
          facility_id: params.facilityId,
          shift_id: params.shiftId,
          employee_id: employeeId,
          assignment_type: assignmentType,
          assigned_by: auth.claims.sub
        };
        try {
          const rows = await pgInsert(auth.client, "shift_assignments", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, {
              error: "employee is already assigned to this shift with this assignment type"
            });
          }
          throw err;
        }
      })
  );

  // PATCHes a shift assignment's status. shift_assignments.status is
  // constrained to pending/approved/declined/cancelled (0003_scheduling.sql);
  // canTransitionAssignment enforces the legal-transition graph (pending can
  // move to any of the three; approved/declined can only be cancelled, which
  // is this API's "unassign" -- there is no separate DELETE route; cancelled is
  // terminal). Order of checks mirrors PATCH schedule-periods: shape -> exists
  // (404) -> belongs to both the facility and the shift in the URL (403/404) ->
  // schedule.manage (403) -> transition legality (400).
  router.register(
    "PATCH",
    "/facilities/:facilityId/shifts/:shiftId/assignments/:assignmentId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const targetStatus = body.payload?.status;
        if (!targetStatus || !ASSIGNMENT_STATUSES.includes(targetStatus)) {
          return sendJson(response, 400, {
            error: `status is required and must be one of ${ASSIGNMENT_STATUSES.join(", ")}`
          });
        }

        const assignment = await loadAssignment(auth.client, params.assignmentId);
        if (!assignment) return sendJson(response, 404, { error: "shift assignment not found" });
        if (assignment.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "shift assignment does not belong to this facility" });
        }
        if (assignment.shift_id !== params.shiftId) {
          return sendJson(response, 404, { error: "shift assignment not found for this shift" });
        }
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        if (!canTransitionAssignment(assignment.status, targetStatus)) {
          return sendJson(response, 400, {
            error: `cannot transition shift assignment from '${assignment.status}' to '${targetStatus}'`
          });
        }

        const rows = await pgUpdate(
          auth.client,
          "shift_assignments",
          { id: params.assignmentId, facility_id: params.facilityId },
          { status: targetStatus, updated_at: new Date().toISOString() },
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // Validates schedule readiness by loading shifts and assignments (optionally
  // scoped to one schedule period via ?period_id= or a { periodId } body
  // field -- omitting it keeps the prior facility-wide behavior), the
  // facility's live scheduling config, and any per-requirement cert-policy
  // overrides, then calling summarizeScheduleReadiness (via the
  // computeScheduleReadiness helper shared with the publish route below).
  // Returns the domain-lib result: { canPublish, doubleBookings, missingCertifications, warnings, certEnforcementMode }
  router.register(
    "POST",
    "/facilities/:facilityId/schedule/validate",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;

        const body = await parseJsonBody(request);
        const qp = queryParams(request);
        const periodId =
          qp.get("period_id") || (body.ok ? body.payload?.periodId ?? body.payload?.period_id : undefined) || undefined;

        const { readiness } = await computeScheduleReadiness(auth.client, params.facilityId, { periodId });

        return sendJson(response, 200, {
          canPublish: readiness.canPublish,
          doubleBookings: readiness.doubleBookings,
          missingCertifications: readiness.missingCertifications,
          warnings: readiness.warnings,
          certEnforcementMode: readiness.certEnforcementMode
        });
      })
  );

  // --- Publish (SC-07) ---------------------------------------------------------
  // POST .../schedule-periods/:periodId/publish runs the SAME readiness check
  // as POST /schedule/validate (via computeScheduleReadiness, scoped to this
  // period -- no duplicated validation logic), then:
  //   1. Rejects (409) if the period's current status cannot reach 'published'
  //      -- either directly illegal (canTransitionPeriod, e.g. from
  //      'archived') or, when the facility's
  //      scheduling.requireApprovalBeforePublish setting is true, because the
  //      period hasn't gone through 'review' first. An already-'published'
  //      period is exempt from both checks -- this is a *republish* (e.g. a
  //      correction after the fact), not a fresh transition into 'published',
  //      so there is nothing to transition and no fresh review gate to pass;
  //      canTransitionPeriod('published','published') is (correctly) illegal
  //      per SC-01's transition graph, so this route special-cases it rather
  //      than calling that check for an already-published period.
  //   2. Rejects (409) with the readiness payload if there are blocking
  //      issues (doubleBookings or non-warning missingCertifications) UNLESS
  //      the body supplies a non-empty `overrideReason`, which is then
  //      recorded on the publication row's change_summary alongside the
  //      blocking issues it overrode.
  //   3. Computes the change summary via buildChangeSummary, diffing the
  //      current shift/assignment state against the snapshot embedded in the
  //      period's most recent prior schedule_publications row (or against []
  //      for a period's first publish -- schedule_shifts/shift_assignments
  //      carry no history of their own, so that embedded snapshot is the only
  //      place a "previous state" can come from for the next publish's diff).
  //   4. Inserts a new schedule_publications row at publish_version + 1, then
  //      updates the period's publish_version to match and its status to
  //      'published' (only when it wasn't already).
  router.register(
    "POST",
    "/facilities/:facilityId/schedule-periods/:periodId/publish",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const period = await loadPeriod(auth.client, params.periodId);
        if (!period) return sendJson(response, 404, { error: "schedule period not found" });
        if (period.facility_id !== params.facilityId) {
          return sendJson(response, 403, { error: "schedule period does not belong to this facility" });
        }
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;

        const alreadyPublished = period.status === "published";
        if (!alreadyPublished && !canTransitionPeriod(period.status, "published")) {
          return sendJson(response, 409, {
            error: `cannot publish a schedule period in status '${period.status}'`
          });
        }

        const config = await loadSchedulingConfig(auth.client, params.facilityId);
        const requireApproval = configValue(config, "scheduling.requireApprovalBeforePublish");
        if (!alreadyPublished && requireApproval && period.status !== "review") {
          return sendJson(response, 409, {
            error: "this facility requires a schedule period to be in 'review' status before it can be published"
          });
        }

        const { readiness, shiftRows, assignmentRows } = await computeScheduleReadiness(auth.client, params.facilityId, {
          periodId: params.periodId
        });

        const overrideReason = typeof body.payload?.overrideReason === "string" ? body.payload.overrideReason.trim() : "";
        if (!readiness.canPublish && !overrideReason) {
          return sendJson(response, 409, {
            error: "schedule period is not ready to publish",
            canPublish: readiness.canPublish,
            doubleBookings: readiness.doubleBookings,
            missingCertifications: readiness.missingCertifications,
            warnings: readiness.warnings,
            certEnforcementMode: readiness.certEnforcementMode
          });
        }

        // The prior publication (if any) carries the snapshot this publish's
        // diff is computed against, embedded in its own change_summary --
        // schedule_shifts/shift_assignments have no history table of their
        // own to diff against instead.
        const priorPublicationRows = await pgSelect(auth.client, "schedule_publications", {
          filters: { facility_id: params.facilityId, schedule_period_id: params.periodId },
          select: PUBLICATION_COLUMNS,
          order: "publish_version.desc",
          limit: 1
        });
        const priorPublication = (priorPublicationRows ?? [])[0] ?? null;
        const previousShifts = priorPublication?.change_summary?.snapshot?.shifts ?? [];
        const previousAssignments = priorPublication?.change_summary?.snapshot?.assignments ?? [];

        const currentShifts = shiftRows.map(toShiftDiffRow);
        const currentAssignments = assignmentRows.map(toAssignmentDiffRow);
        const diff = buildChangeSummary(previousShifts, currentShifts, previousAssignments, currentAssignments);

        const changeSummary = {
          ...diff,
          snapshot: { shifts: currentShifts, assignments: currentAssignments }
        };
        if (!readiness.canPublish && overrideReason) {
          changeSummary.overrideReason = overrideReason;
          changeSummary.overriddenIssues = {
            doubleBookings: readiness.doubleBookings,
            missingCertifications: readiness.missingCertifications
          };
        }

        const newPublishVersion = (period.publish_version ?? 0) + 1;
        const publicationRow = {
          facility_id: params.facilityId,
          schedule_period_id: params.periodId,
          publish_version: newPublishVersion,
          published_by: auth.claims.sub,
          change_summary: changeSummary
        };

        let insertedPublication;
        try {
          const inserted = await pgInsert(auth.client, "schedule_publications", [publicationRow], { returning: true });
          insertedPublication = (inserted ?? [])[0] ?? null;
        } catch (err) {
          if (err instanceof PostgrestError && err.status === 409) {
            return sendJson(response, 409, {
              error: "a publication already exists for this schedule period at this publish version"
            });
          }
          throw err;
        }

        const periodPatch = { publish_version: newPublishVersion, updated_at: new Date().toISOString() };
        if (!alreadyPublished) periodPatch.status = "published";

        const updatedPeriodRows = await pgUpdate(
          auth.client,
          "schedule_periods",
          { id: params.periodId, facility_id: params.facilityId },
          periodPatch,
          { returning: true }
        );

        return sendJson(response, 200, {
          period: (updatedPeriodRows ?? [])[0] ?? null,
          publication: insertedPublication
        });
      })
  );

  return router;
}
