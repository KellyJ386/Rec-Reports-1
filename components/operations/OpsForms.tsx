"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addDailyLogEntry,
  postMemo,
  markMemoRead,
  saveEod,
  submitEod,
  type OpsActionState,
} from "@/lib/operations/ops-actions";

type Option = { id: string; name: string };
const empty: OpsActionState = {};
const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";
const btn =
  "rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60";

export function DailyLogForm({ areas, categories }: { areas: Option[]; categories: Option[] }) {
  const [state, action, pending] = useActionState(addDailyLogEntry, empty);
  const router = useRouter();
  return (
    <form action={async (fd) => { await action(fd); router.refresh(); }} className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-navy">Add log entry</h2>
      <textarea name="body" rows={2} required placeholder="What happened…" className={input} aria-label="Entry" />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <select name="area_id" className={input} aria-label="Area" defaultValue="">
          <option value="">Area (optional)</option>
          {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select name="task_category_id" className={input} aria-label="Category" defaultValue="">
          <option value="">Category (optional)</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {state.error && <p role="alert" className="mt-2 text-sm text-amber-700">{state.error}</p>}
      <button type="submit" disabled={pending} className={`mt-3 ${btn}`}>{pending ? "Adding…" : "Add entry"}</button>
    </form>
  );
}

export function MemoForm({ groups }: { groups: Option[] }) {
  const [state, action, pending] = useActionState(postMemo, empty);
  const router = useRouter();
  return (
    <form action={async (fd) => { await action(fd); router.refresh(); }} className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-navy">Post a memo</h2>
      <input name="subject" required placeholder="Subject" className={input} aria-label="Subject" />
      <textarea name="body_richtext" rows={3} placeholder="Message…" className={`mt-2 ${input}`} aria-label="Body" />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <select name="to_group_id" className={input} aria-label="Recipient group" defaultValue="">
          <option value="">All members</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select name="priority" className={input} aria-label="Priority" defaultValue="normal">
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="optional_email" className="rounded border-gray-300" />
        Also send by email
      </label>
      {state.error && <p role="alert" className="mt-2 text-sm text-amber-700">{state.error}</p>}
      <button type="submit" disabled={pending} className={`mt-3 ${btn}`}>{pending ? "Posting…" : "Post memo"}</button>
    </form>
  );
}

export function MarkReadButton({ memoId, read }: { memoId: string; read: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (read) return <span className="text-xs text-gray-400">Read</span>;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => { await markMemoRead(memoId); router.refresh(); })}
      className="rounded border border-gray-300 px-2 py-1 text-xs text-navy-700 hover:bg-gray-50 disabled:opacity-50"
    >
      {pending ? "…" : "Mark read"}
    </button>
  );
}

export function EodForm({
  existing,
}: {
  existing: { summary: string | null; incidents_occurred: boolean; equipment_issues: boolean; status: string } | null;
}) {
  const [state, action, pending] = useActionState(saveEod, empty);
  const [submitting, startSubmit] = useTransition();
  const router = useRouter();
  const locked = existing?.status === "locked";
  const submitted = existing?.status === "submitted";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <form action={async (fd) => { await action(fd); router.refresh(); }}>
        <fieldset disabled={locked || submitting}>
          <label htmlFor="summary" className="block text-xs font-medium text-gray-600">Day summary</label>
          <textarea id="summary" name="summary" rows={3} defaultValue={existing?.summary ?? ""} className={input} />
          <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="incidents_occurred" defaultChecked={existing?.incidents_occurred} className="rounded border-gray-300" />
            Incidents occurred today
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="equipment_issues" defaultChecked={existing?.equipment_issues} className="rounded border-gray-300" />
            Equipment issues today
          </label>
          {state.error && <p role="alert" className="mt-2 text-sm text-amber-700">{state.error}</p>}
          {!locked && (
            <button type="submit" disabled={pending} className={`mt-3 ${btn}`}>{pending ? "Saving…" : "Save draft"}</button>
          )}
        </fieldset>
      </form>
      {!locked && !submitted && (
        <button
          type="button"
          disabled={submitting}
          onClick={() => startSubmit(async () => { await submitEod(); router.refresh(); })}
          className="mt-2 rounded-md border border-forest px-4 py-2 text-sm font-medium text-forest hover:bg-forest-50 disabled:opacity-60"
        >
          Submit EOD
        </button>
      )}
      {submitted && <p className="mt-2 text-sm text-forest-700">✓ Submitted. Auto-locks at the facility cutoff.</p>}
      {locked && <p className="mt-2 text-sm text-gray-500">Locked.</p>}
    </div>
  );
}
