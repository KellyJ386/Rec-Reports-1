# Production PostgreSQL + Supabase Schema Design

## 1) ERD Structure

### 1.1 Tenant hierarchy and identity
- `facilities` is the tenant boundary.
- Every tenant-scoped table has:
  - `facility_id uuid not null references facilities(id)`
  - `created_at`, `updated_at`, `created_by`, `updated_by`
  - `deleted_at`, `deleted_by` (soft delete)
- `users` maps 1:1 to `auth.users` using Supabase UID.

### 1.2 Core shared tables
- `facilities`
- `users` (profile mirror of `auth.users`)
- `departments`
- `employees`
- `roles`
- `permissions`
- `role_permissions`
- `user_role_assignments`
- `certification_types`
- `employee_certifications`
- `communications`

### 1.3 Operational tables
- Scheduling: `shifts`, `shift_assignments`, `shift_swaps`, `time_off_requests`
- Safety: `incident_reports`, `accident_reports`, `incident_actions`
- Reporting: `daily_report_templates`, `daily_report_submissions`
- Maintenance: `assets`, `work_orders`, `maintenance_logs`
- SOP/training: `sop_documents`, `training_assignments`, `acknowledgements`
- Ops workflow: `tasks`, `notifications`

### 1.4 Relationship map (text ERD)
- `facilities 1---* departments`
- `facilities 1---* employees`
- `users 1---* employees` (nullable for non-login employees)
- `roles *---* permissions` via `role_permissions`
- `users *---* roles per facility` via `user_role_assignments`
- `employees 1---* shift_assignments`
- `shifts 1---* shift_assignments`
- `shift_swaps` references requesting/target assignment rows
- `employees 1---* time_off_requests`
- `incident_reports 1---* incident_actions`
- `assets 1---* work_orders 1---* maintenance_logs`
- `daily_report_templates 1---* daily_report_submissions`
- `sop_documents 1---* acknowledgements`
- `training_assignments` references `employees` + optional `certification_types`
- `notifications` references recipient `users`

---

## 2) SQL Migration Examples

```sql
-- 0001_extensions.sql
create extension if not exists pgcrypto;
create extension if not exists btree_gin;

-- 0002_types.sql
create type app_status as enum ('active','inactive','archived');
create type shift_status as enum ('draft','published','in_progress','completed','cancelled');
create type swap_status as enum ('requested','approved','denied','cancelled','expired');
create type request_status as enum ('pending','approved','denied','cancelled');
create type incident_severity as enum ('low','medium','high','critical');
create type report_status as enum ('draft','submitted','locked');
create type work_order_status as enum ('open','in_progress','on_hold','resolved','closed','cancelled');
create type task_status as enum ('todo','in_progress','blocked','done','cancelled');
create type notification_channel as enum ('in_app','email','sms','push');

-- 0003_helpers.sql
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create or replace function is_facility_member(p_facility_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.employees e
    where e.facility_id = p_facility_id
      and e.user_id = auth.uid()
      and e.deleted_at is null
      and e.status = 'active'
  );
$$;

create or replace function has_permission(p_facility_id uuid, p_permission text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.role_permissions rp on rp.role_id = ura.role_id
    join public.permissions p on p.id = rp.permission_id
    where ura.facility_id = p_facility_id
      and ura.user_id = auth.uid()
      and p.code = p_permission
      and ura.deleted_at is null
  );
$$;

-- 0004_core.sql
create table public.facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'UTC',
  status app_status not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  phone text,
  display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id),
  name text not null,
  code text,
  status app_status not null default 'active',
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  unique(facility_id, name)
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id),
  user_id uuid references public.users(id),
  department_id uuid references public.departments(id),
  employee_no text,
  first_name text not null,
  last_name text not null,
  status app_status not null default 'active',
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  unique(facility_id, employee_no)
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid references public.facilities(id),
  code text not null,
  name text not null,
  status app_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  unique(facility_id, code)
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  action text not null,
  code text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);

create table public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.roles(id),
  permission_id uuid not null references public.permissions(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  unique(role_id, permission_id)
);

create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id),
  user_id uuid not null references public.users(id),
  role_id uuid not null references public.roles(id),
  scope_type text not null default 'facility',
  scope_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);

-- 0005_operational_sample.sql
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id),
  department_id uuid references public.departments(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status shift_status not null default 'draft',
  required_count int not null default 1,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);

create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id),
  shift_id uuid not null references public.shifts(id),
  employee_id uuid not null references public.employees(id),
  assignment_status request_status not null default 'pending',
  checkin_at timestamptz,
  checkout_at timestamptz,
  notes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  unique(shift_id, employee_id)
);

create table public.shift_swaps (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id),
  source_assignment_id uuid not null references public.shift_assignments(id),
  target_assignment_id uuid references public.shift_assignments(id),
  requested_by_employee_id uuid not null references public.employees(id),
  status swap_status not null default 'requested',
  reason text,
  approval_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);

-- Repeat same pattern for: time_off_requests, incidents, accidents,
-- daily_report_templates/submissions, assets, work_orders,
-- maintenance_logs, sops, training_assignments, acknowledgements,
-- communications, notifications, tasks.

-- 0006_audit.sql
create table public.audit_log (
  id bigserial primary key,
  facility_id uuid,
  actor_user_id uuid references auth.users(id),
  table_name text not null,
  record_id uuid,
  action text not null check (action in ('insert','update','delete','soft_delete')),
  old_data jsonb,
  new_data jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create or replace function public.audit_trigger_fn()
returns trigger language plpgsql as $$
begin
  insert into public.audit_log(facility_id, actor_user_id, table_name, record_id, action, old_data, new_data)
  values (
    coalesce(new.facility_id, old.facility_id),
    auth.uid(),
    tg_table_name,
    coalesce(new.id, old.id),
    lower(tg_op),
    to_jsonb(old),
    to_jsonb(new)
  );
  return coalesce(new, old);
end; $$;
```

---

## 3) Supabase RLS Strategy + Example Policies

### 3.1 Strategy
1. Enable RLS on every tenant table.
2. Restrict all reads/writes to facility membership.
3. Add permission-gated mutation policies.
4. Exclude soft-deleted rows by default in `USING` clauses.

### 3.2 Example policies
```sql
alter table public.shifts enable row level security;

create policy shifts_select
on public.shifts
for select
using (
  deleted_at is null
  and is_facility_member(facility_id)
);

create policy shifts_insert
on public.shifts
for insert
with check (
  is_facility_member(facility_id)
  and has_permission(facility_id, 'scheduling.shifts.create')
);

create policy shifts_update
on public.shifts
for update
using (
  deleted_at is null
  and is_facility_member(facility_id)
)
with check (
  is_facility_member(facility_id)
  and has_permission(facility_id, 'scheduling.shifts.update')
);

create policy shifts_soft_delete
on public.shifts
for update
using (
  is_facility_member(facility_id)
)
with check (
  has_permission(facility_id, 'scheduling.shifts.delete')
  and deleted_at is not null
);
```

### 3.3 Supabase auth relationship notes
- `public.users.id` references `auth.users.id`.
- All `created_by/updated_by/deleted_by` reference `auth.users(id)`.
- Use Supabase JWT claims only for identity; authorization resolved in DB via role/permission tables.

---

## 4) Indexing Strategy

### 4.1 Baseline indexes (all tenant tables)
```sql
create index if not exists idx_employees_facility_active
  on public.employees (facility_id, status)
  where deleted_at is null;

create index if not exists idx_shifts_facility_start
  on public.shifts (facility_id, starts_at desc)
  where deleted_at is null;

create index if not exists idx_shift_assignments_facility_employee
  on public.shift_assignments (facility_id, employee_id, assignment_status)
  where deleted_at is null;

create index if not exists idx_work_orders_facility_status_priority
  on public.work_orders (facility_id, status, priority, created_at desc)
  where deleted_at is null;

create index if not exists idx_incidents_facility_occurred
  on public.incident_reports (facility_id, occurred_at desc, severity)
  where deleted_at is null;

create index if not exists idx_notifications_recipient_unsent
  on public.notifications (facility_id, recipient_user_id, status, created_at desc)
  where deleted_at is null;

create index if not exists idx_daily_submissions_facility_date
  on public.daily_report_submissions (facility_id, submitted_at desc)
  where deleted_at is null;

create index if not exists idx_tasks_facility_owner_status_due
  on public.tasks (facility_id, owner_employee_id, status, due_at)
  where deleted_at is null;
```

### 4.2 JSONB indexes
```sql
create index if not exists idx_facilities_settings_gin
  on public.facilities using gin (settings);

create index if not exists idx_reports_payload_gin
  on public.daily_report_submissions using gin (payload jsonb_path_ops);
```

### 4.3 High-scale recommendations (2,000+ facilities)
- Partition `audit_log`, `notifications`, and `daily_report_submissions` by month.
- Keep hot indexes narrow and partial (`deleted_at is null`).
- Avoid over-indexing write-heavy tables like `shift_assignments`.

---

## 5) Performance Recommendations

1. **RLS-safe query design**
   - Always filter by `facility_id` first in app queries.
   - Prefer prepared statements from Supabase clients.

2. **Soft-delete discipline**
   - Use partial unique indexes with `where deleted_at is null` where needed.
   - Archive old soft-deleted data periodically.

3. **Realtime readiness**
   - Enable realtime only on tables requiring live UX (`shifts`, `work_orders`, `incidents`, `notifications`, `tasks`).
   - Publish minimal columns to reduce websocket payload.

4. **Queue/event pattern**
   - Use an outbox table for emails/PDF exports/escalations.
   - Process with Edge Functions on schedules or webhooks.

5. **Connection and workload management**
   - Use Supabase pooled connections for API workloads.
   - Keep long-running analytics off primary OLTP paths.

6. **Vacuum/analyze and bloat control**
   - Monitor autovacuum on high-churn tables (`shift_assignments`, `notifications`, `tasks`).
   - Reindex selectively when bloat grows.

7. **Observability**
   - Track slow queries by module and facility.
   - Add request IDs to `audit_log` to correlate API requests with DB writes.

---

## Practical rollout order
1. Core identity/tenant tables + helper functions.
2. Roles/permissions + RLS for shared tables.
3. Scheduling + incidents + work orders modules.
4. Daily reports + notifications + tasks.
5. Audit + partitions + performance hardening.
