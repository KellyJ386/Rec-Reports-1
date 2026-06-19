import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId } from "@/lib/auth/session";
import { SopAckButton } from "@/components/facility/FacilityControls";

export default async function SopDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const supabase = await createClient();

  const { data: sop } = await supabase
    .from("sop").select("id, title, current_version_no, acknowledgment_required").eq("id", id).eq("facility_id", facilityId).maybeSingle();
  if (!sop) notFound();

  const { data: version } = await supabase
    .from("sop_version").select("id, body_richtext, version_no, effective_at").eq("sop_id", id).eq("version_no", sop.current_version_no).maybeSingle();

  let acknowledged = false;
  if (version && sop.acknowledgment_required) {
    const { data: ack } = await supabase
      .from("sop_acknowledgment").select("id").eq("sop_version_id", version.id).eq("user_id", user.id).maybeSingle();
    acknowledged = !!ack;
  }

  return (
    <div className="space-y-4">
      <Link href="/facility/sops" className="text-sm text-navy-700 hover:underline">← All SOPs</Link>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy">{sop.title}</h1>
        <span className="text-xs text-gray-500">v{sop.current_version_no}</span>
      </div>
      <article className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-800">
        {version?.body_richtext || "No content."}
      </article>
      {sop.acknowledgment_required && version && (
        <SopAckButton sopVersionId={version.id} acknowledged={acknowledged} />
      )}
    </div>
  );
}
