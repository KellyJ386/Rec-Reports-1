import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { getInjuryReport, getReportChildren } from "@/lib/operations/report-queries";
import { ReportDetail } from "@/components/operations/ReportDetail";

export default async function InjuryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const report = await getInjuryReport(id, facilityId);
  if (!report) notFound();

  const role = await getRoleAt(facilityId);
  const isSupervisor = roleAtLeast(role, "supervisor");
  const isManager = roleAtLeast(role, "facility_manager");
  const isAuthor = report.created_by === user.id;
  const editable = (isAuthor && report.status === "draft") || isSupervisor;
  const { people, witnesses } = await getReportChildren("injury", id);

  return (
    <div className="space-y-4">
      <Link href="/operations/injury" className="text-sm text-navy-700 hover:underline">← All injury reports</Link>
      <ReportDetail
        kind="injury"
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
