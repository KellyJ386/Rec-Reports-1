"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser, requireFacilityId } from "@/lib/auth/session";

export type CertActionState = { error?: string; ok?: boolean };

const schema = z.object({
  cert_type_id: z.string().uuid("Choose a certification type"),
  issued_on: z.string().optional().transform((v) => (v ? v : null)),
  expires_on: z.string().optional().transform((v) => (v ? v : null)),
});

/**
 * Add (or upload) one of the current user's own certifications (MODULE_SPEC.md §4.2).
 * Staff manage their own certs; the optional document is stored in the private
 * `certifications` Storage bucket and referenced by path (served via signed URL).
 */
export async function addCertification(
  _prev: CertActionState,
  formData: FormData,
): Promise<CertActionState> {
  try {
    const user = await requireUser();
    const facilityId = await requireFacilityId();
    const parsed = schema.safeParse({
      cert_type_id: formData.get("cert_type_id"),
      issued_on: formData.get("issued_on"),
      expires_on: formData.get("expires_on"),
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const supabase = await createClient();

    let documentUrl: string | null = null;
    const file = formData.get("document");
    if (file instanceof File && file.size > 0) {
      const path = `${facilityId}/${user.id}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage
        .from("certifications")
        .upload(path, file, { upsert: false });
      if (upErr) return { error: `Document upload failed: ${upErr.message}` };
      documentUrl = path;
    }

    const { error } = await supabase.from("staff_certification").insert({
      facility_id: facilityId,
      user_id: user.id, // RLS allows a member to insert their own cert
      cert_type_id: parsed.data.cert_type_id,
      issued_on: parsed.data.issued_on,
      expires_on: parsed.data.expires_on,
      document_url: documentUrl,
      created_by: user.id,
    });
    if (error) return { error: error.message };

    revalidatePath("/workforce/certifications");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add certification" };
  }
}
