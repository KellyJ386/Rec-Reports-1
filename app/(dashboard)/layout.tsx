import { requireUser, getActiveFacilityId, getMemberships } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { SyncStatus } from "@/components/ui/SyncStatus";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();
  const facilityId = await getActiveFacilityId();
  const memberships = await getMemberships();

  let facilityName: string | null = null;
  if (facilityId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("facility")
      .select("name")
      .eq("id", facilityId)
      .maybeSingle();
    facilityName = data?.name ?? null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-forest">RecReports</span>
            {facilityName && (
              <span className="rounded-md bg-gray-100 px-2 py-1 text-sm text-navy-700">
                {facilityName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <SyncStatus />
            <span className="hidden text-sm text-gray-500 sm:inline">
              {user.email}
            </span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-forest"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        {memberships.length === 0 ? (
          <p className="text-gray-600">
            You don&apos;t belong to any facility yet. Ask an administrator to invite you.
          </p>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
