alter table certification_types add column if not exists validity_days integer;
alter table certification_types add column if not exists grace_days integer not null default 0;
alter table certification_types add column if not exists auto_suspend_roles boolean not null default false;

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  code text not null,
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, code)
);

create table if not exists course_modules (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  module_type text not null check (module_type in ('video', 'pdf', 'sop_link', 'quiz', 'checklist')),
  title text not null,
  order_no integer not null,
  content_jsonb jsonb not null default '{}'::jsonb,
  required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (course_id, order_no)
);

create table if not exists training_assignments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  course_id uuid not null references courses(id),
  assigned_by uuid references app_users(id),
  assigned_at timestamptz not null default now(),
  due_at timestamptz,
  reason_code text,
  source_type text not null default 'manual' check (source_type in ('manual', 'role_rule', 'incident_rule', 'certification_rule')),
  source_ref_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (employee_id, course_id, source_type, source_ref_id)
);

create table if not exists training_progress (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  assignment_id uuid not null references training_assignments(id) on delete cascade,
  module_id uuid not null references course_modules(id) on delete cascade,
  state text not null default 'not_started' check (state in ('not_started', 'in_progress', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  score_pct numeric(5, 2),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, module_id)
);

create table if not exists training_completions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  assignment_id uuid not null references training_assignments(id) on delete cascade,
  completed_at timestamptz not null default now(),
  final_score_pct numeric(5, 2),
  completion_status text not null check (completion_status in ('passed', 'failed', 'waived')),
  created_at timestamptz not null default now(),
  unique (assignment_id)
);

create table if not exists certification_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_certification_id uuid not null references employee_certifications(id) on delete cascade,
  event_type text not null check (event_type in ('created', 'renewed', 'expired', 'revoked', 'evidence_uploaded')),
  event_at timestamptz not null default now(),
  payload_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists courses_facility_status_idx on courses(facility_id, status) where deleted_at is null;
create index if not exists course_modules_course_idx on course_modules(facility_id, course_id, order_no) where deleted_at is null;
create index if not exists training_assignments_employee_due_idx on training_assignments(facility_id, employee_id, due_at) where deleted_at is null;
create index if not exists training_progress_assignment_idx on training_progress(facility_id, assignment_id, state);
create index if not exists certification_events_cert_idx on certification_events(facility_id, employee_certification_id, event_at desc);

alter table courses enable row level security;
alter table course_modules enable row level security;
alter table training_assignments enable row level security;
alter table training_progress enable row level security;
alter table training_completions enable row level security;
alter table certification_events enable row level security;

create policy "training readers can read courses" on courses for select using (has_permission(auth.uid(), facility_id, 'training.read'));
create policy "training managers can manage courses" on courses for all using (has_permission(auth.uid(), facility_id, 'training.manage')) with check (has_permission(auth.uid(), facility_id, 'training.manage'));
create policy "training readers can read modules" on course_modules for select using (has_permission(auth.uid(), facility_id, 'training.read'));
create policy "training managers can manage modules" on course_modules for all using (has_permission(auth.uid(), facility_id, 'training.manage')) with check (has_permission(auth.uid(), facility_id, 'training.manage'));
create policy "training readers can read assignments" on training_assignments for select using (has_permission(auth.uid(), facility_id, 'training.read'));
create policy "training managers can manage assignments" on training_assignments for all using (has_permission(auth.uid(), facility_id, 'training.manage')) with check (has_permission(auth.uid(), facility_id, 'training.manage'));
create policy "training readers can read progress" on training_progress for select using (has_permission(auth.uid(), facility_id, 'training.read'));
create policy "training managers can manage progress" on training_progress for all using (has_permission(auth.uid(), facility_id, 'training.manage')) with check (has_permission(auth.uid(), facility_id, 'training.manage'));
create policy "training readers can read completions" on training_completions for select using (has_permission(auth.uid(), facility_id, 'training.read'));
create policy "training readers can read certification events" on certification_events for select using (has_permission(auth.uid(), facility_id, 'training.read'));
