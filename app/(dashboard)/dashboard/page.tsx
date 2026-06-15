import { getActiveFacilityId, getMemberships, getRoleAt } from "@/lib/auth/session";

export default async function DashboardPage() {
  const facilityId = await getActiveFacilityId();
  const memberships = await getMemberships();
  const role = facilityId ? await getRoleAt(facilityId) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-navy">Today</h1>
        <p className="mt-1 text-sm text-gray-600">
          Your role here:{" "}
          <span className="font-medium text-forest">{role ?? "—"}</span>
        </p>
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

      <p className="text-sm text-gray-400">
        Modules (workforce · operations · facility management) arrive in the build
        streams. This is the Phase 0 foundation shell.
      </p>
    </div>
  );
}
