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

  return (
    <div className="space-y-6">
      <div>
        <Link href="/operations" className="text-sm text-navy-700 hover:underline">← Operations</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">End-of-Day Report</h1>
        <p className="text-sm text-gray-600">For {today}. One report per facility per day.</p>
      </div>
      <EodForm existing={existing} />
    </div>
  );
}
