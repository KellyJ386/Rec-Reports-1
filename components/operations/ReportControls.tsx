"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setReportStatus,
  addReportPerson,
  addReportWitness,
  type ReportKind,
  type ReportActionState,
} from "@/lib/operations/report-actions";

const empty: ReportActionState = {};
const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";

/** Status transition buttons. Visibility mirrors the DB state machine (CLAUDE.md §7). */
export function ReportStatusActions({
  kind,
  id,
  status,
  isAuthor,
  isSupervisor,
  isManager,
}: {
  kind: ReportKind;
  id: string;
  status: "draft" | "submitted" | "reviewed" | "closed";
  isAuthor: boolean;
  isSupervisor: boolean;
  isManager: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function go(target: "draft" | "submitted" | "reviewed" | "closed") {
    setError(null);
    start(async () => {
      const res = await setReportStatus(kind, id, target);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  const btn =
    "rounded-md bg-forest px-3 py-1.5 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest disabled:opacity-60";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "draft" && isAuthor && (
        <button type="button" disabled={pending} onClick={() => go("submitted")} className={btn}>
          Submit
        </button>
      )}
      {status === "submitted" && isSupervisor && (
        <button type="button" disabled={pending} onClick={() => go("reviewed")} className={btn}>
          Mark reviewed
        </button>
      )}
      {status === "reviewed" && isSupervisor && (
        <button type="button" disabled={pending} onClick={() => go("closed")} className={btn}>
          Close
        </button>
      )}
      {status === "closed" && isManager && (
        <button type="button" disabled={pending} onClick={() => go("reviewed")} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          Reopen
        </button>
      )}
      {error && <span role="alert" className="text-sm text-amber-700">{error}</span>}
    </div>
  );
}

export function AddPersonForm({ kind, parentId }: { kind: ReportKind; parentId: string }) {
  const [state, formAction, pending] = useActionState(addReportPerson.bind(null, kind, parentId), empty);
  const router = useRouter();
  return (
    <form
      action={async (fd) => { await formAction(fd); router.refresh(); }}
      className="grid gap-2 sm:grid-cols-3"
    >
      <input name="full_name" placeholder="Full name" required className={input} aria-label="Full name" />
      <select name="person_role" className={input} aria-label="Role" defaultValue="involved">
        <option value="injured">Injured</option>
        <option value="involved">Involved</option>
        <option value="completing">Completing report</option>
      </select>
      <input name="phone" placeholder="Phone (optional)" className={input} aria-label="Phone" />
      {state.error && <p role="alert" className="text-sm text-amber-700 sm:col-span-3">{state.error}</p>}
      <button type="submit" disabled={pending} className="rounded-md bg-forest px-3 py-1.5 text-sm font-medium text-white hover:bg-forest-700 disabled:opacity-60 sm:col-span-3 sm:w-fit">
        {pending ? "Adding…" : "Add person"}
      </button>
    </form>
  );
}

export function AddWitnessForm({ kind, parentId }: { kind: ReportKind; parentId: string }) {
  const [state, formAction, pending] = useActionState(addReportWitness.bind(null, kind, parentId), empty);
  const router = useRouter();
  return (
    <form
      action={async (fd) => { await formAction(fd); router.refresh(); }}
      className="grid gap-2"
    >
      <input name="full_name" placeholder="Witness name" required className={input} aria-label="Witness name" />
      <textarea name="statement" placeholder="Statement (optional)" rows={2} className={input} aria-label="Statement" />
      {state.error && <p role="alert" className="text-sm text-amber-700">{state.error}</p>}
      <button type="submit" disabled={pending} className="rounded-md bg-forest px-3 py-1.5 text-sm font-medium text-white hover:bg-forest-700 disabled:opacity-60 sm:w-fit">
        {pending ? "Adding…" : "Add witness"}
      </button>
    </form>
  );
}
