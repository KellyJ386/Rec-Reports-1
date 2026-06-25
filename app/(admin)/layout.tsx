import Link from "next/link";
import { requireUser, requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";

/**
 * Admin Control Center shell. Gated to facility_manager+ (MODULE_SPEC.md §5). RLS is the
 * ultimate authority; this guard provides a friendly boundary instead of a hard error.
 */
export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireUser();
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);

  if (!roleAtLeast(role, "facility_manager")) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-navy">Admin access required</h1>
        <p className="mt-2 text-gray-600">
          The Admin Control Center is available to facility managers and organization
          administrators. Your role here is{" "}
          <span className="font-medium">{role ?? "—"}</span>.
        </p>
        <Link href="/dashboard" className="mt-6 inline-block text-forest underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-lg font-bold text-forest">
              RecReports Admin
            </Link>
          </div>
          <Link
            href="/dashboard"
            className="text-sm text-navy-700 hover:underline focus:outline-none focus:ring-2 focus:ring-forest"
          >
            ← Dashboard
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
