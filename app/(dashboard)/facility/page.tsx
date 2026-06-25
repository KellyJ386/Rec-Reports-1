import Link from "next/link";

const tiles = [
  { href: "/facility/forms", title: "Forms & Inspections", desc: "Build dynamic forms; collect & export responses." },
  { href: "/facility/tasks", title: "Tasks", desc: "Assign work, recurrence, completion." },
  { href: "/facility/counts", title: "Utilization Counts", desc: "Quick attendance/usage counts." },
  { href: "/facility/sops", title: "SOPs", desc: "Versioned procedures with acknowledgments." },
  { href: "/facility/erps", title: "Emergency Plans", desc: "Always-available response protocols." },
  { href: "/facility/work-orders", title: "Work Orders", desc: "Maintenance tickets (photos allowed)." },
  { href: "/facility/assets", title: "Assets", desc: "Equipment registry & PM schedules." },
];

export default function FacilityHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Facility Management</h1>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <li key={t.href}>
            <Link href={t.href} className="block rounded-lg border border-gray-200 bg-white p-5 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest">
              <span className="font-semibold text-gray-900">{t.title}</span>
              <p className="mt-1 text-sm text-gray-600">{t.desc}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
