import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migrationDir = new URL("../supabase/migrations", import.meta.url);
const files = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort();

if (files.length === 0) {
  throw new Error("No Supabase migrations found.");
}

const combinedSql = files
  .map((file) => readFileSync(join(migrationDir.pathname, file), "utf8"))
  .join("\n");

const requiredRlsTables = [
  "facilities",
  "memberships",
  "roles",
  "departments",
  "report_templates",
  "report_template_versions",
  "report_submissions",
  "report_submission_attachments",
  "audit_events",
  "outbox_events",
  "employees",
  "certification_types",
  "employee_certifications",
  "schedule_periods",
  "shift_templates",
  "schedule_shifts",
  "shift_assignments",
  "schedule_publications",
  "incident_reports",
  "incident_people",
  "incident_attachments",
  "incident_escalations",
  "incident_followup_actions",
  "incident_audit_events",
  "incident_amendments",
  "assets",
  "work_orders",
  "work_order_updates",
  "work_order_attachments",
  "communication_channels",
  "messages",
  "message_audiences",
  "message_receipts",
  "message_acknowledgements",
  "notification_jobs",
  "notification_deliveries",
  "courses",
  "course_modules",
  "training_assignments",
  "training_progress",
  "training_completions",
  "certification_events",
  "modules",
  "organization_module_settings",
  "facility_module_overrides",
  "facility_settings",
  "department_settings",
  "branding_profiles",
  "admin_change_requests"
];

for (const table of requiredRlsTables) {
  if (!combinedSql.includes(`alter table ${table} enable row level security`)) {
    throw new Error(`Migrations do not enable RLS for ${table}.`);
  }
}

for (const helper of ["current_facility_ids", "has_permission"]) {
  if (!combinedSql.includes(`function ${helper}`)) {
    throw new Error(`Migrations do not define ${helper}.`);
  }
}

console.log(`Verified ${files.length} migration file(s) include tenant-scoped RLS requirements.`);
