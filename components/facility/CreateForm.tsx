"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";

export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "checkbox" | "datetime" | "date";
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
};
type State = { error?: string; ok?: boolean };

const cls =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";

/** Generic create form driven by a field spec; wraps a (prev, FormData) server action. */
export function CreateForm({
  title,
  action,
  fields,
  submitLabel = "Create",
}: {
  title: string;
  action: (prev: State, fd: FormData) => Promise<State>;
  fields: FieldSpec[];
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as State);
  const router = useRouter();
  return (
    <form
      action={async (fd) => { await formAction(fd); router.refresh(); }}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-navy">{title}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
            {f.type !== "checkbox" && (
              <label htmlFor={f.name} className="block text-xs font-medium text-gray-600">
                {f.label}{f.required && <span className="text-amber-700"> *</span>}
              </label>
            )}
            {f.type === "textarea" ? (
              <textarea id={f.name} name={f.name} rows={2} required={f.required} placeholder={f.placeholder} className={cls} />
            ) : f.type === "select" ? (
              <select id={f.name} name={f.name} required={f.required} className={cls} defaultValue="">
                <option value="">{f.placeholder ?? "Select…"}</option>
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === "checkbox" ? (
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input id={f.name} name={f.name} type="checkbox" className="rounded border-gray-300" />
                {f.label}
              </label>
            ) : (
              <input
                id={f.name}
                name={f.name}
                type={f.type === "number" ? "number" : f.type === "datetime" ? "datetime-local" : f.type === "date" ? "date" : "text"}
                required={f.required}
                placeholder={f.placeholder}
                className={cls}
              />
            )}
          </div>
        ))}
      </div>
      {state.error && <p role="alert" className="mt-2 text-sm text-amber-700">{state.error}</p>}
      <button type="submit" disabled={pending} className="mt-3 rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60">
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
