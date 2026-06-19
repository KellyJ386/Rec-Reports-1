"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, requireRole } from "@/lib/auth/session";

export type MaintActionState = { error?: string; ok?: boolean };

/** Create a work order (any member). */
export async function createWorkOrder(_prev: MaintActionState, formData: FormData): Promise<MaintActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const parsed = z
      .object({
        title: z.string().trim().min(1, "Title is required"),
        description: z.string().optional().transform((v) => (v ? v : null)),
        work_order_category_id: z.string().optional().transform((v) => (v ? v : null)),
        asset_id: z.string().optional().transform((v) => (v ? v : null)),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      })
      .safeParse({
        title: formData.get("title"),
        description: formData.get("description"),
        work_order_category_id: formData.get("work_order_category_id"),
        asset_id: formData.get("asset_id"),
        priority: formData.get("priority") ?? "normal",
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("work_order").insert({
      facility_id: facilityId,
      created_by: user.id,
      ...parsed.data,
    });
    if (error) return { error: error.message };
    revalidatePath("/facility/work-orders");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create work order" };
  }
}

/** Assign a work order to a user (manager-only per §3.6 → supervisor+). */
export async function assignWorkOrder(workOrderId: string, userId: string): Promise<MaintActionState> {
  try {
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "supervisor");
    const supabase = await createClient();
    const { error } = await supabase
      .from("work_order")
      .update({ assigned_to: userId, status: "assigned" })
      .eq("id", workOrderId)
      .eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath(`/facility/work-orders/${workOrderId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to assign" };
  }
}

/** Update work order status (assignee or supervisor+; RLS enforces). */
export async function setWorkOrderStatus(
  workOrderId: string,
  status: "open" | "assigned" | "in_progress" | "completed" | "closed",
): Promise<MaintActionState> {
  try {
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const { error } = await supabase
      .from("work_order").update({ status }).eq("id", workOrderId).eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath(`/facility/work-orders/${workOrderId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update status" };
  }
}

/** Create an asset (supervisor+). */
export async function createAsset(_prev: MaintActionState, formData: FormData): Promise<MaintActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "supervisor");
    const parsed = z
      .object({
        name: z.string().trim().min(1, "Name is required"),
        asset_type_id: z.string().optional().transform((v) => (v ? v : null)),
        area_id: z.string().optional().transform((v) => (v ? v : null)),
        asset_tag: z.string().optional().transform((v) => (v ? v : null)),
      })
      .safeParse({
        name: formData.get("name"),
        asset_type_id: formData.get("asset_type_id"),
        area_id: formData.get("area_id"),
        asset_tag: formData.get("asset_tag"),
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("asset").insert({ facility_id: facilityId, created_by: user.id, ...parsed.data });
    if (error) return { error: error.message };
    revalidatePath("/facility/assets");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create asset" };
  }
}
