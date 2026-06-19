"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTaskStatus } from "@/lib/facility/task-actions";
import { acknowledgeSop } from "@/lib/facility/knowledge-actions";
import { assignWorkOrder, setWorkOrderStatus } from "@/lib/facility/maintenance-actions";

function useRun() {
  const [pending, start] = useTransition();
  const router = useRouter();
  return [pending, (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); })] as const;
}

const sel = "rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";

export function TaskStatusControl({ taskId, status }: { taskId: string; status: string }) {
  const [pending, run] = useRun();
  return (
    <select
      defaultValue={status}
      disabled={pending}
      aria-label="Task status"
      className={sel}
      onChange={(e) => run(() => setTaskStatus(taskId, e.target.value as "open" | "in_progress" | "done" | "cancelled"))}
    >
      <option value="open">Open</option>
      <option value="in_progress">In progress</option>
      <option value="done">Done</option>
      <option value="cancelled">Cancelled</option>
    </select>
  );
}

export function SopAckButton({ sopVersionId, acknowledged }: { sopVersionId: string; acknowledged: boolean }) {
  const [pending, run] = useRun();
  if (acknowledged) return <span className="text-sm text-forest-700">✓ Acknowledged</span>;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(() => acknowledgeSop(sopVersionId))}
      className="rounded-md bg-forest px-3 py-1.5 text-sm font-medium text-white hover:bg-forest-700 disabled:opacity-60"
    >
      {pending ? "…" : "Acknowledge"}
    </button>
  );
}

export function WorkOrderControls({
  workOrderId,
  status,
  members,
  canAssign,
}: {
  workOrderId: string;
  status: string;
  members: { id: string; label: string }[];
  canAssign: boolean;
}) {
  const [pending, run] = useRun();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        defaultValue={status}
        disabled={pending}
        aria-label="Work order status"
        className={sel}
        onChange={(e) => run(() => setWorkOrderStatus(workOrderId, e.target.value as "open" | "assigned" | "in_progress" | "completed" | "closed"))}
      >
        {["open", "assigned", "in_progress", "completed", "closed"].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {canAssign && (
        <select
          defaultValue=""
          disabled={pending}
          aria-label="Assign to"
          className={sel}
          onChange={(e) => {
            const v = e.target.value;
            if (v) run(async () => { const r = await assignWorkOrder(workOrderId, v); if (r.error) setError(r.error); });
          }}
        >
          <option value="">Assign to…</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      )}
      {error && <span role="alert" className="text-sm text-amber-700">{error}</span>}
    </div>
  );
}
