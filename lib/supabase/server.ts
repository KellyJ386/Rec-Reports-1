import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/supabase";

/**
 * Server-side Supabase client bound to the request's auth cookies.
 * Use in Server Components, Server Actions, and Route Handlers.
 *
 * Authorization is enforced by Postgres RLS (CLAUDE.md §6), not by this client.
 * `facility_id` is resolved server-side from the session/membership — never trusted
 * from client input (CLAUDE.md §3.1).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `setAll` was called from a Server Component — safe to ignore when
            // middleware is refreshing sessions. See lib/supabase/middleware.ts.
          }
        },
      },
    },
  );
}
