import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { FacilityRole } from "@/types/supabase";
import { roleAtLeast } from "@/lib/auth/roles";

const ACTIVE_FACILITY_COOKIE = "rr_active_facility";

/** Current authenticated user, or null. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Require an authenticated user; redirect to /login otherwise. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

export type Membership = {
  facility_id: string;
  role: FacilityRole;
  status: string;
};

/**
 * The caller's facility memberships. RLS guarantees this returns ONLY rows for the
 * authenticated user (Module Spec §7.1 acceptance: "resolves to exactly their
 * facility_membership rows").
 */
export async function getMemberships(): Promise<Membership[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("facility_membership")
    .select("facility_id, role, status")
    .eq("status", "active");
  return data ?? [];
}

/**
 * Resolve the active facility_id SERVER-SIDE (CLAUDE.md §3.1). The active-facility cookie
 * is only a hint about which facility the user is operating in; it is always validated
 * against the user's memberships. A facility_id is NEVER trusted from a request body,
 * query param, or header.
 */
export async function getActiveFacilityId(): Promise<string | null> {
  const memberships = await getMemberships();
  if (memberships.length === 0) return null;

  const cookieStore = await cookies();
  const hinted = cookieStore.get(ACTIVE_FACILITY_COOKIE)?.value;
  const valid = hinted && memberships.some((m) => m.facility_id === hinted);

  return valid ? hinted : memberships[0]!.facility_id;
}

/** Require an active facility context; redirect if the user belongs to none. */
export async function requireFacilityId(): Promise<string> {
  const facilityId = await getActiveFacilityId();
  if (!facilityId) redirect("/no-facility");
  return facilityId;
}

/** The caller's effective role at a facility, via the audited SQL helper. */
export async function getRoleAt(facilityId: string): Promise<FacilityRole | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("current_user_role_at", {
    p_facility_id: facilityId,
  });
  return (data as FacilityRole | null) ?? null;
}

/**
 * Require at least `min` role at a facility. Defense-in-depth on top of RLS — use at the
 * top of Server Actions / privileged routes. Throws (not redirect) so callers can map to
 * a 403; RLS remains the ultimate authority.
 */
export async function requireRole(
  facilityId: string,
  min: FacilityRole,
): Promise<FacilityRole> {
  const role = await getRoleAt(facilityId);
  if (!roleAtLeast(role, min)) {
    throw new Error(`Forbidden: requires ${min} at facility ${facilityId}`);
  }
  return role!;
}
