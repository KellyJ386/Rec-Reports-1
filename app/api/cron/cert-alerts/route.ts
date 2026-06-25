import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";

/**
 * Certification expiry alert engine (MODULE_SPEC.md §4.2): notifies cert holders at exactly
 * 60 / 30 / 7 days before expiry. Intended to run daily as a scheduled job (e.g. Vercel
 * Cron). Uses the service role (no end-user session) to scan all facilities, so it is
 * protected by a shared CRON_SECRET when configured.
 */
const ALERT_DAYS = [60, 30, 7];

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const admin = createAdminClient();

  // staff_certification_status exposes computed status + days_to_expiry (RLS bypassed by
  // the service role — this is a system job, not a user request).
  const { data: certs, error } = await admin
    .from("staff_certification_status")
    .select("id, user_id, cert_type_name, expires_on, days_to_expiry")
    .in("days_to_expiry", ALERT_DAYS);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = certs ?? [];
  if (rows.length === 0) return NextResponse.json({ sent: 0 });

  // Resolve recipient emails.
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: accounts } = await admin
    .from("user_account")
    .select("id, email, display_name")
    .in("id", userIds);
  const emailById = new Map((accounts ?? []).map((a) => [a.id, a]));

  let sent = 0;
  for (const cert of rows) {
    const account = emailById.get(cert.user_id);
    if (!account?.email) continue;
    const days = cert.days_to_expiry;
    const result = await sendEmail({
      to: account.email,
      subject: `Certification expiring in ${days} days: ${cert.cert_type_name}`,
      html: `<p>Hi ${account.display_name ?? ""},</p>
        <p>Your <strong>${cert.cert_type_name}</strong> certification expires on
        <strong>${cert.expires_on}</strong> (${days} days). Please renew it and upload the
        updated document in RecReports.</p>`,
    });
    if (!result.error) sent++;
  }

  return NextResponse.json({ scanned: rows.length, sent });
}
