import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { createErp } from "@/lib/facility/knowledge-actions";
import { CreateForm } from "@/components/facility/CreateForm";

export default async function ErpsPage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "facility_manager");
  const supabase = await createClient();
  const [{ data: erps }, { data: scenarios }, { data: levels }] = await Promise.all([
    supabase.from("erp").select("id, title").eq("facility_id", facilityId).is("deleted_at", null).order("title"),
    supabase.from("erp_scenario_type").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    supabase.from("erp_response_level").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Emergency Response Plans</h1>
      </div>
      {canManage && (
        <CreateForm
          title="New ERP"
          action={createErp}
          submitLabel="Create ERP"
          fields={[
            { name: "title", label: "Title", type: "text", required: true },
            { name: "erp_scenario_type_id", label: "Scenario", type: "select", options: (scenarios ?? []).map((s) => ({ value: s.id, label: s.name })) },
            { name: "erp_response_level_id", label: "Response level", type: "select", options: (levels ?? []).map((l) => ({ value: l.id, label: l.name })) },
            { name: "steps", label: "Protocol steps (one per line)", type: "textarea" },
            { name: "evacuation_ref", label: "Evacuation reference", type: "text" },
            { name: "aed_ref", label: "AED reference", type: "text" },
          ]}
        />
      )}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(erps ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No ERPs yet.</li>}
        {(erps ?? []).map((e) => (
          <li key={e.id} className="p-4">
            <Link href={`/facility/erps/${e.id}`} className="font-medium text-gray-900 hover:underline">{e.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
