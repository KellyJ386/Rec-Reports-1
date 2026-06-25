import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { getFacilityMembers } from "@/lib/facility/members";
import { WorkOrderControls } from "@/components/facility/FacilityControls";

export default async function WorkOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data: wo } = await supabase
    .from("work_order").select("id, title, description, status, priority, assigned_to").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  if (!wo) notFound();

  const role = await getRoleAt(facilityId);
  const canAssign = roleAtLeast(role, "supervisor");
  const members = canAssign ? await getFacilityMembers(facilityId) : [];

  return (
    <div className="space-y-4">
      <Link href="/facility/work-orders" className="text-sm text-navy-700 hover:underline">← All work orders</Link>
      <h1 className="text-2xl font-bold text-navy">{wo.title}</h1>
      <p className="text-sm text-gray-500">Priority: {wo.priority}</p>
      {wo.description && <p className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-800">{wo.description}</p>}
      <WorkOrderControls workOrderId={wo.id} status={wo.status} members={members} canAssign={canAssign} />
      <p className="text-xs text-gray-400">Photo attachments are allowed on work orders (upload UI is the next increment).</p>
    </div>
  );
}
