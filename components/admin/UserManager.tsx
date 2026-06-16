"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FacilityRole } from "@/types/supabase";
import {
  inviteUser,
  changeMemberRole,
  setMemberStatus,
  setFacilitySso,
  type UserActionState,
} from "@/lib/admin/user-actions";

export type MemberRow = {
  id: string;
  userId: string;
  role: FacilityRole;
  status: "active" | "inactive" | "archived";
  email: string;
  displayName: string | null;
};

const ROLE_LABEL: Record<FacilityRole, string> = {
  super_admin: "Super admin",
  org_admin: "Org admin",
  facility_manager: "Facility manager",
  supervisor: "Supervisor",
  staff: "Staff",
};

const STATUS_STYLE: Record<MemberRow["status"], string> = {
  active: "bg-forest-50 text-forest-700",
  inactive: "bg-amber-50 text-amber-700",
  archived: "bg-gray-100 text-gray-600",
};

const empty: UserActionState = {};

export function UserManager({
  members,
  assignableRoles,
  ssoEnabled,
  currentUserId,
}: {
  members: MemberRow[];
  assignableRoles: FacilityRole[];
  ssoEnabled: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, formAction, inviting] = useActionState(inviteUser, empty);

  function run(fn: () => Promise<unknown>) {
    startTransition(async () => {
      await fn();
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* Invite */}
      <form
        action={async (fd) => {
          await formAction(fd);
          router.refresh();
        }}
        className="rounded-lg border border-gray-200 bg-white p-4"
      >
        <h2 className="text-sm font-semibold text-navy">Invite a user</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[12rem]">
            <label htmlFor="inv_email" className="block text-xs font-medium text-gray-600">
              Email
            </label>
            <input
              id="inv_email"
              name="email"
              type="email"
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
              placeholder="person@facility.org"
            />
          </div>
          <div>
            <label htmlFor="inv_role" className="block text-xs font-medium text-gray-600">
              Role
            </label>
            <select
              id="inv_role"
              name="role"
              defaultValue="staff"
              className="mt-1 block rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest"
            >
              {assignableRoles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={inviting}
            className="rounded-md bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2 disabled:opacity-60"
          >
            {inviting ? "Inviting…" : "Send invite"}
          </button>
        </div>
        {state.error && (
          <p role="alert" className="mt-2 text-sm text-amber-700">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="mt-2 text-sm text-forest-700">
            ✓ Invitation sent.
          </p>
        )}
      </form>

      {/* Members */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <ul className="divide-y divide-gray-100">
          {members.length === 0 && (
            <li className="p-4 text-sm text-gray-500">No members yet.</li>
          )}
          {members.map((m) => {
            const isSelf = m.userId === currentUserId;
            return (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {m.displayName ?? m.email}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[m.status]}`}
                    >
                      {m.status}
                    </span>
                    {isSelf && <span className="text-xs text-gray-400">(you)</span>}
                  </div>
                  <span className="text-xs text-gray-500">{m.email}</span>
                </div>

                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`role_${m.id}`}>
                    Role for {m.email}
                  </label>
                  <select
                    id={`role_${m.id}`}
                    defaultValue={m.role}
                    disabled={isPending || !assignableRoles.includes(m.role)}
                    onChange={(e) =>
                      run(() => changeMemberRole(m.id, e.target.value as FacilityRole))
                    }
                    className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest disabled:opacity-50"
                  >
                    {/* show current role even if not in assignable (e.g. higher-ranked) */}
                    {!assignableRoles.includes(m.role) && (
                      <option value={m.role}>{ROLE_LABEL[m.role]}</option>
                    )}
                    {assignableRoles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>

                  {m.status === "active" ? (
                    <button
                      type="button"
                      disabled={isPending || isSelf}
                      onClick={() => run(() => setMemberStatus(m.id, "inactive"))}
                      className="rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => run(() => setMemberStatus(m.id, "active"))}
                      className="rounded px-2 py-1 text-sm text-forest-700 hover:bg-gray-100 disabled:opacity-40"
                    >
                      Reactivate
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isPending || isSelf || m.status === "archived"}
                    onClick={() => run(() => setMemberStatus(m.id, "archived"))}
                    className="rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                  >
                    Archive
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* SSO toggle (placeholder) */}
      <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <h2 className="text-sm font-semibold text-navy">Enterprise SSO (SAML 2.0)</h2>
          <p className="text-xs text-gray-500">
            Placeholder — enables SAML sign-in for this facility once configured.
          </p>
        </div>
        <button
          type="button"
          disabled={isPending}
          aria-pressed={ssoEnabled}
          onClick={() => run(() => setFacilitySso(!ssoEnabled))}
          className={`rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-forest ${
            ssoEnabled
              ? "bg-forest text-white hover:bg-forest-700"
              : "border border-gray-300 text-gray-700 hover:bg-gray-50"
          }`}
        >
          {ssoEnabled ? "Enabled" : "Disabled"}
        </button>
      </div>
    </div>
  );
}
