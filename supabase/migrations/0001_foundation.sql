create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists facilities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (facility_id, name)
);

create table if not exists permissions (
  code text primary key,
  description text not null
);

create table if not exists role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  facility_id uuid not null references facilities(id) on delete cascade,
  role_id uuid not null references roles(id),
  status text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (user_id, facility_id)
);

create index if not exists facilities_organization_id_idx on facilities(organization_id);
create index if not exists memberships_user_facility_idx on memberships(user_id, facility_id) where status = 'active';
create index if not exists roles_facility_id_idx on roles(facility_id);

create or replace function current_facility_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select facility_id from memberships where user_id = auth.uid() and status = 'active';
$$;

create or replace function has_permission(check_user_id uuid, check_facility_id uuid, permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from memberships m
    join role_permissions rp on rp.role_id = m.role_id
    where m.user_id = check_user_id
      and m.facility_id = check_facility_id
      and m.status = 'active'
      and rp.permission_code = permission_code
  );
$$;

alter table organizations enable row level security;
alter table facilities enable row level security;
alter table app_users enable row level security;
alter table roles enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;
alter table memberships enable row level security;

create policy "members can read their facilities" on facilities
  for select using (id in (select current_facility_ids()));

create policy "members can read facility roles" on roles
  for select using (facility_id in (select current_facility_ids()));

create policy "members can read own memberships" on memberships
  for select using (user_id = auth.uid() or facility_id in (select current_facility_ids()));

create policy "users can read themselves" on app_users
  for select using (id = auth.uid());

create policy "authenticated users can read permissions" on permissions
  for select to authenticated using (true);

create policy "members can read role permissions" on role_permissions
  for select using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and r.facility_id in (select current_facility_ids())
    )
  );
