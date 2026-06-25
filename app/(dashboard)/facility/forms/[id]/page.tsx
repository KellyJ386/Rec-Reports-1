import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseFormSchema } from "@/lib/facility/form-schema";
import { FormBuilder } from "@/components/facility/FormBuilder";

export default async function FormBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data: form } = await supabase
    .from("form").select("id, name, status, schema_json, version_no").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  if (!form) notFound();

  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "facility_manager");
  const { fields } = parseFormSchema(form.schema_json);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility/forms" className="text-sm text-navy-700 hover:underline">← All forms</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">{form.name}</h1>
        <p className="text-xs text-gray-500">Status: {form.status}</p>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        {form.status === "published" && (
          <Link href={`/facility/forms/${id}/respond`} className="text-forest underline">Fill out</Link>
        )}
        <Link href={`/facility/forms/${id}/responses`} className="text-forest underline">View responses</Link>
      </div>

      {canManage ? (
        <FormBuilder formId={id} initialFields={fields} status={form.status} />
      ) : (
        <p className="text-sm text-gray-500">Only facility managers can edit this form.</p>
      )}
    </div>
  );
}
