"use client";

import { useState, useTransition } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import type { ConfigField, ConfigTableDef } from "@/lib/admin/config-registry";
import {
  createConfigItem,
  updateConfigItem,
  toggleConfigActive,
  reorderConfigItem,
  type ActionState,
} from "@/lib/admin/actions";

type Row = Record<string, unknown> & { id: string; active: boolean; display_order: number };

const empty: ActionState = {};

function Field({ field, value }: { field: ConfigField; value?: unknown }) {
  const id = `f_${field.key}`;
  const common =
    "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest";
  const v = value == null ? (field.default ?? "") : String(value);
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-600">
        {field.label}
        {field.required && <span className="text-amber-700"> *</span>}
      </label>
      {field.type === "textarea" ? (
        <textarea id={id} name={field.key} defaultValue={v} rows={2} className={common} />
      ) : field.type === "select" ? (
        <select id={id} name={field.key} defaultValue={v} className={common}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          name={field.key}
          type={field.type === "number" ? "number" : "text"}
          defaultValue={v}
          required={field.required}
          className={common}
        />
      )}
    </div>
  );
}

function CreateForm({ def }: { def: ConfigTableDef }) {
  const action = createConfigItem.bind(null, def.table);
  const [state, formAction, pending] = useActionState(action, empty);
  const router = useRouter();
  const [key, setKey] = useState(0);

  return (
    <form
      key={key}
      action={async (fd) => {
        await formAction(fd);
        setKey((k) => k + 1); // reset inputs
        router.refresh();
      }}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-navy">Add {def.singular}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {def.fields.map((f) => (
          <Field key={f.key} field={f} />
        ))}
      </div>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-amber-700">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Adding…" : `Add ${def.singular}`}
      </button>
    </form>
  );
}

function EditForm({
  def,
  row,
  onDone,
}: {
  def: ConfigTableDef;
  row: Row;
  onDone: () => void;
}) {
  const action = updateConfigItem.bind(null, def.table, row.id);
  const [state, formAction, pending] = useActionState(action, empty);
  const router = useRouter();
  return (
    <form
      action={async (fd) => {
        await formAction(fd);
        router.refresh();
        onDone();
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      {def.fields.map((f) => (
        <Field key={f.key} field={f} value={row[f.key]} />
      ))}
      {state.error && (
        <p role="alert" className="text-sm text-amber-700 sm:col-span-2">
          {state.error}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-forest px-3 py-1.5 text-sm font-medium text-white hover:bg-forest-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ConfigList({ def, rows }: { def: ConfigTableDef; rows: Row[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function run(fn: () => Promise<unknown>) {
    startTransition(async () => {
      await fn();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <CreateForm def={def} />

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <ul className="divide-y divide-gray-100">
          {rows.length === 0 && (
            <li className="p-4 text-sm text-gray-500">No values yet. Add one above.</li>
          )}
          {rows.map((row, i) => (
            <li key={row.id} className="p-4">
              {editing === row.id ? (
                <EditForm def={def} row={row} onDone={() => setEditing(null)} />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">
                        {String(row.name ?? "")}
                      </span>
                      {/* Status by text + color, never color alone (CLAUDE.md §4) */}
                      {row.active ? (
                        <span className="rounded-full bg-forest-50 px-2 py-0.5 text-xs font-medium text-forest-700">
                          Active
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                          Disabled
                        </span>
                      )}
                    </div>
                    {def.fields
                      .filter((f) => f.key !== "name" && row[f.key] != null && row[f.key] !== "")
                      .map((f) => (
                        <span key={f.key} className="mr-3 text-xs text-gray-500">
                          {f.label}: {String(row[f.key])}
                        </span>
                      ))}
                  </div>
                  <div className="flex items-center gap-1">
                    {def.reorderable && (
                      <>
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={i === 0 || isPending}
                          onClick={() => run(() => reorderConfigItem(def.table, row.id, "up"))}
                          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={i === rows.length - 1 || isPending}
                          onClick={() => run(() => reorderConfigItem(def.table, row.id, "down"))}
                          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setEditing(row.id)}
                      className="rounded px-2 py-1 text-sm text-navy-700 hover:bg-gray-100"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() =>
                        run(() => toggleConfigActive(def.table, row.id, !row.active))
                      }
                      className="rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                    >
                      {row.active ? "Disable" : "Enable"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
