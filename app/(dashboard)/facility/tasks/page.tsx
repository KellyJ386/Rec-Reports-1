import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { getFacilityMembers } from "@/lib/facility/members";
import { createTaskFromForm } from "@/lib/facility/task-actions";
import { CreateForm } from "@/components/facility/CreateForm";
import { TaskStatusControl } from "@/components/facility/FacilityControls";

export default async function TasksPage() {
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canManage = roleAtLeast(role, "supervisor");
  const supabase = await createClient();

  const [{ data: tasks }, { data: cats }, members] = await Promise.all([
    supabase.from("task").select("id, title, status, priority, due_at").eq("facility_id", facilityId).is("deleted_at", null).order("due_at", { ascending: true, nullsFirst: false }),
    supabase.from("task_category").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order"),
    getFacilityMembers(facilityId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/facility" className="text-sm text-navy-700 hover:underline">← Facility</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Tasks</h1>
      </div>
      {canManage && (
        <CreateForm
          title="New task"
          action={createTaskFromForm}
          submitLabel="Create task"
          fields={[
            { name: "title", label: "Title", type: "text", required: true },
            { name: "priority", label: "Priority", type: "select", options: ["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p })) },
            { name: "task_category_id", label: "Category", type: "select", options: (cats ?? []).map((c) => ({ value: c.id, label: c.name })) },
            { name: "assigned_to", label: "Assign to", type: "select", options: members.map((m) => ({ value: m.id, label: m.label })) },
            { name: "due_at", label: "Due", type: "datetime" },
            { name: "description", label: "Description", type: "textarea" },
          ]}
        />
      )}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(tasks ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No tasks.</li>}
        {(tasks ?? []).map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 p-4">
            <div>
              <span className="font-medium text-gray-900">{t.title}</span>
              <span className="ml-2 text-xs text-gray-500">{t.priority}{t.due_at ? ` · due ${new Date(t.due_at).toLocaleDateString()}` : ""}</span>
            </div>
            <TaskStatusControl taskId={t.id} status={t.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}
