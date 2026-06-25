import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { recordCount } from "@/lib/facility/task-actions";
import { CreateForm } from "@/components/facility/CreateForm";

export default async function CountsPage() {
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const [{ data: areas }, { data: types }, { data: recent }] = await Promise.all([
    supabase.from("count_area").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    supabase.from("count_type").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    supabase.from("utilization_count").select("id, count_value, counted_at").eq("facility_id", facilityId).is("deleted_at", null).order("counted_at", { ascending: false }).limit(20),
  ]);

  const todayTotal = (recent ?? [])
    .filter((c) => new Date(c.counted_at).toDateString() === new Date().toDateString())
    .reduce((s, c) => s + c.count_value, 0);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Utilization Counts</h1>
        <p className="text-sm text-gray-600">Today&apos;s recorded total: <span className="font-medium text-forest">{todayTotal}</span></p>
      </div>
      <CreateForm
        title="Record a count"
        action={recordCount}
        submitLabel="Record"
        fields={[
          { name: "count_area_id", label: "Area", type: "select", options: (areas ?? []).map((a) => ({ value: a.id, label: a.name })) },
          { name: "count_type_id", label: "Type", type: "select", options: (types ?? []).map((t) => ({ value: t.id, label: t.name })) },
          { name: "count_value", label: "Count", type: "number", required: true },
        ]}
      />
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(recent ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No counts yet.</li>}
        {(recent ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between p-4 text-sm">
            <span className="font-medium text-gray-900">{c.count_value}</span>
            <span className="text-xs text-gray-500">{new Date(c.counted_at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
