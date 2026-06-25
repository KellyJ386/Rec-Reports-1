import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId, getRoleAt } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/roles";
import { MemoForm, MarkReadButton } from "@/components/operations/OpsForms";

export default async function MemosPage() {
  const user = await requireUser();
  const facilityId = await requireFacilityId();
  const role = await getRoleAt(facilityId);
  const canPost = roleAtLeast(role, "supervisor");
  const supabase = await createClient();

  const { data: memos } = await supabase
    .from("memo")
    .select("id, subject, body_richtext, priority, posted_at")
    .eq("facility_id", facilityId)
    .is("deleted_at", null)
    .order("posted_at", { ascending: false })
    .limit(50);

  const memoIds = (memos ?? []).map((m) => m.id);
  const readSet = new Set<string>();
  if (memoIds.length) {
    const { data: receipts } = await supabase
      .from("memo_receipt")
      .select("memo_id, read_at")
      .eq("user_id", user.id)
      .in("memo_id", memoIds);
    for (const r of receipts ?? []) if (r.read_at) readSet.add(r.memo_id);
  }

  const groups = canPost
    ? (await supabase.from("recipient_group").select("id, name").eq("facility_id", facilityId).eq("active", true).order("display_order")).data ?? []
    : [];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/operations" className="text-sm text-navy-700 hover:underline">← Operations</Link>
        <h1 className="mt-1 text-2xl font-bold text-navy">Memo Board</h1>
      </div>
      {canPost && <MemoForm groups={groups} />}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {(memos ?? []).length === 0 && <li className="p-4 text-sm text-gray-500">No memos yet.</li>}
        {(memos ?? []).map((m) => (
          <li key={m.id} className="flex items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{m.subject}</span>
                {m.priority === "high" && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">High priority</span>
                )}
              </div>
              {m.body_richtext && <p className="mt-1 text-sm text-gray-600">{m.body_richtext}</p>}
              <p className="mt-1 text-xs text-gray-400">{new Date(m.posted_at).toLocaleString()}</p>
            </div>
            <MarkReadButton memoId={m.id} read={readSet.has(m.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
