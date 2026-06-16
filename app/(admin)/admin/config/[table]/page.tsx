import Link from "next/link";
import { notFound } from "next/navigation";
import { getConfigDef } from "@/lib/admin/config-registry";
import { fetchConfigRows } from "@/lib/admin/queries";
import { requireFacilityId } from "@/lib/auth/session";
import { ConfigList } from "@/components/config/ConfigList";

export default async function ConfigTablePage({
  params,
}: {
  params: Promise<{ table: string }>;
}) {
  const { table } = await params;
  const def = getConfigDef(table);
  if (!def) notFound();

  const facilityId = await requireFacilityId();
  const rows = await fetchConfigRows(table, facilityId);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/config" className="text-sm text-navy-700 hover:underline">
          ← All configuration
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">{def.label}</h1>
        <p className="text-xs uppercase tracking-wide text-gray-400">{def.group}</p>
      </div>
      <ConfigList def={def} rows={rows} />
    </div>
  );
}
