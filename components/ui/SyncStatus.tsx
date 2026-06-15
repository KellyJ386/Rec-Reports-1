"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { queueCounts } from "@/lib/offline/sync-queue";

/**
 * Always-visible sync-status indicator for the app shell (CLAUDE.md §8). Communicates
 * state with an icon AND a text label — never color alone (CLAUDE.md §4, accessibility).
 */
export function SyncStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const counts = useLiveQuery(() => queueCounts(), [], {
    pending: 0,
    conflicts: 0,
    errors: 0,
  });

  let icon = "✓";
  let label = "Synced";
  let className = "bg-forest-50 text-forest-700 border-forest-100";

  if (!online) {
    icon = "⊘";
    label = "Offline";
    className = "bg-gray-100 text-gray-700 border-gray-200";
  } else if (counts.conflicts > 0) {
    icon = "⚠";
    label = `${counts.conflicts} conflict${counts.conflicts > 1 ? "s" : ""} — needs review`;
    className = "bg-amber-50 text-amber-700 border-amber-100";
  } else if (counts.errors > 0) {
    icon = "✕";
    label = `${counts.errors} sync error${counts.errors > 1 ? "s" : ""}`;
    className = "bg-amber-50 text-amber-700 border-amber-100";
  } else if (counts.pending > 0) {
    icon = "↻";
    label = `Syncing ${counts.pending}…`;
    className = "bg-navy-600/5 text-navy-700 border-gray-200";
  }

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}
