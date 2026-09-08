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
  "report_submission_signatures",
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
  "incident_witness_statements",
  "incident_signatures",
  "incident_compliance_checks",
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
  "platform_admins",
  "pdf_templates",
  "pdf_template_bindings",
  "custom_fields",
  "form_definitions",
  "form_field_bindings",
  "notification_events",
  "distribution_lists",
  "distribution_list_members",
  "notification_routes",
  "certification_role_requirements",
  "certification_policies",
  "feature_flags",
  "feature_flag_rules",
  "employee_device_tokens",
  "employee_notification_preferences",
  "subscription_plans",
  "tenant_subscriptions",
  "usage_counters",
  "auth_throttle",
  "report_workflow_events",
  "report_distribution_lists",
  "report_deliveries",
  "incident_training_triggers"
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
  "is_platform_admin",
  "fn_block_audit_mutation",
  "fn_audit_admin_change",
  "fn_protect_system_role",
  "fn_audit_chain_link",
  "fn_enforce_change_request_transition",
  "fn_storage_attachment_facility_id",
  "fn_storage_attachment_module",
  "fn_message_audience_ref_facility",
  "fn_incident_report_audit",
  "fn_incident_report_transition_guard",
  "fn_incident_witness_statement_guard",
  "fn_report_submission_signature_guard",
  "fn_incident_signature_guard",
  "internal.apply_incident_amendment",
  "public.apply_incident_amendment",
  "internal.enqueue_report_workflow",
  "public.enqueue_report_workflow",
  "internal.mint_workflow_incident",
  "public.mint_workflow_incident",
  "internal.mint_workflow_work_order",
  "public.mint_workflow_work_order",
  "internal.create_work_order_from_incident",
  "public.create_work_order_from_incident"
]) {
  if (!combinedSql.includes(`function ${helper}`)) {
    throw new Error(`Migrations do not define ${helper}.`);
  }
}

// 0042 moved the five internal scope/permission helper names (has_permission
// covers both its overloads) into the `internal` schema and locked them down
// so PostgREST can never expose them as /rest/v1/rpc/<name>. Any later
// migration that redefines one of them must keep it there -- a bare or
// `public.`-qualified `create [or replace] function <name>(...)` from 0043
// onward would silently recreate the old public-schema, PUBLIC-executable
// version (CREATE FUNCTION defaults to a new object in the search_path's
// first schema and grants EXECUTE to PUBLIC), re-opening OP-05.
const internalHelperNames = new Set([
  "current_facility_ids",
  "has_permission",
  "fn_assert_same_facility",
  "is_organization_admin",
  "is_platform_admin"
]);
const createFunctionPattern = /create\s+(?:or\s+replace\s+)?function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/gi;
for (const file of files) {
  const fileNumber = Number.parseInt(file.slice(0, 4), 10);
  if (Number.isNaN(fileNumber) || fileNumber < 43) {
    continue;
  }
  const fileSql = readFileSync(join(migrationDir.pathname, file), "utf8");
  createFunctionPattern.lastIndex = 0;
  let helperMatch;
  while ((helperMatch = createFunctionPattern.exec(fileSql)) !== null) {
    const qualifiedName = helperMatch[1];
    const parts = qualifiedName.split(".");
    const bareName = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[0] : null;
    if (internalHelperNames.has(bareName) && schema !== "internal") {
      throw new Error(
        `${file}: "create function ${qualifiedName}(...)" redefines an internal helper outside the internal schema; use internal.${bareName}(...).`
      );
    }
  }
}

// M-3: the guard above only caught a bad *definition* -- a >=0043
// migration that CALLS one of the five internal helpers bare (or
// `public.`-qualified), e.g. inside a new policy predicate, was never
// checked at all, even though 0042's own header promises
// "scripts/verify-migrations.mjs enforces this for every migration
// numbered >= 0043" for exactly that shape of reference. Such a call is
// self-detecting today (H-2's `alter database ... set search_path =
// public, internal` makes a bare reference resolve and WORK correctly, so
// it is no longer even self-detecting the way it was before that fix --
// it would just silently succeed), so this is the only thing left
// enforcing the "always write internal.<helper>(...)" convention the
// header documents. `has_permission` covers both its overloads; a call is
// any occurrence of the bare name immediately followed by `(`, not already
// qualified with `internal.` right before it.
const helperCallPattern = new RegExp(
  `(?<!internal\\.)\\b(${[...internalHelperNames].sort((a, b) => b.length - a.length).join("|")})\\s*\\(`,
  "g"
);
for (const file of files) {
  const fileNumber = Number.parseInt(file.slice(0, 4), 10);
  if (Number.isNaN(fileNumber) || fileNumber < 43) {
    continue;
  }
  // Match against code only: `--` line comments and `/* */` blocks routinely
  // mention the helpers by name when explaining a policy, and a mention is
  // not a call.
  const fileSql = readFileSync(join(migrationDir.pathname, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  helperCallPattern.lastIndex = 0;
  let callMatch;
  while ((callMatch = helperCallPattern.exec(fileSql)) !== null) {
    // Definitions ("create [or replace] function <name>(") are already
    // reported by the more specific error above -- skip them here so a bad
    // definition doesn't also get flagged as a bad call, muddying the
    // error message.
    const precedingText = fileSql.slice(0, callMatch.index);
    if (/create\s+(?:or\s+replace\s+)?function\s+$/i.test(precedingText)) {
      continue;
    }
    throw new Error(
      `${file}: bare reference to internal helper "${callMatch[1]}(...)" outside the internal schema; call it as internal.${callMatch[1]}(...).`
    );
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

// Guard carry-forward: a trigger function that several migrations >= 0043
// redefine with `create or replace` is replaced whole -- the LAST definition
// wins and silently drops anything an earlier migration added. Slice 3B hit
// exactly this: 0057 recreated fn_incident_report_transition_guard from the
// 0048 text and lost 0056's closure gate until the RLS suite caught it. Every
// guard in these functions is labelled `-- Guard <id>` (or `-- Guard <id>
// (...)`), so the rule is mechanical: for each function redefined more than
// once from 0043 on, every guard label present in an earlier definition must
// also appear in every later one.
const guardedFunctionDefinition = /create\s+or\s+replace\s+function\s+(?:public\.)?(fn_[a-z0-9_]+)\s*\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi;
const guardLabelPattern = /^\s*--\s*Guard\s+([0-9]+(?:\.[0-9]+)?[a-z]?)\b/gim;
const guardLabelsByFunction = new Map();
for (const file of files) {
  const fileNumber = Number.parseInt(file.slice(0, 4), 10);
  if (Number.isNaN(fileNumber) || fileNumber < 43) continue;
  const fileSql = readFileSync(join(migrationDir.pathname, file), "utf8");
  guardedFunctionDefinition.lastIndex = 0;
  let definition;
  while ((definition = guardedFunctionDefinition.exec(fileSql)) !== null) {
    const [, functionName, body] = definition;
    const labels = new Set();
    guardLabelPattern.lastIndex = 0;
    let label;
    while ((label = guardLabelPattern.exec(body)) !== null) labels.add(label[1]);
    if (labels.size === 0) continue;
    const earlier = guardLabelsByFunction.get(functionName);
    if (earlier) {
      const dropped = [...earlier.labels].filter((id) => !labels.has(id));
      if (dropped.length > 0) {
        throw new Error(
          `${file}: redefines ${functionName}() without guard(s) ${dropped.map((id) => `"Guard ${id}"`).join(", ")} that ${earlier.file} added; a create or replace must carry every earlier guard forward.`
        );
      }
    }
    guardLabelsByFunction.set(functionName, { file, labels });
  }
}

console.log(`Verified ${files.length} migration file(s) include tenant-scoped RLS requirements.`);
