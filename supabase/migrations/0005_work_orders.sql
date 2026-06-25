create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  asset_tag text,
  name text not null,
  location_text text,
  status text not null default 'active' check (status in ('active', 'inactive', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (facility_id, asset_tag)
);

create table if not exists work_orders (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid references departments(id),
  asset_id uuid references assets(id),
  source_type text check (source_type in ('manual', 'report', 'incident')),
  source_id uuid,
  title text not null,
  description text not null,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'on_hold', 'resolved', 'closed', 'cancelled')),
  assigned_to_employee_id uuid references employees(id),
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists work_order_updates (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  work_order_id uuid not null references work_orders(id) on delete cascade,
  update_type text not null check (update_type in ('comment', 'status_change', 'assignment_change', 'priority_change')),
  body text,
  previous_value text,
  new_value text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists work_order_attachments (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  work_order_id uuid not null references work_orders(id) on delete cascade,
  storage_path text not null,
  mime_type text not null,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists assets_facility_department_idx on assets(facility_id, department_id) where deleted_at is null;
create index if not exists work_orders_facility_status_idx on work_orders(facility_id, status, due_at) where deleted_at is null;
create index if not exists work_orders_facility_priority_idx on work_orders(facility_id, priority, created_at desc) where deleted_at is null;
create index if not exists work_orders_assignee_idx on work_orders(facility_id, assigned_to_employee_id, status) where deleted_at is null;
create index if not exists work_order_updates_facility_order_idx on work_order_updates(facility_id, work_order_id, created_at desc) where deleted_at is null;
create index if not exists work_order_attachments_facility_order_idx on work_order_attachments(facility_id, work_order_id) where deleted_at is null;

alter table assets enable row level security;
alter table work_orders enable row level security;
alter table work_order_updates enable row level security;
alter table work_order_attachments enable row level security;

create policy "work order readers can read assets" on assets for select using (has_permission(auth.uid(), facility_id, 'work_orders.read'));
create policy "work order managers can manage assets" on assets for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage')) with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));
create policy "work order readers can read work orders" on work_orders for select using (has_permission(auth.uid(), facility_id, 'work_orders.read'));
create policy "work order managers can manage work orders" on work_orders for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage')) with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));
create policy "work order readers can read updates" on work_order_updates for select using (has_permission(auth.uid(), facility_id, 'work_orders.read'));
create policy "work order managers can manage updates" on work_order_updates for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage')) with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));
create policy "work order readers can read attachments" on work_order_attachments for select using (has_permission(auth.uid(), facility_id, 'work_orders.read'));
create policy "work order managers can manage attachments" on work_order_attachments for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage')) with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));
