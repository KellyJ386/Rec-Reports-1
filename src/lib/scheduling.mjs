import { configValue } from "./settings-registry.mjs";
import { effectiveEnforcementMode } from "./admin/cert-policy.mjs";

export function shiftsOverlap(first, second) {
  return new Date(first.startsAt) < new Date(second.endsAt) && new Date(second.startsAt) < new Date(first.endsAt);
}

export function findDoubleBookings(assignments) {
  const conflicts = [];
  const byEmployee = new Map();
  for (const assignment of assignments) {
    const employeeAssignments = byEmployee.get(assignment.employeeId) ?? [];
    for (const existing of employeeAssignments) {
      if (shiftsOverlap(existing, assignment)) {
        conflicts.push({ employeeId: assignment.employeeId, shiftIds: [existing.shiftId, assignment.shiftId] });
      }
    }
    employeeAssignments.push(assignment);
    byEmployee.set(assignment.employeeId, employeeAssignments);
  }
  return conflicts;
}

export function findMissingCertifications(assignments, certificationsByEmployee) {
  return assignments.flatMap((assignment) => {
    const heldCertifications = new Set(certificationsByEmployee[assignment.employeeId] ?? []);
    return assignment.requiredCertificationCodes
      .filter((code) => !heldCertifications.has(code))
      .map((code) => ({ employeeId: assignment.employeeId, shiftId: assignment.shiftId, certificationCode: code }));
  });
}

// `config` is an optional flat map of registry keys (defaults applied per key),
// so existing callers pass nothing and get the shipped hard-block behavior.
// - scheduling.conflictCheckEnabled=false skips double-booking blocking.
// - scheduling.certEnforcementMode='warning' downgrades missing certifications
//   from a publish-blocking error to a non-blocking warning.
//
// The optional `roleRequirements` (an array of requirement rows carrying a
// certificationCode and an enforcement_mode, i.e. certification_role_requirements
// from 0017) refines enforcement PER missing certification: a missing cert whose
// requirement resolves (via effectiveEnforcementMode -- the requirement override
// winning over the registry mode) to 'warning' is downgraded to a non-blocking
// warning, while 'hard-block' ones still block. With no roleRequirements the
// single registry certEnforcementMode governs every missing cert (Phase 5
// behavior, fully backward compatible).
//
// SC-13/SC-14 (Wave 3 3D): the optional `availabilityRows` (employee_availability
// rows), `timeOffWindows` (time_off_requests rows) and `timeZone` (the
// facility's IANA zone) add two more result arrays. `availabilityConflicts`
// are always non-blocking warnings; `timeOffConflicts` carry a per-entry
// severity -- an APPROVED overlap is 'blocking' (and so withholds canPublish)
// only when scheduling.timeOffConflictMode is 'hard-block', a pending overlap
// is always a 'warning'. Both need `shiftDate` (and startsAt/endsAt) on the
// assignment entries; omit the options and both arrays are simply empty.
export function summarizeScheduleReadiness(
  assignments,
  certificationsByEmployee,
  config = {},
  { roleRequirements, availabilityRows, timeOffWindows, timeZone } = {}
) {
  const conflictCheckEnabled = configValue(config, "scheduling.conflictCheckEnabled");
  const certEnforcementMode = configValue(config, "scheduling.certEnforcementMode");

  const doubleBookings = conflictCheckEnabled ? findDoubleBookings(assignments) : [];
  const missingCertifications = findMissingCertifications(assignments, certificationsByEmployee);

  const requirementByCode = new Map();
  for (const requirement of roleRequirements ?? []) {
    const code = requirement?.certificationCode ?? requirement?.certification_code;
    if (code) requirementByCode.set(code, requirement);
  }
  const modeForMissing = (missing) => {
    if (requirementByCode.size === 0) return certEnforcementMode;
    const requirement = requirementByCode.get(missing.certificationCode);
    if (!requirement) return certEnforcementMode;
    return effectiveEnforcementMode(requirement, config);
  };

  const blocking = [];
  const warnings = [];
  for (const missing of missingCertifications) {
    if (modeForMissing(missing) === "warning") warnings.push({ ...missing, severity: "warning" });
    else blocking.push(missing);
  }

  const timeOffConflicts = findTimeOffConflicts(assignments, timeOffWindows ?? [], {
    mode: configValue(config, "scheduling.timeOffConflictMode")
  });
  const availabilityConflicts = findAvailabilityConflicts(assignments, availabilityRows ?? [], timeZone ?? "UTC");

  return {
    canPublish:
      doubleBookings.length === 0 &&
      blocking.length === 0 &&
      !timeOffConflicts.some((conflict) => conflict.severity === "blocking"),
    doubleBookings,
    missingCertifications,
    warnings,
    timeOffConflicts,
    availabilityConflicts,
    certEnforcementMode
  };
}

// --- Schedule period lifecycle (SC-01) --------------------------------------
// schedule_periods.status is constrained by 0003_scheduling.sql to
// 'draft' | 'review' | 'published' | 'archived'. The legal-transition graph
// below mirrors the design doc's linear flow (draft -> review -> published ->
// archived), plus two documented allowances: SCHEDULING_SYSTEM_DESIGN.md
// notes review is "optional for multi-manager environments", so draft can
// jump straight to published; and review -> draft lets a manager send a
// submitted-for-review period back for edits before it goes live. published
// and archived are one-way (an already-published period is only changed
// through the future publish/override flow, SC-07 -- not by this transition
// map), and archived is terminal.
const PERIOD_TRANSITIONS = {
  draft: new Set(["review", "published"]),
  review: new Set(["draft", "published"]),
  published: new Set(["archived"]),
  archived: new Set()
};

export const PERIOD_STATUSES = Object.freeze(Object.keys(PERIOD_TRANSITIONS));

// Pure legal-transition check: true iff `to` is a status schedule_periods may
// move to directly from `from`. Same-status "transitions", unknown statuses,
// and skipped/backward moves not explicitly allowed above all return false so
// the route layer can turn a false result into a 400 without any DB round trip.
export function canTransitionPeriod(from, to) {
  const allowed = PERIOD_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

// --- Shift template validation (SC-02) --------------------------------------
// Pure shape/range check for shift_templates rows, run BEFORE any fetch so an
// invalid payload never reaches PostgREST. `partial` relaxes required-field
// checks for PATCH: a field is only validated if present in `input`, except
// start/end time which are validated together whenever either is present
// (comparing just one against the unfetched current row isn't possible here,
// so PATCH callers must send both together to change either).
export function validateTemplateInput(input, { partial = false } = {}) {
  const errors = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(input ?? {}, key);
  const roleCode = input?.roleCode;
  const startTimeLocal = input?.startTimeLocal;
  const endTimeLocal = input?.endTimeLocal;
  const daysOfWeek = input?.daysOfWeek;
  const requiredCertificationIds = input?.requiredCertificationIds;

  if (!partial || has("roleCode")) {
    if (!roleCode) errors.push("roleCode is required");
  }

  if (!partial || has("startTimeLocal") || has("endTimeLocal")) {
    if (!startTimeLocal) errors.push("startTimeLocal is required");
    if (!endTimeLocal) errors.push("endTimeLocal is required");
    if (startTimeLocal && endTimeLocal && !(startTimeLocal < endTimeLocal)) {
      errors.push("startTimeLocal must be before endTimeLocal");
    }
  }

  if (!partial || has("daysOfWeek")) {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      errors.push("daysOfWeek must be a non-empty array");
    } else if (!daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
      errors.push("daysOfWeek entries must be integers between 0 and 6");
    }
  }

  if (has("requiredCertificationIds")) {
    if (!Array.isArray(requiredCertificationIds)) {
      errors.push("requiredCertificationIds must be an array");
    } else if (!requiredCertificationIds.every((id) => typeof id === "string" && id.length > 0)) {
      errors.push("requiredCertificationIds entries must be non-empty strings");
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Template expansion (SC-03) ----------------------------------------------
//
// DST-safe local-time -> UTC conversion, no libraries.
//
// The technique: to convert a local wall-clock time (a plain date + "HH:MM")
// in an IANA `timeZone` to a UTC instant, without a tz-database library, we
// lean on the one piece of IANA tz data the JS engine already ships:
// Intl.DateTimeFormat's per-instant offset resolution.
//
//   1. "Naive guess": reinterpret the local date+time components as if they
//      were UTC (Date.UTC(y, m, d, hh, mm)). This is *a* real instant, just
//      probably the wrong one -- it's off by whatever the zone's offset is.
//   2. Ask Intl what wall-clock time that guessed instant displays as in
//      `timeZone` (via formatToParts), and diff it against the guess to get
//      the zone's offset *at that instant* (getOffsetMs).
//   3. Subtract that offset from the guess to get a first candidate instant.
//   4. Re-derive the offset AT the candidate instant. Away from a DST
//      transition this matches the step-2 offset and the candidate is
//      correct as-is (this two-step correction is what step 4 exists to
//      verify -- a single step, using only the step-2 offset, gives wrong
//      answers for local times that fall shortly after a transition, since
//      the naive guess instant hasn't crossed the same UTC threshold the
//      real target instant has).
//   5. If the two offsets disagree, we are within one UTC-offset-delta of a
//      transition. This covers THREE distinct situations, not two -- an
//      ordinary local time shortly after a transition (unambiguous, just
//      needs the step-4 correction), a spring-forward gap (the requested
//      local time never occurs), or a fall-back fold (it occurs twice). A
//      fold's ambiguous local time is already resolved to its first
//      (pre-transition, e.g. still-daylight) occurrence by step 4's equality
//      check above -- the intuitive choice -- without ever reaching this
//      step (see zonedTimeToUtcMs's inline comment for why that's
//      guaranteed, not coincidental). Reaching this step therefore means
//      either the "shortly after transition" case or a genuine gap; a
//      second correction, re-deriving the offset at a candidate built from
//      the step-4 offset and checking it against ITSELF for self-consistency,
//      tells them apart (see zonedTimeToUtcMs's inline comment for the exact
//      test) -- self-consistent means the local time genuinely exists and
//      that recomputed candidate is the answer; not self-consistent means a
//      true gap, which resolves to the step-3 candidate instead -- i.e. as
//      if the pre-transition (step-2) offset still applied -- displaying as
//      the requested local time pushed forward across the gap by the gap's
//      size (concretely, for a 2:00->3:00 spring-forward, a nonexistent
//      02:30 local resolves to display as 03:30, one hour past what was
//      asked for, rather than falling back to 01:30 before it). All three
//      situations are exercised in test/scheduling.test.mjs with exact
//      instants asserted, so this policy is pinned by tests, not just prose.
function getZoneOffsetMs(instantMs, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(instantMs))) {
    parts[type] = value;
  }
  // formatToParts can render midnight as "24" under hourCycle h23 in some
  // engines; normalize it back to 0 so Date.UTC doesn't roll to the wrong day.
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asIfUtc - instantMs;
}

// Converts a local wall-clock "HH:MM" (or "HH:MM:SS") on `dateStr`
// ("YYYY-MM-DD") in `timeZone` to a UTC epoch-ms instant. See the block
// comment above for the algorithm and its documented DST-fold/gap policy.
function zonedTimeToUtcMs(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const offsetAtGuess = getZoneOffsetMs(naiveUtcMs, timeZone);
  const candidate = naiveUtcMs - offsetAtGuess;

  const offsetAtCandidate = getZoneOffsetMs(candidate, timeZone);
  if (offsetAtCandidate === offsetAtGuess) return candidate;

  // Mismatch: `candidate` (built from `offsetAtGuess`) landed on the other
  // side of a transition from where it started. Two distinct situations
  // produce this, and they need OPPOSITE resolutions, so we cannot just pick
  // "the earlier" or "the later" of the two blindly:
  //
  //   (a) An ORDINARY, EXISTING local time shortly after a transition (e.g.
  //       05:00 on the spring-forward day, after the 2am jump): `candidate`
  //       overshot because `offsetAtGuess` was still the pre-transition
  //       offset. Recomputing with `offsetAtCandidate` (the offset actually
  //       in effect at `candidate`) gives the right instant -- and that
  //       instant's OWN offset (checked below) agrees with the offset used
  //       to build it, i.e. it's self-consistent.
  //   (b) A GENUINELY NONEXISTENT local time inside a spring-forward gap
  //       (e.g. 02:30 that same day): no instant displays back as the
  //       requested wall-clock time, so recomputing with `offsetAtCandidate`
  //       produces an instant whose own offset does NOT match
  //       `offsetAtCandidate` -- it's not self-consistent, because it has
  //       overshot back across the transition the other way.
  //
  // (A fall-back fold's ambiguous local time never reaches this branch at
  // all -- it already converges to its pre-fold occurrence at the
  // `offsetAtCandidate === offsetAtGuess` check above. Both this branch's
  // cases, (a) and (b), are exercised with exact pinned instants in
  // test/scheduling.test.mjs.)
  const candidate2 = naiveUtcMs - offsetAtCandidate;
  const offsetAtCandidate2 = getZoneOffsetMs(candidate2, timeZone);
  if (offsetAtCandidate2 === offsetAtCandidate) {
    // Case (a): self-consistent -- this local time genuinely exists.
    return candidate2;
  }

  // Case (b): a true gap. Per the policy note above, resolve "as if the old
  // (pre-transition) offset still applied" -- `candidate` IS that instant,
  // and it displays as the requested local time pushed forward across the
  // gap by the gap's size (e.g. a nonexistent 02:30 resolves to display as
  // 03:30, not backward to 01:30).
  return candidate;
}

function addDaysToDateOnly(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Calendar weekday of a plain "YYYY-MM-DD" date, 0 (Sunday) - 6 (Saturday),
// matching both JS Date#getDay/getUTCDay and validateTemplateInput's
// daysOfWeek range. Parsed as UTC so the result never depends on the host
// process's local timezone -- a calendar date's weekday is timezone-
// independent by definition, so this is safe regardless of `timeZone`.
function weekdayOfDateOnly(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Pure template expansion: for each active template, emits one draft shift
// row per day in [weekStartDate, weekStartDate+6] whose weekday is in the
// template's daysOfWeek. Each row's startsAt/endsAt are UTC ISO instants
// converted from the template's local HH:MM times in `timeZone` via
// zonedTimeToUtcMs above (DST-safe, see that function's doc comment).
//
// Accepts templates in either camelCase (route-shaped, as produced by this
// module's own callers) or the raw snake_case shift_templates row shape
// (department_id/role_code/start_time_local/end_time_local/days_of_week/
// required_certification_ids) so callers can pass PostgREST rows directly.
// `templates` with `active === false` are skipped (defensive -- callers are
// expected to have already filtered to active=true at the query layer).
export function expandTemplates(templates, weekStartDate, timeZone) {
  const rows = [];
  for (const template of templates ?? []) {
    if (template?.active === false) continue;
    const daysOfWeek = template.daysOfWeek ?? template.days_of_week ?? [];
    const startTimeLocal = template.startTimeLocal ?? template.start_time_local;
    const endTimeLocal = template.endTimeLocal ?? template.end_time_local;
    const departmentId = template.departmentId ?? template.department_id ?? null;
    const roleCode = template.roleCode ?? template.role_code;
    const requiredCertificationIds = template.requiredCertificationIds ?? template.required_certification_ids ?? [];

    for (let offset = 0; offset <= 6; offset++) {
      const shiftDate = addDaysToDateOnly(weekStartDate, offset);
      const weekday = weekdayOfDateOnly(shiftDate);
      if (!daysOfWeek.includes(weekday)) continue;

      rows.push({
        templateId: template.id ?? null,
        departmentId,
        roleCode,
        shiftDate,
        startsAt: new Date(zonedTimeToUtcMs(shiftDate, startTimeLocal, timeZone)).toISOString(),
        endsAt: new Date(zonedTimeToUtcMs(shiftDate, endTimeLocal, timeZone)).toISOString(),
        requiredCertificationIds,
        source: "template"
      });
    }
  }
  return rows;
}

// --- Idempotency key for generated shifts (SC-03) ---------------------------
// schedule_shifts (0003_scheduling.sql) carries no shift_template_id FK, so a
// previously-generated template shift can't be looked up by template id.
// Instead we identify it by this natural key -- the tuple that fully
// determines what a given (template, date) expansion would produce:
// (department_id, role_code, shift_date, starts_at, ends_at). Two distinct
// active templates that happened to expand to the exact same tuple would
// collide (and the second would be treated as "already generated"); that is
// an accepted, documented limitation given the schema has no template
// reference to disambiguate them.
//
// startsAt/endsAt are normalized via Date#getTime() rather than compared as
// raw strings, because a value freshly produced by expandTemplates()
// (`toISOString()`, e.g. "2026-08-01T12:00:00.000Z") and the same instant
// read back from PostgREST (typically "2026-08-01T12:00:00+00:00") are not
// byte-identical even though they name the same instant -- string equality
// would wrongly treat every already-generated shift as new on each rerun.
export function shiftNaturalKey(departmentId, roleCode, shiftDate, startsAt, endsAt) {
  return [departmentId ?? "", roleCode, shiftDate, new Date(startsAt).getTime(), new Date(endsAt).getTime()].join("|");
}

// --- Shift assignment status transitions (SC-05) -----------------------------
// shift_assignments.status is constrained by 0003_scheduling.sql to
// 'pending' | 'approved' | 'declined' | 'cancelled' (a freshly-created
// assignment defaults to 'pending' at the DB layer). The transition graph
// below: from 'pending' a manager can approve, decline, or cancel outright;
// 'approved' and 'declined' can still be cancelled (i.e. "unassign" -- the
// plan's PATCH route treats status='cancelled' as unassignment, since there
// is no separate DELETE/unassign endpoint); 'cancelled' is terminal.
const ASSIGNMENT_TRANSITIONS = {
  pending: new Set(["approved", "declined", "cancelled"]),
  approved: new Set(["cancelled"]),
  declined: new Set(["cancelled"]),
  cancelled: new Set()
};

export const ASSIGNMENT_STATUSES = Object.freeze(Object.keys(ASSIGNMENT_TRANSITIONS));

export function canTransitionAssignment(from, to) {
  const allowed = ASSIGNMENT_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

// --- Publish change summary (SC-07) -----------------------------------------
// Pure structural diff between a schedule period's shift/assignment state as
// of its previous publication (or [] for a period's first publish) and its
// current state, feeding the schedule_publications.change_summary jsonb
// column so every publication carries an auditable record of exactly what
// changed since the prior one -- not just a point-in-time snapshot.
//
// Rows are domain-shaped and matched by `id` (the route layer is responsible
// for adapting DB rows -- schedule_shifts/shift_assignments columns are
// snake_case -- into this shape first, the same way summarizeScheduleReadiness's
// callers already adapt rows before calling in):
//   shift:      { id, roleCode, shiftDate, startsAt, endsAt, status, departmentId }
//   assignment: { id, shiftId, employeeId, assignmentType, status }
//
// A row present in both `previous*` and `current*` with the same id is
// "changed" if any tracked field differs (listed per-field as { field,
// before, after }); a row whose id is new is "added"; a row whose id no
// longer appears is "removed". Two distinct assignment rows for the same
// shift with different ids -- e.g. the prior assignment cancelled and a new
// one created for a different employee, which is how a reassignment actually
// surfaces given shift_assignments has no employee_id-mutating update path --
// show up as one "changed" (the old row's status flipping to cancelled) plus
// one "added" (the new row) rather than a single synthetic "reassigned"
// entry; callers can derive that narrative from the pair via shiftId, but the
// pure diff itself stays a straightforward id-keyed set/field comparison.
const SHIFT_DIFF_FIELDS = ["roleCode", "shiftDate", "startsAt", "endsAt", "status", "departmentId"];
const ASSIGNMENT_DIFF_FIELDS = ["shiftId", "employeeId", "assignmentType", "status"];

function diffRowsById(previousRows, currentRows, fields) {
  const previousById = new Map((previousRows ?? []).filter((row) => row?.id != null).map((row) => [row.id, row]));
  const currentById = new Map((currentRows ?? []).filter((row) => row?.id != null).map((row) => [row.id, row]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, current] of currentById) {
    const previous = previousById.get(id);
    if (!previous) {
      added.push(current);
      continue;
    }
    const fieldChanges = [];
    for (const field of fields) {
      if (previous[field] !== current[field]) {
        fieldChanges.push({ field, before: previous[field] ?? null, after: current[field] ?? null });
      }
    }
    if (fieldChanges.length > 0) changed.push({ id, changes: fieldChanges });
  }
  for (const [id, previous] of previousById) {
    if (!currentById.has(id)) removed.push(previous);
  }

  return { added, removed, changed };
}

export function buildChangeSummary(previousShifts, currentShifts, previousAssignments, currentAssignments) {
  return {
    shifts: diffRowsById(previousShifts, currentShifts, SHIFT_DIFF_FIELDS),
    assignments: diffRowsById(previousAssignments, currentAssignments, ASSIGNMENT_DIFF_FIELDS)
  };
}

// ===========================================================================
// Self-service requests, availability and atomic-approval planning (Wave 3
// Slice 3D, SC-10 .. SC-16). Everything below is pure: the route layer loads
// rows and passes them in, and the authoritative decision still happens in
// the 0062 decide_* RPCs -- these functions exist to pre-validate (so a
// caller gets a structured 409 instead of an RPC error string) and to
// describe exactly what an approval will do, mirroring the SQL one-to-one
// (supabase/migrations/0062_scheduling_self_service.sql,
// internal.fn_assignment_blockers and the decide_* bodies).
// ===========================================================================

export const REQUEST_KINDS = Object.freeze(["open_shift_claim", "shift_swap", "time_off"]);
export const CLAIM_STATUSES = Object.freeze(["pending", "approved", "denied", "withdrawn"]);
export const SWAP_STATUSES = Object.freeze(["pending", "approved", "denied", "cancelled", "expired"]);
export const SWAP_TYPES = Object.freeze(["direct", "drop_pickup"]);
export const TIME_OFF_STATUSES = Object.freeze(["pending", "approved", "denied", "cancelled"]);
export const TIME_OFF_TYPES = Object.freeze(["vacation", "sick", "unpaid", "other"]);
export const REQUEST_DECISIONS = Object.freeze(["approve", "deny"]);

// Mirrors the BEFORE UPDATE guard triggers (0062 Guard 8 / 6 / 5): pending is
// the only live state, except an approved time-off request the employee may
// still cancel before it starts. Same-status "transitions" are not legal.
const REQUEST_TRANSITIONS = {
  open_shift_claim: {
    pending: new Set(["approved", "denied", "withdrawn"]),
    approved: new Set(),
    denied: new Set(),
    withdrawn: new Set()
  },
  shift_swap: {
    pending: new Set(["approved", "denied", "cancelled", "expired"]),
    approved: new Set(),
    denied: new Set(),
    cancelled: new Set(),
    expired: new Set()
  },
  time_off: {
    pending: new Set(["approved", "denied", "cancelled"]),
    approved: new Set(["cancelled"]),
    denied: new Set(),
    cancelled: new Set()
  }
};

export function canTransitionRequest(kind, from, to) {
  const allowed = REQUEST_TRANSITIONS[kind]?.[from];
  if (!allowed) return false;
  return allowed.has(to);
}

const MAX_REASON_LENGTH = 1000;

// Validates a decision body ({ decision: 'approve'|'deny', reason }). A denial
// always needs a non-blank reason (design 5.2: "denial reason required for
// auditability"); the cleaned values are returned so the route passes exactly
// what was validated to the RPC.
export function validateDecisionInput(input) {
  const errors = [];
  const decision = typeof input?.decision === "string" ? input.decision.trim().toLowerCase() : "";
  const reasonText = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (!REQUEST_DECISIONS.includes(decision)) {
    errors.push(`decision must be one of ${REQUEST_DECISIONS.join(", ")}`);
  }
  if (input?.reason !== undefined && input?.reason !== null && typeof input.reason !== "string") {
    errors.push("reason must be a string");
  }
  if (decision === "deny" && !reasonText) errors.push("a denial requires a reason");
  if (reasonText.length > MAX_REASON_LENGTH) errors.push(`reason must be at most ${MAX_REASON_LENGTH} characters`);
  return { valid: errors.length === 0, errors, decision, reason: reasonText || null };
}

// scheduling.openShiftClaimWindowHours: a shift is claimable until
// `windowHours` after it was opened (schedule_shifts.opened_at, stamped
// server-side by 0062's trigger). A missing/invalid openedAt is treated as
// "window unknown -> open" here; the DB guard (Guard 4) is the authority.
export function isClaimWindowOpen({ openedAt, now = new Date(), windowHours }) {
  const hours = Number(windowHours);
  if (!Number.isFinite(hours) || hours <= 0) return false;
  if (openedAt === null || openedAt === undefined) return true;
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return true;
  return new Date(now).getTime() <= opened + hours * 3600 * 1000;
}

// Certification codes each employee holds ON `dateStr`: status 'active', not
// soft-deleted, and not expired before the shift date (the SQL mirror checks
// `expires_at >= shift_date`). Rows are employee_certifications; types are
// certification_types (id -> code).
export function certificationsHeldOn(employeeCertRows, certTypeRows, dateStr) {
  const codeById = new Map((certTypeRows ?? []).map((type) => [type.id, type.code]));
  const held = {};
  for (const row of employeeCertRows ?? []) {
    if (row.status !== "active" || row.deleted_at) continue;
    if (row.expires_at && dateStr && String(row.expires_at).slice(0, 10) < dateStr) continue;
    const code = codeById.get(row.certification_type_id);
    if (!code) continue;
    (held[row.employee_id] ??= []).push(code);
  }
  return held;
}

function windowOf(entry) {
  return {
    startsAt: entry.startsAt ?? entry.starts_at,
    endsAt: entry.endsAt ?? entry.ends_at
  };
}

// Approved/pending time off overlapping an assignment. `mode` is
// scheduling.timeOffConflictMode: an APPROVED overlap is 'blocking' in
// 'hard-block' mode and a 'warning' otherwise; a PENDING overlap is always a
// 'warning'. Cancelled/denied requests never conflict. Boundaries are
// exclusive (shiftsOverlap): time off that ends exactly when a shift starts
// does not conflict.
export function findTimeOffConflicts(assignments, timeOffWindows, { mode = "warning" } = {}) {
  const conflicts = [];
  for (const assignment of assignments ?? []) {
    for (const window of timeOffWindows ?? []) {
      const employeeId = window.employeeId ?? window.employee_id;
      if (employeeId !== assignment.employeeId) continue;
      if (window.status !== "approved" && window.status !== "pending") continue;
      if (!shiftsOverlap(windowOf(assignment), windowOf(window))) continue;
      conflicts.push({
        employeeId,
        shiftId: assignment.shiftId,
        timeOffRequestId: window.id ?? null,
        status: window.status,
        severity: window.status === "approved" && mode === "hard-block" ? "blocking" : "warning"
      });
    }
  }
  return conflicts;
}

function timeOfDay(value) {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  return match ? `${match[1]}:${match[2]}` : null;
}

// Availability warnings. For each assignment (needs shiftDate/startsAt/
// endsAt), the employee's rule for that calendar weekday that is effective on
// the shift date (latest effective_from wins; soft-deleted rows ignored) is
// consulted: an `unavailable` rule always conflicts; a rule with a window
// conflicts when the shift does not fit inside [start, end] of that local day
// in `timeZone` (a shift that runs past midnight cannot fit a same-day
// window). No rule = no constraint. Availability is advisory -- these are
// warnings, never blockers.
export function findAvailabilityConflicts(assignments, availabilityRows, timeZone = "UTC") {
  const conflicts = [];
  const rows = (availabilityRows ?? []).filter((row) => !row.deleted_at);
  for (const assignment of assignments ?? []) {
    if (!assignment.shiftDate) continue;
    const weekday = weekdayOfDateOnly(assignment.shiftDate);
    const rule = rows
      .filter(
        (row) =>
          row.employee_id === assignment.employeeId &&
          Number(row.weekday) === weekday &&
          String(row.effective_from).slice(0, 10) <= assignment.shiftDate &&
          (!row.effective_to || String(row.effective_to).slice(0, 10) >= assignment.shiftDate)
      )
      .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0];
    if (!rule) continue;
    if (rule.unavailable) {
      conflicts.push({ employeeId: assignment.employeeId, shiftId: assignment.shiftId, reason: "unavailable", weekday });
      continue;
    }
    const start = timeOfDay(rule.available_start_local);
    const end = timeOfDay(rule.available_end_local);
    if (!start || !end) continue;
    const windowStart = zonedTimeToUtcMs(assignment.shiftDate, start, timeZone);
    const windowEnd = zonedTimeToUtcMs(assignment.shiftDate, end, timeZone);
    const shiftStart = new Date(assignment.startsAt).getTime();
    const shiftEnd = new Date(assignment.endsAt).getTime();
    if (shiftStart < windowStart || shiftEnd > windowEnd) {
      conflicts.push({ employeeId: assignment.employeeId, shiftId: assignment.shiftId, reason: "outside_window", weekday });
    }
  }
  return conflicts;
}

function shiftToWindow(shift) {
  return {
    id: shift.id,
    shiftDate: shift.shift_date ?? shift.shiftDate,
    startsAt: shift.starts_at ?? shift.startsAt,
    endsAt: shift.ends_at ?? shift.endsAt
  };
}

// "May this employee work this shift right now" -- the JS twin of
// internal.fn_assignment_blockers. Wires findMissingCertifications,
// shiftsOverlap, findTimeOffConflicts and findAvailabilityConflicts:
//   * blocking: a missing certification (unless scheduling.certEnforcementMode
//     is 'warning'), an overlapping live assignment (unless
//     scheduling.conflictCheckEnabled is false), already assigned to this very
//     shift, approved time off in 'hard-block' mode;
//   * warnings: everything else, incl. availability.
// `employeeAssignments` are the employee's live assignments joined to their
// shifts ({ assignmentId, shiftId, startsAt, endsAt, status });
// `ignoreAssignmentIds` are the assignments the same decision is about to
// cancel (a swap's two legs). Per-requirement cert-policy overrides are
// deliberately NOT applied -- the SQL authority reads only the facility-wide
// mode, and the two must agree.
export function checkAssignmentEligibility({
  employeeId,
  shift,
  requiredCertificationCodes = [],
  certificationsByEmployee = {},
  employeeAssignments = [],
  ignoreAssignmentIds = [],
  timeOffWindows = [],
  availabilityRows = [],
  timeZone = "UTC",
  config = {}
} = {}) {
  const target = shiftToWindow(shift);
  const blocking = [];
  const warnings = [];

  const certMode = configValue(config, "scheduling.certEnforcementMode");
  const missing = findMissingCertifications(
    [{ employeeId, shiftId: target.id, requiredCertificationCodes }],
    certificationsByEmployee
  );
  for (const entry of missing) {
    (certMode === "warning" ? warnings : blocking).push({ code: "missing_certification", ...entry });
  }

  const conflictCheckEnabled = configValue(config, "scheduling.conflictCheckEnabled") !== false;
  const ignored = new Set(ignoreAssignmentIds);
  for (const other of employeeAssignments) {
    if (ignored.has(other.assignmentId)) continue;
    if (other.status && !["pending", "approved"].includes(other.status)) continue;
    if (other.shiftId === target.id) {
      blocking.push({ code: "already_assigned", employeeId, assignmentId: other.assignmentId, shiftIds: [other.shiftId, target.id] });
    } else if (conflictCheckEnabled && shiftsOverlap(windowOf(other), target)) {
      blocking.push({ code: "overlap", employeeId, assignmentId: other.assignmentId, shiftIds: [other.shiftId, target.id] });
    }
  }

  const probe = [{ employeeId, shiftId: target.id, shiftDate: target.shiftDate, startsAt: target.startsAt, endsAt: target.endsAt }];
  for (const conflict of findTimeOffConflicts(probe, timeOffWindows, { mode: configValue(config, "scheduling.timeOffConflictMode") })) {
    const entry = {
      code: conflict.status === "approved" ? "time_off" : "time_off_pending",
      employeeId,
      shiftId: target.id,
      timeOffRequestId: conflict.timeOffRequestId
    };
    (conflict.severity === "blocking" ? blocking : warnings).push(entry);
  }
  for (const conflict of findAvailabilityConflicts(probe, availabilityRows, timeZone)) {
    warnings.push({
      code: conflict.reason === "unavailable" ? "unavailable" : "outside_availability",
      employeeId,
      shiftId: target.id
    });
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

// What approving an open-shift claim will do (SC-11), as a pure plan:
// `allowed` only when the claim is still pending, the shift is still open and
// unstarted and the claimant passes `eligibility` (the checkAssignmentEligibility
// result the caller computed for this claimant and shift). On approval the
// winner is assigned, the shift becomes 'assigned' and every OTHER pending
// claim on the shift is denied -- ordered by created_at then id so the list is
// deterministic. Mirrors decide_open_shift_claim's re-validation order.
export function resolveClaim({ claim, siblingClaims = [], shift, now = new Date(), eligibility = { ok: true, blocking: [], warnings: [] } }) {
  const reasons = [];
  if (!claim || claim.claim_status !== "pending") reasons.push("claim_not_pending");
  if (!shift || shift.deleted_at) {
    reasons.push("shift_missing");
  } else {
    if (shift.status !== "open") reasons.push("shift_not_open");
    if (new Date(shift.starts_at).getTime() <= new Date(now).getTime()) reasons.push("shift_started");
  }
  if (reasons.length === 0 && !eligibility.ok) reasons.push("claimant_ineligible");

  const allowed = reasons.length === 0;
  const denyClaimIds = (siblingClaims ?? [])
    .filter((sibling) => sibling.id !== claim?.id && sibling.shift_id === claim?.shift_id && sibling.claim_status === "pending")
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
    .map((sibling) => sibling.id);

  return {
    allowed,
    reasons,
    blocking: eligibility.blocking ?? [],
    warnings: eligibility.warnings ?? [],
    assign: allowed ? { employeeId: claim.claimant_employee_id, shiftId: claim.shift_id, assignmentType: "primary" } : null,
    shiftStatusAfter: allowed ? "assigned" : (shift?.status ?? null),
    denyClaimIds: allowed ? denyClaimIds : []
  };
}

const LIVE_ASSIGNMENT_STATUSES = ["pending", "approved"];

function assignmentIsLive(assignment, expectedEmployeeId) {
  return (
    Boolean(assignment) &&
    !assignment.deleted_at &&
    LIVE_ASSIGNMENT_STATUSES.includes(assignment.status) &&
    assignment.employee_id === expectedEmployeeId
  );
}

function shiftIsLive(shift, now) {
  return (
    Boolean(shift) &&
    !shift.deleted_at &&
    shift.status !== "cancelled" &&
    new Date(shift.starts_at).getTime() > new Date(now).getTime()
  );
}

// What approving a swap will do (SC-12). `stale` is true when either leg is
// no longer exactly what the request named (assignment reassigned/cancelled,
// shift cancelled or started) -- the route answers 409 and a manager can only
// deny. `checkEligibility(employeeId, shift, ignoreAssignmentIds)` returns a
// checkAssignmentEligibility-shaped result for the INCOMING employee on the
// shift they would take; both legs are ignored in each overlap test (the swap
// removes them). A drop_pickup with no named target simply cancels the
// offered assignment and reopens the shift.
export function planSwap({
  swap,
  offeredAssignment,
  offeredShift,
  requestedAssignment = null,
  requestedShift = null,
  now = new Date(),
  checkEligibility
}) {
  const reasons = [];
  if (!swap || swap.status !== "pending") reasons.push("swap_not_pending");

  let stale = false;
  if (!assignmentIsLive(offeredAssignment, swap?.requester_employee_id) || !shiftIsLive(offeredShift, now)) {
    stale = true;
    reasons.push("offered_assignment_changed");
  }
  const direct = swap?.swap_type === "direct";
  if (direct && (!assignmentIsLive(requestedAssignment, swap.target_employee_id) || !shiftIsLive(requestedShift, now))) {
    stale = true;
    reasons.push("requested_assignment_changed");
  }
  if (reasons.length > 0) {
    return {
      allowed: false,
      stale,
      reasons,
      blocking: [],
      warnings: [],
      cancelAssignmentIds: [],
      assign: [],
      reopenShiftId: null
    };
  }

  const ignoreIds = [offeredAssignment.id, ...(direct ? [requestedAssignment.id] : [])];
  const blocking = [];
  const warnings = [];
  const assign = [];
  if (swap.target_employee_id) {
    const result = checkEligibility(swap.target_employee_id, offeredShift, ignoreIds);
    blocking.push(...result.blocking);
    warnings.push(...result.warnings);
    assign.push({ employeeId: swap.target_employee_id, shiftId: offeredShift.id, assignmentType: offeredAssignment.assignment_type ?? "primary" });
  }
  if (direct) {
    const result = checkEligibility(swap.requester_employee_id, requestedShift, ignoreIds);
    blocking.push(...result.blocking);
    warnings.push(...result.warnings);
    assign.push({ employeeId: swap.requester_employee_id, shiftId: requestedShift.id, assignmentType: requestedAssignment.assignment_type ?? "primary" });
  }

  return {
    allowed: blocking.length === 0,
    stale: false,
    reasons: blocking.length === 0 ? [] : ["participant_ineligible"],
    blocking,
    warnings,
    cancelAssignmentIds: ignoreIds,
    assign,
    reopenShiftId: swap.target_employee_id ? null : offeredShift.id
  };
}

// --- Time-off + availability input validation (SC-13/SC-14) -----------------
const MAX_TIME_OFF_DAYS = 366;

export function validateTimeOffInput(input, { now = new Date() } = {}) {
  const errors = [];
  const startsAt = new Date(input?.startsAt);
  const endsAt = new Date(input?.endsAt);
  if (typeof input?.startsAt !== "string" || Number.isNaN(startsAt.getTime())) errors.push("startsAt must be an ISO date-time");
  if (typeof input?.endsAt !== "string" || Number.isNaN(endsAt.getTime())) errors.push("endsAt must be an ISO date-time");
  if (errors.length === 0) {
    if (!(startsAt < endsAt)) errors.push("startsAt must be before endsAt");
    else if (endsAt.getTime() - startsAt.getTime() > MAX_TIME_OFF_DAYS * 86400000) {
      errors.push(`a time-off request may span at most ${MAX_TIME_OFF_DAYS} days`);
    }
    if (endsAt <= new Date(now)) errors.push("the requested window has already ended");
  }
  const requestType = input?.requestType ?? "other";
  if (!TIME_OFF_TYPES.includes(requestType)) errors.push(`requestType must be one of ${TIME_OFF_TYPES.join(", ")}`);
  if (input?.reason !== undefined && input?.reason !== null) {
    if (typeof input.reason !== "string") errors.push("reason must be a string");
    else if (input.reason.length > MAX_REASON_LENGTH) errors.push(`reason must be at most ${MAX_REASON_LENGTH} characters`);
  }
  return {
    valid: errors.length === 0,
    errors,
    value: errors.length === 0
      ? {
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          requestType,
          reason: typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : null
        }
      : null
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// PUT /me/availability body: { effectiveFrom?: 'YYYY-MM-DD', effectiveTo?:
// 'YYYY-MM-DD'|null, days: [{ weekday: 0-6, unavailable?: boolean,
// availableStart?: 'HH:MM', availableEnd?: 'HH:MM' }] }. One entry per weekday
// (a duplicate weekday is rejected). A day is either unavailable, a window
// (both times, start before end) or an explicit "available all day" (no
// times). Returns DB-shaped rows minus the server-owned facility/employee.
export function validateAvailabilityInput(input, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  const effectiveFrom = input?.effectiveFrom ?? today;
  const effectiveTo = input?.effectiveTo ?? null;
  if (!isCalendarDate(effectiveFrom)) errors.push("effectiveFrom must be a YYYY-MM-DD date");
  if (effectiveTo !== null && !isCalendarDate(effectiveTo)) errors.push("effectiveTo must be a YYYY-MM-DD date or null");
  if (isCalendarDate(effectiveFrom) && effectiveTo !== null && isCalendarDate(effectiveTo) && effectiveTo < effectiveFrom) {
    errors.push("effectiveTo must not be before effectiveFrom");
  }
  const days = input?.days;
  const rows = [];
  if (!Array.isArray(days) || days.length === 0) {
    errors.push("days must be a non-empty array");
  } else if (days.length > 7) {
    errors.push("days may hold at most 7 entries");
  } else {
    const seen = new Set();
    days.forEach((day, index) => {
      const label = `days[${index}]`;
      if (!Number.isInteger(day?.weekday) || day.weekday < 0 || day.weekday > 6) {
        errors.push(`${label}.weekday must be an integer between 0 and 6`);
        return;
      }
      if (seen.has(day.weekday)) errors.push(`${label}.weekday ${day.weekday} appears more than once`);
      seen.add(day.weekday);
      const unavailable = day.unavailable === true;
      const start = day.availableStart ?? null;
      const end = day.availableEnd ?? null;
      if (unavailable) {
        if (start !== null || end !== null) errors.push(`${label}: an unavailable day carries no times`);
      } else if (start !== null || end !== null) {
        const a = timeOfDay(start);
        const b = timeOfDay(end);
        if (!a || !b) errors.push(`${label}: availableStart and availableEnd must both be HH:MM`);
        else if (!(a < b)) errors.push(`${label}: availableStart must be before availableEnd`);
      }
      rows.push({
        weekday: day.weekday,
        unavailable,
        available_start_local: unavailable ? null : timeOfDay(start),
        available_end_local: unavailable ? null : timeOfDay(end),
        effective_from: effectiveFrom,
        effective_to: effectiveTo
      });
    });
  }
  return { valid: errors.length === 0, errors, rows: errors.length === 0 ? rows : [] };
}

// --- Views (SC-15/SC-16) ------------------------------------------------------

// Monday-start week containing `dateStr` -> { weekStartDate, weekEndDate }.
export function weekRangeFor(dateStr) {
  const weekday = weekdayOfDateOnly(dateStr); // 0 Sun .. 6 Sat
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const weekStartDate = addDaysToDateOnly(dateStr, diffToMonday);
  return { weekStartDate, weekEndDate: addDaysToDateOnly(weekStartDate, 6) };
}

export function isValidDateOnly(value) {
  return isCalendarDate(value);
}

// GET /me/schedule body. SELF-SCOPING IS THE POINT: only assignments owned by
// `employeeId`, only in PUBLISHED periods, only live statuses, only shifts
// inside the requested week -- regardless of what the caller's reads happened
// to return (a schedule.read holder's query sees everything). Open shifts are
// the published, still-open, unstarted shifts of the week with a computed
// claimable flag; the caller's own requests ride along.
export function buildMySchedule({
  employeeId,
  weekStartDate,
  periods = [],
  shifts = [],
  assignments = [],
  claims = [],
  swaps = [],
  incomingSwaps = [],
  timeOff = [],
  now = new Date(),
  claimWindowHours = 48
}) {
  const weekEndDate = addDaysToDateOnly(weekStartDate, 6);
  const publishedPeriodIds = new Set(
    periods.filter((period) => period.status === "published" && !period.deleted_at).map((period) => period.id)
  );
  const inWeek = (shift) =>
    publishedPeriodIds.has(shift.schedule_period_id) &&
    !shift.deleted_at &&
    shift.shift_date >= weekStartDate &&
    shift.shift_date <= weekEndDate;
  const weekShifts = shifts.filter(inWeek);
  const shiftById = new Map(weekShifts.map((shift) => [shift.id, shift]));

  const mine = assignments
    .filter(
      (assignment) =>
        assignment.employee_id === employeeId &&
        !assignment.deleted_at &&
        LIVE_ASSIGNMENT_STATUSES.includes(assignment.status) &&
        shiftById.has(assignment.shift_id)
    )
    .map((assignment) => ({ assignment, shift: shiftById.get(assignment.shift_id) }))
    .sort((a, b) => new Date(a.shift.starts_at) - new Date(b.shift.starts_at));

  const myClaims = claims.filter((claim) => claim.claimant_employee_id === employeeId && !claim.deleted_at);
  const claimedShiftIds = new Set(myClaims.filter((claim) => claim.claim_status === "pending").map((claim) => claim.shift_id));
  const heldShiftIds = new Set(mine.map((entry) => entry.shift.id));
  const openShifts = weekShifts
    .filter((shift) => shift.status === "open" && new Date(shift.starts_at).getTime() > new Date(now).getTime())
    .map((shift) => ({
      shift,
      claimed: claimedShiftIds.has(shift.id),
      claimable:
        !claimedShiftIds.has(shift.id) &&
        !heldShiftIds.has(shift.id) &&
        isClaimWindowOpen({ openedAt: shift.opened_at ?? shift.updated_at, now, windowHours: claimWindowHours })
    }))
    .sort((a, b) => new Date(a.shift.starts_at) - new Date(b.shift.starts_at));

  return {
    employeeId,
    weekStartDate,
    weekEndDate,
    assignments: mine,
    openShifts,
    claims: myClaims,
    swaps: swaps.filter((swap) => swap.requester_employee_id === employeeId && !swap.deleted_at),
    // Requests that NAME this employee and still wait for their answer.
    incomingSwaps: incomingSwaps.filter(
      (swap) =>
        swap.target_employee_id === employeeId &&
        swap.requester_employee_id !== employeeId &&
        swap.status === "pending" &&
        !swap.deleted_at &&
        !swap.target_accepted_at &&
        !swap.target_declined_at
    ),
    timeOff: timeOff.filter((request) => request.employee_id === employeeId && !request.deleted_at)
  };
}

export const APPROVAL_TYPES = Object.freeze(["claims", "swaps", "time_off"]);

// Normalises the three request kinds into one queue for GET
// /facilities/:id/approvals. Each item carries just enough context for the
// manager panel (who, which shift(s), when) -- names/shifts come from the
// rows the route loaded, never from the request body.
export function buildApprovalItems({ claims = [], swaps = [], timeOff = [], employees = [], shifts = [], assignments = [] }) {
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const nameOf = (id) => {
    const employee = employeeById.get(id);
    return employee ? `${employee.first_name} ${employee.last_name}`.trim() : null;
  };
  const shiftSummary = (shift) =>
    shift
      ? { id: shift.id, roleCode: shift.role_code, shiftDate: shift.shift_date, startsAt: shift.starts_at, endsAt: shift.ends_at }
      : null;

  const items = [];
  for (const claim of claims) {
    items.push({
      type: "claims",
      id: claim.id,
      status: claim.claim_status,
      employeeId: claim.claimant_employee_id,
      employeeName: nameOf(claim.claimant_employee_id),
      shift: shiftSummary(shiftById.get(claim.shift_id)),
      reason: null,
      decisionReason: claim.decision_reason ?? null,
      createdAt: claim.created_at,
      decidedAt: claim.decided_at ?? null
    });
  }
  for (const swap of swaps) {
    const offered = assignmentById.get(swap.offered_assignment_id);
    const requested = swap.requested_assignment_id ? assignmentById.get(swap.requested_assignment_id) : null;
    items.push({
      type: "swaps",
      id: swap.id,
      status: swap.status,
      swapType: swap.swap_type,
      employeeId: swap.requester_employee_id,
      employeeName: nameOf(swap.requester_employee_id),
      targetEmployeeId: swap.target_employee_id ?? null,
      targetEmployeeName: swap.target_employee_id ? nameOf(swap.target_employee_id) : null,
      targetAcceptedAt: swap.target_accepted_at ?? null,
      awaitingTarget: Boolean(swap.target_employee_id) && !swap.target_accepted_at && swap.status === "pending",
      shift: shiftSummary(offered ? shiftById.get(offered.shift_id) : null),
      requestedShift: shiftSummary(requested ? shiftById.get(requested.shift_id) : null),
      reason: swap.reason ?? null,
      decisionReason: swap.decision_reason ?? null,
      createdAt: swap.created_at,
      decidedAt: swap.decided_at ?? null
    });
  }
  for (const request of timeOff) {
    items.push({
      type: "time_off",
      id: request.id,
      status: request.status,
      requestType: request.request_type,
      employeeId: request.employee_id,
      employeeName: nameOf(request.employee_id),
      startsAt: request.starts_at,
      endsAt: request.ends_at,
      reason: request.reason ?? null,
      decisionReason: request.decision_notes ?? null,
      createdAt: request.created_at,
      decidedAt: request.decided_at ?? null
    });
  }
  return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}
