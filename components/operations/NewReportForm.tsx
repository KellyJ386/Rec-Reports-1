"use client";

import { useActionState } from "react";
import { createReport, type ReportKind, type ReportActionState } from "@/lib/operations/report-actions";

type Option = { id: string; name: string };
const empty: ReportActionState = {};
const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";

export function NewReportForm({
  kind,
  severities,
  areas,
  categories,
}: {
  kind: ReportKind;
  severities: Option[];
  areas: Option[];
  categories?: Option[];
}) {
  const [state, formAction, pending] = useActionState(createReport.bind(null, kind), empty);

  return (
    <form action={formAction} className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-navy">
        New {kind === "injury" ? "injury / illness" : "incident"} report
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {kind === "injury" ? (
          <div>
            <label htmlFor="report_type" className="block text-xs font-medium text-gray-600">Type</label>
            <select id="report_type" name="report_type" className={input}>
              <option value="injury">Injury</option>
              <option value="illness">Illness</option>
            </select>
          </div>
        ) : (
          <div>
            <label htmlFor="incident_category_id" className="block text-xs font-medium text-gray-600">Category</label>
            <select id="incident_category_id" name="incident_category_id" className={input}>
              <option value="">Select…</option>
              {(categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="severity_level_id" className="block text-xs font-medium text-gray-600">Severity</label>
          <select id="severity_level_id" name="severity_level_id" className={input}>
            <option value="">Select…</option>
            {severities.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="area_id" className="block text-xs font-medium text-gray-600">Area</label>
          <select id="area_id" name="area_id" className={input}>
            <option value="">Select…</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="occurred_at" className="block text-xs font-medium text-gray-600">Occurred at</label>
          <input id="occurred_at" name="occurred_at" type="datetime-local" className={input} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="summary" className="block text-xs font-medium text-gray-600">What happened</label>
          <textarea id="summary" name="summary" rows={3} className={input} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="immediate_actions" className="block text-xs font-medium text-gray-600">Immediate actions taken</label>
          <textarea id="immediate_actions" name="immediate_actions" rows={2} className={input} />
        </div>
        {kind === "incident" && (
          <label className="flex items-center gap-2 text-sm text-gray-700 sm:col-span-2">
            <input type="checkbox" name="follow_up_required" className="rounded border-gray-300" />
            Follow-up required (a task will be created on submit — wired in integration)
          </label>
        )}
      </div>
      {state.error && <p role="alert" className="mt-2 text-sm text-amber-700">{state.error}</p>}
      <p className="mt-2 text-xs text-gray-400">No photos — narrative + structured fields only.</p>
      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create draft"}
      </button>
    </form>
  );
}
