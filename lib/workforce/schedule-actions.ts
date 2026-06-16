"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, requireRole } from "@/lib/auth/session";
import { evaluateSchedulePeriod } from "@/lib/workforce/schedule-service";
import type { Conflict } from "@/lib/workforce/conflict-engine";

export type ScheduleActionState = { error?: string; ok?: boolean };
export type PublishResult =
  | { ok: true }
  | { ok: false; error?: string; blocking?: Conflict[] };

/** Create a draft schedule period for a week (supervisor+). */
export async function createSchedulePeriod(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  try {
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "supervisor");

    const parsed = z
      .object({ week_start_date: z.string().min(1, "Pick a week start date") })
      .safeParse({ week_start_date: formData.get("week_start_date") });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const start = new Date(parsed.data.week_start_date);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);

    const supabase = await createClient();
    const { error } = await supabase.from("schedule_period").insert({
      facility_id: facilityId,
      week_start_date: parsed.data.week_start_date,
      week_end_date: end.toISOString().slice(0, 10),
    });
    if (error) {
      if (error.code === "23505") return { error: "A schedule for that week already exists" };
      return { error: error.message };
    }
    revalidatePath("/workforce/schedule");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create schedule" };
  }
}

/**
 * Publish gate (MODULE_SPEC.md §4.1.2): a period with ANY blocking conflict cannot move
 * Draft -> Published. Returns all blocking conflicts so the UI can deep-link them. On
 * success the period and its shifts become published.
 */
export async function publishSchedule(periodId: string): Promise<PublishResult> {
  try {
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "supervisor");

    const evaluation = await evaluateSchedulePeriod(facilityId, periodId);
    if (!evaluation.canPublish) {
      return { ok: false, blocking: evaluation.blocking };
    }

    const supabase = await createClient();
    const { data: period } = await supabase
      .from("schedule_period")
      .select("publish_version")
      .eq("id", periodId)
      .eq("facility_id", facilityId)
      .single();

    const { error: pErr } = await supabase
      .from("schedule_period")
      .update({ status: "published", publish_version: (period?.publish_version ?? 0) + 1 })
      .eq("id", periodId)
      .eq("facility_id", facilityId);
    if (pErr) return { ok: false, error: pErr.message };

    await supabase
      .from("shift")
      .update({ status: "published" })
      .eq("schedule_period_id", periodId)
      .eq("facility_id", facilityId)
      .in("status", ["draft", "assigned"]);

    revalidatePath("/workforce/schedule");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to publish" };
  }
}
