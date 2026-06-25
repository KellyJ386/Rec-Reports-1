import Link from "next/link";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { getComplianceData } from "@/lib/compliance/queries";

/** Metric card — count communicated with an icon + label, never color alone (CLAUDE.md §4). */
function Metric({
  icon,
  label,
  count,
  href,
  tone,
}: {
  icon: string;
  label: string;
  count: number;
  href: string;
  tone: "ok" | "warn";
}) {
  const cls = count === 0 ? "border-gray-200" : tone === "warn" ? "border-amber-300" : "border-gray-200";
  return (
    <Link href={href} className={`block rounded-lg border bg-white p-5 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest ${cls}`}>
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className={`mt-2 text-3xl font-bold ${count > 0 && tone === "warn" ? "text-amber-700" : "text-navy"}`}>
        {count}
      </div>
    </Link>
  );
}

export default async function CompliancePage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);

  if (!roleAtLeast(role, "supervisor")) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h1 className="text-xl font-bold text-navy">Compliance Dashboard</h1>
        <p className="mt-2 text-sm text-gray-600">Available to supervisors and managers.</p>
      </div>
    );
  }

  const data = await getComplianceData(facilityId);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Compliance Dashboard</h1>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon="⚠" label="Open incidents" count={data.openIncidents.length} href="/operations/incident" tone="warn" />
        <Metric icon="⏰" label="Overdue tasks" count={data.overdueTasks.length} href="/facility/tasks" tone="warn" />
        <Metric icon="🪪" label="Cert expirations" count={data.expiringCerts.length} href="/workforce/certifications" tone="warn" />
        <Metric icon="📅" label="Unfilled shifts" count={data.openShifts.length} href="/workforce/schedule" tone="warn" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Open incidents</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.openIncidents.length === 0 && <li className="text-gray-500">None.</li>}
            {data.openIncidents.slice(0, 8).map((i) => (
              <li key={i.id} className="flex justify-between">
                <Link href={`/operations/incident/${i.id}`} className="text-forest underline">{i.incident_no}</Link>
                <span className="text-xs text-gray-500">{i.status}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Overdue tasks</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.overdueTasks.length === 0 && <li className="text-gray-500">None.</li>}
            {data.overdueTasks.slice(0, 8).map((t) => (
              <li key={t.id} className="flex justify-between">
                <span className="text-gray-900">{t.title}</span>
                <span className="text-xs text-amber-700">{t.due_at ? new Date(t.due_at).toLocaleDateString() : ""}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Expiring / expired certs</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.expiringCerts.length === 0 && <li className="text-gray-500">None.</li>}
            {data.expiringCerts.slice(0, 8).map((c) => (
              <li key={c.id} className="flex justify-between">
                <span className="text-gray-900">{c.cert_type_name}</span>
                <span className="text-xs text-amber-700">{c.status} · {c.expires_on}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Unfilled shifts</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.openShifts.length === 0 && <li className="text-gray-500">None.</li>}
            {data.openShifts.slice(0, 8).map((s) => (
              <li key={s.id} className="text-gray-900">{new Date(s.starts_at).toLocaleString()}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
