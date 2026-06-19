import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { toCsv } from "@/lib/exports/csv";

/** CSV of tasks for the active facility (MODULE_SPEC.md §6). RLS-scoped. */
export async function GET(_request: NextRequest) {
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data } = await supabase
    .from("task")
    .select("title, status, priority, due_at")
    .eq("facility_id", facilityId)
    .is("deleted_at", null)
    .order("due_at", { ascending: true, nullsFirst: false });

  const csv = toCsv(
    ["title", "status", "priority", "due_at"],
    (data ?? []).map((r) => [r.title, r.status, r.priority, r.due_at]),
  );
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="tasks.csv"' },
  });
}
