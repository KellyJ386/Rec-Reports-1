import "server-only";
import { Resend } from "resend";

/**
 * Thin Resend wrapper (CLAUDE.md §2). Returns `{ skipped: true }` when no API key is
 * configured so local/dev flows don't crash — callers should treat email as best-effort
 * (the in-app record is authoritative; CLAUDE.md §8.6).
 */
export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  html: string;
}): Promise<{ id?: string; error?: string; skipped?: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping send:", params.subject);
    return { skipped: true };
  }
  const resend = new Resend(apiKey);
  const from = process.env.EMAIL_FROM ?? "RecReports <noreply@send.recreports.com>";
  const { data, error } = await resend.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
  });
  return { id: data?.id, error: error?.message };
}
