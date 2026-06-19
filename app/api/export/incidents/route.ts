import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { toCsv } from "@/lib/exports/csv";

/** CSV of incident reports for the active facility (MODULE_SPEC.md §6). RLS-scoped. */
export async function GET(_request: NextRequest) {
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data } = await supabase
    .from("incident_report")
    .select("incident_no, status, occurred_at, reported_at, summary")
    .eq("facility_id", facilityId)
    .is("deleted_at", null)
    .order("reported_at", { ascending: false });

  const csv = toCsv(
    ["incident_no", "status", "occurred_at", "reported_at", "summary"],
    (data ?? []).map((r) => [r.incident_no, r.status, r.occurred_at, r.reported_at, r.summary]),
  );
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="incidents.csv"' },
  });
}
