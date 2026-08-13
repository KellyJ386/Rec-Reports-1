import { pgSelect, pgInsert, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import { summarizeScheduleReadiness, canTransitionPeriod, validateTemplateInput } from "../scheduling.mjs";
import { settingsForModule, effectiveConfig } from "../settings-registry.mjs";

const READ = "schedule.read";
const MANAGE = "schedule.manage";

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
const PERIOD_STATUS_VALUES = ["draft", "review", "published", "archived"];
const SHIFT_STATUS_VALUES = ["draft", "open", "assigned", "published", "cancelled"];
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
  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  function requireRead(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, READ);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function requirePerm(auth, facilityId, code, response) {
    const guard = requireAuthPermission(auth, facilityId, code);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

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

  async function loadFacilityOrgId(client, facilityId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { id: facilityId },
      select: "id,organization_id",
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

  // Validates schedule readiness by loading shifts and assignments (optionally
  // scoped to one schedule period via ?period_id= or a { periodId } body
  // field -- omitting it keeps the prior facility-wide behavior), the
  // facility's live scheduling config, and any per-requirement cert-policy
  // overrides, then calling summarizeScheduleReadiness. Returns the
  // domain-lib result: { canPublish, doubleBookings, missingCertifications, warnings, certEnforcementMode }
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

        const shiftFilters = { facility_id: params.facilityId };
        if (periodId) shiftFilters.schedule_period_id = periodId;

        // Load shifts (period-scoped when period_id given), assignments,
        // certifications, certification types, the facility's effective
        // scheduling config, and active per-requirement cert-policy overrides.
        // shift_assignments carries no schedule_period_id column of its own, so
        // it is loaded facility-wide and scoped to the period implicitly below
        // via shiftById (an assignment whose shift fell outside the period-
        // scoped shifts query is dropped as "orphaned", same as today).
        const [shiftsRows, assignmentsRows, certsRows, certTypesRows, config, roleRequirementRows] = await Promise.all([
          pgSelect(auth.client, "schedule_shifts", {
            filters: shiftFilters,
            select: SHIFT_COLUMNS
          }),
          pgSelect(auth.client, "shift_assignments", {
            filters: { facility_id: params.facilityId },
            select: ASSIGNMENT_COLUMNS
          }),
          pgSelect(auth.client, "employee_certifications", {
            filters: { facility_id: params.facilityId },
            select: EMPLOYEE_CERT_COLUMNS
          }),
          pgSelect(auth.client, "certification_types", {
            filters: { facility_id: params.facilityId },
            select: CERT_TYPE_COLUMNS
          }),
          loadSchedulingConfig(auth.client, params.facilityId),
          pgSelect(auth.client, "certification_role_requirements", {
            filters: { facility_id: params.facilityId },
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

        return sendJson(response, 200, {
          canPublish: readiness.canPublish,
          doubleBookings: readiness.doubleBookings,
          missingCertifications: readiness.missingCertifications,
          warnings: readiness.warnings,
          certEnforcementMode: readiness.certEnforcementMode
        });
      })
  );

  return router;
}
