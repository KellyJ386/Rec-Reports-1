import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { createSop } from "@/lib/facility/knowledge-actions";
import { CreateForm } from "@/components/facility/CreateForm";

export default async function SopsPage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "facility_manager");
  const supabase = await createClient();
  const [{ data: sops }, { data: cats }] = await Promise.all([
    supabase.from("sop").select("id, title, acknowledgment_required").eq("facility_id", facilityId).is("deleted_at", null).order("title"),
    supabase.from("sop_category").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">SOPs</h1>
      </div>
      {canManage && (
        <CreateForm
          title="New SOP"
          action={createSop}
          submitLabel="Create SOP"
          fields={[
            { name: "title", label: "Title", type: "text", required: true },
            { name: "sop_category_id", label: "Category", type: "select", options: (cats ?? []).map((c) => ({ value: c.id, label: c.name })) },
            { name: "visibility_role", label: "Visible to", type: "select", options: [
              { value: "staff", label: "All staff" }, { value: "supervisor", label: "Supervisors+" },
              { value: "facility_manager", label: "Managers+" }] },
            { name: "acknowledgment_required", label: "Require acknowledgment", type: "checkbox" },
            { name: "body_richtext", label: "Body", type: "textarea" },
          ]}
        />
      )}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(sops ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No SOPs visible.</li>}
        {(sops ?? []).map((s) => (
          <li key={s.id} className="flex items-center justify-between p-4">
            <Link href={`/facility/sops/${s.id}`} className="font-medium text-gray-900 hover:underline">{s.title}</Link>
            {s.acknowledgment_required && <span className="text-xs text-amber-700">Ack required</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
