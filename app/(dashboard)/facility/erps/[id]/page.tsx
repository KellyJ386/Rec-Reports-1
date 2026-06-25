import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";

export default async function ErpDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data: erp } = await supabase
    .from("erp").select("id, title, protocol_steps_json, evacuation_ref, aed_ref").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  if (!erp) notFound();

  const { data: contacts } = await supabase
    .from("erp_emergency_contact").select("id, name, phone, org").eq("erp_id", id).order("display_order");

  const steps = Array.isArray(erp.protocol_steps_json) ? (erp.protocol_steps_json as string[]) : [];

  return (
    <div className="space-y-4">
      <Link href="/facility/erps" className="text-sm text-navy-700 hover:underline">← All ERPs</Link>
      <h1 className="text-2xl font-bold text-navy">{erp.title}</h1>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Protocol</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-800">
          {steps.length === 0 ? <li className="list-none text-gray-500">No steps recorded.</li> : steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        {(erp.evacuation_ref || erp.aed_ref) && (
          <p className="mt-3 text-xs text-gray-500">
            {erp.evacuation_ref && <>Evacuation: {erp.evacuation_ref}. </>}
            {erp.aed_ref && <>AED: {erp.aed_ref}.</>}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Emergency contacts</h2>
        <ul className="mt-2 text-sm text-gray-800">
          {(contacts ?? []).length === 0 ? <li className="text-gray-500">None.</li> : (contacts ?? []).map((c) => (
            <li key={c.id}>{c.name}{c.org ? ` (${c.org})` : ""}{c.phone ? ` — ${c.phone}` : ""}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
