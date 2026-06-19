"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitFormResponse } from "@/lib/facility/form-actions";
import { DISPLAY_ONLY, type FormField } from "@/lib/facility/form-schema";

const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";

export function FormRenderer({ formId, fields }: { formId: string; fields: FormField[] }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  function submit() {
    setErrors({});
    start(async () => {
      const r = await submitFormResponse(formId, values);
      if (r.ok) { setDone(true); setValues({}); router.refresh(); }
      else if (r.errors) setErrors(r.errors);
      else setErrors({ _form: r.error ?? "Submission failed" });
    });
  }

  if (done) return <p role="status" className="rounded-md bg-forest-50 p-4 text-sm text-forest-700">✓ Response submitted.</p>;

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      {fields.map((f) => {
        if (f.type === "section_header") return <h3 key={f.key} className="text-sm font-semibold text-navy">{f.label}</h3>;
        if (f.type === "instructions") return <p key={f.key} className="text-sm text-gray-600">{f.label}</p>;
        const err = errors[f.key];
        const label = (
          <label htmlFor={f.key} className="block text-xs font-medium text-gray-600">
            {f.label}{f.required && <span className="text-amber-700"> *</span>}
          </label>
        );
        return (
          <div key={f.key}>
            {label}
            {f.type === "textarea" ? (
              <textarea id={f.key} rows={2} className={input} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === "yes_no" ? (
              <select id={f.key} className={input} defaultValue="" onChange={(e) => set(f.key, e.target.value)}>
                <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
              </select>
            ) : f.type === "single_select" ? (
              <select id={f.key} className={input} defaultValue="" onChange={(e) => set(f.key, e.target.value)}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "multi_select" ? (
              <select id={f.key} multiple className={input} onChange={(e) => set(f.key, Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                id={f.key}
                type={f.type === "number" || f.type === "rating" ? "number" : f.type === "date" ? "date" : f.type === "time" ? "time" : f.type === "datetime" ? "datetime-local" : "text"}
                className={input}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
            {err && <p role="alert" className="mt-1 text-xs text-amber-700">{err}</p>}
          </div>
        );
      })}
      {errors._form && <p role="alert" className="text-sm text-amber-700">{errors._form}</p>}
      <button type="button" onClick={submit} disabled={pending} className="rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 disabled:opacity-60">
        {pending ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}
