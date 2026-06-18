import Link from "next/link";
import { requireFacilityId } from "@/lib/auth/session";
import { listReports, getReportConfig } from "@/lib/operations/report-queries";
import { NewReportForm } from "@/components/operations/NewReportForm";
import { ReportListLinks } from "@/components/operations/ReportListLinks";

export default async function IncidentListPage() {
  const facilityId = await requireFacilityId();
  const [rows, config] = await Promise.all([
    listReports("incident", facilityId),
    getReportConfig("incident", facilityId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/operations" className="text-sm text-navy-700 hover:underline">← Operations</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Incident reports</h1>
      </div>
      <NewReportForm kind="incident" severities={config.severities} areas={config.areas} categories={config.categories} />
      <ReportListLinks kind="incident" rows={rows} />
    </div>
  );
}
