create table if not exists modules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null,
  default_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists organization_module_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  module_id uuid not null references modules(id) on delete cascade,
  enabled boolean not null,
  config_jsonb jsonb not null default '{}'::jsonb,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  unique (organization_id, module_id)
);

create table if not exists facility_module_overrides (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  module_id uuid not null references modules(id) on delete cascade,
  enabled boolean,
  config_patch_jsonb jsonb not null default '{}'::jsonb,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  unique (facility_id, module_id)
);

create table if not exists facility_settings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  settings_jsonb jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  published_at timestamptz,
  published_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, version)
);

create table if not exists department_settings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  department_id uuid not null references departments(id) on delete cascade,
  settings_jsonb jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  published_at timestamptz,
  published_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, version)
);

create table if not exists branding_profiles (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  name text not null,
  theme_jsonb jsonb not null default '{}'::jsonb,
  logo_path text,
  is_default boolean not null default false,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (facility_id, name)
);

create table if not exists admin_change_requests (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  entity_table text not null,
  entity_id uuid,
  change_summary text not null,
  before_jsonb jsonb not null default '{}'::jsonb,
  after_jsonb jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'approved', 'rejected', 'published')),
  requested_by uuid references app_users(id),
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organization_module_settings_org_idx on organization_module_settings(organization_id);
create index if not exists facility_module_overrides_facility_idx on facility_module_overrides(facility_id);
create index if not exists facility_settings_facility_version_idx on facility_settings(facility_id, version desc);
create index if not exists department_settings_department_version_idx on department_settings(facility_id, department_id, version desc);
create index if not exists branding_profiles_facility_idx on branding_profiles(facility_id, is_default);
create index if not exists admin_change_requests_facility_status_idx on admin_change_requests(facility_id, status, created_at desc);

alter table modules enable row level security;
alter table organization_module_settings enable row level security;
alter table facility_module_overrides enable row level security;
alter table facility_settings enable row level security;
alter table department_settings enable row level security;
alter table branding_profiles enable row level security;
alter table admin_change_requests enable row level security;

create policy "authenticated users can read module catalog" on modules for select to authenticated using (true);
create policy "admin readers can read org module settings" on organization_module_settings for select using (
  exists (
    select 1 from facilities f
    where f.organization_id = organization_module_settings.organization_id
      and has_permission(auth.uid(), f.id, 'admin.manage')
  )
);
create policy "admins can manage facility module overrides" on facility_module_overrides for all using (has_permission(auth.uid(), facility_id, 'admin.manage')) with check (has_permission(auth.uid(), facility_id, 'admin.manage'));
create policy "admins can manage facility settings" on facility_settings for all using (has_permission(auth.uid(), facility_id, 'admin.manage')) with check (has_permission(auth.uid(), facility_id, 'admin.manage'));
create policy "admins can manage department settings" on department_settings for all using (has_permission(auth.uid(), facility_id, 'admin.manage')) with check (has_permission(auth.uid(), facility_id, 'admin.manage'));
create policy "admins can manage branding profiles" on branding_profiles for all using (has_permission(auth.uid(), facility_id, 'admin.manage')) with check (has_permission(auth.uid(), facility_id, 'admin.manage'));
create policy "admins can manage change requests" on admin_change_requests for all using (has_permission(auth.uid(), facility_id, 'admin.manage')) with check (has_permission(auth.uid(), facility_id, 'admin.manage'));
