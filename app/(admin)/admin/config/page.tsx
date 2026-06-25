import Link from "next/link";
import { CONFIG_REGISTRY, CONFIG_GROUPS } from "@/lib/admin/config-registry";

export default function ConfigIndex() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-navy">Configuration</h1>
        <p className="mt-1 text-sm text-gray-600">
          Manage the admin-configurable values every module reads from. Disabling a value
          preserves history.
        </p>
      </div>

      {CONFIG_GROUPS.map((group) => (
        <section key={group}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            {group}
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CONFIG_REGISTRY.filter((d) => d.group === group).map((d) => (
              <li key={d.table}>
                <Link
                  href={`/admin/config/${d.table}`}
                  className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
                >
                  <span className="font-medium text-gray-900">{d.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="text-sm text-gray-400">
        User management lives at{" "}
        <Link href="/admin/users" className="text-forest underline">
          Admin → Users
        </Link>
        .
      </p>
    </div>
  );
}
