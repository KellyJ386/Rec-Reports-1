import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { createForm } from "@/lib/facility/form-actions";
import { CreateForm } from "@/components/facility/CreateForm";

export default async function FormsPage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "facility_manager");
  const supabase = await createClient();

  const [{ data: forms }, { data: cats }] = await Promise.all([
    supabase.from("form").select("id, name, status, schedule").eq("facility_id", facilityId).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("form_category").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Forms &amp; Inspections</h1>
      </div>
      {canManage && (
        <CreateForm
          title="New form"
          action={createForm}
          submitLabel="Create & build"
          fields={[
            { name: "name", label: "Name", type: "text", required: true },
            { name: "form_category_id", label: "Category", type: "select", options: (cats ?? []).map((c) => ({ value: c.id, label: c.name })) },
            { name: "schedule", label: "Schedule", type: "select", options: [
              { value: "ad_hoc", label: "Ad hoc" }, { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" }, { value: "event", label: "Event" }] },
          ]}
        />
      )}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(forms ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No forms yet.</li>}
        {(forms ?? []).map((f) => (
          <li key={f.id} className="flex items-center justify-between p-4">
            <Link href={`/facility/forms/${f.id}`} className="font-medium text-gray-900 hover:underline">{f.name}</Link>
            <span className="text-xs text-gray-500">{f.status} · {f.schedule}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
