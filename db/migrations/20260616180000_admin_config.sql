-- =============================================================================
-- 20260616180000_admin_config.sql
-- Phase 1.1 — Admin Control Center config tables, RLS, and per-facility seed defaults.
-- Spec: MODULE_SPEC.md §5.1. Admin-first: modules read catalog values from here
-- (CLAUDE.md §3.2 — never hardcoded in app code). All config tables are facility-scoped
-- with RLS: read = members, write = facility_manager+ (CLAUDE.md §5).
--
-- Append-only migration (CLAUDE.md §6) — do not edit after applying to remote.
-- =============================================================================

-- Module cutoffs / engine toggles (e.g. EOD auto-lock time, conflict Warn->Block flags)
-- live in facility.settings (MODULE_SPEC.md §5.1 "Facility configuration").
alter table public.facility add column settings jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Uniform catalog tables. Identical shape: a named, orderable, toggleable value list
-- scoped to a facility. Generated in a loop to keep the migration DRY and consistent;
-- each gets the standard RLS (members read, facility_manager+ write) + updated_at trigger.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  catalogs text[] := array[
    'area',                -- physical locations
    'incident_category',
    'task_category',
    'count_type',
    'count_area',
    'form_category',
    'sop_category',
    'erp_scenario_type',
    'erp_response_level',
    'work_order_category',
    'position_type',
    'asset_type',
    'recipient_group'
  ];
begin
  foreach t in array catalogs loop
    execute format($f$
      create table public.%1$I (
        id            uuid primary key default gen_random_uuid(),
        facility_id   uuid not null references public.facility(id),
        name          text not null,
        description   text,
        display_order int not null default 0,
        active        boolean not null default true,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        created_by    uuid references auth.users(id),
        deleted_at    timestamptz,
        deleted_by    uuid references auth.users(id),
        unique (facility_id, name)
      );
      alter table public.%1$I enable row level security;
      create index %1$s_facility_idx on public.%1$I (facility_id, display_order)
        where deleted_at is null;
      create trigger %1$s_updated before update on public.%1$I
        for each row execute function public.set_updated_at();
      create policy %1$s_select on public.%1$I
        for select using (deleted_at is null and public.is_facility_member(facility_id));
      create policy %1$s_write on public.%1$I
        for all using (public.has_facility_role(facility_id, 'facility_manager'))
        with check (public.has_facility_role(facility_id, 'facility_manager'));
    $f$, t);
  end loop;
end $$;

-- severity_level is per-module (MODULE_SPEC.md §5.1) and ordered by weight.
create table public.severity_level (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references public.facility(id),
  module        text not null default 'general',  -- 'general' | 'injury' | 'incident' | ...
  name          text not null,
  weight        int not null default 0,            -- higher = more severe
  display_order int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  unique (facility_id, module, name)
);
alter table public.severity_level enable row level security;
create index severity_level_facility_idx
  on public.severity_level (facility_id, module, weight) where deleted_at is null;
create trigger severity_level_updated before update on public.severity_level
  for each row execute function public.set_updated_at();
create policy severity_level_select on public.severity_level
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy severity_level_write on public.severity_level
  for all using (public.has_facility_role(facility_id, 'facility_manager'))
  with check (public.has_facility_role(facility_id, 'facility_manager'));

-- ---------------------------------------------------------------------------
-- provision_facility_defaults(): seeds a NEW facility's config catalogs with the
-- sensible defaults from MODULE_SPEC.md §5.1. This is the seed (data lives in a
-- migration/function, not app code — CLAUDE.md §3.2). Called during facility onboarding.
--
-- SECURITY DEFINER justification (CLAUDE.md §3.6): runs at provisioning time, possibly by
-- an org_admin who is not yet a facility_manager of the brand-new facility, so it must
-- insert config rows without tripping the facility_manager write policies. It is gated:
-- only the bootstrap path (auth.uid() is null) or a facility_manager+/org_admin of the
-- facility may run it, and it only ever writes rows for the passed facility_id.
-- ---------------------------------------------------------------------------
create or replace function public.provision_facility_defaults(p_facility_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null
     and not public.has_facility_role(p_facility_id, 'facility_manager') then
    raise exception 'not authorized to provision defaults for facility %', p_facility_id;
  end if;

  -- area
  insert into public.area (facility_id, name, display_order) values
    (p_facility_id, 'Front Desk', 1), (p_facility_id, 'Pool', 2),
    (p_facility_id, 'Gym Floor', 3), (p_facility_id, 'Locker Room', 4),
    (p_facility_id, 'Field', 5), (p_facility_id, 'Office', 6),
    (p_facility_id, 'Other', 99)
  on conflict do nothing;

  -- severity levels (general, used by injury + incident unless overridden per module)
  insert into public.severity_level (facility_id, module, name, weight, display_order) values
    (p_facility_id, 'general', 'Low', 1, 1),
    (p_facility_id, 'general', 'Medium', 2, 2),
    (p_facility_id, 'general', 'High', 3, 3),
    (p_facility_id, 'general', 'Critical', 4, 4)
  on conflict do nothing;

  insert into public.incident_category (facility_id, name, display_order) values
    (p_facility_id, 'Slip/Fall', 1), (p_facility_id, 'Equipment', 2),
    (p_facility_id, 'Behavioral', 3), (p_facility_id, 'Security', 4),
    (p_facility_id, 'Facility', 5), (p_facility_id, 'Other', 99)
  on conflict do nothing;

  insert into public.task_category (facility_id, name, display_order) values
    (p_facility_id, 'Cleaning', 1), (p_facility_id, 'Maintenance', 2),
    (p_facility_id, 'Safety', 3), (p_facility_id, 'Setup/Teardown', 4),
    (p_facility_id, 'Admin', 5)
  on conflict do nothing;

  insert into public.count_type (facility_id, name, display_order) values
    (p_facility_id, 'Headcount', 1), (p_facility_id, 'Entries', 2),
    (p_facility_id, 'Equipment Checkout', 3)
  on conflict do nothing;

  insert into public.count_area (facility_id, name, display_order) values
    (p_facility_id, 'Front Desk', 1), (p_facility_id, 'Pool', 2),
    (p_facility_id, 'Gym Floor', 3), (p_facility_id, 'Courts', 4)
  on conflict do nothing;

  insert into public.form_category (facility_id, name, display_order) values
    (p_facility_id, 'Opening', 1), (p_facility_id, 'Closing', 2),
    (p_facility_id, 'Inspection', 3), (p_facility_id, 'Safety', 4),
    (p_facility_id, 'Maintenance', 5)
  on conflict do nothing;

  insert into public.sop_category (facility_id, name, display_order) values
    (p_facility_id, 'Aquatics', 1), (p_facility_id, 'Fitness', 2),
    (p_facility_id, 'Front Desk', 3), (p_facility_id, 'Emergency', 4),
    (p_facility_id, 'Facility', 5)
  on conflict do nothing;

  insert into public.erp_scenario_type (facility_id, name, display_order) values
    (p_facility_id, 'Medical Emergency', 1), (p_facility_id, 'Fire', 2),
    (p_facility_id, 'Severe Weather', 3), (p_facility_id, 'Active Threat', 4),
    (p_facility_id, 'Chemical Spill', 5), (p_facility_id, 'Evacuation', 6)
  on conflict do nothing;

  insert into public.erp_response_level (facility_id, name, display_order) values
    (p_facility_id, 'Level 1 — Monitor', 1), (p_facility_id, 'Level 2 — Respond', 2),
    (p_facility_id, 'Level 3 — Evacuate', 3)
  on conflict do nothing;

  insert into public.work_order_category (facility_id, name, display_order) values
    (p_facility_id, 'HVAC', 1), (p_facility_id, 'Plumbing', 2),
    (p_facility_id, 'Electrical', 3), (p_facility_id, 'Structural', 4),
    (p_facility_id, 'Equipment', 5), (p_facility_id, 'Grounds', 6)
  on conflict do nothing;

  insert into public.position_type (facility_id, name, display_order) values
    (p_facility_id, 'Lifeguard', 1), (p_facility_id, 'Front Desk Attendant', 2),
    (p_facility_id, 'Fitness Instructor', 3), (p_facility_id, 'Supervisor', 4),
    (p_facility_id, 'Maintenance Tech', 5)
  on conflict do nothing;

  insert into public.asset_type (facility_id, name, display_order) values
    (p_facility_id, 'HVAC Unit', 1), (p_facility_id, 'Pump', 2),
    (p_facility_id, 'Treadmill', 3), (p_facility_id, 'Scoreboard', 4),
    (p_facility_id, 'Pool Filter', 5), (p_facility_id, 'Vehicle', 6)
  on conflict do nothing;

  insert into public.recipient_group (facility_id, name, display_order) values
    (p_facility_id, 'All Staff', 1), (p_facility_id, 'Supervisors', 2),
    (p_facility_id, 'Aquatics Team', 3), (p_facility_id, 'Fitness Team', 4)
  on conflict do nothing;

  -- job areas (drive required certs for scheduling — MODULE_SPEC.md §4.1.2)
  insert into public.job_area (facility_id, name, display_order) values
    (p_facility_id, 'Lifeguard', 1), (p_facility_id, 'Front Desk', 2),
    (p_facility_id, 'Fitness Floor', 3), (p_facility_id, 'Maintenance', 4),
    (p_facility_id, 'Supervisor', 5)
  on conflict do nothing;

  -- cert types
  insert into public.cert_type (facility_id, name, validity_days, renewal_window_days, display_order) values
    (p_facility_id, 'CPR/AED', 730, 60, 1),
    (p_facility_id, 'First Aid', 730, 60, 2),
    (p_facility_id, 'Lifeguard', 365, 60, 3)
  on conflict do nothing;

  -- Lifeguard job area requires all three certs (three-hop join target).
  insert into public.job_area_required_cert (facility_id, job_area_id, cert_type_id)
  select p_facility_id, ja.id, ct.id
  from public.job_area ja
  join public.cert_type ct
    on ct.facility_id = p_facility_id and ct.name in ('CPR/AED', 'First Aid', 'Lifeguard')
  where ja.facility_id = p_facility_id and ja.name = 'Lifeguard'
  on conflict do nothing;
end;
$$;
comment on function public.provision_facility_defaults(uuid) is
  'Seeds a new facility''s admin config catalogs (MODULE_SPEC.md §5.1). SECURITY DEFINER '
  'so onboarding (org_admin / service role) can seed before facility_manager rights exist; '
  'gated to facility_manager+ or the null-uid bootstrap path; writes only the given facility.';
