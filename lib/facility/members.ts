import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Active members of a facility as {id, label} for assignee pickers. */
export async function getFacilityMembers(facilityId: string): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("facility_membership")
    .select("user_id")
    .eq("facility_id", facilityId)
    .eq("status", "active");
  const ids = [...new Set((memberships ?? []).map((m) => m.user_id))];
  if (ids.length === 0) return [];
  const { data: accounts } = await supabase
    .from("user_account").select("id, email, display_name").in("id", ids);
  return (accounts ?? []).map((a) => ({ id: a.id, label: a.display_name ?? a.email }));
}
