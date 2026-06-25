"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, requireRole } from "@/lib/auth/session";

export type OpsActionState = { error?: string; ok?: boolean };

// --- Daily Log (§2.3) ---
export async function addDailyLogEntry(
  _prev: OpsActionState,
  formData: FormData,
): Promise<OpsActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const parsed = z
      .object({
        body: z.string().trim().min(1, "Entry text is required"),
        area_id: z.string().optional().transform((v) => (v ? v : null)),
        task_category_id: z.string().optional().transform((v) => (v ? v : null)),
      })
      .safeParse({
        body: formData.get("body"),
        area_id: formData.get("area_id"),
        task_category_id: formData.get("task_category_id"),
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("daily_log_entry").insert({
      facility_id: facilityId,
      body: parsed.data.body,
      area_id: parsed.data.area_id,
      task_category_id: parsed.data.task_category_id,
      created_by: user.id,
    });
    if (error) return { error: error.message };
    revalidatePath("/operations/daily-log");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add entry" };
  }
}

// --- Memo Board (§2.5) ---
export async function postMemo(
  _prev: OpsActionState,
  formData: FormData,
): Promise<OpsActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "supervisor");

    const parsed = z
      .object({
        subject: z.string().trim().min(1, "Subject is required"),
        body_richtext: z.string().optional().transform((v) => (v ? v : null)),
        to_group_id: z.string().optional().transform((v) => (v ? v : null)),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
      })
      .safeParse({
        subject: formData.get("subject"),
        body_richtext: formData.get("body_richtext"),
        to_group_id: formData.get("to_group_id"),
        priority: formData.get("priority") ?? "normal",
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("memo").insert({
      facility_id: facilityId,
      from_user_id: user.id,
      subject: parsed.data.subject,
      body_richtext: parsed.data.body_richtext,
      to_group_id: parsed.data.to_group_id,
      priority: parsed.data.priority,
      optional_email: formData.get("optional_email") === "on",
      created_by: user.id,
    });
    if (error) return { error: error.message };
    revalidatePath("/operations/memos");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to post memo" };
  }
}

export async function markMemoRead(memoId: string): Promise<OpsActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const { error } = await supabase
      .from("memo_receipt")
      .upsert(
        { facility_id: facilityId, memo_id: memoId, user_id: user.id, read_at: new Date().toISOString() },
        { onConflict: "memo_id,user_id" },
      );
    if (error) return { error: error.message };
    revalidatePath("/operations/memos");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to mark read" };
  }
}

// --- EOD Report (§2.4) ---
export async function saveEod(
  _prev: OpsActionState,
  formData: FormData,
): Promise<OpsActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const today = new Date().toISOString().slice(0, 10);

    const payload = {
      summary: (formData.get("summary") as string) ?? null,
      incidents_occurred: formData.get("incidents_occurred") === "on",
      equipment_issues: formData.get("equipment_issues") === "on",
    };

    const { data: existing } = await supabase
      .from("eod_report")
      .select("id, status")
      .eq("facility_id", facilityId)
      .eq("report_date", today)
      .maybeSingle();

    if (existing) {
      if (existing.status === "locked") return { error: "Today's EOD report is locked" };
      const { error } = await supabase.from("eod_report").update(payload).eq("id", existing.id).eq("facility_id", facilityId);
      if (error) return { error: error.message };
    } else {
      const { error } = await supabase.from("eod_report").insert({
        facility_id: facilityId,
        report_date: today,
        created_by: user.id,
        ...payload,
      });
      if (error) return { error: error.message };
    }
    revalidatePath("/operations/eod");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save EOD" };
  }
}

export async function submitEod(): Promise<OpsActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase
      .from("eod_report")
      .update({ status: "submitted", submitted_by: user.id, submitted_at: new Date().toISOString() })
      .eq("facility_id", facilityId)
      .eq("report_date", today)
      .eq("status", "draft");
    if (error) return { error: error.message };
    revalidatePath("/operations/eod");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to submit EOD" };
  }
}
