"use client";

import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(sendMagicLink, initialState);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-forest">RecReports</h1>
        <p className="mt-1 text-sm text-gray-600">
          Sign in to your facility operations workspace.
        </p>

        {state.sent ? (
          <p
            role="status"
            className="mt-6 rounded-md bg-forest-50 p-4 text-sm text-forest-700"
          >
            ✓ Check your email — we sent you a secure sign-in link.
          </p>
        ) : (
          <form action={formAction} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700"
              >
                Work email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
                placeholder="you@facility.org"
              />
            </div>

            {state.error && (
              <p role="alert" className="text-sm text-amber-700">
                {state.error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-md bg-forest px-4 py-2 font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60"
            >
              {pending ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        <div className="mt-6 border-t border-gray-100 pt-4">
          <button
            type="button"
            disabled
            title="Enterprise SSO (SAML 2.0) — coming soon"
            className="w-full cursor-not-allowed rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-400"
          >
            Sign in with SSO (SAML) — coming soon
          </button>
        </div>
      </div>
    </main>
  );
}
