import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderReportPdf, type PdfSection } from "@/lib/exports/pdf";

/** Postable weekly schedule PDF (MODULE_SPEC.md §4.1.6 / §6). RLS-scoped. */
export async function GET(request: NextRequest) {
  const periodId = request.nextUrl.searchParams.get("period_id");
  if (!periodId) return new Response("period_id required", { status: 400 });
  const supabase = await createClient();

  const { data: period } = await supabase
    .from("schedule_period").select("id, week_start_date, week_end_date, status").eq("id", periodId).maybeSingle();
  if (!period) return new Response("Not found", { status: 404 });

  const { data: shifts } = await supabase
    .from("shift")
    .select("id, starts_at, ends_at, status, job_area_id")
    .eq("schedule_period_id", periodId)
    .is("deleted_at", null)
    .order("starts_at", { ascending: true });

  const { data: assignments } = await supabase
    .from("shift_assignment")
    .select("shift_id, user_id")
    .in("status", ["pending", "approved"]);
  const assignedByShift = new Map<string, number>();
  for (const a of assignments ?? []) assignedByShift.set(a.shift_id, (assignedByShift.get(a.shift_id) ?? 0) + 1);

  // group by day
  const byDay = new Map<string, string[]>();
  for (const s of shifts ?? []) {
    const day = new Date(s.starts_at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const time = `${new Date(s.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${new Date(s.ends_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const staffed = assignedByShift.get(s.id) ?? 0;
    const label = `${time} · ${staffed > 0 ? `${staffed} assigned` : "OPEN"}${s.status === "open" ? " (open)" : ""}`;
    byDay.set(day, [...(byDay.get(day) ?? []), label]);
  }

  const sections: PdfSection[] = [...byDay.entries()].map(([day, lines]) => ({ heading: day, lines }));
  if (sections.length === 0) sections.push({ heading: "No shifts", lines: ["This schedule has no shifts."] });

  const bytes = await renderReportPdf({
    title: `Weekly schedule — ${period.week_start_date} to ${period.week_end_date}`,
    subtitle: `Status: ${period.status}`,
    sections,
    footer: `Generated ${new Date().toISOString()} · RecReports`,
  });

  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="schedule-${period.week_start_date}.pdf"`,
    },
  });
}
