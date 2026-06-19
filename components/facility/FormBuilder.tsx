"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveFormSchema, publishForm } from "@/lib/facility/form-actions";
import { FIELD_TYPES, DISPLAY_ONLY, type FieldType, type FormField } from "@/lib/facility/form-schema";

const input =
  "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";
const needsOptions = (t: FieldType) => t === "single_select" || t === "multi_select";

function slug(label: string, i: number) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || `field_${i + 1}`;
}

export function FormBuilder({
  formId,
  initialFields,
  status,
}: {
  formId: string;
  initialFields: FormField[];
  status: string;
}) {
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function addField() {
    if (!label.trim()) return;
    const field: FormField = {
      key: slug(label, fields.length),
      label: label.trim(),
      type,
      ...(required ? { required: true } : {}),
      ...(needsOptions(type) ? { options: options.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
    };
    setFields([...fields, field]);
    setLabel(""); setOptions(""); setRequired(false); setType("text");
  }

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveFormSchema(formId, fields);
      setMsg(r.error ?? "Saved.");
      router.refresh();
    });
  }
  function publish() {
    setMsg(null);
    start(async () => {
      const r = await publishForm(formId);
      setMsg(r.error ?? "Published.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {fields.length === 0 && <li className="p-3 text-sm text-gray-500">No fields yet.</li>}
        {fields.map((f, i) => (
          <li key={f.key} className="flex items-center justify-between p-3 text-sm">
            <span>
              <span className="font-medium text-gray-900">{f.label}</span>
              <span className="ml-2 text-xs text-gray-500">{f.type}{f.required ? " · required" : ""}{DISPLAY_ONLY.includes(f.type) ? " · display" : ""}</span>
            </span>
            <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} className="text-xs text-amber-700 hover:underline">
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Add field</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className={input} aria-label="Field label" />
          <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={input} aria-label="Field type">
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {needsOptions(type) && (
            <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Options (comma-separated)" className={`${input} sm:col-span-2`} aria-label="Options" />
          )}
          {!DISPLAY_ONLY.includes(type) && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="rounded border-gray-300" />
              Required
            </label>
          )}
        </div>
        <button type="button" onClick={addField} className="mt-2 rounded-md border border-forest px-3 py-1.5 text-sm font-medium text-forest hover:bg-forest-50">
          Add field
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={pending} className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60">
          Save draft
        </button>
        <button type="button" onClick={publish} disabled={pending} className="rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 disabled:opacity-60">
          {status === "published" ? "Re-publish" : "Publish"}
        </button>
        {msg && <span role="status" className="text-sm text-gray-600">{msg}</span>}
      </div>
    </div>
  );
}
