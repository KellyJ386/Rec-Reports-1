"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId } from "@/lib/auth/session";

export type ReportKind = "injury" | "incident";
export type ReportActionState = { error?: string; ok?: boolean };

const TABLE: Record<ReportKind, "injury_report" | "incident_report"> = {
  injury: "injury_report",
  incident: "incident_report",
};
const PREFIX: Record<ReportKind, string> = { injury: "INJ", incident: "INC" };

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

/** Create a new draft report and go to its detail page. */
export async function createReport(
  kind: ReportKind,
  _prev: ReportActionState,
  formData: FormData,
): Promise<ReportActionState> {
  let newId: string | null = null;
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const supabase = await createClient();

    const incidentNo = `${PREFIX[kind]}-${Date.now().toString(36).toUpperCase()}`;
    const common = {
      facility_id: facilityId,
      incident_no: incidentNo,
      severity_level_id: emptyToNull(formData.get("severity_level_id")),
      area_id: emptyToNull(formData.get("area_id")),
      occurred_at: emptyToNull(formData.get("occurred_at")),
      summary: emptyToNull(formData.get("summary")),
      immediate_actions: emptyToNull(formData.get("immediate_actions")),
      created_by: user.id,
    };

    if (kind === "injury") {
      const reportType = formData.get("report_type") === "illness" ? "illness" : "injury";
      const { data, error } = await supabase
        .from("injury_report")
        .insert({ ...common, report_type: reportType })
        .select("id")
        .single();
      if (error) return { error: error.message };
      newId = data.id;
    } else {
      const { data, error } = await supabase
        .from("incident_report")
        .insert({
          ...common,
          incident_category_id: emptyToNull(formData.get("incident_category_id")),
          follow_up_required: formData.get("follow_up_required") === "on",
        })
        .select("id")
        .single();
      if (error) return { error: error.message };
      newId = data.id;
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create report" };
  }
  // redirect() throws — must be outside try/catch.
  if (newId) redirect(`/operations/${kind}/${newId}`);
  return { ok: true };
}

const STATUS_VALUES = ["draft", "submitted", "reviewed", "closed"] as const;

/** Transition a report's status. The DB trigger enforces lock + valid transitions. */
export async function setReportStatus(
  kind: ReportKind,
  id: string,
  target: (typeof STATUS_VALUES)[number],
): Promise<ReportActionState> {
  try {
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const { error } = await supabase
      .from(TABLE[kind])
      .update({ status: target })
      .eq("id", id)
      .eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath(`/operations/${kind}/${id}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update status" };
  }
}

const personSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required"),
  person_role: z.enum(["injured", "involved", "completing"]),
  phone: z.string().trim().optional(),
});

/** Add a person involved (polymorphic child). facility_id is derived by a DB trigger. */
export async function addReportPerson(
  kind: ReportKind,
  parentId: string,
  _prev: ReportActionState,
  formData: FormData,
): Promise<ReportActionState> {
  try {
    const user = await requireUser();
    await requireFacilityId();
    const parsed = personSchema.safeParse({
      full_name: formData.get("full_name"),
      person_role: formData.get("person_role"),
      phone: formData.get("phone"),
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("report_person").insert({
      parent_id: parentId,
      parent_type: TABLE[kind],
      person_role: parsed.data.person_role,
      full_name: parsed.data.full_name,
      contact: parsed.data.phone ? { phone: parsed.data.phone } : {},
      created_by: user.id,
    });
    if (error) return { error: error.message };
    revalidatePath(`/operations/${kind}/${parentId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add person" };
  }
}

const witnessSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required"),
  statement: z.string().trim().optional(),
});

export async function addReportWitness(
  kind: ReportKind,
  parentId: string,
  _prev: ReportActionState,
  formData: FormData,
): Promise<ReportActionState> {
  try {
    const user = await requireUser();
    await requireFacilityId();
    const parsed = witnessSchema.safeParse({
      full_name: formData.get("full_name"),
      statement: formData.get("statement"),
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("report_witness").insert({
      parent_id: parentId,
      parent_type: TABLE[kind],
      full_name: parsed.data.full_name,
      statement: parsed.data.statement ?? null,
      created_by: user.id,
    });
    if (error) return { error: error.message };
    revalidatePath(`/operations/${kind}/${parentId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add witness" };
  }
}
