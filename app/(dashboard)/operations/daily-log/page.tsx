import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { DailyLogForm } from "@/components/operations/OpsForms";

export default async function DailyLogPage() {
  const facilityId = await requireFacilityId();
  const supabase = await createClient();

  const [{ data: entries }, { data: areas }, { data: categories }] = await Promise.all([
    supabase.from("daily_log_entry").select("id, body, log_date, entry_at").eq("facility_id", facilityId).is("deleted_at", null).order("entry_at", { ascending: false }).limit(50),
    supabase.from("area").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    supabase.from("task_category").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/operations" className="text-sm text-navy-700 hover:underline">← Operations</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Daily Log</h1>
      </div>
      <DailyLogForm areas={areas ?? []} categories={categories ?? []} />
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(entries ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No entries yet.</li>}
        {(entries ?? []).map((e) => (
          <li key={e.id} className="p-4 text-sm">
            <p className="text-gray-900">{e.body}</p>
            <p className="mt-1 text-xs text-gray-400">{new Date(e.entry_at).toLocaleString()}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
