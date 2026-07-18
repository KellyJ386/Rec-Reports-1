import { pgSelect, pgInsert } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import { findDoubleBookings, summarizeScheduleReadiness } from "../scheduling.mjs";

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

  // Validates schedule readiness by loading shifts and assignments, then
  // calling findDoubleBookings and summarizeScheduleReadiness. Returns the
  // domain-lib result: { canPublish, doubleBookings, missingCertifications, warnings, certEnforcementMode }
  router.register(
    "POST",
    "/facilities/:facilityId/schedule/validate",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;

        // Load shifts, assignments, certifications, and certification types.
        const [shiftsRows, assignmentsRows, certsRows, certTypesRows] = await Promise.all([
          pgSelect(auth.client, "schedule_shifts", {
            filters: { facility_id: params.facilityId },
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

        // Call the domain functions.
        const doubleBookings = findDoubleBookings(domainAssignments);
        const readiness = summarizeScheduleReadiness(domainAssignments, certificationsByEmployee);

        return sendJson(response, 200, {
          canPublish: readiness.canPublish,
          doubleBookings,
          missingCertifications: readiness.missingCertifications,
          warnings: readiness.warnings,
          certEnforcementMode: readiness.certEnforcementMode
        });
      })
  );

  return router;
}
