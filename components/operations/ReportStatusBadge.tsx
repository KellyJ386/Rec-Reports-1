/** Report status as text + color (never color alone — CLAUDE.md §4). */
export function ReportStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-gray-100 text-gray-700" },
    submitted: { label: "Submitted", cls: "bg-amber-50 text-amber-700" },
    reviewed: { label: "Reviewed", cls: "bg-navy-600/10 text-navy-700" },
    closed: { label: "Closed", cls: "bg-forest-50 text-forest-700" },
    locked: { label: "Locked", cls: "bg-forest-50 text-forest-700" },
  };
  const m = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-700" };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.label}</span>
  );
}
