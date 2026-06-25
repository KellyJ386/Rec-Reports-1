import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt, requireUser } from "@/lib/auth/session";
import { rankOf } from "@/lib/auth/roles";
import { ASSIGNABLE_ROLES } from "@/lib/admin/config-registry";
import { UserManager, type MemberRow } from "@/components/admin/UserManager";

export default async function UsersPage() {
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const actorRole = await getRoleAt(facilityId);
  const supabase = await createClient();

  const { data: memberships } = await supabase
    .from("facility_membership")
    .select("id, role, status, user_id")
    .eq("facility_id", facilityId);

  const ids = (memberships ?? []).map((m) => m.user_id);
  let accounts: { id: string; email: string; display_name: string | null }[] = [];
  if (ids.length) {
    const { data } = await supabase
      .from("user_account")
      .select("id, email, display_name")
      .in("id", ids);
    accounts = data ?? [];
  }
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const members: MemberRow[] = (memberships ?? []).map((m) => ({
    id: m.id,
    userId: m.user_id,
    role: m.role,
    status: m.status,
    email: byId.get(m.user_id)?.email ?? "—",
    displayName: byId.get(m.user_id)?.display_name ?? null,
  }));

  const { data: facility } = await supabase
    .from("facility")
    .select("settings")
    .eq("id", facilityId)
    .single();
  const ssoEnabled = Boolean(
    (facility?.settings as Record<string, unknown> | undefined)?.sso_enabled,
  );

  const assignableRoles = ASSIGNABLE_ROLES.filter((r) => rankOf(r) <= rankOf(actorRole));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="text-sm text-navy-700 hover:underline">
          ← Admin
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Users</h1>
        <p className="text-sm text-gray-600">
          Invite staff, assign roles, and manage access. You can&apos;t grant a role above
          your own; every role change is audited.
        </p>
      </div>
      <UserManager
        members={members}
        assignableRoles={assignableRoles}
        ssoEnabled={ssoEnabled}
        currentUserId={user.id}
      />
    </div>
  );
}
