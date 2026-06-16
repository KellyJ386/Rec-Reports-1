/**
 * Supabase database types.
 *
 * GENERATED ARTIFACT — regenerate with `npm run db:types` (which runs
 * `supabase gen types typescript --local`) after every migration. The hand-written
 * version below tracks db/migrations/20260615120000_tenancy_foundation.sql so the app
 * type-checks before a live Supabase project is wired (CLAUDE.md §11 "Generated Supabase
 * types updated").
 *
 * NOTE: table type aliases are declared standalone (no self-reference into `Database`) so
 * the schema satisfies postgrest-js `GenericSchema` without circular resolution.
 */

export type FacilityRole =
  | "super_admin"
  | "org_admin"
  | "facility_manager"
  | "supervisor"
  | "staff";

export type MembershipStatus = "active" | "inactive" | "archived";
export type LifecycleStatus = "active" | "inactive" | "archived";
export type FacilityType =
  | "campus_rec"
  | "aquatic"
  | "fitness"
  | "parks_rec"
  | "ymca"
  | "multi_sport"
  | "other";

type Timestamps = { created_at: string; updated_at: string };
type Authored = {
  created_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
};

// --- organization ---
type OrganizationRow = { id: string; name: string; status: LifecycleStatus; plan_tier: string } & Timestamps & Authored;
type OrganizationInsert = { id?: string; name: string; status?: LifecycleStatus; plan_tier?: string; created_by?: string | null };

// --- facility ---
type FacilityRow = {
  id: string;
  org_id: string;
  name: string;
  facility_type: FacilityType;
  time_zone: string;
  operating_hours: Record<string, unknown>;
  logo_url: string | null;
  status: LifecycleStatus;
  settings: Record<string, unknown>;
} & Timestamps & Authored;
type FacilityInsert = {
  id?: string;
  org_id: string;
  name: string;
  facility_type?: FacilityType;
  time_zone?: string;
  operating_hours?: Record<string, unknown>;
  logo_url?: string | null;
  status?: LifecycleStatus;
  settings?: Record<string, unknown>;
  created_by?: string | null;
};

// --- user_account ---
type UserAccountRow = {
  id: string;
  email: string;
  phone: string | null;
  display_name: string | null;
  status: LifecycleStatus;
} & Timestamps;
type UserAccountInsert = {
  id: string;
  email: string;
  phone?: string | null;
  display_name?: string | null;
  status?: LifecycleStatus;
};

// --- facility_membership ---
type MembershipRow = {
  id: string;
  facility_id: string;
  user_id: string;
  role: FacilityRole;
  status: MembershipStatus;
} & Timestamps & Authored;
type MembershipInsert = {
  id?: string;
  facility_id: string;
  user_id: string;
  role: FacilityRole;
  status?: MembershipStatus;
  created_by?: string | null;
};

// --- job_area ---
type JobAreaRow = { id: string; facility_id: string; name: string; display_order: number; active: boolean } & Timestamps & Authored;
type JobAreaInsert = { id?: string; facility_id: string; name: string; display_order?: number; active?: boolean; created_by?: string | null };

// --- cert_type ---
type CertTypeRow = {
  id: string;
  facility_id: string;
  name: string;
  validity_days: number;
  renewal_window_days: number;
  display_order: number;
  active: boolean;
} & Timestamps & Authored;
type CertTypeInsert = {
  id?: string;
  facility_id: string;
  name: string;
  validity_days?: number;
  renewal_window_days?: number;
  display_order?: number;
  active?: boolean;
  created_by?: string | null;
};

// --- job_area_required_cert ---
type JarcRow = { id: string; facility_id: string; job_area_id: string; cert_type_id: string } & Timestamps & Authored;
type JarcInsert = { id?: string; facility_id: string; job_area_id: string; cert_type_id: string; created_by?: string | null };

// --- audit_event (written only via SECURITY DEFINER triggers; RLS blocks direct writes) ---
type AuditEventRow = {
  id: number;
  facility_id: string | null;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string;
};
type AuditEventInsert = {
  facility_id?: string | null;
  actor_user_id?: string | null;
  entity_type: string;
  entity_id?: string | null;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  request_id?: string | null;
};

// --- uniform config catalog tables (MODULE_SPEC.md §5.1) ---
type CatalogRow = {
  id: string;
  facility_id: string;
  name: string;
  description: string | null;
  display_order: number;
  active: boolean;
} & Timestamps & Authored;
type CatalogInsert = {
  id?: string;
  facility_id: string;
  name: string;
  description?: string | null;
  display_order?: number;
  active?: boolean;
  created_by?: string | null;
};
type CatalogTable = { Row: CatalogRow; Insert: CatalogInsert; Update: Partial<CatalogInsert>; Relationships: [] };

/** Names of the uniform (same-shape) config catalog tables. */
export const CATALOG_TABLES = [
  "area",
  "incident_category",
  "task_category",
  "count_type",
  "count_area",
  "form_category",
  "sop_category",
  "erp_scenario_type",
  "erp_response_level",
  "work_order_category",
  "position_type",
  "asset_type",
  "recipient_group",
] as const;
export type CatalogTableName = (typeof CATALOG_TABLES)[number];

// --- severity_level (per-module, weighted) ---
type SeverityLevelRow = {
  id: string;
  facility_id: string;
  module: string;
  name: string;
  weight: number;
  display_order: number;
  active: boolean;
} & Timestamps & Authored;
type SeverityLevelInsert = {
  id?: string;
  facility_id: string;
  module?: string;
  name: string;
  weight?: number;
  display_order?: number;
  active?: boolean;
  created_by?: string | null;
};

export type Database = {
  public: {
    Tables: {
      organization: { Row: OrganizationRow; Insert: OrganizationInsert; Update: Partial<OrganizationInsert>; Relationships: [] };
      facility: { Row: FacilityRow; Insert: FacilityInsert; Update: Partial<FacilityInsert>; Relationships: [] };
      user_account: { Row: UserAccountRow; Insert: UserAccountInsert; Update: Partial<UserAccountInsert>; Relationships: [] };
      facility_membership: { Row: MembershipRow; Insert: MembershipInsert; Update: Partial<MembershipInsert>; Relationships: [] };
      job_area: { Row: JobAreaRow; Insert: JobAreaInsert; Update: Partial<JobAreaInsert>; Relationships: [] };
      cert_type: { Row: CertTypeRow; Insert: CertTypeInsert; Update: Partial<CertTypeInsert>; Relationships: [] };
      job_area_required_cert: { Row: JarcRow; Insert: JarcInsert; Update: Partial<JarcInsert>; Relationships: [] };
      audit_event: { Row: AuditEventRow; Insert: AuditEventInsert; Update: Partial<AuditEventInsert>; Relationships: [] };
      severity_level: { Row: SeverityLevelRow; Insert: SeverityLevelInsert; Update: Partial<SeverityLevelInsert>; Relationships: [] };
      area: CatalogTable;
      incident_category: CatalogTable;
      task_category: CatalogTable;
      count_type: CatalogTable;
      count_area: CatalogTable;
      form_category: CatalogTable;
      sop_category: CatalogTable;
      erp_scenario_type: CatalogTable;
      erp_response_level: CatalogTable;
      work_order_category: CatalogTable;
      position_type: CatalogTable;
      asset_type: CatalogTable;
      recipient_group: CatalogTable;
    };
    Views: { [_ in never]: never };
    Functions: {
      current_user_role_at: { Args: { p_facility_id: string }; Returns: FacilityRole | null };
      has_facility_role: { Args: { p_facility_id: string; p_min_role: FacilityRole }; Returns: boolean };
      is_facility_member: { Args: { p_facility_id: string }; Returns: boolean };
      role_rank: { Args: { p_role: FacilityRole }; Returns: number };
      provision_facility_defaults: { Args: { p_facility_id: string }; Returns: undefined };
    };
    Enums: {
      facility_role: FacilityRole;
      membership_status: MembershipStatus;
      lifecycle_status: LifecycleStatus;
      facility_type: FacilityType;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
