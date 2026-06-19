import Link from "next/link";

/**
 * Reporting & Export hub (MODULE_SPEC.md §6). CSV for tabular reports; PDF for filed
 * reports and the postable weekly schedule (those download from each record's detail page).
 * No BI dashboards — exports only (CLAUDE.md §12). All exports are RLS-scoped.
 */
export default function ReportingPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Reporting &amp; Export</h1>
      <p className="text-sm text-gray-600">CSV and PDF exports. Exports respect your access (RLS).</p>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">CSV (tabular)</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li><a href="/api/export/incidents" className="text-forest underline">Incidents CSV</a></li>
          <li><a href="/api/export/tasks" className="text-forest underline">Tasks CSV</a></li>
          <li className="text-gray-600">Form responses: open a form → <span className="italic">View responses → Export CSV</span></li>
        </ul>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">PDF (filed documents)</h2>
        <ul className="mt-2 space-y-1 text-sm text-gray-600">
          <li>Injury / Incident report: open the report → <span className="italic">Export PDF</span> (<Link href="/operations/incident" className="text-forest underline">incidents</Link>).</li>
          <li>Weekly schedule: <Link href="/workforce/schedule" className="text-forest underline">Scheduling</Link> → <span className="italic">Weekly PDF</span>.</li>
        </ul>
      </section>
    </div>
  );
}
