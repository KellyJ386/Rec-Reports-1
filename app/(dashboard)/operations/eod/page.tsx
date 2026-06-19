import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { EodForm } from "@/components/operations/OpsForms";

export default async function EodPage() {
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data: existing } = await supabase
    .from("eod_report")
    .select("summary, incidents_occurred, equipment_issues, status")
    .eq("facility_id", facilityId)
    .eq("report_date", today)
    .maybeSingle();

  // Phase 5.1 cross-links: surface today's reports / maintenance entry from the EOD.
  let todaysReports: { id: string; incident_no: string; kind: "injury" | "incident" }[] = [];
  if (existing?.incidents_occurred) {
    const [{ data: injuries }, { data: incidents }] = await Promise.all([
      supabase.from("injury_report").select("id, incident_no").eq("facility_id", facilityId).gte("reported_at", `${today}T00:00:00Z`),
      supabase.from("incident_report").select("id, incident_no").eq("facility_id", facilityId).gte("reported_at", `${today}T00:00:00Z`),
    ]);
    todaysReports = [
      ...(injuries ?? []).map((r) => ({ ...r, kind: "injury" as const })),
      ...(incidents ?? []).map((r) => ({ ...r, kind: "incident" as const })),
    ];
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/operations" className="text-sm text-navy-700 hover:underline">← Operations</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">End-of-Day Report</h1>
        <p className="text-sm text-gray-600">For {today}. One report per facility per day.</p>
      </div>
      <EodForm existing={existing} />

      {existing?.incidents_occurred && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Today&apos;s reports</h2>
          <ul className="mt-2 text-sm">
            {todaysReports.length === 0 && <li className="text-gray-500">No reports you can view today.</li>}
            {todaysReports.map((r) => (
              <li key={`${r.kind}-${r.id}`}>
                <Link href={`/operations/${r.kind}/${r.id}`} className="text-forest underline">
                  {r.incident_no} ({r.kind})
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {existing?.equipment_issues && (
        <p className="text-sm text-gray-600">
          Equipment issues flagged —{" "}
          <Link href="/facility/work-orders" className="text-forest underline">create a work order</Link>.
        </p>
      )}
    </div>
  );
}
