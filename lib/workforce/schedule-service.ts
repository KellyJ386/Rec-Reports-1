import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  evaluateAssignment,
  evaluateShift,
  buildScheduleEvaluation,
  DEFAULT_POLICY,
  type Conflict,
  type ConflictPolicy,
  type AvailabilityConfig,
  type DayAvailability,
  type ExistingAssignment,
  type RequiredCert,
  type ScheduleEvaluation,
} from "@/lib/workforce/conflict-engine";

const ACTIVE_ASSIGNMENT = ["pending", "approved"] as const;

/** Read the facility's conflict policy from facility.settings, falling back to defaults. */
function policyFromSettings(settings: Record<string, unknown> | null | undefined): ConflictPolicy {
  const p = (settings?.conflict_policy ?? {}) as Partial<ConflictPolicy>;
  return { ...DEFAULT_POLICY, ...p };
}

/**
 * Gather all data for a schedule period and run the conflict engine over every assignment
 * and shift. Uses the request-bound client so RLS scopes everything to the caller's
 * facility (MODULE_SPEC.md §4.1.2). Returns the aggregated evaluation incl. the publish gate.
 */
export async function evaluateSchedulePeriod(
  facilityId: string,
  periodId: string,
): Promise<ScheduleEvaluation> {
  const supabase = await createClient();

  const [{ data: shifts }, { data: assignments }, { data: reqCerts }, { data: certTypes }, { data: certStatuses }, { data: avail }, { data: facility }] =
    await Promise.all([
      supabase.from("shift").select("*").eq("facility_id", facilityId).eq("schedule_period_id", periodId).is("deleted_at", null),
      supabase.from("shift_assignment").select("*").eq("facility_id", facilityId).is("deleted_at", null).in("status", ACTIVE_ASSIGNMENT),
      supabase.from("job_area_required_cert").select("job_area_id, cert_type_id").eq("facility_id", facilityId).is("deleted_at", null),
      supabase.from("cert_type").select("id, name").eq("facility_id", facilityId),
      supabase.from("staff_certification_status").select("user_id, cert_type_id, status, expires_on").eq("facility_id", facilityId),
      supabase.from("availability").select("*").eq("facility_id", facilityId).is("deleted_at", null),
      supabase.from("facility").select("settings").eq("id", facilityId).single(),
    ]);

  const certTypeName = new Map((certTypes ?? []).map((c) => [c.id, c.name]));

  const allShifts = shifts ?? [];
  const shiftIds = new Set(allShifts.map((s) => s.id));
  // Only assignments belonging to this period's shifts.
  const periodAssignments = (assignments ?? []).filter((a) => shiftIds.has(a.shift_id));
  const policy = policyFromSettings(facility?.settings as Record<string, unknown>);

  // shiftId -> assigned userIds
  const assignedByShift = new Map<string, string[]>();
  for (const a of periodAssignments) {
    assignedByShift.set(a.shift_id, [...(assignedByShift.get(a.shift_id) ?? []), a.user_id]);
  }

  // jobAreaId -> required certs
  const requiredByJobArea = new Map<string, RequiredCert[]>();
  for (const rc of reqCerts ?? []) {
    requiredByJobArea.set(rc.job_area_id, [
      ...(requiredByJobArea.get(rc.job_area_id) ?? []),
      { certTypeId: rc.cert_type_id, name: certTypeName.get(rc.cert_type_id) ?? "Certification" },
    ]);
  }

  // userId -> certs
  const certsByUser = new Map<string, { certTypeId: string; status: "active" | "expiring" | "expired"; expiresOn: string | null }[]>();
  for (const c of certStatuses ?? []) {
    certsByUser.set(c.user_id, [
      ...(certsByUser.get(c.user_id) ?? []),
      { certTypeId: c.cert_type_id, status: c.status, expiresOn: c.expires_on },
    ]);
  }

  // userId -> availability config
  const availByUser = new Map<string, AvailabilityConfig>();
  for (const row of avail ?? []) {
    const existing = availByUser.get(row.user_id) ?? {
      doublesAllowed: row.doubles_allowed,
      maxHoursPerDay: row.max_hours_per_day,
      maxHoursPerWeek: row.max_hours_per_week,
      byWeekday: {} as Record<number, DayAvailability>,
    };
    existing.byWeekday[row.weekday] = {
      weekday: row.weekday,
      unavailable: row.unavailable,
      availableStart: row.available_start,
      availableEnd: row.available_end,
    };
    // doubles/max-hours are taken from the latest row seen (assumed consistent per user).
    existing.doublesAllowed = row.doubles_allowed;
    existing.maxHoursPerDay = row.max_hours_per_day;
    existing.maxHoursPerWeek = row.max_hours_per_week;
    availByUser.set(row.user_id, existing);
  }

  // userId -> all their assignments this period (for overlap / hours / back-to-back)
  const shiftById = new Map(allShifts.map((s) => [s.id, s]));
  const assignmentsByUser = new Map<string, ExistingAssignment[]>();
  for (const a of periodAssignments) {
    const s = shiftById.get(a.shift_id);
    if (!s) continue;
    assignmentsByUser.set(a.user_id, [
      ...(assignmentsByUser.get(a.user_id) ?? []),
      { shiftId: s.id, facilityId: s.facility_id, startsAt: s.starts_at, endsAt: s.ends_at },
    ]);
  }

  const conflicts: Conflict[] = [];

  for (const s of allShifts) {
    const assignedUserIds = assignedByShift.get(s.id) ?? [];
    conflicts.push(
      ...evaluateShift({
        id: s.id,
        facilityId: s.facility_id,
        jobAreaId: s.job_area_id,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        requiredCount: s.required_count,
        assignedUserIds,
      }),
    );

    for (const userId of assignedUserIds) {
      conflicts.push(
        ...evaluateAssignment({
          shift: {
            id: s.id,
            facilityId: s.facility_id,
            jobAreaId: s.job_area_id,
            startsAt: s.starts_at,
            endsAt: s.ends_at,
            requiredCount: s.required_count,
            assignedUserIds,
          },
          userId,
          existingAssignments: assignmentsByUser.get(userId) ?? [],
          availability: availByUser.get(userId) ?? { doublesAllowed: true, byWeekday: {} },
          requiredCerts: requiredByJobArea.get(s.job_area_id) ?? [],
          userCerts: certsByUser.get(userId) ?? [],
          policy,
        }),
      );
    }
  }

  return buildScheduleEvaluation(conflicts);
}
