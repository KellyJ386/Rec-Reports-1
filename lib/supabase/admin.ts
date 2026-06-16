import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

/**
 * Service-role Supabase client. SERVER-ONLY — the service role key bypasses RLS and must
 * never reach the client bundle (CLAUDE.md §8). Use ONLY for privileged operations that
 * genuinely require it (e.g. inviting users via the Auth admin API, looking up an existing
 * account by email). All tenant-scoped reads/writes should use the request-bound client in
 * lib/supabase/server.ts so RLS applies.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");

  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
