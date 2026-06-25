import Link from "next/link";

const tiles = [
  { href: "/workforce/certifications", title: "Certifications", desc: "Track issue/expiry, upload documents, manage expiring certs." },
  { href: "/workforce/schedule", title: "Scheduling", desc: "Build weekly schedules; cert-aware conflict checks gate publishing." },
];

export default function WorkforceHome() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-navy">Workforce</h1>
      <ul className="grid gap-3 sm:grid-cols-2">
        {tiles.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              className="block rounded-lg border border-gray-200 bg-white p-5 hover:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
            >
              <span className="font-semibold text-gray-900">{t.title}</span>
              <p className="mt-1 text-sm text-gray-600">{t.desc}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
