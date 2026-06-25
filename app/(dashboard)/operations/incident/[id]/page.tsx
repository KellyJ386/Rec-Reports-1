import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { getIncidentReport, getReportChildren } from "@/lib/operations/report-queries";
import { ReportDetail } from "@/components/operations/ReportDetail";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const report = await getIncidentReport(id, facilityId);
  if (!report) notFound();

  const role = await getRoleAt(facilityId);
  const isSupervisor = roleAtLeast(role, "supervisor");
  const isManager = roleAtLeast(role, "facility_manager");
  const isAuthor = report.created_by === user.id;
  const editable = (isAuthor && report.status === "draft") || isSupervisor;
  const { people, witnesses } = await getReportChildren("incident", id);

  return (
    <div className="space-y-4">
      <Link href="/operations/incident" className="text-sm text-navy-700 hover:underline">← All incident reports</Link>
      <ReportDetail
        kind="incident"
        report={report}
        people={people}
        witnesses={witnesses}
        editable={editable}
        isAuthor={isAuthor}
        isSupervisor={isSupervisor}
        isManager={isManager}
      />
    </div>
  );
}
