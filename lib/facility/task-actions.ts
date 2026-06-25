"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, requireRole } from "@/lib/auth/session";

export type TaskActionState = { error?: string; ok?: boolean };

export type CreateTaskInput = {
  facilityId: string;
  title: string;
  description?: string | null;
  taskCategoryId?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  assignedTo?: string | null;
  dueAt?: string | null;
  sourceType?: string | null;
  sourceRefId?: string | null;
};

/**
 * Programmatic task creation — the seam other modules call (e.g. the Incident
 * "Follow-Up Required" flow in Phase 5; MODULE_SPEC.md §3.1 / §6). Requires supervisor+
 * at the facility. Returns the new task id.
 */
export async function createTask(input: CreateTaskInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const user = await requireUser();
    await requireRole(input.facilityId, "supervisor");
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("task")
      .insert({
        facility_id: input.facilityId,
        title: input.title,
        description: input.description ?? null,
        task_category_id: input.taskCategoryId ?? null,
        priority: input.priority ?? "normal",
        assigned_to: input.assignedTo ?? null,
        due_at: input.dueAt ?? null,
        source_type: input.sourceType ?? null,
        source_ref_id: input.sourceRefId ?? null,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to create task" };
  }
}

/** UI form wrapper around createTask(). */
export async function createTaskFromForm(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  const facilityId = await requireFacilityId();
  const parsed = z
    .object({
      title: z.string().trim().min(1, "Title is required"),
      description: z.string().optional(),
      task_category_id: z.string().optional().transform((v) => (v ? v : null)),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      assigned_to: z.string().optional().transform((v) => (v ? v : null)),
      due_at: z.string().optional().transform((v) => (v ? v : null)),
    })
    .safeParse({
      title: formData.get("title"),
      description: formData.get("description") ?? undefined,
      task_category_id: formData.get("task_category_id"),
      priority: formData.get("priority") ?? "normal",
      assigned_to: formData.get("assigned_to"),
      due_at: formData.get("due_at"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const res = await createTask({
    facilityId,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    taskCategoryId: parsed.data.task_category_id,
    priority: parsed.data.priority,
    assignedTo: parsed.data.assigned_to,
    dueAt: parsed.data.due_at,
  });
  if (!res.ok) return { error: res.error };
  revalidatePath("/facility/tasks");
  return { ok: true };
}

/** Update task status (assignee or supervisor+; RLS enforces). */
export async function setTaskStatus(
  taskId: string,
  status: "open" | "in_progress" | "done" | "cancelled",
  completionNotes?: string,
): Promise<TaskActionState> {
  try {
    const facilityId = await requireFacilityId();
    const supabase = await createClient();
    const patch: { status: typeof status; completion_notes?: string } = { status };
    if (status === "done" && completionNotes) patch.completion_notes = completionNotes;
    const { error } = await supabase.from("task").update(patch).eq("id", taskId).eq("facility_id", facilityId);
    if (error) return { error: error.message };
    revalidatePath("/facility/tasks");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update task" };
  }
}

/** Record a utilization count (§3.2). */
export async function recordCount(_prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const parsed = z
      .object({
        count_area_id: z.string().optional().transform((v) => (v ? v : null)),
        count_type_id: z.string().optional().transform((v) => (v ? v : null)),
        count_value: z.coerce.number().int().min(0),
      })
      .safeParse({
        count_area_id: formData.get("count_area_id"),
        count_type_id: formData.get("count_type_id"),
        count_value: formData.get("count_value"),
      });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();
    const { error } = await supabase.from("utilization_count").insert({
      facility_id: facilityId,
      count_area_id: parsed.data.count_area_id,
      count_type_id: parsed.data.count_type_id,
      count_value: parsed.data.count_value,
      created_by: user.id,
    });
    if (error) return { error: error.message };
    revalidatePath("/facility/counts");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record count" };
  }
}
