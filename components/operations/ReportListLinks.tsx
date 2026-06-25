import Link from "next/link";
import type { ReportKind } from "@/lib/operations/report-actions";
import { ReportStatusBadge } from "@/components/operations/ReportStatusBadge";

type Row = { id: string; incident_no: string; status: string; summary: string | null; reported_at: string };

export function ReportListLinks({ kind, rows }: { kind: ReportKind; rows: Row[] }) {
  return (
    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
      {rows.length === 0 && <li className="p-4 text-sm text-gray-500">No reports yet.</li>}
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/operations/${kind}/${r.id}`}
            className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-forest"
          >
            <div className="min-w-0">
              <span className="font-medium text-gray-900">{r.incident_no}</span>
              <p className="truncate text-sm text-gray-500">{r.summary || "—"}</p>
            </div>
            <ReportStatusBadge status={r.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
