import type { FacilityRole } from "@/types/supabase";

/**
 * Role hierarchy ranks (CLAUDE.md §5). Higher = more privileged. Mirrors the SQL
 * `role_rank()` function — keep the two in sync. UI may use these for affordances, but
 * authorization is ALWAYS enforced server-side / in RLS, never by the client alone.
 */
export const ROLE_RANK: Record<FacilityRole, number> = {
  super_admin: 5,
  org_admin: 4,
  facility_manager: 3,
  supervisor: 2,
  staff: 1,
};

export function rankOf(role: FacilityRole | null | undefined): number {
  return role ? ROLE_RANK[role] : 0;
}

/** True if `role` satisfies a minimum required tier. */
export function roleAtLeast(
  role: FacilityRole | null | undefined,
  min: FacilityRole,
): boolean {
  return rankOf(role) >= ROLE_RANK[min];
}
