/**
 * Scheduling conflict detection engine (MODULE_SPEC.md §4.1.2). PURE logic — no DB, no IO —
 * so it is exhaustively unit-testable. The server gathers data and calls this; the publish
 * gate (Draft -> Published) blocks on any `block` conflict.
 *
 * Resolutions: "allow" (no issue), "warn" (acknowledgeable with one confirmation), "block"
 * (hard stop; prevents publish). Conflicts carry a text label + icon — NEVER color alone
 * (CLAUDE.md §4); the UI styles them but the meaning is in `label`/`message`.
 */

export type Resolution = "allow" | "warn" | "block";

export type ConflictCode =
  | "double_booking"
  | "back_to_back_cross_facility"
  | "max_hours_day"
  | "max_hours_week"
  | "doubles_not_allowed"
  | "outside_availability"
  | "availability_closed"
  | "missing_cert"
  | "expired_cert"
  | "cert_expiring_before_shift"
  | "understaffed_template"
  | "open_shift";

export interface Conflict {
  code: ConflictCode;
  resolution: Resolution;
  /** Short text label for accessible display (icon paired in UI). */
  label: string;
  message: string;
  shiftId?: string;
  userId?: string;
}

/** Configurable Warn->Block toggles + thresholds (from facility.settings, MODULE_SPEC §5.1). */
export interface ConflictPolicy {
  maxHoursDayBlocks: boolean;
  maxHoursWeekBlocks: boolean;
  certExpiringBeforeShiftBlocks: boolean;
  /** Minutes between shifts at different facilities to flag a back-to-back warning. */
  backToBackThresholdMinutes: number;
}

export const DEFAULT_POLICY: ConflictPolicy = {
  maxHoursDayBlocks: false,
  maxHoursWeekBlocks: false,
  certExpiringBeforeShiftBlocks: false,
  backToBackThresholdMinutes: 60,
};

export interface ShiftLike {
  id: string;
  facilityId: string;
  jobAreaId: string;
  startsAt: Date | string;
  endsAt: Date | string;
  requiredCount: number;
  assignedUserIds: string[];
}

/** Another assignment the user already holds (this week), for overlap/hours/back-to-back. */
export interface ExistingAssignment {
  shiftId: string;
  facilityId: string;
  startsAt: Date | string;
  endsAt: Date | string;
}

export interface DayAvailability {
  weekday: number; // 0=Sun .. 6=Sat
  unavailable: boolean;
  availableStart?: string | null; // "HH:MM"
  availableEnd?: string | null;
}

export interface AvailabilityConfig {
  maxHoursPerDay?: number | null;
  maxHoursPerWeek?: number | null;
  doublesAllowed: boolean;
  byWeekday: Record<number, DayAvailability>;
}

export interface RequiredCert {
  certTypeId: string;
  name: string;
}

export interface UserCert {
  certTypeId: string;
  status: "active" | "expiring" | "expired";
  expiresOn?: Date | string | null;
}

export interface AssignmentEvaluation {
  shift: ShiftLike;
  userId: string;
  existingAssignments: ExistingAssignment[];
  availability: AvailabilityConfig;
  requiredCerts: RequiredCert[];
  userCerts: UserCert[];
  policy?: ConflictPolicy;
}

// --- helpers ---
const toDate = (d: Date | string): Date => (d instanceof Date ? d : new Date(d));
const hours = (start: Date | string, end: Date | string): number =>
  (toDate(end).getTime() - toDate(start).getTime()) / 3_600_000;
const overlaps = (
  aStart: Date | string,
  aEnd: Date | string,
  bStart: Date | string,
  bEnd: Date | string,
): boolean =>
  toDate(aStart).getTime() < toDate(bEnd).getTime() &&
  toDate(bStart).getTime() < toDate(aEnd).getTime();
const sameDay = (a: Date | string, b: Date | string): boolean =>
  toDate(a).toDateString() === toDate(b).toDateString();
/** Minutes in [HH:MM] -> minutes from midnight. */
const minsOfDay = (d: Date | string): number => {
  const x = toDate(d);
  return x.getHours() * 60 + x.getMinutes();
};
const parseHHMM = (s: string): number => {
  const [h, m] = s.split(":");
  return Number(h) * 60 + Number(m ?? 0);
};

/**
 * Evaluate a single (user -> shift) assignment against all user-scoped rules.
 * Returns every applicable conflict (may be multiple). Empty array = clean assignment.
 */
export function evaluateAssignment(input: AssignmentEvaluation): Conflict[] {
  const { shift, userId, existingAssignments, availability, requiredCerts, userCerts } = input;
  const policy = input.policy ?? DEFAULT_POLICY;
  const conflicts: Conflict[] = [];
  const base = { shiftId: shift.id, userId };

  // 1. Double-booking — overlap with any existing assignment (BLOCK).
  if (existingAssignments.some((a) => a.shiftId !== shift.id && overlaps(shift.startsAt, shift.endsAt, a.startsAt, a.endsAt))) {
    conflicts.push({ ...base, code: "double_booking", resolution: "block", label: "Double-booked", message: "Overlaps another assigned shift." });
  }

  // 2. Back-to-back across facilities (WARN).
  const gapMin = policy.backToBackThresholdMinutes;
  if (
    existingAssignments.some((a) => {
      if (a.facilityId === shift.facilityId) return false;
      const gapBefore = (toDate(shift.startsAt).getTime() - toDate(a.endsAt).getTime()) / 60000;
      const gapAfter = (toDate(a.startsAt).getTime() - toDate(shift.endsAt).getTime()) / 60000;
      return (gapBefore >= 0 && gapBefore < gapMin) || (gapAfter >= 0 && gapAfter < gapMin);
    })
  ) {
    conflicts.push({ ...base, code: "back_to_back_cross_facility", resolution: "warn", label: "Back-to-back (other facility)", message: "Little time between shifts at different facilities." });
  }

  const weekday = toDate(shift.startsAt).getDay();
  const day = availability.byWeekday[weekday];

  // 7. Availability closed (BLOCK).
  if (day?.unavailable) {
    conflicts.push({ ...base, code: "availability_closed", resolution: "block", label: "Marked unavailable", message: "Staff marked this day unavailable." });
  } else if (day && day.availableStart && day.availableEnd) {
    // 6. Outside availability window (WARN).
    const winStart = parseHHMM(day.availableStart);
    const winEnd = parseHHMM(day.availableEnd);
    if (minsOfDay(shift.startsAt) < winStart || minsOfDay(shift.endsAt) > winEnd) {
      conflicts.push({ ...base, code: "outside_availability", resolution: "warn", label: "Outside availability", message: "Shift falls outside the stated availability window." });
    }
  }

  // 5. Doubles not allowed (BLOCK) — already has a (non-overlapping) shift the same day.
  if (!availability.doublesAllowed && existingAssignments.some((a) => a.shiftId !== shift.id && sameDay(a.startsAt, shift.startsAt))) {
    conflicts.push({ ...base, code: "doubles_not_allowed", resolution: "block", label: "Doubles not allowed", message: "Staff is already scheduled that day and doesn't accept doubles." });
  }

  // 3/4. Max hours per day / week (WARN, configurable BLOCK).
  const candidateHours = hours(shift.startsAt, shift.endsAt);
  if (availability.maxHoursPerDay != null) {
    const dayHours = candidateHours + existingAssignments.filter((a) => a.shiftId !== shift.id && sameDay(a.startsAt, shift.startsAt)).reduce((s, a) => s + hours(a.startsAt, a.endsAt), 0);
    if (dayHours > availability.maxHoursPerDay) {
      conflicts.push({ ...base, code: "max_hours_day", resolution: policy.maxHoursDayBlocks ? "block" : "warn", label: "Over daily hours", message: `Day total ${dayHours.toFixed(1)}h exceeds max ${availability.maxHoursPerDay}h.` });
    }
  }
  if (availability.maxHoursPerWeek != null) {
    const weekHours = candidateHours + existingAssignments.filter((a) => a.shiftId !== shift.id).reduce((s, a) => s + hours(a.startsAt, a.endsAt), 0);
    if (weekHours > availability.maxHoursPerWeek) {
      conflicts.push({ ...base, code: "max_hours_week", resolution: policy.maxHoursWeekBlocks ? "block" : "warn", label: "Over weekly hours", message: `Week total ${weekHours.toFixed(1)}h exceeds max ${availability.maxHoursPerWeek}h.` });
    }
  }

  // 8/9/10. Cert checks (three-hop join already resolved into requiredCerts + userCerts).
  const certByType = new Map(userCerts.map((c) => [c.certTypeId, c]));
  for (const req of requiredCerts) {
    const held = certByType.get(req.certTypeId);
    if (!held) {
      conflicts.push({ ...base, code: "missing_cert", resolution: "warn", label: `Missing ${req.name}`, message: `Required certification "${req.name}" is not on file.` });
      continue;
    }
    if (held.status === "expired") {
      conflicts.push({ ...base, code: "expired_cert", resolution: "block", label: `${req.name} expired`, message: `Required certification "${req.name}" is expired.` });
      continue;
    }
    // Cert valid now but expires before the shift starts.
    if (held.expiresOn != null && toDate(held.expiresOn).getTime() < toDate(shift.startsAt).getTime()) {
      conflicts.push({ ...base, code: "cert_expiring_before_shift", resolution: policy.certExpiringBeforeShiftBlocks ? "block" : "warn", label: `${req.name} expires before shift`, message: `"${req.name}" expires before this shift starts.` });
    }
  }

  return conflicts;
}

/** Shift-level rules independent of a specific user. */
export function evaluateShift(shift: ShiftLike): Conflict[] {
  const conflicts: Conflict[] = [];
  const assigned = shift.assignedUserIds.length;
  if (assigned === 0) {
    conflicts.push({ shiftId: shift.id, code: "open_shift", resolution: "warn", label: "Open shift", message: "Shift has no assigned staff." });
  }
  if (assigned > 0 && assigned < shift.requiredCount) {
    conflicts.push({ shiftId: shift.id, code: "understaffed_template", resolution: "warn", label: "Understaffed", message: `Assigned ${assigned} of ${shift.requiredCount} required.` });
  }
  return conflicts;
}

/** Aggregate result for a whole schedule period + the publish decision. */
export interface ScheduleEvaluation {
  conflicts: Conflict[];
  blocking: Conflict[];
  canPublish: boolean;
}

/** Combine many evaluations into the publish gate (MODULE_SPEC.md §4.1.2). */
export function buildScheduleEvaluation(allConflicts: Conflict[]): ScheduleEvaluation {
  const blocking = allConflicts.filter((c) => c.resolution === "block");
  return { conflicts: allConflicts, blocking, canPublish: blocking.length === 0 };
}
