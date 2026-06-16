"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, requireRole } from "@/lib/auth/session";
import { getConfigDef, type ConfigTableDef } from "@/lib/admin/config-registry";

export type ActionState = { error?: string; ok?: boolean };

/**
 * Untyped query builder for generic config CRUD over registry-allowlisted tables.
 * Justified `any` (CLAUDE.md §11): a single table-agnostic builder; per-table typing would
 * defeat the purpose of one reusable CRUD path. Authorization is enforced by RLS +
 * requireRole, and the table name is validated against the registry, not user-typed.
 */
type GenericBuilder = any;

/** Build a Zod schema for a table's editable fields from the registry. */
function schemaFor(def: ConfigTableDef) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of def.fields) {
    if (f.type === "number") {
      shape[f.key] = z.coerce.number().min(f.min ?? Number.MIN_SAFE_INTEGER);
    } else if (f.type === "select") {
      const values = (f.options ?? []).map((o) => o.value);
      shape[f.key] = z.string().refine((v) => values.includes(v), "Invalid option");
    } else {
      // text / textarea
      const base = z.string().trim();
      shape[f.key] = f.required
        ? base.min(1, `${f.label} is required`)
        : base.optional().transform((v) => (v ? v : null));
    }
  }
  return z.object(shape);
}

function payloadFromForm(def: ConfigTableDef, formData: FormData) {
  const raw: Record<string, unknown> = {};
  for (const f of def.fields) raw[f.key] = formData.get(f.key);
  return schemaFor(def).safeParse(raw);
}

/**
 * Dynamic-table access for the uniform config CRUD. Justified `any` (CLAUDE.md §11): the
 * table name is constrained to the registry allowlist (getConfigDef), and RLS +
 * requireRole enforce authorization regardless of typing. Centralizing the cast here keeps
 * it out of the rest of the codebase.
 */
async function configTable(table: string) {
  const supabase = await createClient();
  // Justified loose typing (CLAUDE.md §11): the dynamic builder is intentionally untyped
  // (a generic query builder over a registry-allowlisted table name). Authorization is
  // enforced by RLS + requireRole regardless of static typing.
  const from = supabase.from.bind(supabase) as unknown as (t: string) => GenericBuilder;
  return from(table);
}

async function authorize(table: string): Promise<
  { def: ConfigTableDef; facilityId: string } | { error: string }
> {
  const def = getConfigDef(table);
  if (!def) return { error: "Unknown config table" };
  const facilityId = await requireFacilityId();
  await requireRole(facilityId, "facility_manager"); // throws -> caught by callers
  return { def, facilityId };
}

export async function createConfigItem(
  table: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const auth = await authorize(table);
    if ("error" in auth) return auth;
    const parsed = payloadFromForm(auth.def, formData);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const t = await configTable(table);
    // place new rows at the end
    const { data: last } = await t
      .select("display_order")
      .eq("facility_id", auth.facilityId)
      .order("display_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextOrder = (last?.display_order ?? 0) + 1;

    const { error } = await t.insert({
      ...parsed.data,
      facility_id: auth.facilityId,
      display_order: nextOrder,
    });
    if (error) return { error: error.message };

    revalidatePath(`/admin/config/${table}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create" };
  }
}

export async function updateConfigItem(
  table: string,
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const auth = await authorize(table);
    if ("error" in auth) return auth;
    const parsed = payloadFromForm(auth.def, formData);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const t = await configTable(table);
    const { error } = await t
      .update(parsed.data)
      .eq("id", id)
      .eq("facility_id", auth.facilityId);
    if (error) return { error: error.message };

    revalidatePath(`/admin/config/${table}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update" };
  }
}

/** Disable/enable a value. Disabling preserves history (CLAUDE.md §5.1 — never hard-delete). */
export async function toggleConfigActive(
  table: string,
  id: string,
  active: boolean,
): Promise<ActionState> {
  try {
    const auth = await authorize(table);
    if ("error" in auth) return auth;
    const t = await configTable(table);
    const { error } = await t
      .update({ active })
      .eq("id", id)
      .eq("facility_id", auth.facilityId);
    if (error) return { error: error.message };
    revalidatePath(`/admin/config/${table}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to toggle" };
  }
}

/** Move a row up/down by swapping display_order with its neighbor. */
export async function reorderConfigItem(
  table: string,
  id: string,
  direction: "up" | "down",
): Promise<ActionState> {
  try {
    const auth = await authorize(table);
    if ("error" in auth) return auth;
    const t = await configTable(table);

    const { data: rows } = await t
      .select("id, display_order")
      .eq("facility_id", auth.facilityId)
      .is("deleted_at", null)
      .order("display_order", { ascending: true });
    if (!rows) return { error: "Could not load rows" };

    const idx = rows.findIndex((r: { id: string }) => r.id === id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= rows.length) return { ok: true };

    const a = rows[idx];
    const b = rows[swapIdx];
    await t.update({ display_order: b.display_order }).eq("id", a.id).eq("facility_id", auth.facilityId);
    await t.update({ display_order: a.display_order }).eq("id", b.id).eq("facility_id", auth.facilityId);

    revalidatePath(`/admin/config/${table}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reorder" };
  }
}
