create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  user_id uuid references app_users(id),
  department_id uuid references departments(id),
  employee_no text,
  first_name text not null,
  last_name text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, employee_no)
);

create table if not exists certification_types (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  code text not null,
  name text not null,
  renewal_window_days integer not null default 30,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, code)
);

create table if not exists employee_certifications (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  certification_type_id uuid not null references certification_types(id),
  issued_at date,
  expires_at date,
  evidence_path text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (employee_id, certification_type_id)
);

create table if not exists schedule_periods (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  week_start_date date not null,
  week_end_date date not null,
  status text not null default 'draft' check (status in ('draft', 'review', 'published', 'archived')),
  publish_version integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, department_id, week_start_date)
);

create table if not exists shift_templates (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  role_code text not null,
  recurrence_rule text not null,
  start_time_local time not null,
  end_time_local time not null,
  days_of_week integer[] not null default '{}',
  required_certification_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists schedule_shifts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  schedule_period_id uuid not null references schedule_periods(id) on delete cascade,
  department_id uuid references departments(id),
  role_code text not null,
  shift_date date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null default 'manual' check (source in ('template', 'manual')),
  status text not null default 'draft' check (status in ('draft', 'open', 'assigned', 'published', 'cancelled')),
  required_certification_ids uuid[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (starts_at < ends_at)
);

create table if not exists shift_assignments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  shift_id uuid not null references schedule_shifts(id) on delete cascade,
  employee_id uuid not null references employees(id),
  assignment_type text not null default 'primary' check (assignment_type in ('primary', 'cover')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  assigned_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (shift_id, employee_id, assignment_type)
);

create table if not exists schedule_publications (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  schedule_period_id uuid not null references schedule_periods(id) on delete cascade,
  publish_version integer not null,
  published_at timestamptz not null default now(),
  published_by uuid references app_users(id),
  change_summary jsonb not null default '{}'::jsonb,
  unique (schedule_period_id, publish_version)
);

create index if not exists employees_facility_department_idx on employees(facility_id, department_id) where deleted_at is null;
create index if not exists certification_types_facility_code_idx on certification_types(facility_id, code) where deleted_at is null;
create index if not exists employee_certifications_employee_idx on employee_certifications(facility_id, employee_id) where deleted_at is null;
create index if not exists schedule_periods_facility_week_idx on schedule_periods(facility_id, week_start_date desc) where deleted_at is null;
create index if not exists schedule_shifts_facility_date_idx on schedule_shifts(facility_id, shift_date, starts_at) where deleted_at is null;
create index if not exists shift_assignments_facility_employee_idx on shift_assignments(facility_id, employee_id) where deleted_at is null;

alter table employees enable row level security;
alter table certification_types enable row level security;
alter table employee_certifications enable row level security;
alter table schedule_periods enable row level security;
alter table shift_templates enable row level security;
alter table schedule_shifts enable row level security;
alter table shift_assignments enable row level security;
alter table schedule_publications enable row level security;

create policy "members can read employees" on employees for select using (facility_id in (select current_facility_ids()));
create policy "members can read certification types" on certification_types for select using (facility_id in (select current_facility_ids()));
create policy "members can read employee certifications" on employee_certifications for select using (facility_id in (select current_facility_ids()));
create policy "schedule readers can read periods" on schedule_periods for select using (has_permission(auth.uid(), facility_id, 'schedule.read'));
create policy "schedule managers can manage periods" on schedule_periods for all using (has_permission(auth.uid(), facility_id, 'schedule.manage')) with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));
create policy "schedule readers can read shift templates" on shift_templates for select using (has_permission(auth.uid(), facility_id, 'schedule.read'));
create policy "schedule managers can manage shift templates" on shift_templates for all using (has_permission(auth.uid(), facility_id, 'schedule.manage')) with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));
create policy "schedule readers can read shifts" on schedule_shifts for select using (has_permission(auth.uid(), facility_id, 'schedule.read'));
create policy "schedule managers can manage shifts" on schedule_shifts for all using (has_permission(auth.uid(), facility_id, 'schedule.manage')) with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));
create policy "schedule readers can read assignments" on shift_assignments for select using (has_permission(auth.uid(), facility_id, 'schedule.read'));
create policy "schedule managers can manage assignments" on shift_assignments for all using (has_permission(auth.uid(), facility_id, 'schedule.manage')) with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));
create policy "schedule readers can read publications" on schedule_publications for select using (has_permission(auth.uid(), facility_id, 'schedule.read'));
