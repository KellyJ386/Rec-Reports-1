"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ email: z.string().email("Enter a valid email address.") });

export type LoginState = { error?: string; sent?: boolean };

/**
 * Passwordless sign-in via Supabase magic link (email OTP). Enterprise SSO (SAML 2.0) is
 * a placeholder for now (CLAUDE.md §2). No facility_id is involved here — facility context
 * is resolved server-side after auth (CLAUDE.md §3.1).
 */
export async function sendMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback`,
    },
  });

  if (error) return { error: error.message };
  return { sent: true };
}
