import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { AddCertForm } from "@/components/workforce/AddCertForm";
import { CertStatusBadge } from "@/components/workforce/CertStatusBadge";

export default async function CertificationsPage() {
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const isManager = roleAtLeast(role, "supervisor");
  const supabase = await createClient();

  const { data: myCerts } = await supabase
    .from("staff_certification_status")
    .select("id, cert_type_name, issued_on, expires_on, status, days_to_expiry")
    .eq("user_id", user.id)
    .order("expires_on", { ascending: true });

  const { data: certTypes } = await supabase
    .from("cert_type")
    .select("id, name")
    .eq("facility_id", facilityId)
    .eq("active", true)
    .order("display_order");

  // Manager view: certs expiring/expired across the facility.
  let expiring: { id: string; user_id: string; cert_type_name: string; expires_on: string | null; status: "active" | "expiring" | "expired"; email: string }[] = [];
  if (isManager) {
    const { data: rows } = await supabase
      .from("staff_certification_status")
      .select("id, user_id, cert_type_name, expires_on, status")
      .in("status", ["expiring", "expired"])
      .order("expires_on", { ascending: true });
    const ids = [...new Set((rows ?? []).map((r) => r.user_id))];
    const emailById = new Map<string, string>();
    if (ids.length) {
      const { data: accounts } = await supabase
        .from("user_account")
        .select("id, email")
        .in("id", ids);
      for (const a of accounts ?? []) emailById.set(a.id, a.email);
    }
    expiring = (rows ?? []).map((r) => ({ ...r, email: emailById.get(r.user_id) ?? "—" }));
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/workforce" className="text-sm text-navy-700 hover:underline">← Workforce</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Certifications</h1>
      </div>

      <AddCertForm certTypes={certTypes ?? []} />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">My certifications</h2>
        <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {(myCerts ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">None on file yet.</li>}
          {(myCerts ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between p-4 text-sm">
              <div>
                <span className="font-medium text-gray-900">{c.cert_type_name}</span>
                <span className="ml-2 text-gray-500">
                  {c.expires_on ? `expires ${c.expires_on}` : "no expiry"}
                </span>
              </div>
              <CertStatusBadge status={c.status} />
            </li>
          ))}
        </ul>
      </section>

      {isManager && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Expiring / expired (facility-wide)
          </h2>
          <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {expiring.length === 0 && <li className="p-4 text-sm text-gray-500">Nothing expiring.</li>}
            {expiring.map((c) => (
              <li key={c.id} className="flex items-center justify-between p-4 text-sm">
                <div>
                  <span className="font-medium text-gray-900">{c.email}</span>
                  <span className="ml-2 text-gray-600">{c.cert_type_name}</span>
                  <span className="ml-2 text-gray-500">{c.expires_on}</span>
                </div>
                <CertStatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
