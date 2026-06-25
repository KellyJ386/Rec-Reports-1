import Link from "next/link";

const tiles = [
  { href: "/operations/injury", title: "Injury / Illness", desc: "Mobile-first injury & illness reports with review workflow." },
  { href: "/operations/incident", title: "Incidents", desc: "Incident reports with categories, severity, and follow-up." },
  { href: "/operations/daily-log", title: "Daily Log", desc: "Running operational log; tag staff to notify them." },
  { href: "/operations/memos", title: "Memo Board", desc: "Broadcast memos to recipient groups with read tracking." },
  { href: "/operations/eod", title: "End-of-Day Report", desc: "One per day; auto-locks at the facility cutoff." },
];

export default function OperationsHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Operations</h1>
      <ul className="grid gap-3 sm:grid-cols-2">
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
