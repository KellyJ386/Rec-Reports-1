import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId } from "@/lib/auth/session";
import { parseFormSchema } from "@/lib/facility/form-schema";
import { FormRenderer } from "@/components/facility/FormRenderer";

export default async function RespondPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facilityId = await requireFacilityId();
  const supabase = await createClient();
  const { data: form } = await supabase
    .from("form").select("id, name, status, schema_json").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  if (!form) notFound();

  const { fields } = parseFormSchema(form.schema_json);

  return (
    <div className="space-y-4">
      <Link href={`/facility/forms/${id}`} className="text-sm text-navy-700 hover:underline">← {form.name}</Link>
      <h1 className="text-2xl font-bold text-navy">{form.name}</h1>
      {form.status !== "published" ? (
        <p className="text-sm text-amber-700">This form is not published yet.</p>
      ) : (
        <FormRenderer formId={id} fields={fields} />
      )}
    </div>
  );
}
