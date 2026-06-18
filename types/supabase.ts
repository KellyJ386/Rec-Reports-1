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

// --- Workforce (Stream A): certifications + scheduling ---
type StaffCertRow = {
  id: string; facility_id: string; user_id: string; cert_type_id: string;
  issued_on: string | null; expires_on: string | null; document_url: string | null; notes: string | null;
} & Timestamps & Authored;
type StaffCertInsert = {
  id?: string; facility_id: string; user_id: string; cert_type_id: string;
  issued_on?: string | null; expires_on?: string | null; document_url?: string | null; notes?: string | null; created_by?: string | null;
};
type StaffCertStatusRow = StaffCertRow & {
  cert_type_name: string; renewal_window_days: number;
  status: "active" | "expiring" | "expired"; days_to_expiry: number | null;
};

type SchedulePeriodRow = {
  id: string; facility_id: string; week_start_date: string; week_end_date: string;
  status: "draft" | "published" | "locked"; publish_version: number;
} & Timestamps & Authored;
type SchedulePeriodInsert = {
  id?: string; facility_id: string; week_start_date: string; week_end_date: string;
  status?: "draft" | "published" | "locked"; publish_version?: number; created_by?: string | null;
};

type ShiftTemplateRow = {
  id: string; facility_id: string; job_area_id: string; area_id: string | null;
  days_of_week: number[]; start_time_local: string; end_time_local: string; required_count: number; active: boolean;
} & Timestamps & Authored;
type ShiftTemplateInsert = {
  id?: string; facility_id: string; job_area_id: string; area_id?: string | null;
  days_of_week?: number[]; start_time_local: string; end_time_local: string; required_count?: number; active?: boolean; created_by?: string | null;
};

type ShiftRow = {
  id: string; facility_id: string; schedule_period_id: string; job_area_id: string; area_id: string | null;
  starts_at: string; ends_at: string;
  status: "draft" | "open" | "assigned" | "published" | "cancelled";
  source: "template" | "manual"; required_count: number; notes: string | null;
} & Timestamps & Authored;
type ShiftInsert = {
  id?: string; facility_id: string; schedule_period_id: string; job_area_id: string; area_id?: string | null;
  starts_at: string; ends_at: string;
  status?: "draft" | "open" | "assigned" | "published" | "cancelled";
  source?: "template" | "manual"; required_count?: number; notes?: string | null; created_by?: string | null;
};

type ShiftAssignmentRow = {
  id: string; facility_id: string; shift_id: string; user_id: string;
  assignment_type: "primary" | "cover"; status: "pending" | "approved" | "declined" | "cancelled"; assigned_by: string | null;
} & Timestamps & Authored;
type ShiftAssignmentInsert = {
  id?: string; facility_id: string; shift_id: string; user_id: string;
  assignment_type?: "primary" | "cover"; status?: "pending" | "approved" | "declined" | "cancelled"; assigned_by?: string | null; created_by?: string | null;
};

type AvailabilityRow = {
  id: string; facility_id: string; user_id: string; weekday: number; unavailable: boolean;
  available_start: string | null; available_end: string | null;
  max_hours_per_day: number | null; max_hours_per_week: number | null; doubles_allowed: boolean;
  effective_from: string; effective_to: string | null;
} & Timestamps & Authored;
type AvailabilityInsert = {
  id?: string; facility_id: string; user_id: string; weekday: number; unavailable?: boolean;
  available_start?: string | null; available_end?: string | null;
  max_hours_per_day?: number | null; max_hours_per_week?: number | null; doubles_allowed?: boolean;
  effective_from?: string; effective_to?: string | null; created_by?: string | null;
};

type SwapRequestRow = {
  id: string; facility_id: string; offered_assignment_id: string; requested_assignment_id: string | null;
  requester_user_id: string; target_user_id: string | null;
  swap_type: "direct" | "drop_pickup"; status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  reason: string | null; decided_by: string | null;
} & Timestamps & Authored;
type SwapRequestInsert = {
  id?: string; facility_id: string; offered_assignment_id: string; requested_assignment_id?: string | null;
  requester_user_id: string; target_user_id?: string | null;
  swap_type?: "direct" | "drop_pickup"; status?: "pending" | "approved" | "denied" | "cancelled" | "expired";
  reason?: string | null; decided_by?: string | null; created_by?: string | null;
};

type ScheduleDeliveryRow = {
  id: string; facility_id: string; schedule_period_id: string; recipient_user_id: string;
  channel: "email" | "in_app"; status: "queued" | "sent" | "failed";
  provider_message_id: string | null; sent_at: string | null;
} & Timestamps;
type ScheduleDeliveryInsert = {
  id?: string; facility_id: string; schedule_period_id: string; recipient_user_id: string;
  channel?: "email" | "in_app"; status?: "queued" | "sent" | "failed";
  provider_message_id?: string | null; sent_at?: string | null;
};

// --- Operations Core (Stream B) ---
type ReportStatus = "draft" | "submitted" | "reviewed" | "closed";
type ReportStampFields = {
  submitted_by: string | null; submitted_at: string | null;
  reviewed_by: string | null; reviewed_at: string | null; closed_at: string | null;
};

type InjuryReportRow = {
  id: string; facility_id: string; incident_no: string; report_type: "injury" | "illness";
  severity_level_id: string | null; area_id: string | null;
  occurred_at: string | null; reported_at: string; summary: string | null; immediate_actions: string | null;
  status: ReportStatus; legal_hold: boolean;
} & ReportStampFields & Timestamps & Authored;
type InjuryReportInsert = {
  id?: string; facility_id: string; incident_no: string; report_type?: "injury" | "illness";
  severity_level_id?: string | null; area_id?: string | null;
  occurred_at?: string | null; reported_at?: string; summary?: string | null; immediate_actions?: string | null;
  status?: ReportStatus; legal_hold?: boolean; created_by?: string | null;
};

type IncidentReportRow = {
  id: string; facility_id: string; incident_no: string; incident_category_id: string | null;
  severity_level_id: string | null; area_id: string | null;
  occurred_at: string | null; reported_at: string; summary: string | null; immediate_actions: string | null;
  status: ReportStatus; legal_hold: boolean; follow_up_required: boolean; follow_up_task_id: string | null;
} & ReportStampFields & Timestamps & Authored;
type IncidentReportInsert = {
  id?: string; facility_id: string; incident_no: string; incident_category_id?: string | null;
  severity_level_id?: string | null; area_id?: string | null;
  occurred_at?: string | null; reported_at?: string; summary?: string | null; immediate_actions?: string | null;
  status?: ReportStatus; legal_hold?: boolean; follow_up_required?: boolean; follow_up_task_id?: string | null; created_by?: string | null;
};

type ReportPersonRow = {
  id: string; facility_id: string; parent_id: string; parent_type: "injury_report" | "incident_report";
  person_role: "injured" | "involved" | "completing"; full_name: string;
  contact: Record<string, unknown>; details: Record<string, unknown>;
} & Timestamps & Authored;
type ReportPersonInsert = {
  id?: string; facility_id?: string; parent_id: string; parent_type: "injury_report" | "incident_report";
  person_role?: "injured" | "involved" | "completing"; full_name: string;
  contact?: Record<string, unknown>; details?: Record<string, unknown>; created_by?: string | null;
};

type ReportWitnessRow = {
  id: string; facility_id: string; parent_id: string; parent_type: "injury_report" | "incident_report";
  full_name: string; contact: Record<string, unknown>; statement: string | null;
} & Timestamps & Authored;
type ReportWitnessInsert = {
  id?: string; facility_id?: string; parent_id: string; parent_type: "injury_report" | "incident_report";
  full_name: string; contact?: Record<string, unknown>; statement?: string | null; created_by?: string | null;
};

type DailyLogEntryRow = {
  id: string; facility_id: string; log_date: string; area_id: string | null; task_category_id: string | null;
  body: string; entry_at: string;
} & Timestamps & Authored;
type DailyLogEntryInsert = {
  id?: string; facility_id: string; log_date?: string; area_id?: string | null; task_category_id?: string | null;
  body: string; entry_at?: string; created_by?: string | null;
};

type DailyLogTagRow = { id: string; facility_id: string; daily_log_entry_id: string; user_id: string; created_at: string };
type DailyLogTagInsert = { id?: string; facility_id: string; daily_log_entry_id: string; user_id: string };

type MemoRow = {
  id: string; facility_id: string; to_group_id: string | null; from_user_id: string;
  subject: string; body_richtext: string | null; priority: "low" | "normal" | "high";
  optional_email: boolean; posted_at: string;
} & Timestamps & Authored;
type MemoInsert = {
  id?: string; facility_id: string; to_group_id?: string | null; from_user_id: string;
  subject: string; body_richtext?: string | null; priority?: "low" | "normal" | "high";
  optional_email?: boolean; posted_at?: string; created_by?: string | null;
};

type MemoReceiptRow = { id: string; facility_id: string; memo_id: string; user_id: string; read_at: string | null; created_at: string };
type MemoReceiptInsert = { id?: string; facility_id: string; memo_id: string; user_id: string; read_at?: string | null };

type EodReportRow = {
  id: string; facility_id: string; report_date: string; summary: string | null; fields: Record<string, unknown>;
  incidents_occurred: boolean; equipment_issues: boolean; status: "draft" | "submitted" | "locked";
  submitted_by: string | null; submitted_at: string | null; locked_at: string | null;
} & Timestamps & Authored;
type EodReportInsert = {
  id?: string; facility_id: string; report_date?: string; summary?: string | null; fields?: Record<string, unknown>;
  incidents_occurred?: boolean; equipment_issues?: boolean; status?: "draft" | "submitted" | "locked";
  submitted_by?: string | null; submitted_at?: string | null; locked_at?: string | null; created_by?: string | null;
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
      staff_certification: { Row: StaffCertRow; Insert: StaffCertInsert; Update: Partial<StaffCertInsert>; Relationships: [] };
      schedule_period: { Row: SchedulePeriodRow; Insert: SchedulePeriodInsert; Update: Partial<SchedulePeriodInsert>; Relationships: [] };
      shift_template: { Row: ShiftTemplateRow; Insert: ShiftTemplateInsert; Update: Partial<ShiftTemplateInsert>; Relationships: [] };
      shift: { Row: ShiftRow; Insert: ShiftInsert; Update: Partial<ShiftInsert>; Relationships: [] };
      shift_assignment: { Row: ShiftAssignmentRow; Insert: ShiftAssignmentInsert; Update: Partial<ShiftAssignmentInsert>; Relationships: [] };
      availability: { Row: AvailabilityRow; Insert: AvailabilityInsert; Update: Partial<AvailabilityInsert>; Relationships: [] };
      swap_request: { Row: SwapRequestRow; Insert: SwapRequestInsert; Update: Partial<SwapRequestInsert>; Relationships: [] };
      schedule_delivery: { Row: ScheduleDeliveryRow; Insert: ScheduleDeliveryInsert; Update: Partial<ScheduleDeliveryInsert>; Relationships: [] };
      injury_report: { Row: InjuryReportRow; Insert: InjuryReportInsert; Update: Partial<InjuryReportInsert>; Relationships: [] };
      incident_report: { Row: IncidentReportRow; Insert: IncidentReportInsert; Update: Partial<IncidentReportInsert>; Relationships: [] };
      report_person: { Row: ReportPersonRow; Insert: ReportPersonInsert; Update: Partial<ReportPersonInsert>; Relationships: [] };
      report_witness: { Row: ReportWitnessRow; Insert: ReportWitnessInsert; Update: Partial<ReportWitnessInsert>; Relationships: [] };
      daily_log_entry: { Row: DailyLogEntryRow; Insert: DailyLogEntryInsert; Update: Partial<DailyLogEntryInsert>; Relationships: [] };
      daily_log_entry_tag: { Row: DailyLogTagRow; Insert: DailyLogTagInsert; Update: Partial<DailyLogTagInsert>; Relationships: [] };
      memo: { Row: MemoRow; Insert: MemoInsert; Update: Partial<MemoInsert>; Relationships: [] };
      memo_receipt: { Row: MemoReceiptRow; Insert: MemoReceiptInsert; Update: Partial<MemoReceiptInsert>; Relationships: [] };
      eod_report: { Row: EodReportRow; Insert: EodReportInsert; Update: Partial<EodReportInsert>; Relationships: [] };
    };
    Views: {
      staff_certification_status: { Row: StaffCertStatusRow; Relationships: [] };
    };
    Functions: {
      current_user_role_at: { Args: { p_facility_id: string }; Returns: FacilityRole | null };
      has_facility_role: { Args: { p_facility_id: string; p_min_role: FacilityRole }; Returns: boolean };
      is_facility_member: { Args: { p_facility_id: string }; Returns: boolean };
      role_rank: { Args: { p_role: FacilityRole }; Returns: number };
      provision_facility_defaults: { Args: { p_facility_id: string }; Returns: undefined };
      cert_computed_status: { Args: { p_expires_on: string | null; p_renewal_window_days: number }; Returns: string };
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
