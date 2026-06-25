/** Cert status as icon + text (never color alone — CLAUDE.md §4). */
export function CertStatusBadge({ status }: { status: "active" | "expiring" | "expired" }) {
  const map = {
    active: { icon: "✓", label: "Active", cls: "bg-forest-50 text-forest-700" },
    expiring: { icon: "⚠", label: "Expiring", cls: "bg-amber-50 text-amber-700" },
    expired: { icon: "✕", label: "Expired", cls: "bg-amber-100 text-amber-800" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${map.cls}`}>
      <span aria-hidden="true">{map.icon}</span>
      {map.label}
    </span>
  );
}
