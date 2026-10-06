// Scheduling self-service API (Wave 3 Slice 3D, SC-11 .. SC-16): open-shift
// claims, shift swaps, time-off requests, availability, "My schedule" and the
// manager approvals queue. Tables, guards and the atomic decide_* RPCs live in
// supabase/migrations/0062_scheduling_self_service.sql.
//
// Authorization model (every route re-derives it; nothing is trusted from a
// body):
//   * employee routes need facility MEMBERSHIP, not a schedule permission, and
//     act as the caller's OWN employees row, resolved from auth.claims.sub --
//     a client-supplied employee id is never read;
//   * decision routes need the approver code for the kind (schedule.manage
//     also satisfies claims and swaps, never time off) and then ONLY call the
//     definer RPC -- this module never writes a decision, an assignment or a
//     shift status itself, so an approval is one atomic database transaction;
//   * the approvals queue only returns the kinds the caller may decide.
//
// Pre-validation (checkAssignmentEligibility / resolveClaim / planSwap in
// src/lib/scheduling.mjs, which wire findMissingCertifications and
// shiftsOverlap) gives a caller a structured 409 before the RPC runs. It reads
// through the CALLER'S client, so a manager's view may be narrower than the
// whole facility; the RPC re-validates against the full data and is the
// authority.
import { pgSelect, pgInsert, pgUpdate, pgRpc, PostgrestError } from "../supabase-rest.mjs";
import { makeGuards, requireAuthPermission } from "./guard.mjs";
import { loadSchedulingConfig, loadFacilityOrgId } from "./scheduling-routes.mjs";
import { configValue } from "../settings-registry.mjs";
import {
  APPROVAL_TYPES,
  SWAP_TYPES,
  REQUEST_DECISIONS,
  buildApprovalItems,
  buildMySchedule,
  certificationsHeldOn,
  checkAssignmentEligibility,
  isClaimWindowOpen,
  isValidDateOnly,
  planSwap,
  resolveClaim,
  validateAvailabilityInput,
  validateDecisionInput,
  validateTimeOffInput,
  weekRangeFor
} from "../scheduling.mjs";

const APPROVE_SWAPS = "schedule.approve.swaps";
const APPROVE_TIME_OFF = "schedule.approve.time_off";
const MANAGE_OPEN_SHIFTS = "schedule.manage.open_shifts";
const MANAGE = "schedule.manage";

const SHIFT_COLUMNS =
  "id,facility_id,schedule_period_id,department_id,role_code,shift_date,starts_at,ends_at,source,status,required_certification_ids,notes,opened_at,deleted_at,created_at,updated_at";
const ASSIGNMENT_COLUMNS =
  "id,facility_id,shift_id,employee_id,assignment_type,status,assigned_by,deleted_at,created_at,updated_at";
const PERIOD_COLUMNS = "id,facility_id,week_start_date,week_end_date,status,publish_version,deleted_at";
const CLAIM_COLUMNS =
  "id,facility_id,shift_id,claimant_employee_id,claim_status,manager_id,decided_at,decision_reason,created_at,updated_at,deleted_at";
const SWAP_COLUMNS =
  "id,facility_id,offered_assignment_id,requested_assignment_id,requester_employee_id,target_employee_id,swap_type,status,reason,manager_id,decided_at,decision_reason,target_accepted_at,target_declined_at,created_at,updated_at,deleted_at";
const TIME_OFF_COLUMNS =
  "id,facility_id,employee_id,starts_at,ends_at,request_type,status,reason,manager_id,decided_at,decision_notes,created_at,updated_at,deleted_at";
const AVAILABILITY_COLUMNS =
  "id,facility_id,employee_id,weekday,available_start_local,available_end_local,unavailable,effective_from,effective_to,created_at,updated_at";
const EMPLOYEE_NAME_COLUMNS = "id,first_name,last_name";
const CERT_COLUMNS = "id,employee_id,certification_type_id,status,expires_at,deleted_at";
const CERT_TYPE_COLUMNS = "id,code";
const LIVE_ASSIGNMENT_STATUSES = ["pending", "approved"];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
// The approvals queue merges three tables in memory, so the page window
// (limit + offset) is bounded.
const MAX_LIST_OFFSET = 1000;
const OPEN_SHIFT_LIST_LIMIT = 200;

// One entry per request kind: the REST path segment, table, status column,
// the approver codes (any one suffices), the decide_* RPC and the query-param
// spelling GET /approvals uses.
const KINDS = Object.freeze({
  claims: {
    key: "claims",
    path: "open-shift-claims",
    table: "open_shift_claims",
    statusColumn: "claim_status",
    columns: CLAIM_COLUMNS,
    approverCodes: [MANAGE_OPEN_SHIFTS, MANAGE],
    rpc: "decide_open_shift_claim",
    statuses: ["pending", "approved", "denied", "withdrawn"]
  },
  swaps: {
    key: "swaps",
    path: "shift-swaps",
    table: "shift_swap_requests",
    statusColumn: "status",
    columns: SWAP_COLUMNS,
    approverCodes: [APPROVE_SWAPS, MANAGE],
    rpc: "decide_shift_swap",
    statuses: ["pending", "approved", "denied", "cancelled", "expired"]
  },
  time_off: {
    key: "time_off",
    path: "time-off-requests",
    table: "time_off_requests",
    statusColumn: "status",
    columns: TIME_OFF_COLUMNS,
    approverCodes: [APPROVE_TIME_OFF],
    rpc: "decide_time_off_request",
    statuses: ["pending", "approved", "denied", "cancelled"]
  }
});

const SWAP_RESPONSES = Object.freeze(["accept", "decline"]);

const ALL_APPROVAL_STATUSES = [...new Set(Object.values(KINDS).flatMap((kind) => kind.statuses))];

function parseDetails(error) {
  const raw = error?.body?.details;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Maps an error raised by a decide_* RPC (or a 0062 guard trigger) to the
// HTTP answer a caller should see, relaying our own raise-exception text
// (never a driver/stack string). SQLSTATEs: 42501 permission, P0002 not
// found, PT409 stale/ineligible/conflict (PostgREST maps PTnnn to status
// nnn), 23514 check_violation (guard rejection), 22023 bad decision, 23505
// unique. Returns null for anything else so it still reaches the central
// handler.
function requestErrorResponse(error) {
  if (!(error instanceof PostgrestError)) return null;
  const code = String(error.body?.code ?? "");
  const message = typeof error.body?.message === "string" ? error.body.message : "request rejected";
  if (code === "42501" || error.status === 403) return { status: 403, body: { error: message } };
  if (code === "P0002" || error.status === 404) return { status: 404, body: { error: message } };
  if (code === "PT409" || code === "23505" || error.status === 409) {
    const details = parseDetails(error);
    return { status: 409, body: { error: message, ...(details ? { details } : {}) } };
  }
  if (code === "23514" || code === "22023") return { status: 400, body: { error: message } };
  return null;
}

function isUuidLike(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function registerSchedulingSelfServiceRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requireMember, parseJsonBody, queryParams, parseListLimitOffset } = guards;

  function hasAny(auth, facilityId, codes) {
    return codes.some((code) => requireAuthPermission(auth, facilityId, code).allowed);
  }

  // Sends a 403 naming the first code unless the caller holds any of them.
  function requireAny(auth, facilityId, codes, response) {
    if (hasAny(auth, facilityId, codes)) return true;
    sendJson(response, 403, { error: `missing permission: ${codes[0]}` });
    return false;
  }

  // The caller's own employees.id in a facility, from their auth user id --
  // employees.user_id is what every 0062 self-service policy keys on, and it
  // is NOT the auth user id itself.
  async function loadCallerEmployeeId(client, facilityId, userId) {
    const rows = await pgSelect(client, "employees", {
      filters: { facility_id: facilityId, user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? [])[0]?.id ?? null;
  }

  async function requireEmployee(auth, facilityId, response) {
    const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
    if (!employeeId) {
      sendJson(response, 403, { error: "no employee record for this facility" });
      return null;
    }
    return employeeId;
  }

  async function loadOne(client, table, columns, filters) {
    const rows = await pgSelect(client, table, { filters, select: columns, limit: 1 });
    return (rows ?? [])[0] ?? null;
  }

  // --- Eligibility context (pre-validation only) ---------------------------------
  async function loadFacilityContext(client, facilityId) {
    const [config, facility, certTypes] = await Promise.all([
      loadSchedulingConfig(client, facilityId),
      loadFacilityOrgId(client, facilityId),
      pgSelect(client, "certification_types", {
        filters: { facility_id: facilityId },
        select: CERT_TYPE_COLUMNS
      })
    ]);
    return { config, timeZone: facility?.timezone ?? "UTC", certTypes: certTypes ?? [] };
  }

  // One employee's live assignments (joined to their shifts), certifications,
  // pending/approved time off and availability rules.
  async function loadEmployeeContext(client, facilityId, employeeId) {
    const [assignmentRows, certRows, timeOffRows, availabilityRows] = await Promise.all([
      pgSelect(client, "shift_assignments", {
        filters: { facility_id: facilityId, employee_id: employeeId, status: { in: LIVE_ASSIGNMENT_STATUSES } },
        select: ASSIGNMENT_COLUMNS,
        extra: { deleted_at: "is.null" }
      }),
      pgSelect(client, "employee_certifications", {
        filters: { facility_id: facilityId, employee_id: employeeId },
        select: CERT_COLUMNS
      }),
      pgSelect(client, "time_off_requests", {
        filters: { facility_id: facilityId, employee_id: employeeId, status: { in: ["pending", "approved"] } },
        select: TIME_OFF_COLUMNS,
        extra: { deleted_at: "is.null" }
      }),
      pgSelect(client, "employee_availability", {
        filters: { facility_id: facilityId, employee_id: employeeId },
        select: AVAILABILITY_COLUMNS,
        extra: { deleted_at: "is.null" }
      })
    ]);
    const shiftIds = [...new Set((assignmentRows ?? []).map((row) => row.shift_id))];
    const shiftRows = shiftIds.length
      ? await pgSelect(client, "schedule_shifts", {
          filters: { id: { in: shiftIds } },
          select: SHIFT_COLUMNS
        })
      : [];
    const shiftById = new Map((shiftRows ?? []).map((row) => [row.id, row]));
    const assignments = [];
    for (const row of assignmentRows ?? []) {
      const shift = shiftById.get(row.shift_id);
      if (!shift || shift.deleted_at || shift.status === "cancelled") continue;
      assignments.push({
        assignmentId: row.id,
        shiftId: row.shift_id,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        status: row.status
      });
    }
    return {
      assignments,
      certRows: certRows ?? [],
      timeOff: (timeOffRows ?? []).map((row) => ({
        id: row.id,
        employeeId: row.employee_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status
      })),
      availability: availabilityRows ?? []
    };
  }

  function eligibilityFor({ employeeId, shift, employeeContext, facilityContext, ignoreAssignmentIds = [] }) {
    const codeById = new Map(facilityContext.certTypes.map((type) => [type.id, type.code]));
    // An unknown required cert id stays required under its own id (no
    // employee can hold it), exactly what the SQL mirror does.
    const requiredCertificationCodes = (shift.required_certification_ids ?? []).map((id) => codeById.get(id) ?? id);
    return checkAssignmentEligibility({
      employeeId,
      shift,
      requiredCertificationCodes,
      certificationsByEmployee: certificationsHeldOn(employeeContext.certRows, facilityContext.certTypes, shift.shift_date),
      employeeAssignments: employeeContext.assignments,
      ignoreAssignmentIds,
      timeOffWindows: employeeContext.timeOff,
      availabilityRows: employeeContext.availability,
      timeZone: facilityContext.timeZone,
      config: facilityContext.config
    });
  }

  // =================================================================================
  // Employee self-service
  // =================================================================================

  // GET /me/schedule?facilityId=&week_start= -- the caller's own published
  // assignments for the week, the week's open shifts, and their own requests.
  router.register("GET", "/me/schedule", (request, response, { env }) =>
    withAuth(request, response, env, async (auth) => {
      const qp = queryParams(request);
      const facilityId = qp.get("facilityId");
      if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
      const weekParam = qp.get("week_start");
      if (weekParam !== null && !isValidDateOnly(weekParam)) {
        return sendJson(response, 400, { error: "week_start must be a YYYY-MM-DD date" });
      }
      if (!requireMember(auth, facilityId, response)) return;

      const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
      const { weekStartDate, weekEndDate } = weekRangeFor(weekParam ?? new Date().toISOString().slice(0, 10));
      if (!employeeId) {
        return sendJson(response, 200, buildMySchedule({ employeeId: null, weekStartDate }));
      }

      const periods = await pgSelect(auth.client, "schedule_periods", {
        filters: { facility_id: facilityId, status: "published" },
        select: PERIOD_COLUMNS,
        extra: { week_start_date: `lte.${weekEndDate}`, week_end_date: `gte.${weekStartDate}`, deleted_at: "is.null" }
      });
      const periodIds = (periods ?? []).map((period) => period.id);
      const shifts = periodIds.length
        ? await pgSelect(auth.client, "schedule_shifts", {
            filters: {
              facility_id: facilityId,
              schedule_period_id: { in: periodIds },
              shift_date: { gte: weekStartDate, lte: weekEndDate }
            },
            select: SHIFT_COLUMNS,
            extra: { deleted_at: "is.null" },
            order: "starts_at.asc"
          })
        : [];

      const [assignments, claims, swaps, incomingSwapRows, timeOff, config] = await Promise.all([
        // Scoped to the caller's own employee row IN THE QUERY (and again in
        // buildMySchedule), so a schedule.read holder never receives a
        // colleague's assignment from this route.
        pgSelect(auth.client, "shift_assignments", {
          filters: { facility_id: facilityId, employee_id: employeeId, status: { in: LIVE_ASSIGNMENT_STATUSES } },
          select: ASSIGNMENT_COLUMNS,
          extra: { deleted_at: "is.null" }
        }),
        pgSelect(auth.client, "open_shift_claims", {
          filters: { facility_id: facilityId, claimant_employee_id: employeeId },
          select: CLAIM_COLUMNS,
          order: "created_at.desc",
          limit: MAX_LIST_LIMIT
        }),
        pgSelect(auth.client, "shift_swap_requests", {
          filters: { facility_id: facilityId, requester_employee_id: employeeId },
          select: SWAP_COLUMNS,
          order: "created_at.desc",
          limit: MAX_LIST_LIMIT
        }),
        // Requests that NAME the caller as the colleague who must accept
        // (RLS lets the named employee read exactly these).
        pgSelect(auth.client, "shift_swap_requests", {
          filters: { facility_id: facilityId, target_employee_id: employeeId, status: "pending" },
          select: SWAP_COLUMNS,
          extra: { deleted_at: "is.null" },
          order: "created_at.desc",
          limit: MAX_LIST_LIMIT
        }),
        pgSelect(auth.client, "time_off_requests", {
          filters: { facility_id: facilityId, employee_id: employeeId },
          select: TIME_OFF_COLUMNS,
          order: "created_at.desc",
          limit: MAX_LIST_LIMIT
        }),
        loadSchedulingConfig(auth.client, facilityId)
      ]);

      // Who is asking, by name (employee names are readable by every member).
      const incomingSwaps = incomingSwapRows ?? [];
      let requesterNames = new Map();
      if (incomingSwaps.length > 0) {
        const requesters = await pgSelect(auth.client, "employees", {
          filters: { facility_id: facilityId, id: { in: [...new Set(incomingSwaps.map((swap) => swap.requester_employee_id))] } },
          select: EMPLOYEE_NAME_COLUMNS
        });
        requesterNames = new Map((requesters ?? []).map((row) => [row.id, `${row.first_name} ${row.last_name}`.trim()]));
      }

      return sendJson(
        response,
        200,
        buildMySchedule({
          employeeId,
          weekStartDate,
          periods: periods ?? [],
          shifts: shifts ?? [],
          assignments: assignments ?? [],
          claims: claims ?? [],
          swaps: swaps ?? [],
          incomingSwaps: incomingSwaps.map((swap) => ({
            ...swap,
            requester_name: requesterNames.get(swap.requester_employee_id) ?? null
          })),
          timeOff: timeOff ?? [],
          claimWindowHours: configValue(config, "scheduling.openShiftClaimWindowHours")
        })
      );
    })
  );

  // GET /me/availability?facilityId= -- the caller's own weekly rules.
  router.register("GET", "/me/availability", (request, response, { env }) =>
    withAuth(request, response, env, async (auth) => {
      const facilityId = queryParams(request).get("facilityId");
      if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
      if (!requireMember(auth, facilityId, response)) return;
      const employeeId = await requireEmployee(auth, facilityId, response);
      if (!employeeId) return;
      const rows = await pgSelect(auth.client, "employee_availability", {
        filters: { facility_id: facilityId, employee_id: employeeId },
        select: AVAILABILITY_COLUMNS,
        extra: { deleted_at: "is.null" },
        order: "weekday.asc,effective_from.desc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  // PUT /me/availability?facilityId= -- upserts one rule per submitted weekday
  // for the caller's own employee row (employee/facility are server-derived;
  // the body only carries weekday windows).
  router.register("PUT", "/me/availability", (request, response, { env }) =>
    withAuth(request, response, env, async (auth) => {
      const facilityId = queryParams(request).get("facilityId");
      if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const validation = validateAvailabilityInput(body.payload);
      if (!validation.valid) return sendJson(response, 400, { errors: validation.errors });
      if (!requireMember(auth, facilityId, response)) return;
      const employeeId = await requireEmployee(auth, facilityId, response);
      if (!employeeId) return;

      const rows = validation.rows.map((row) => ({
        ...row,
        facility_id: facilityId,
        employee_id: employeeId,
        deleted_at: null
      }));
      const saved = await pgInsert(auth.client, "employee_availability", rows, {
        onConflict: "employee_id,weekday,effective_from",
        merge: true,
        returning: true
      });
      return sendJson(response, 200, saved ?? []);
    })
  );

  // GET /facilities/:facilityId/open-shifts -- published, still-open,
  // unstarted shifts a member may claim, soonest first.
  router.register("GET", "/facilities/:facilityId/open-shifts", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireMember(auth, params.facilityId, response)) return;
      const periods = await pgSelect(auth.client, "schedule_periods", {
        filters: { facility_id: params.facilityId, status: "published" },
        select: "id",
        extra: { deleted_at: "is.null" }
      });
      const periodIds = (periods ?? []).map((period) => period.id);
      if (periodIds.length === 0) return sendJson(response, 200, []);
      const now = new Date();
      const [shifts, config, employeeId] = await Promise.all([
        pgSelect(auth.client, "schedule_shifts", {
          filters: {
            facility_id: params.facilityId,
            status: "open",
            schedule_period_id: { in: periodIds },
            starts_at: { gt: now.toISOString() }
          },
          select: SHIFT_COLUMNS,
          extra: { deleted_at: "is.null" },
          order: "starts_at.asc",
          limit: OPEN_SHIFT_LIST_LIMIT
        }),
        loadSchedulingConfig(auth.client, params.facilityId),
        loadCallerEmployeeId(auth.client, params.facilityId, auth.claims.sub)
      ]);
      const windowHours = configValue(config, "scheduling.openShiftClaimWindowHours");
      let claimedShiftIds = new Set();
      if (employeeId && (shifts ?? []).length > 0) {
        const mine = await pgSelect(auth.client, "open_shift_claims", {
          filters: {
            facility_id: params.facilityId,
            claimant_employee_id: employeeId,
            claim_status: "pending",
            shift_id: { in: shifts.map((shift) => shift.id) }
          },
          select: "shift_id"
        });
        claimedShiftIds = new Set((mine ?? []).map((row) => row.shift_id));
      }
      return sendJson(
        response,
        200,
        (shifts ?? []).map((shift) => ({
          ...shift,
          claim_window_open: isClaimWindowOpen({ openedAt: shift.opened_at ?? shift.updated_at, now, windowHours }),
          claimed_by_me: claimedShiftIds.has(shift.id)
        }))
      );
    })
  );

  // POST /facilities/:facilityId/open-shift-claims { shiftId } -- the caller
  // claims an open shift. The claimant is always the caller's own employee;
  // the facility is taken from the LOADED shift, never the body.
  router.register("POST", "/facilities/:facilityId/open-shift-claims", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { shiftId } = body.payload;
      if (!isUuidLike(shiftId)) return sendJson(response, 400, { errors: ["shiftId is required"] });
      if (!requireMember(auth, params.facilityId, response)) return;
      const employeeId = await requireEmployee(auth, params.facilityId, response);
      if (!employeeId) return;

      const shift = await loadOne(auth.client, "schedule_shifts", SHIFT_COLUMNS, {
        id: shiftId,
        facility_id: params.facilityId
      });
      if (!shift) return sendJson(response, 404, { error: "shift not found" });
      if (shift.status !== "open") return sendJson(response, 409, { error: "this shift is not open for claims" });

      const facilityContext = await loadFacilityContext(auth.client, params.facilityId);
      const windowHours = configValue(facilityContext.config, "scheduling.openShiftClaimWindowHours");
      if (!isClaimWindowOpen({ openedAt: shift.opened_at ?? shift.updated_at, now: new Date(), windowHours })) {
        return sendJson(response, 400, { error: "the claim window for this shift has closed" });
      }

      const employeeContext = await loadEmployeeContext(auth.client, params.facilityId, employeeId);
      const eligibility = eligibilityFor({ employeeId, shift, employeeContext, facilityContext });
      if (!eligibility.ok) {
        return sendJson(response, 409, {
          error: "you are not eligible for this shift",
          blocking: eligibility.blocking,
          warnings: eligibility.warnings
        });
      }

      try {
        const rows = await pgInsert(
          auth.client,
          "open_shift_claims",
          [{ facility_id: params.facilityId, shift_id: shift.id, claimant_employee_id: employeeId }],
          { returning: true }
        );
        return sendJson(response, 201, { claim: (rows ?? [])[0] ?? null, warnings: eligibility.warnings });
      } catch (error) {
        if (error instanceof PostgrestError && (error.status === 409 || error.body?.code === "23505")) {
          return sendJson(response, 409, { error: "you already have a live claim on this shift" });
        }
        const mapped = requestErrorResponse(error);
        if (mapped) return sendJson(response, mapped.status, mapped.body);
        throw error;
      }
    })
  );

  // POST /facilities/:facilityId/shift-swaps -- a direct swap or a
  // drop/pickup of the caller's OWN assignment. requester is the caller; for
  // a direct swap the target is DERIVED from the requested assignment's own
  // employee; a drop_pickup may name a pickup colleague who must be an
  // active employee of this facility.
  router.register("POST", "/facilities/:facilityId/shift-swaps", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { offeredAssignmentId, requestedAssignmentId, targetEmployeeId, swapType, reason } = body.payload;
      const shape = [];
      if (!isUuidLike(offeredAssignmentId)) shape.push("offeredAssignmentId is required");
      if (!SWAP_TYPES.includes(swapType)) shape.push(`swapType must be one of ${SWAP_TYPES.join(", ")}`);
      if (swapType === "direct" && !isUuidLike(requestedAssignmentId)) {
        shape.push("requestedAssignmentId is required for a direct swap");
      }
      if (swapType === "drop_pickup" && requestedAssignmentId) {
        shape.push("requestedAssignmentId is not allowed for a drop_pickup");
      }
      if (swapType === "drop_pickup" && targetEmployeeId !== undefined && targetEmployeeId !== null && !isUuidLike(targetEmployeeId)) {
        shape.push("targetEmployeeId must be an employee id");
      }
      if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 1000)) {
        shape.push("reason must be a string of at most 1000 characters");
      }
      if (shape.length > 0) return sendJson(response, 400, { errors: shape });
      if (!requireMember(auth, params.facilityId, response)) return;
      const requesterId = await requireEmployee(auth, params.facilityId, response);
      if (!requesterId) return;

      const offered = await loadOne(auth.client, "shift_assignments", ASSIGNMENT_COLUMNS, {
        id: offeredAssignmentId,
        facility_id: params.facilityId
      });
      if (!offered) return sendJson(response, 404, { error: "assignment not found" });
      if (offered.employee_id !== requesterId) {
        return sendJson(response, 403, { error: "you can only offer your own assignment" });
      }

      let target = null;
      let requested = null;
      if (swapType === "direct") {
        requested = await loadOne(auth.client, "shift_assignments", ASSIGNMENT_COLUMNS, {
          id: requestedAssignmentId,
          facility_id: params.facilityId
        });
        if (!requested) return sendJson(response, 404, { error: "requested assignment not found" });
        target = requested.employee_id;
        if (target === requesterId) return sendJson(response, 400, { error: "you cannot swap with yourself" });
      } else if (targetEmployeeId) {
        const colleague = await loadOne(auth.client, "employees", `${EMPLOYEE_NAME_COLUMNS},status`, {
          id: targetEmployeeId,
          facility_id: params.facilityId
        });
        if (!colleague || colleague.status !== "active") {
          return sendJson(response, 400, { error: "targetEmployeeId must be an active employee of this facility" });
        }
        if (colleague.id === requesterId) return sendJson(response, 400, { error: "you cannot pick up your own shift" });
        target = colleague.id;
      }

      try {
        const rows = await pgInsert(
          auth.client,
          "shift_swap_requests",
          [
            {
              facility_id: params.facilityId,
              offered_assignment_id: offered.id,
              requested_assignment_id: requested?.id ?? null,
              requester_employee_id: requesterId,
              target_employee_id: target,
              swap_type: swapType,
              reason: typeof reason === "string" && reason.trim() ? reason.trim() : null
            }
          ],
          { returning: true }
        );
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      } catch (error) {
        if (error instanceof PostgrestError && (error.status === 409 || error.body?.code === "23505")) {
          return sendJson(response, 409, { error: "a swap request is already pending for one of these assignments" });
        }
        const mapped = requestErrorResponse(error);
        if (mapped) return sendJson(response, mapped.status, mapped.body);
        throw error;
      }
    })
  );

  // POST /facilities/:facilityId/time-off-requests
  router.register("POST", "/facilities/:facilityId/time-off-requests", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const validation = validateTimeOffInput(body.payload);
      if (!validation.valid) return sendJson(response, 400, { errors: validation.errors });
      if (!requireMember(auth, params.facilityId, response)) return;
      const employeeId = await requireEmployee(auth, params.facilityId, response);
      if (!employeeId) return;

      try {
        const rows = await pgInsert(
          auth.client,
          "time_off_requests",
          [
            {
              facility_id: params.facilityId,
              employee_id: employeeId,
              starts_at: validation.value.startsAt,
              ends_at: validation.value.endsAt,
              request_type: validation.value.requestType,
              reason: validation.value.reason
            }
          ],
          { returning: true }
        );
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      } catch (error) {
        const mapped = requestErrorResponse(error);
        if (mapped) return sendJson(response, mapped.status, mapped.body);
        throw error;
      }
    })
  );

  // Requester-side cancellation: POST .../open-shift-claims/:id/withdraw,
  // .../shift-swaps/:id/cancel, .../time-off-requests/:id/cancel. The UPDATE
  // is filtered to the caller's own row and a live status, so another
  // employee's id simply matches nothing (404).
  const CANCELLATIONS = [
    { kind: KINDS.claims, action: "withdraw", ownerColumn: "claimant_employee_id", from: ["pending"], to: "withdrawn" },
    { kind: KINDS.swaps, action: "cancel", ownerColumn: "requester_employee_id", from: ["pending"], to: "cancelled" },
    { kind: KINDS.time_off, action: "cancel", ownerColumn: "employee_id", from: ["pending", "approved"], to: "cancelled" }
  ];
  for (const { kind, action, ownerColumn, from, to } of CANCELLATIONS) {
    router.register("POST", `/facilities/:facilityId/${kind.path}/:requestId/${action}`, (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const employeeId = await requireEmployee(auth, params.facilityId, response);
        if (!employeeId) return;
        let rows;
        try {
          rows = await pgUpdate(
            auth.client,
            kind.table,
            {
              id: params.requestId,
              facility_id: params.facilityId,
              [ownerColumn]: employeeId,
              [kind.statusColumn]: { in: from }
            },
            { [kind.statusColumn]: to },
            { returning: true }
          );
        } catch (error) {
          const mapped = requestErrorResponse(error);
          if (mapped) return sendJson(response, mapped.status, mapped.body);
          throw error;
        }
        if (!Array.isArray(rows) || rows.length === 0) {
          return sendJson(response, 404, { error: "request not found or can no longer be changed" });
        }
        return sendJson(response, 200, rows[0]);
      })
    );
  }

  // The colleague a swap or named pickup NAMES answers it: POST
  // .../shift-swaps/:requestId/{accept|decline}, no body. Only the named
  // employee can (the RPC answers anyone else with the same 404 as a missing
  // id); a request must be accepted before a manager can approve it.
  for (const answer of SWAP_RESPONSES) {
    router.register("POST", `/facilities/:facilityId/shift-swaps/:requestId/${answer}`, (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const row = await loadOne(auth.client, KINDS.swaps.table, "id,facility_id", {
          id: params.requestId,
          facility_id: params.facilityId
        });
        if (!row) return sendJson(response, 404, { error: "request not found" });
        let result;
        try {
          result = await pgRpc(auth.client, "respond_to_shift_swap", { p_request_id: row.id, p_response: answer });
        } catch (error) {
          const mapped = requestErrorResponse(error);
          if (mapped) return sendJson(response, mapped.status, mapped.body);
          throw error;
        }
        return sendJson(response, 200, result);
      })
    );
  }

  // =================================================================================
  // Manager side
  // =================================================================================

  // GET /facilities/:facilityId/approvals?type=&status=&limit=&offset= -- one
  // queue over the three request kinds, scoped to the kinds the caller may
  // decide. type: claims | swaps | time_off (default: every permitted kind);
  // status: a status or "all" (default pending).
  router.register("GET", "/facilities/:facilityId/approvals", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const qp = queryParams(request);
      const type = qp.get("type");
      if (type !== null && !APPROVAL_TYPES.includes(type)) {
        return sendJson(response, 400, { error: `type must be one of ${APPROVAL_TYPES.join(", ")}` });
      }
      const status = qp.get("status") ?? "pending";
      if (status !== "all" && !ALL_APPROVAL_STATUSES.includes(status)) {
        return sendJson(response, 400, { error: `status must be "all" or one of ${ALL_APPROVAL_STATUSES.join(", ")}` });
      }
      const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIST_LIMIT, maxLimit: MAX_LIST_LIMIT });
      if (!paging.ok) return sendJson(response, 400, { error: paging.error });
      if (paging.offset > MAX_LIST_OFFSET) {
        return sendJson(response, 400, { error: `offset must be at most ${MAX_LIST_OFFSET}` });
      }

      const permitted = Object.values(KINDS).filter((kind) => hasAny(auth, params.facilityId, kind.approverCodes));
      let selected = permitted;
      if (type !== null) {
        selected = permitted.filter((kind) => kind.key === type);
        if (selected.length === 0) return sendJson(response, 403, { error: `missing permission: ${KINDS[type].approverCodes[0]}` });
      } else if (permitted.length === 0) {
        return sendJson(response, 403, { error: `missing permission: ${MANAGE_OPEN_SHIFTS}` });
      }

      const fetchWindow = paging.limit + paging.offset;
      const results = await Promise.all(
        selected.map(async (kind) => {
          if (status !== "all" && !kind.statuses.includes(status)) return [];
          const filters = { facility_id: params.facilityId };
          if (status !== "all") filters[kind.statusColumn] = status;
          return (
            (await pgSelect(auth.client, kind.table, {
              filters,
              select: kind.columns,
              extra: { deleted_at: "is.null" },
              order: "created_at.asc",
              limit: fetchWindow
            })) ?? []
          );
        })
      );
      const byKind = Object.fromEntries(selected.map((kind, index) => [kind.key, results[index]]));
      const claims = byKind.claims ?? [];
      const swaps = byKind.swaps ?? [];
      const timeOff = byKind.time_off ?? [];

      // Context rows for the summary lines: employee names, the shifts the
      // claims point at and the two assignments (and their shifts) per swap.
      const employeeIds = new Set();
      for (const row of claims) employeeIds.add(row.claimant_employee_id);
      for (const row of swaps) {
        employeeIds.add(row.requester_employee_id);
        if (row.target_employee_id) employeeIds.add(row.target_employee_id);
      }
      for (const row of timeOff) employeeIds.add(row.employee_id);
      const assignmentIds = new Set();
      for (const row of swaps) {
        assignmentIds.add(row.offered_assignment_id);
        if (row.requested_assignment_id) assignmentIds.add(row.requested_assignment_id);
      }
      const assignments = assignmentIds.size
        ? ((await pgSelect(auth.client, "shift_assignments", {
            filters: { facility_id: params.facilityId, id: { in: [...assignmentIds] } },
            select: ASSIGNMENT_COLUMNS
          })) ?? [])
        : [];
      const shiftIds = new Set([...claims.map((row) => row.shift_id), ...assignments.map((row) => row.shift_id)]);
      const [shifts, employees] = await Promise.all([
        shiftIds.size
          ? pgSelect(auth.client, "schedule_shifts", {
              filters: { facility_id: params.facilityId, id: { in: [...shiftIds] } },
              select: SHIFT_COLUMNS
            })
          : [],
        employeeIds.size
          ? pgSelect(auth.client, "employees", {
              filters: { facility_id: params.facilityId, id: { in: [...employeeIds] } },
              select: EMPLOYEE_NAME_COLUMNS
            })
          : []
      ]);

      const items = buildApprovalItems({
        claims,
        swaps,
        timeOff,
        employees: employees ?? [],
        shifts: shifts ?? [],
        assignments
      }).slice(paging.offset, paging.offset + paging.limit);

      return sendJson(response, 200, {
        items,
        permittedTypes: permitted.map((kind) => kind.key)
      });
    })
  );

  // Pre-validation for an APPROVE (never for a deny, never for a replay).
  // Returns { status, body } for a 409 the caller should answer, or null.
  async function preflightApproval(auth, kind, row) {
    if (kind.key === "claims") {
      const shift = await loadOne(auth.client, "schedule_shifts", SHIFT_COLUMNS, {
        id: row.shift_id,
        facility_id: row.facility_id
      });
      if (!shift) return null;
      const [facilityContext, employeeContext, siblings] = await Promise.all([
        loadFacilityContext(auth.client, row.facility_id),
        loadEmployeeContext(auth.client, row.facility_id, row.claimant_employee_id),
        pgSelect(auth.client, "open_shift_claims", {
          filters: { facility_id: row.facility_id, shift_id: row.shift_id, claim_status: "pending" },
          select: CLAIM_COLUMNS,
          extra: { deleted_at: "is.null" }
        })
      ]);
      const eligibility = eligibilityFor({ employeeId: row.claimant_employee_id, shift, employeeContext, facilityContext });
      const plan = resolveClaim({ claim: row, siblingClaims: siblings ?? [], shift, eligibility });
      if (plan.allowed) return null;
      return {
        status: 409,
        body: { error: "this claim can no longer be approved", reasons: plan.reasons, blocking: plan.blocking, warnings: plan.warnings }
      };
    }
    if (kind.key === "swaps") {
      const offered = await loadOne(auth.client, "shift_assignments", ASSIGNMENT_COLUMNS, {
        id: row.offered_assignment_id,
        facility_id: row.facility_id
      });
      const requested = row.requested_assignment_id
        ? await loadOne(auth.client, "shift_assignments", ASSIGNMENT_COLUMNS, {
            id: row.requested_assignment_id,
            facility_id: row.facility_id
          })
        : null;
      // A leg this caller cannot read leaves nothing to pre-validate against
      // -- the RPC decides on the full data.
      if (!offered || (row.requested_assignment_id && !requested)) return null;
      const [offeredShift, requestedShift] = await Promise.all([
        loadOne(auth.client, "schedule_shifts", SHIFT_COLUMNS, { id: offered.shift_id, facility_id: row.facility_id }),
        requested
          ? loadOne(auth.client, "schedule_shifts", SHIFT_COLUMNS, { id: requested.shift_id, facility_id: row.facility_id })
          : null
      ]);
      if (!offeredShift || (requested && !requestedShift)) return null;
      const facilityContext = await loadFacilityContext(auth.client, row.facility_id);
      const contexts = new Map();
      for (const employeeId of [row.target_employee_id, row.requester_employee_id]) {
        if (employeeId && !contexts.has(employeeId)) {
          contexts.set(employeeId, await loadEmployeeContext(auth.client, row.facility_id, employeeId));
        }
      }
      const plan = planSwap({
        swap: row,
        offeredAssignment: offered,
        offeredShift,
        requestedAssignment: requested,
        requestedShift,
        checkEligibility: (employeeId, shift, ignoreAssignmentIds) =>
          eligibilityFor({
            employeeId,
            shift,
            employeeContext: contexts.get(employeeId),
            facilityContext,
            ignoreAssignmentIds
          })
      });
      if (plan.allowed) return null;
      return {
        status: 409,
        body: {
          error: plan.stale ? "this swap request is stale: an assignment changed" : "a participant is not eligible for the swap",
          stale: plan.stale,
          reasons: plan.reasons,
          blocking: plan.blocking,
          warnings: plan.warnings
        }
      };
    }
    return null; // time off: the RPC validates the window and the employee.
  }

  // POST /facilities/:facilityId/{open-shift-claims|shift-swaps|time-off-requests}/:requestId/{approve|deny}
  // Body { reason }: required for deny, optional note for approve.
  for (const kind of Object.values(KINDS)) {
    for (const decision of REQUEST_DECISIONS) {
      router.register("POST", `/facilities/:facilityId/${kind.path}/:requestId/${decision}`, (request, response, { env, params }) =>
        withAuth(request, response, env, async (auth) => {
          const body = await parseJsonBody(request);
          if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
          const validation = validateDecisionInput({ decision, reason: body.payload?.reason });
          if (!validation.valid) return sendJson(response, 400, { errors: validation.errors });
          if (!requireAny(auth, params.facilityId, kind.approverCodes, response)) return;

          const row = await loadOne(auth.client, kind.table, kind.columns, {
            id: params.requestId,
            facility_id: params.facilityId
          });
          if (!row) return sendJson(response, 404, { error: "request not found" });

          // A swap that names a colleague waits for that colleague's answer
          // (the RPC enforces the same rule; this gives the caller the
          // structured 409 first).
          if (
            decision === "approve" &&
            kind.key === "swaps" &&
            row.status === "pending" &&
            row.target_employee_id &&
            !row.target_accepted_at
          ) {
            return sendJson(response, 409, {
              error: "the colleague named in this request has not accepted it yet",
              awaitingTarget: true
            });
          }

          if (decision === "approve" && row[kind.statusColumn] === "pending") {
            const blocked = await preflightApproval(auth, kind, row);
            if (blocked) return sendJson(response, blocked.status, blocked.body);
          }

          // The ONLY write this route performs: one definer RPC. It
          // re-checks the caller's permission, re-validates, writes the
          // assignment change and the decision in a single transaction, and
          // is idempotent on replay. Only the request id and the validated
          // decision/reason cross the boundary.
          let result;
          try {
            result = await pgRpc(auth.client, kind.rpc, {
              p_request_id: row.id,
              p_decision: validation.decision,
              p_reason: validation.reason
            });
          } catch (error) {
            const mapped = requestErrorResponse(error);
            if (mapped) return sendJson(response, mapped.status, mapped.body);
            throw error;
          }
          return sendJson(response, 200, result);
        })
      );
    }
  }

  return router;
}
