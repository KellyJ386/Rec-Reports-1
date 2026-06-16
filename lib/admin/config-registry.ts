/**
 * Admin config registry (MODULE_SPEC.md §5.1–§5.2). One declarative entry per config
 * table drives a single reusable CRUD UI + generic server actions, so we never hand-write
 * a screen per table. Grouped by module for the Admin Control Center nav (§5.2).
 *
 * This module is shared by client and server — keep it free of secrets and server-only
 * imports. It is the allowlist that constrains which tables the generic actions may touch.
 */

import type { FacilityRole } from "@/types/supabase";

/**
 * Roles assignable through the facility admin UI (super_admin is platform-only). Lives here
 * (a plain shared module) rather than in the "use server" actions file, which may only
 * export async functions.
 */
export const ASSIGNABLE_ROLES: FacilityRole[] = [
  "org_admin",
  "facility_manager",
  "supervisor",
  "staff",
];

export type FieldType = "text" | "textarea" | "number" | "select";

export type ConfigField = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  default?: string | number;
  min?: number;
};

export type ConfigGroup = "Operations" | "Facility Management" | "Workforce";

export type ConfigTableDef = {
  /** DB table name — also the URL slug. */
  table: string;
  /** Plural label for the list page. */
  label: string;
  /** Singular noun for buttons ("Add area"). */
  singular: string;
  group: ConfigGroup;
  /** Whether rows can be reordered via display_order. */
  reorderable: boolean;
  /** Editable form fields (excludes display_order + active, handled by the UI chrome). */
  fields: ConfigField[];
};

const NAME_FIELD: ConfigField = { key: "name", label: "Name", type: "text", required: true };
const DESC_FIELD: ConfigField = { key: "description", label: "Description", type: "textarea" };

/** Build a uniform catalog table definition (name + description). */
function catalog(
  table: string,
  label: string,
  singular: string,
  group: ConfigGroup,
): ConfigTableDef {
  return { table, label, singular, group, reorderable: true, fields: [NAME_FIELD, DESC_FIELD] };
}

export const CONFIG_REGISTRY: ConfigTableDef[] = [
  // --- Operations ---
  {
    table: "severity_level",
    label: "Severity levels",
    singular: "severity level",
    group: "Operations",
    reorderable: true,
    fields: [
      {
        key: "module",
        label: "Module",
        type: "select",
        required: true,
        default: "general",
        options: [
          { value: "general", label: "General (all modules)" },
          { value: "injury", label: "Injury / Illness" },
          { value: "incident", label: "Incident" },
        ],
      },
      NAME_FIELD,
      { key: "weight", label: "Weight (higher = more severe)", type: "number", default: 0, min: 0 },
    ],
  },
  catalog("incident_category", "Incident categories", "incident category", "Operations"),
  catalog("area", "Areas / locations", "area", "Operations"),
  catalog("recipient_group", "Recipient groups", "recipient group", "Operations"),

  // --- Facility Management ---
  catalog("task_category", "Task categories", "task category", "Facility Management"),
  catalog("count_type", "Count types", "count type", "Facility Management"),
  catalog("count_area", "Count areas", "count area", "Facility Management"),
  catalog("form_category", "Form categories", "form category", "Facility Management"),
  catalog("sop_category", "SOP categories", "SOP category", "Facility Management"),
  catalog("erp_scenario_type", "ERP scenario types", "ERP scenario type", "Facility Management"),
  catalog("erp_response_level", "ERP response levels", "ERP response level", "Facility Management"),
  catalog("work_order_category", "Work order categories", "work order category", "Facility Management"),
  catalog("asset_type", "Asset types", "asset type", "Facility Management"),

  // --- Workforce ---
  {
    table: "job_area",
    label: "Job areas",
    singular: "job area",
    group: "Workforce",
    reorderable: true,
    fields: [NAME_FIELD],
  },
  {
    table: "position_type",
    label: "Position types",
    singular: "position type",
    group: "Workforce",
    reorderable: true,
    fields: [NAME_FIELD, DESC_FIELD],
  },
  {
    table: "cert_type",
    label: "Certification types",
    singular: "certification type",
    group: "Workforce",
    reorderable: true,
    fields: [
      NAME_FIELD,
      { key: "validity_days", label: "Validity (days)", type: "number", required: true, default: 365, min: 1 },
      { key: "renewal_window_days", label: "Renewal window (days)", type: "number", required: true, default: 60, min: 0 },
    ],
  },
];

export const CONFIG_GROUPS: ConfigGroup[] = ["Operations", "Facility Management", "Workforce"];

export function getConfigDef(table: string): ConfigTableDef | undefined {
  return CONFIG_REGISTRY.find((d) => d.table === table);
}
