"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createSchedulePeriod,
  publishSchedule,
  type ScheduleActionState,
} from "@/lib/workforce/schedule-actions";
import type { Conflict } from "@/lib/workforce/conflict-engine";

const empty: ScheduleActionState = {};

export function CreatePeriodForm() {
  const [state, formAction, pending] = useActionState(createSchedulePeriod, empty);
  const router = useRouter();
  return (
    <form
      action={async (fd) => {
        await formAction(fd);
        router.refresh();
      }}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4"
    >
      <div>
        <label htmlFor="week_start_date" className="block text-xs font-medium text-gray-600">
          Week start date
        </label>
        <input
          id="week_start_date"
          name="week_start_date"
          type="date"
          required
          className="mt-1 block rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Creating…" : "New schedule week"}
      </button>
      {state.error && <p role="alert" className="w-full text-sm text-amber-700">{state.error}</p>}
    </form>
  );
}

export function PublishButton({ periodId }: { periodId: string }) {
  const [pending, start] = useTransition();
  const [blocking, setBlocking] = useState<Conflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function publish() {
    setBlocking(null);
    setError(null);
    start(async () => {
      const res = await publishSchedule(periodId);
      if (res.ok) {
        router.refresh();
      } else if (res.blocking?.length) {
        setBlocking(res.blocking);
      } else {
        setError(res.error ?? "Could not publish");
      }
    });
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={publish}
        disabled={pending}
        className="rounded-md bg-forest px-3 py-1.5 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest disabled:opacity-60"
      >
        {pending ? "Checking…" : "Publish"}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-amber-700">{error}</p>}
      {blocking && (
        <div role="alert" className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-800">
            ✕ Cannot publish — {blocking.length} blocking conflict
            {blocking.length > 1 ? "s" : ""}:
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-800">
            {blocking.map((c, i) => (
              <li key={i}>
                <span className="font-medium">{c.label}</span> — {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
