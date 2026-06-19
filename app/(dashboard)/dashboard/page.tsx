import Link from "next/link";
import { getActiveFacilityId, getMemberships, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";

export default async function DashboardPage() {
  const facilityId = await getActiveFacilityId();
  const memberships = await getMemberships();
  const role = facilityId ? await getRoleAt(facilityId) : null;
  const isManager = roleAtLeast(role, "facility_manager");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-navy">Today</h1>
        <p className="mt-1 text-sm text-gray-600">
          Your role here:{" "}
          <span className="font-medium text-forest">{role ?? "—"}</span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/compliance" className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-navy-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-forest">
            Compliance Dashboard
          </Link>
          <Link href="/reporting" className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-navy-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-forest">
            Reporting &amp; Export
          </Link>
          {isManager && (
            <Link href="/admin" className="rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2">
              Admin Control Center
            </Link>
          )}
        </div>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Your facilities
        </h2>
        <ul className="mt-3 divide-y divide-gray-100">
          {memberships.map((m) => (
            <li
              key={m.facility_id}
              className="flex items-center justify-between py-2 text-sm"
            >
              <span className="font-mono text-xs text-gray-500">{m.facility_id}</span>
              <span className="rounded-full bg-forest-50 px-2 py-0.5 text-xs font-medium text-forest-700">
                {m.role}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Modules
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          <li>
            <Link
              href="/workforce"
              className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
            >
              <span className="font-medium text-gray-900">Workforce</span>
              <p className="text-xs text-gray-500">Scheduling &amp; certifications</p>
            </Link>
          </li>
          <li>
            <Link
              href="/operations"
              className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
            >
              <span className="font-medium text-gray-900">Operations</span>
              <p className="text-xs text-gray-500">Injury/incident, daily log, memos, EOD</p>
            </Link>
          </li>
          <li>
            <Link
              href="/facility"
              className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
            >
              <span className="font-medium text-gray-900">Facility Mgmt</span>
              <p className="text-xs text-gray-500">Forms, tasks, counts, SOPs, ERPs, work orders, assets</p>
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
