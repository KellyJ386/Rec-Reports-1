import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderReportPdf, type PdfSection } from "@/lib/exports/pdf";

/** PDF of a filed injury/incident report (MODULE_SPEC.md §6). RLS-scoped to the caller. */
export async function GET(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get("kind");
  const id = request.nextUrl.searchParams.get("id");
  if ((kind !== "injury" && kind !== "incident") || !id) {
    return new Response("kind (injury|incident) and id required", { status: 400 });
  }
  const table = kind === "injury" ? "injury_report" : "incident_report";
  const supabase = await createClient();

  const { data: report } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
  if (!report) return new Response("Not found", { status: 404 });

  const [{ data: people }, { data: witnesses }] = await Promise.all([
    supabase.from("report_person").select("full_name, person_role").eq("parent_type", table).eq("parent_id", id).is("deleted_at", null),
    supabase.from("report_witness").select("full_name, statement").eq("parent_type", table).eq("parent_id", id).is("deleted_at", null),
  ]);

  const r = report as Record<string, unknown>;
  const overview: string[] = [
    `Type: ${kind === "injury" ? (r.report_type as string) : "incident"}`,
    `Status: ${r.status as string}`,
    `Occurred: ${r.occurred_at ? new Date(r.occurred_at as string).toLocaleString() : "—"}`,
    `Reported: ${new Date(r.reported_at as string).toLocaleString()}`,
    `Summary: ${(r.summary as string) || "—"}`,
    `Immediate actions: ${(r.immediate_actions as string) || "—"}`,
  ];

  const sections: PdfSection[] = [
    { heading: "Overview", lines: overview },
    {
      heading: "People involved",
      lines: (people ?? []).length ? (people ?? []).map((p) => `${p.full_name} — ${p.person_role}`) : ["None recorded."],
    },
    {
      heading: "Witnesses",
      lines: (witnesses ?? []).length ? (witnesses ?? []).map((w) => `${w.full_name}: ${w.statement ?? ""}`) : ["None recorded."],
    },
  ];

  const bytes = await renderReportPdf({
    title: `${r.incident_no as string}`,
    subtitle: `${kind === "injury" ? "Injury / Illness" : "Incident"} report`,
    sections,
    footer: `Generated ${new Date().toISOString()} · RecReports`,
  });

  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${r.incident_no as string}.pdf"`,
    },
  });
}
