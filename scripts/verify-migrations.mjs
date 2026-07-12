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
  "admin_change_requests",
  "organization_admins",
  "pdf_templates",
  "pdf_template_bindings"
];

for (const table of requiredRlsTables) {
  if (!combinedSql.includes(`alter table ${table} enable row level security`)) {
    throw new Error(`Migrations do not enable RLS for ${table}.`);
  }
}

for (const helper of [
  "current_facility_ids",
  "has_permission",
  "fn_assert_same_facility",
  "is_organization_admin",
  "fn_block_audit_mutation",
  "fn_audit_admin_change",
  "fn_protect_system_role",
  "fn_audit_chain_link",
  "fn_enforce_change_request_transition"
]) {
  if (!combinedSql.includes(`function ${helper}`)) {
    throw new Error(`Migrations do not define ${helper}.`);
  }
}

// Audit backbone: both audit tables must carry an append-only guard, i.e. a
// BEFORE UPDATE OR DELETE trigger, so audit rows can never be mutated in place.
const lowerSql = combinedSql.toLowerCase();
for (const auditTable of ["audit_events", "incident_audit_events"]) {
  if (!lowerSql.includes(`before update or delete on ${auditTable}`)) {
    throw new Error(`Migrations do not define an append-only (before update or delete) trigger on ${auditTable}.`);
  }
}

// Hash chain (0013): audit_events must carry a BEFORE INSERT trigger that
// stamps prev_hash/row_hash on every row, so a later "verify chain integrity"
// pass has something trustworthy to recompute against.
if (!lowerSql.includes("before insert on audit_events")) {
  throw new Error("Migrations do not define a hash-chain (before insert) trigger on audit_events.");
}

// From 0009 onward every `create policy` must be immediately preceded (in the
// same file) by a matching `drop policy if exists` for the same name+table, so
// every policy stays idempotent and re-runnable. Historical files are exempt.
const dropCreatePattern = /(drop policy if exists|create policy)\s+"([^"]+)"\s+on\s+(\w+)/g;
for (const file of files) {
  const fileNumber = Number.parseInt(file.slice(0, 4), 10);
  if (Number.isNaN(fileNumber) || fileNumber < 9) {
    continue;
  }
  const fileSql = readFileSync(join(migrationDir.pathname, file), "utf8");
  const statements = [...fileSql.matchAll(dropCreatePattern)];
  for (let index = 0; index < statements.length; index += 1) {
    const [, kind, name, table] = statements[index];
    if (kind !== "create policy") {
      continue;
    }
    const previous = statements[index - 1];
    if (
      !previous ||
      previous[1] !== "drop policy if exists" ||
      previous[2] !== name ||
      previous[3] !== table
    ) {
      throw new Error(
        `${file}: create policy "${name}" on ${table} is not immediately preceded by a matching drop policy if exists.`
      );
    }
  }
}

const policyTables = new Set();
const policyPattern = /create policy\s+"[^"]*"\s+on\s+(\w+)/g;
let policyMatch;
while ((policyMatch = policyPattern.exec(combinedSql)) !== null) {
  policyTables.add(policyMatch[1]);
}

for (const table of requiredRlsTables) {
  if (!policyTables.has(table)) {
    throw new Error(`Migrations do not define a create policy statement for ${table}.`);
  }
}

console.log(`Verified ${files.length} migration file(s) include tenant-scoped RLS requirements.`);
