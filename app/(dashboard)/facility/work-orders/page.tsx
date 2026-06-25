import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { createWorkOrder } from "@/lib/facility/maintenance-actions";
import { CreateForm } from "@/components/facility/CreateForm";
import { ReportStatusBadge } from "@/components/operations/ReportStatusBadge";

export default async function WorkOrdersPage() {
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const [{ data: orders }, { data: cats }, { data: assets }] = await Promise.all([
    supabase.from("work_order").select("id, title, status, priority").eq("facility_id", facilityId).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("work_order_category").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    supabase.from("asset").select("id, name").eq("facility_id", facilityId).is("deleted_at", null).order("name"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Work Orders</h1>
      </div>
      <CreateForm
        title="New work order"
        action={createWorkOrder}
        submitLabel="Create"
        fields={[
          { name: "title", label: "Title", type: "text", required: true },
          { name: "priority", label: "Priority", type: "select", options: ["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p })) },
          { name: "work_order_category_id", label: "Category", type: "select", options: (cats ?? []).map((c) => ({ value: c.id, label: c.name })) },
          { name: "asset_id", label: "Asset", type: "select", options: (assets ?? []).map((a) => ({ value: a.id, label: a.name })) },
          { name: "description", label: "Description", type: "textarea" },
        ]}
      />
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(orders ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No work orders.</li>}
        {(orders ?? []).map((w) => (
          <li key={w.id} className="flex items-center justify-between p-4">
            <Link href={`/facility/work-orders/${w.id}`} className="font-medium text-gray-900 hover:underline">
              {w.title} <span className="text-xs text-gray-500">({w.priority})</span>
            </Link>
            <ReportStatusBadge status={w.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}
