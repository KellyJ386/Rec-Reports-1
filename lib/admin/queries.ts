import "server-only";
import { createClient } from "@/lib/supabase/server";

type ConfigRow = Record<string, unknown> & {
  id: string;
  active: boolean;
  display_order: number;
};

/**
 * Fetch all (non-deleted) rows of a config table for a facility, ordered for display.
 * Dynamic-table access is justified `any` (see lib/admin/actions.ts) — the table name
 * comes from the registry allowlist and RLS scopes reads to the caller's facility.
 */
// Justified untyped builder for registry-allowlisted dynamic tables (CLAUDE.md §11).
type GenericBuilder = any;

export async function fetchConfigRows(
  table: string,
  facilityId: string,
): Promise<ConfigRow[]> {
  const supabase = await createClient();
  const from = supabase.from.bind(supabase) as unknown as (t: string) => GenericBuilder;
  const { data } = await from(table)
    .select("*")
    .eq("facility_id", facilityId)
    .is("deleted_at", null)
    .order("display_order", { ascending: true });
  return (data as ConfigRow[]) ?? [];
}
