create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  name text not null,
  code text,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, name)
);

create table if not exists report_templates (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  code text not null,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  active_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, code)
);

create table if not exists report_template_versions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  template_id uuid not null references report_templates(id) on delete cascade,
  version_number integer not null,
  schema_json jsonb not null,
  validation_json jsonb not null default '{}'::jsonb,
  workflow_json jsonb not null default '{}'::jsonb,
  pdf_layout_json jsonb not null default '{}'::jsonb,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  unique (template_id, version_number)
);

create table if not exists report_submissions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  template_id uuid not null references report_templates(id),
  template_version_id uuid not null references report_template_versions(id),
  report_date date not null,
  shift_ref text,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'locked', 'revised')),
  submitted_by uuid references app_users(id),
  submitted_at timestamptz,
  payload_json jsonb not null default '{}'::jsonb,
  validation_results jsonb not null default '{}'::jsonb,
  source text not null default 'web' check (source in ('web', 'mobile', 'offline_sync')),
  pdf_status text not null default 'not_requested' check (pdf_status in ('not_requested', 'queued', 'generated', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists report_submission_attachments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  submission_id uuid not null references report_submissions(id) on delete cascade,
  field_key text not null,
  storage_path text not null,
  mime_type text not null,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  actor_user_id uuid references app_users(id),
  event_type text not null,
  entity_table text not null,
  entity_id uuid not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists departments_facility_idx on departments(facility_id) where deleted_at is null;
create index if not exists report_templates_facility_status_idx on report_templates(facility_id, status) where deleted_at is null;
create index if not exists report_submissions_facility_date_idx on report_submissions(facility_id, report_date desc) where deleted_at is null;
create index if not exists report_submissions_facility_template_status_idx on report_submissions(facility_id, template_id, status) where deleted_at is null;
create index if not exists report_attachments_facility_submission_idx on report_submission_attachments(facility_id, submission_id);
create index if not exists audit_events_facility_created_idx on audit_events(facility_id, created_at desc);
create index if not exists outbox_events_facility_status_idx on outbox_events(facility_id, status, available_at);

alter table departments enable row level security;
alter table report_templates enable row level security;
alter table report_template_versions enable row level security;
alter table report_submissions enable row level security;
alter table report_submission_attachments enable row level security;
alter table audit_events enable row level security;
alter table outbox_events enable row level security;

create policy "members can read departments" on departments for select using (facility_id in (select current_facility_ids()));
create policy "report readers can read templates" on report_templates for select using (has_permission(auth.uid(), facility_id, 'reports.read'));
create policy "report readers can read template versions" on report_template_versions for select using (has_permission(auth.uid(), facility_id, 'reports.read'));
create policy "report readers can read submissions" on report_submissions for select using (has_permission(auth.uid(), facility_id, 'reports.read'));
create policy "report creators can create submissions" on report_submissions for insert with check (has_permission(auth.uid(), facility_id, 'reports.create'));
create policy "report submitters can update drafts" on report_submissions for update using (has_permission(auth.uid(), facility_id, 'reports.submit') and status = 'draft');
create policy "report readers can read attachments" on report_submission_attachments for select using (has_permission(auth.uid(), facility_id, 'reports.read'));
create policy "members can read audit events" on audit_events for select using (facility_id in (select current_facility_ids()));
create policy "members can read outbox status" on outbox_events for select using (facility_id in (select current_facility_ids()));
