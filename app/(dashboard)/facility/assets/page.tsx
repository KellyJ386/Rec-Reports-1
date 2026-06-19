import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { createAsset } from "@/lib/facility/maintenance-actions";
import { CreateForm } from "@/components/facility/CreateForm";

export default async function AssetsPage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "supervisor");
  const supabase = await createClient();
  const [{ data: assets }, { data: types }, { data: areas }] = await Promise.all([
    supabase.from("asset").select("id, name, asset_tag").eq("facility_id", facilityId).is("deleted_at", null).order("name"),
    supabase.from("asset_type").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    supabase.from("area").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Assets</h1>
      </div>
      {canManage && (
        <CreateForm
          title="New asset"
          action={createAsset}
          submitLabel="Create asset"
          fields={[
            { name: "name", label: "Name", type: "text", required: true },
            { name: "asset_type_id", label: "Type", type: "select", options: (types ?? []).map((t) => ({ value: t.id, label: t.name })) },
            { name: "area_id", label: "Location", type: "select", options: (areas ?? []).map((a) => ({ value: a.id, label: a.name })) },
            { name: "asset_tag", label: "Asset tag", type: "text" },
          ]}
        />
      )}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(assets ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No assets.</li>}
        {(assets ?? []).map((a) => (
          <li key={a.id} className="flex items-center justify-between p-4 text-sm">
            <span className="font-medium text-gray-900">{a.name}</span>
            {a.asset_tag && <span className="text-xs text-gray-500">{a.asset_tag}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
