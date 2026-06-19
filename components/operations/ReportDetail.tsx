import Link from "next/link";
import type { ReportKind } from "@/lib/operations/report-actions";
import { ReportStatusBadge } from "@/components/operations/ReportStatusBadge";
import { ReportStatusActions, AddPersonForm, AddWitnessForm } from "@/components/operations/ReportControls";

type ReportRow = {
  id: string;
  incident_no: string;
  status: "draft" | "submitted" | "reviewed" | "closed";
  report_type?: string;
  occurred_at: string | null;
  reported_at: string;
  summary: string | null;
  immediate_actions: string | null;
  follow_up_required?: boolean;
  follow_up_task_id?: string | null;
};
type Person = { id: string; full_name: string; person_role: string };
type Witness = { id: string; full_name: string; statement: string | null };

export function ReportDetail({
  kind,
  report,
  people,
  witnesses,
  editable,
  isAuthor,
  isSupervisor,
  isManager,
}: {
  kind: ReportKind;
  report: ReportRow;
  people: Person[];
  witnesses: Witness[];
  editable: boolean;
  isAuthor: boolean;
  isSupervisor: boolean;
  isManager: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">{report.incident_no}</h1>
          <p className="text-sm text-gray-500">
            {kind === "injury" ? report.report_type ?? "injury" : "incident"} · reported{" "}
            {new Date(report.reported_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/api/export/report-pdf?kind=${kind}&id=${report.id}`}
            className="rounded-md border border-forest px-3 py-1.5 text-sm font-medium text-forest hover:bg-forest-50"
          >
            Export PDF
          </a>
          <ReportStatusBadge status={report.status} />
        </div>
      </div>

      <ReportStatusActions
        kind={kind}
        id={report.id}
        status={report.status}
        isAuthor={isAuthor}
        isSupervisor={isSupervisor}
        isManager={isManager}
      />
      {!editable && report.status !== "draft" && (
        <p className="text-xs text-gray-400">
          This report is locked to the author. {isSupervisor ? "Use the status actions above." : ""}
        </p>
      )}

      <dl className="grid gap-4 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-gray-500">Occurred at</dt>
          <dd className="text-sm text-gray-900">{report.occurred_at ? new Date(report.occurred_at).toLocaleString() : "—"}</dd>
        </div>
        {kind === "incident" && (
          <div>
            <dt className="text-xs font-medium text-gray-500">Follow-up required</dt>
            <dd className="text-sm text-gray-900">
              {report.follow_up_required ? "Yes" : "No"}
              {report.follow_up_task_id && (
                <Link href="/facility/tasks" className="ml-2 text-forest underline">task created ✓</Link>
              )}
              {report.follow_up_required && !report.follow_up_task_id && (
                <span className="ml-2 text-xs text-gray-400">(task is created on review)</span>
              )}
            </dd>
          </div>
        )}
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-gray-500">What happened</dt>
          <dd className="whitespace-pre-wrap text-sm text-gray-900">{report.summary || "—"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-gray-500">Immediate actions</dt>
          <dd className="whitespace-pre-wrap text-sm text-gray-900">{report.immediate_actions || "—"}</dd>
        </div>
      </dl>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">People involved</h2>
        <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {people.length === 0 && <li className="p-3 text-sm text-gray-500">None recorded.</li>}
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between p-3 text-sm">
              <span className="text-gray-900">{p.full_name}</span>
              <span className="text-xs text-gray-500">{p.person_role}</span>
            </li>
          ))}
        </ul>
        {editable && <div className="mt-2"><AddPersonForm kind={kind} parentId={report.id} /></div>}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Witnesses</h2>
        <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {witnesses.length === 0 && <li className="p-3 text-sm text-gray-500">None recorded.</li>}
          {witnesses.map((w) => (
            <li key={w.id} className="p-3 text-sm">
              <span className="font-medium text-gray-900">{w.full_name}</span>
              {w.statement && <p className="mt-1 whitespace-pre-wrap text-gray-600">{w.statement}</p>}
            </li>
          ))}
        </ul>
        {editable && <div className="mt-2"><AddWitnessForm kind={kind} parentId={report.id} /></div>}
      </section>
    </div>
  );
}
