import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ReportKind } from "@/lib/operations/report-actions";

const TABLE = { injury: "injury_report", incident: "incident_report" } as const;
const PARENT_TYPE = { injury: "injury_report", incident: "incident_report" } as const;

export async function listReports(kind: ReportKind, facilityId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from(TABLE[kind])
    .select("id, incident_no, status, occurred_at, reported_at, summary")
    .eq("facility_id", facilityId)
    .is("deleted_at", null)
    .order("reported_at", { ascending: false });
  return data ?? [];
}

export async function getInjuryReport(id: string, facilityId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("injury_report").select("*").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  return data;
}

export async function getIncidentReport(id: string, facilityId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("incident_report").select("*").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  return data;
}

export async function getReportChildren(kind: ReportKind, parentId: string) {
  const supabase = await createClient();
  const [{ data: people }, { data: witnesses }] = await Promise.all([
    supabase.from("report_person").select("*").eq("parent_type", PARENT_TYPE[kind]).eq("parent_id", parentId).is("deleted_at", null),
    supabase.from("report_witness").select("*").eq("parent_type", PARENT_TYPE[kind]).eq("parent_id", parentId).is("deleted_at", null),
  ]);
  return { people: people ?? [], witnesses: witnesses ?? [] };
}

/** Config options for the new-report form. */
export async function getReportConfig(kind: ReportKind, facilityId: string) {
  const supabase = await createClient();
  const modules = kind === "injury" ? ["general", "injury"] : ["general", "incident"];
  const [{ data: severities }, { data: areas }, { data: categories }] = await Promise.all([
    supabase.from("severity_level").select("id, name").eq("facility_id", facilityId).eq("active", true).in("module", modules).order("weight"),
    supabase.from("area").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    kind === "incident"
      ? supabase.from("incident_category").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order")
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  return { severities: severities ?? [], areas: areas ?? [], categories: categories ?? [] };
}
