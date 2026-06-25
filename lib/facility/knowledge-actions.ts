"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, requireRole } from "@/lib/auth/session";

export type KnowledgeActionState = { error?: string; ok?: boolean };

/** Create an SOP with its first version (facility_manager+). */
export async function createSop(_prev: KnowledgeActionState, formData: FormData): Promise<KnowledgeActionState> {
  let id: string | null = null;
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "facility_manager");
    const parsed = z
      .object({
        title: z.string().trim().min(1, "Title is required"),
        sop_category_id: z.string().optional().transform((v) => (v ? v : null)),
        visibility_role: z.enum(["staff", "supervisor", "facility_manager", "org_admin"]).default("staff"),
        body_richtext: z.string().optional(),
      })
      .safeParse({
        title: formData.get("title"),
        sop_category_id: formData.get("sop_category_id"),
        visibility_role: formData.get("visibility_role") ?? "staff",
        body_richtext: formData.get("body_richtext") ?? undefined,
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { data: sop, error } = await supabase
      .from("sop")
      .insert({
        facility_id: facilityId,
        title: parsed.data.title,
        sop_category_id: parsed.data.sop_category_id,
        visibility_role: parsed.data.visibility_role,
        acknowledgment_required: formData.get("acknowledgment_required") === "on",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) return { error: error.message };

    const { error: vErr } = await supabase.from("sop_version").insert({
      facility_id: facilityId,
      sop_id: sop.id,
      version_no: 1,
      body_richtext: parsed.data.body_richtext ?? null,
      published_by: user.id,
    });
    if (vErr) return { error: vErr.message };
    id = sop.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create SOP" };
  }
  if (id) redirect(`/facility/sops/${id}`);
  return { ok: true };
}

/** Acknowledge the current version of an SOP (any member with visibility). */
export async function acknowledgeSop(sopVersionId: string): Promise<KnowledgeActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const { error } = await supabase.from("sop_acknowledgment").insert({
      facility_id: facilityId,
      sop_version_id: sopVersionId,
      user_id: user.id,
    });
    if (error && error.code !== "23505") return { error: error.message };
    revalidatePath("/facility/sops");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to acknowledge" };
  }
}

/** Create an ERP (facility_manager+). Steps entered one per line. */
export async function createErp(_prev: KnowledgeActionState, formData: FormData): Promise<KnowledgeActionState> {
  let id: string | null = null;
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "facility_manager");
    const parsed = z
      .object({
        title: z.string().trim().min(1, "Title is required"),
        erp_scenario_type_id: z.string().optional().transform((v) => (v ? v : null)),
        erp_response_level_id: z.string().optional().transform((v) => (v ? v : null)),
        steps: z.string().optional(),
        evacuation_ref: z.string().optional().transform((v) => (v ? v : null)),
        aed_ref: z.string().optional().transform((v) => (v ? v : null)),
      })
      .safeParse({
        title: formData.get("title"),
        erp_scenario_type_id: formData.get("erp_scenario_type_id"),
        erp_response_level_id: formData.get("erp_response_level_id"),
        steps: formData.get("steps") ?? undefined,
        evacuation_ref: formData.get("evacuation_ref"),
        aed_ref: formData.get("aed_ref"),
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const steps = (parsed.data.steps ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("erp")
      .insert({
        facility_id: facilityId,
        title: parsed.data.title,
        erp_scenario_type_id: parsed.data.erp_scenario_type_id,
        erp_response_level_id: parsed.data.erp_response_level_id,
        protocol_steps_json: steps,
        evacuation_ref: parsed.data.evacuation_ref,
        aed_ref: parsed.data.aed_ref,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) return { error: error.message };
    id = data.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create ERP" };
  }
  if (id) redirect(`/facility/erps/${id}`);
  return { ok: true };
}
