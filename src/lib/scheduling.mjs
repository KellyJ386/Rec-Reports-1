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
export function summarizeScheduleReadiness(assignments, certificationsByEmployee, config = {}, { roleRequirements } = {}) {
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

  return {
    canPublish: doubleBookings.length === 0 && blocking.length === 0,
    doubleBookings,
    missingCertifications,
    warnings,
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
