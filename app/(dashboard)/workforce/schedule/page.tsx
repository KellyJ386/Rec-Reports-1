import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { CreatePeriodForm, PublishButton } from "@/components/workforce/SchedulePublish";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  published: "bg-forest-50 text-forest-700",
  locked: "bg-navy-600/10 text-navy-700",
};

export default async function SchedulePage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "supervisor");
  const supabase = await createClient();

  const { data: periods } = await supabase
    .from("schedule_period")
    .select("id, week_start_date, week_end_date, status, publish_version")
    .eq("facility_id", facilityId)
    .is("deleted_at", null)
    .order("week_start_date", { ascending: false });

  return (
    <div className="space-y-6">
      <div>
        <Link href="/workforce" className="text-sm text-navy-700 hover:underline">← Workforce</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Scheduling</h1>
        <p className="text-sm text-gray-600">
          Publishing runs the cert-aware conflict engine; any blocking conflict stops the
          publish and is listed with details.
        </p>
      </div>

      {canManage && <CreatePeriodForm />}

      <ul className="space-y-3">
        {(periods ?? []).length === 0 && (
          <li className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
            No schedule weeks yet.
          </li>
        )}
        {(periods ?? []).map((p) => (
          <li key={p.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-900">
                Week of {p.week_start_date} – {p.week_end_date}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status] ?? ""}`}>
                {p.status}
                {p.publish_version > 0 ? ` · v${p.publish_version}` : ""}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              {canManage && p.status === "draft" && <PublishButton periodId={p.id} />}
              <a href={`/api/export/schedule-pdf?period_id=${p.id}`} className="text-sm text-forest underline">
                Weekly PDF
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
