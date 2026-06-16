"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { rankOf } from "@/lib/auth/roles";
import { ASSIGNABLE_ROLES } from "@/lib/admin/config-registry";
import type { FacilityRole } from "@/types/supabase";

export type UserActionState = { error?: string; ok?: boolean };

async function authorizeManager() {
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const actorRole = await getRoleAt(facilityId);
  if (rankOf(actorRole) < rankOf("facility_manager")) {
    throw new Error("Forbidden: facility manager role required");
  }
  return { userId: user.id, facilityId, actorRole };
}

/** Defense-in-depth check mirroring the DB escalation guard (nicer error messages). */
function assertAssignable(role: FacilityRole, actorRole: FacilityRole | null) {
  if (!ASSIGNABLE_ROLES.includes(role)) throw new Error("That role cannot be assigned here");
  if (rankOf(role) > rankOf(actorRole)) {
    throw new Error("You cannot grant a role higher than your own");
  }
}

const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  role: z.string(),
});

export async function inviteUser(
  _prev: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  try {
    const { facilityId, actorRole, userId } = await authorizeManager();
    const parsed = inviteSchema.safeParse({
      email: formData.get("email"),
      role: formData.get("role"),
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    const role = parsed.data.role as FacilityRole;
    assertAssignable(role, actorRole);

    const admin = createAdminClient();

    // Existing account? (service role bypasses RLS to look up by email)
    const { data: existing } = await admin
      .from("user_account")
      .select("id")
      .eq("email", parsed.data.email)
      .maybeSingle();

    let inviteeId = existing?.id;
    if (!inviteeId) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback`,
      });
      if (error) return { error: error.message };
      inviteeId = data.user.id;
    }

    // Create the membership through the MANAGER's session so RLS + the escalation guard
    // apply (facility_id is server-derived; role is rank-checked in the DB).
    const supabase = await createClient();
    const { error } = await supabase.from("facility_membership").insert({
      facility_id: facilityId,
      user_id: inviteeId,
      role,
      created_by: userId,
    });
    if (error) {
      if (error.code === "23505") return { error: "That user is already a member of this facility" };
      return { error: error.message };
    }

    revalidatePath("/admin/users");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to invite" };
  }
}

export async function changeMemberRole(
  membershipId: string,
  role: FacilityRole,
): Promise<UserActionState> {
  try {
    const { facilityId, actorRole } = await authorizeManager();
    assertAssignable(role, actorRole);
    const supabase = await createClient();
    const { error } = await supabase
      .from("facility_membership")
      .update({ role })
      .eq("id", membershipId)
      .eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath("/admin/users");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to change role" };
  }
}

export async function setMemberStatus(
  membershipId: string,
  status: "active" | "inactive" | "archived",
): Promise<UserActionState> {
  try {
    const { facilityId, userId } = await authorizeManager();
    const supabase = await createClient();

    // Don't let a manager lock themselves out of their own membership.
    const { data: target } = await supabase
      .from("facility_membership")
      .select("user_id")
      .eq("id", membershipId)
      .eq("facility_id", facilityId)
      .maybeSingle();
    if (target?.user_id === userId && status !== "active") {
      return { error: "You cannot deactivate your own membership" };
    }

    const { error } = await supabase
      .from("facility_membership")
      .update({ status })
      .eq("id", membershipId)
      .eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath("/admin/users");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update status" };
  }
}

/** SSO (SAML) enable toggle — stored on facility.settings (placeholder; CLAUDE.md §2). */
export async function setFacilitySso(enabled: boolean): Promise<UserActionState> {
  try {
    const { facilityId } = await authorizeManager();
    const supabase = await createClient();
    const { data: facility } = await supabase
      .from("facility")
      .select("settings")
      .eq("id", facilityId)
      .single();
    const settings = { ...(facility?.settings ?? {}), sso_enabled: enabled };
    const { error } = await supabase
      .from("facility")
      .update({ settings })
      .eq("id", facilityId);
    if (error) return { error: error.message };
    revalidatePath("/admin/users");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to toggle SSO" };
  }
}
