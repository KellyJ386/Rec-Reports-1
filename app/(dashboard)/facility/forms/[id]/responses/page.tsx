import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";

export default async function ResponsesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data: form } = await supabase
    .from("form").select("name").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  if (!form) notFound();

  const { data: responses } = await supabase
    .from("form_response").select("id, submitted_at").eq("form_id", id).is("deleted_at", null).order("submitted_at", { ascending: false });

  return (
    <div className="space-y-4">
      <Link href={`/facility/forms/${id}`} className="text-sm text-navy-700 hover:underline">← {form.name}</Link>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy">Responses</h1>
        <a href={`/api/export/form-responses?form_id=${id}`} className="rounded-md border border-forest px-3 py-1.5 text-sm font-medium text-forest hover:bg-forest-50">
          Export CSV
        </a>
      </div>
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(responses ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No responses yet.</li>}
        {(responses ?? []).map((r) => (
          <li key={r.id} className="p-4 text-sm text-gray-700">{new Date(r.submitted_at).toLocaleString()}</li>
        ))}
      </ul>
    </div>
  );
}
