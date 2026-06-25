import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Compliance Dashboard aggregates (MODULE_SPEC.md §6). All reads go through the
 * request-bound client, so RLS scopes everything to facilities the caller belongs to and
 * to what their role may see. Manager-scoped (the page gates to supervisor+).
 */
export async function getComplianceData(facilityId: string) {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [openIncidents, overdueTasks, expiringCerts, openShifts] = await Promise.all([
    supabase
      .from("incident_report")
      .select("id, incident_no, status")
      .eq("facility_id", facilityId)
      .is("deleted_at", null)
      .neq("status", "closed")
      .order("reported_at", { ascending: false })
      .limit(50),
    supabase
      .from("task")
      .select("id, title, due_at")
      .eq("facility_id", facilityId)
      .is("deleted_at", null)
      .in("status", ["open", "in_progress"])
      .lt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(50),
    supabase
      .from("staff_certification_status")
      .select("id, cert_type_name, status, expires_on")
      .eq("facility_id", facilityId)
      .in("status", ["expiring", "expired"])
      .order("expires_on", { ascending: true })
      .limit(50),
    supabase
      .from("shift")
      .select("id, starts_at, job_area_id")
      .eq("facility_id", facilityId)
      .is("deleted_at", null)
      .eq("status", "open")
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(50),
  ]);

  return {
    openIncidents: openIncidents.data ?? [],
    overdueTasks: overdueTasks.data ?? [],
    expiringCerts: expiringCerts.data ?? [],
    openShifts: openShifts.data ?? [],
  };
}
