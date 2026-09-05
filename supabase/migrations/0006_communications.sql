create table if not exists communication_channels (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  channel_type text not null default 'department' check (channel_type in ('facility', 'department', 'shift', 'emergency')),
  name text not null,
  shift_scoped boolean not null default false,
  emergency_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, name)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  channel_id uuid not null references communication_channels(id) on delete cascade,
  author_employee_id uuid references employees(id),
  message_type text not null default 'announcement' check (message_type in ('announcement', 'direct', 'alert', 'sop_notice')),
  subject text not null,
  body_text text not null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'urgent', 'emergency')),
  is_required_ack boolean not null default false,
  ack_due_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists message_audiences (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  audience_type text not null check (audience_type in ('role', 'department', 'shift', 'employee')),
  audience_ref_id uuid,
  rule_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists message_receipts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  device_id text,
  created_at timestamptz not null default now(),
  unique (message_id, employee_id)
);

create table if not exists message_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  ack_state text not null default 'pending' check (ack_state in ('pending', 'acknowledged', 'overdue', 'waived')),
  acknowledged_at timestamptz,
  ack_method text check (ack_method in ('button', 'signature', 'manager_override')),
  signature_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, employee_id)
);

create table if not exists notification_jobs (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  event_type text not null,
  payload_jsonb jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  job_id uuid not null references notification_jobs(id) on delete cascade,
  employee_id uuid references employees(id),
  channel text not null check (channel in ('in_app', 'email', 'sms', 'push')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'bounced')),
  sent_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists communication_channels_facility_idx on communication_channels(facility_id, channel_type) where deleted_at is null;
create index if not exists messages_facility_created_idx on messages(facility_id, created_at desc) where deleted_at is null;
create index if not exists message_audiences_message_idx on message_audiences(facility_id, message_id) where deleted_at is null;
create index if not exists message_receipts_employee_idx on message_receipts(facility_id, employee_id, read_at);
create index if not exists message_acknowledgements_state_idx on message_acknowledgements(facility_id, ack_state, acknowledged_at);
create index if not exists notification_jobs_status_idx on notification_jobs(facility_id, status, scheduled_for);
create index if not exists notification_deliveries_job_idx on notification_deliveries(facility_id, job_id, status);

alter table communication_channels enable row level security;
alter table messages enable row level security;
alter table message_audiences enable row level security;
alter table message_receipts enable row level security;
alter table message_acknowledgements enable row level security;
alter table notification_jobs enable row level security;
alter table notification_deliveries enable row level security;

create policy "communication readers can read channels" on communication_channels for select using (has_permission(auth.uid(), facility_id, 'communications.read'));
create policy "communication publishers can manage channels" on communication_channels for all using (has_permission(auth.uid(), facility_id, 'communications.publish')) with check (has_permission(auth.uid(), facility_id, 'communications.publish'));
create policy "communication readers can read messages" on messages for select using (has_permission(auth.uid(), facility_id, 'communications.read'));
create policy "communication publishers can manage messages" on messages for all using (has_permission(auth.uid(), facility_id, 'communications.publish')) with check (has_permission(auth.uid(), facility_id, 'communications.publish'));
create policy "communication readers can read audiences" on message_audiences for select using (has_permission(auth.uid(), facility_id, 'communications.read'));
create policy "communication publishers can manage audiences" on message_audiences for all using (has_permission(auth.uid(), facility_id, 'communications.publish')) with check (has_permission(auth.uid(), facility_id, 'communications.publish'));
create policy "communication readers can read receipts" on message_receipts for select using (has_permission(auth.uid(), facility_id, 'communications.read'));
create policy "communication readers can read acknowledgements" on message_acknowledgements for select using (has_permission(auth.uid(), facility_id, 'communications.read'));
create policy "communication publishers can manage notifications" on notification_jobs for all using (has_permission(auth.uid(), facility_id, 'communications.publish')) with check (has_permission(auth.uid(), facility_id, 'communications.publish'));
create policy "communication publishers can read notification deliveries" on notification_deliveries for select using (has_permission(auth.uid(), facility_id, 'communications.publish'));
