"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, requireRole } from "@/lib/auth/session";
import { parseFormSchema, validateAnswers, type FormField, type AnswerErrors } from "@/lib/facility/form-schema";

export type FormActionState = { error?: string; ok?: boolean };

/** Create a draft form and open its builder (facility_manager+). */
export async function createForm(_prev: FormActionState, formData: FormData): Promise<FormActionState> {
  let id: string | null = null;
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "facility_manager");
    const parsed = z
      .object({
        name: z.string().trim().min(1, "Name is required"),
        form_category_id: z.string().optional().transform((v) => (v ? v : null)),
        schedule: z.enum(["ad_hoc", "daily", "weekly", "event"]).default("ad_hoc"),
      })
      .safeParse({
        name: formData.get("name"),
        form_category_id: formData.get("form_category_id"),
        schedule: formData.get("schedule") ?? "ad_hoc",
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("form")
      .insert({ facility_id: facilityId, created_by: user.id, ...parsed.data })
      .select("id")
      .single();
    if (error) return { error: error.message };
    id = data.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create form" };
  }
  if (id) redirect(`/facility/forms/${id}`);
  return { ok: true };
}

/** Save the builder's field list (validated) onto the form (facility_manager+). */
export async function saveFormSchema(formId: string, fields: FormField[]): Promise<FormActionState> {
  try {
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "facility_manager");
    const parsed = parseFormSchema(fields);
    if (parsed.error) return { error: parsed.error };

    const supabase = await createClient();
    const { error } = await supabase
      .from("form")
      .update({ schema_json: parsed.fields })
      .eq("id", formId)
      .eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath(`/facility/forms/${formId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save schema" };
  }
}

/** Publish a form after validating its schema (facility_manager+). */
export async function publishForm(formId: string): Promise<FormActionState> {
  try {
    const facilityId = await requireFacilityId();
    await requireRole(facilityId, "facility_manager");
    const supabase = await createClient();
    const { data: form } = await supabase
      .from("form").select("schema_json").eq("id", formId).eq("facility_id", facilityId).maybeSingle();
    if (!form) return { error: "Form not found" };
    const parsed = parseFormSchema(form.schema_json);
    if (parsed.error) return { error: parsed.error };
    if (parsed.fields.length === 0) return { error: "Add at least one field before publishing" };

    const { error } = await supabase
      .from("form").update({ status: "published" }).eq("id", formId).eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath(`/facility/forms/${formId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to publish" };
  }
}

export type SubmitResult = { ok: boolean; errors?: AnswerErrors; error?: string };

/** Submit a response — answers validated server-side against the form's own schema (§3.3). */
export async function submitFormResponse(
  formId: string,
  answers: Record<string, unknown>,
  assetId?: string | null,
): Promise<SubmitResult> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const { data: form } = await supabase
      .from("form").select("status, version_no, schema_json").eq("id", formId).eq("facility_id", facilityId).maybeSingle();
    if (!form) return { ok: false, error: "Form not found" };
    if (form.status !== "published") return { ok: false, error: "Form is not published" };

    const { fields, error: schemaErr } = parseFormSchema(form.schema_json);
    if (schemaErr) return { ok: false, error: schemaErr };

    const result = validateAnswers(fields, answers);
    if (!result.ok) return { ok: false, errors: result.errors };

    const { data: response, error } = await supabase
      .from("form_response")
      .insert({
        facility_id: facilityId,
        form_id: formId,
        form_version_no: form.version_no,
        answers_json: result.value,
        created_by: user.id,
        submitted_by: user.id,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };

    // Cross-module link (Phase 5.1): a PM/Inspection response tied to an asset feeds the
    // asset's inspection history (MODULE_SPEC.md §3.6).
    if (assetId) {
      await supabase.from("asset_inspection_history").insert({
        facility_id: facilityId,
        asset_id: assetId,
        form_response_id: response.id,
      });
    }

    revalidatePath(`/facility/forms/${formId}/respond`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to submit" };
  }
}
