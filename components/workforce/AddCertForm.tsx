"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { addCertification, type CertActionState } from "@/lib/workforce/cert-actions";

const empty: CertActionState = {};

export function AddCertForm({ certTypes }: { certTypes: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(addCertification, empty);
  const router = useRouter();

  return (
    <form
      action={async (fd) => {
        await formAction(fd);
        router.refresh();
      }}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-navy">Add a certification</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="cert_type_id" className="block text-xs font-medium text-gray-600">
            Type
          </label>
          <select
            id="cert_type_id"
            name="cert_type_id"
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
          >
            <option value="">Select…</option>
            {certTypes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="document" className="block text-xs font-medium text-gray-600">
            Document (optional)
          </label>
          <input
            id="document"
            name="document"
            type="file"
            accept="application/pdf,image/*"
            className="mt-1 block w-full text-sm text-gray-700"
          />
        </div>
        <div>
          <label htmlFor="issued_on" className="block text-xs font-medium text-gray-600">
            Issued on
          </label>
          <input id="issued_on" name="issued_on" type="date" className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest" />
        </div>
        <div>
          <label htmlFor="expires_on" className="block text-xs font-medium text-gray-600">
            Expires on
          </label>
          <input id="expires_on" name="expires_on" type="date" className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest" />
        </div>
      </div>
      {state.error && <p role="alert" className="mt-2 text-sm text-amber-700">{state.error}</p>}
      {state.ok && <p role="status" className="mt-2 text-sm text-forest-700">✓ Saved.</p>}
      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Add certification"}
      </button>
    </form>
  );
}
