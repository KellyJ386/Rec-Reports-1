create table if not exists incident_reports (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  incident_no text not null,
  report_type text not null check (report_type in ('incident', 'accident', 'near_miss')),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'under_review', 'escalated', 'action_pending', 'closed')),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  occurred_at timestamptz not null,
  reported_at timestamptz not null default now(),
  location_text text not null,
  summary text not null,
  immediate_actions text,
  requires_osha_review boolean not null default false,
  legal_hold boolean not null default false,
  submitted_by uuid references app_users(id),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, incident_no)
);

create table if not exists incident_people (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  person_role text not null check (person_role in ('injured_party', 'witness', 'staff', 'contractor', 'visitor')),
  full_name text not null,
  contact_json jsonb not null default '{}'::jsonb,
  injury_json jsonb not null default '{}'::jsonb,
  statement_text text,
  statement_submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists incident_attachments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  attachment_type text not null check (attachment_type in ('photo', 'document', 'video', 'audio')),
  storage_path text not null,
  captured_at timestamptz,
  captured_by uuid references app_users(id),
  checksum_sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists incident_escalations (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  escalation_level integer not null default 1,
  reason_code text not null,
  target_role text not null,
  target_user_id uuid references app_users(id),
  status text not null default 'pending' check (status in ('pending', 'acknowledged', 'resolved', 'expired')),
  due_at timestamptz not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists incident_followup_actions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  owner_user_id uuid references app_users(id),
  action_type text not null check (action_type in ('corrective_action', 'investigation', 'documentation', 'equipment_fix', 'training')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'completed', 'waived')),
  due_at timestamptz,
  description text not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists incident_audit_events (
  id bigserial primary key,
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid references app_users(id),
  event_payload jsonb not null default '{}'::jsonb,
  prev_event_hash text,
  event_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists incident_amendments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  amendment_reason text not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  amended_by uuid references app_users(id),
  amended_at timestamptz not null default now()
);

create index if not exists incident_reports_facility_status_idx on incident_reports(facility_id, status, occurred_at desc) where deleted_at is null;
create index if not exists incident_reports_facility_severity_idx on incident_reports(facility_id, severity, occurred_at desc) where deleted_at is null;
create index if not exists incident_people_facility_incident_idx on incident_people(facility_id, incident_id) where deleted_at is null;
create index if not exists incident_attachments_facility_incident_idx on incident_attachments(facility_id, incident_id) where deleted_at is null;
create index if not exists incident_escalations_facility_status_idx on incident_escalations(facility_id, status, due_at) where deleted_at is null;
create index if not exists incident_followups_facility_status_idx on incident_followup_actions(facility_id, status, due_at) where deleted_at is null;
create index if not exists incident_audit_facility_incident_idx on incident_audit_events(facility_id, incident_id, created_at);

alter table incident_reports enable row level security;
alter table incident_people enable row level security;
alter table incident_attachments enable row level security;
alter table incident_escalations enable row level security;
alter table incident_followup_actions enable row level security;
alter table incident_audit_events enable row level security;
alter table incident_amendments enable row level security;

create policy "incident readers can read reports" on incident_reports for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
create policy "incident managers can manage reports" on incident_reports for all using (has_permission(auth.uid(), facility_id, 'incidents.manage')) with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));
create policy "incident readers can read people" on incident_people for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
create policy "incident managers can manage people" on incident_people for all using (has_permission(auth.uid(), facility_id, 'incidents.manage')) with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));
create policy "incident readers can read attachments" on incident_attachments for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
create policy "incident managers can manage attachments" on incident_attachments for all using (has_permission(auth.uid(), facility_id, 'incidents.manage')) with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));
create policy "incident readers can read escalations" on incident_escalations for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
create policy "incident managers can manage escalations" on incident_escalations for all using (has_permission(auth.uid(), facility_id, 'incidents.manage')) with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));
create policy "incident readers can read followups" on incident_followup_actions for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
create policy "incident managers can manage followups" on incident_followup_actions for all using (has_permission(auth.uid(), facility_id, 'incidents.manage')) with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));
create policy "incident readers can read audit" on incident_audit_events for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
create policy "incident readers can read amendments" on incident_amendments for select using (has_permission(auth.uid(), facility_id, 'incidents.read'));
