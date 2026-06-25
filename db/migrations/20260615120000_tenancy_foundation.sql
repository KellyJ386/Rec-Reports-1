-- =============================================================================
-- 20260615120000_tenancy_foundation.sql
-- Phase 0.2 — Tenancy + identity entities, role helpers, RLS, audit.
-- Authoritative spec: CLAUDE.md §6 (DB/RLS), §5 (roles), §8 (audit). Module Spec §7.1.
--
-- Migrations are append-only (CLAUDE.md §6). Never edit this file after it has been
-- applied to a remote environment; add a new timestamped migration instead.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums (workflow/identity states — NOT admin-configurable catalogs; CLAUDE.md §3.2)
-- ---------------------------------------------------------------------------
create type facility_role as enum (
  'super_admin',      -- platform operator (RecReports staff); cross-org; not a customer role
  'org_admin',        -- manages a multi-facility organization
  'facility_manager', -- full control of one facility
  'supervisor',       -- creates/reviews reports, assigns tasks, edits schedules
  'staff'             -- creates reports, completes work, views own schedule
);

create type membership_status as enum ('active', 'inactive', 'archived');
create type lifecycle_status   as enum ('active', 'inactive', 'archived');
create type facility_type      as enum (
  'campus_rec', 'aquatic', 'fitness', 'parks_rec', 'ymca', 'multi_sport', 'other'
);

-- ---------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Core tables (tenancy chain: organization -> facility -> everything; CLAUDE.md §6)
-- ---------------------------------------------------------------------------

create table public.organization (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      lifecycle_status not null default 'active',
  plan_tier   text not null default 'core',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references auth.users(id)
);

create table public.facility (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organization(id),
  name            text not null,
  facility_type   facility_type not null default 'other',
  time_zone       text not null default 'UTC',
  operating_hours jsonb not null default '{}'::jsonb,
  logo_url        text,
  status          lifecycle_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id)
);
create index idx_facility_org on public.facility (org_id) where deleted_at is null;

-- Profile mirror of auth.users (CLAUDE.md §6). id === auth.users.id.
create table public.user_account (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  phone        text,
  display_name text,
  status       lifecycle_status not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- User <-> facility <-> role. Multi-facility access = multiple rows.
create table public.facility_membership (
  id          uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facility(id),
  user_id     uuid not null references public.user_account(id),
  role        facility_role not null,
  status      membership_status not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references auth.users(id),
  unique (facility_id, user_id)
);
create index idx_membership_user on public.facility_membership (user_id)
  where deleted_at is null;
create index idx_membership_facility on public.facility_membership (facility_id, role)
  where deleted_at is null;

-- Config catalog seeds (Phase 1 fills the rest). Included here because the conflict
-- engine's three-hop join (Module Spec §4.1.2) needs them at the foundation layer.
create table public.job_area (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references public.facility(id),
  name          text not null,
  display_order int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id),
  unique (facility_id, name)
);

create table public.cert_type (
  id                  uuid primary key default gen_random_uuid(),
  facility_id         uuid not null references public.facility(id),
  name                text not null,
  validity_days       int not null default 365,
  renewal_window_days int not null default 60,
  display_order       int not null default 0,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),
  deleted_at          timestamptz,
  deleted_by          uuid references auth.users(id),
  unique (facility_id, name)
);

create table public.job_area_required_cert (
  id           uuid primary key default gen_random_uuid(),
  facility_id  uuid not null references public.facility(id),
  job_area_id  uuid not null references public.job_area(id),
  cert_type_id uuid not null references public.cert_type(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references auth.users(id),
  unique (facility_id, job_area_id, cert_type_id)
);

-- Immutable audit trail (CLAUDE.md §8). Append-only; no customer role may edit it.
create table public.audit_event (
  id            bigserial primary key,
  facility_id   uuid,
  actor_user_id uuid,
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,
  before        jsonb,
  after         jsonb,
  request_id    text,
  created_at    timestamptz not null default now()
);
create index idx_audit_facility on public.audit_event (facility_id, created_at desc);
create index idx_audit_entity on public.audit_event (entity_type, entity_id);

-- updated_at triggers
create trigger trg_org_updated     before update on public.organization        for each row execute function public.set_updated_at();
create trigger trg_fac_updated     before update on public.facility            for each row execute function public.set_updated_at();
create trigger trg_ua_updated      before update on public.user_account        for each row execute function public.set_updated_at();
create trigger trg_mem_updated     before update on public.facility_membership for each row execute function public.set_updated_at();
create trigger trg_ja_updated      before update on public.job_area            for each row execute function public.set_updated_at();
create trigger trg_ct_updated      before update on public.cert_type           for each row execute function public.set_updated_at();
create trigger trg_jarc_updated    before update on public.job_area_required_cert for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Role helpers (CLAUDE.md §6: "single audited SQL helper current_user_role_at")
-- ---------------------------------------------------------------------------

-- Numeric rank for hierarchy comparisons (higher = more privileged). IMMUTABLE.
create or replace function public.role_rank(p_role facility_role)
returns int
language sql
immutable
as $$
  select case p_role
    when 'super_admin'      then 5
    when 'org_admin'        then 4
    when 'facility_manager' then 3
    when 'supervisor'       then 2
    when 'staff'            then 1
    else 0
  end;
$$;

-- Resolves the caller's EFFECTIVE role at a facility, folding three sources:
--   1. super_admin  — any active super_admin membership applies platform-wide.
--   2. org_admin    — applies to every facility in the same organization.
--   3. direct role  — facility_manager / supervisor / staff at that facility.
-- Returns the highest-ranked applicable role, or NULL if not a member.
--
-- SECURITY DEFINER justification (CLAUDE.md §3.6): this function reads
-- facility_membership, and the RLS policies on facility_membership call this function.
-- Running as INVOKER would recurse infinitely (policy -> function -> policy -> ...).
-- DEFINER bypasses RLS for this read only. It is read-only, STABLE, exposes no data to
-- the caller beyond a single role enum, and pins search_path to prevent hijacking.
create or replace function public.current_user_role_at(p_facility_id uuid)
returns facility_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from (
    -- super_admin: global
    select fm.role
    from public.facility_membership fm
    where fm.user_id = auth.uid()
      and fm.role = 'super_admin'
      and fm.status = 'active'
      and fm.deleted_at is null

    union all

    -- org_admin: any facility in the same org as the target
    select fm.role
    from public.facility_membership fm
    join public.facility f_member on f_member.id = fm.facility_id
    join public.facility f_target on f_target.id = p_facility_id
    where fm.user_id = auth.uid()
      and fm.role = 'org_admin'
      and fm.status = 'active'
      and fm.deleted_at is null
      and f_member.org_id = f_target.org_id

    union all

    -- direct facility roles
    select fm.role
    from public.facility_membership fm
    where fm.user_id = auth.uid()
      and fm.facility_id = p_facility_id
      and fm.status = 'active'
      and fm.deleted_at is null
  ) applicable
  order by public.role_rank(role) desc
  limit 1;
$$;

-- True if caller's effective role at the facility is at least p_min_role.
create or replace function public.has_facility_role(p_facility_id uuid, p_min_role facility_role)
returns boolean
language sql
stable
as $$
  select public.role_rank(public.current_user_role_at(p_facility_id))
       >= public.role_rank(p_min_role);
$$;

-- True if caller has any active role at the facility.
create or replace function public.is_facility_member(p_facility_id uuid)
returns boolean
language sql
stable
as $$
  select public.current_user_role_at(p_facility_id) is not null;
$$;

-- ---------------------------------------------------------------------------
-- Privilege-escalation guard + role-change audit on facility_membership
-- (CLAUDE.md §5: "cannot grant a role above their own"; §8: audit every role change)
-- ---------------------------------------------------------------------------
create or replace function public.guard_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_rank int;
begin
  -- Service-role / definer bootstrap (auth.uid() is null when no JWT, e.g. seeding or
  -- the first super_admin/org_admin provisioning) is allowed to set up initial access.
  if auth.uid() is null then
    return new;
  end if;

  actor_rank := public.role_rank(public.current_user_role_at(coalesce(new.facility_id, old.facility_id)));

  -- A member may never grant/modify a role above their own effective rank.
  if tg_op in ('INSERT', 'UPDATE') and public.role_rank(new.role) > actor_rank then
    raise exception 'role escalation blocked: cannot grant % (rank %) — actor rank %',
      new.role, public.role_rank(new.role), actor_rank;
  end if;

  -- Audit any role change (CLAUDE.md §8).
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.role is distinct from old.role) then
    insert into public.audit_event (facility_id, actor_user_id, entity_type, entity_id, action, before, after)
    values (
      new.facility_id, auth.uid(), 'facility_membership', new.id,
      case when tg_op = 'INSERT' then 'role_grant' else 'role_change' end,
      case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
      to_jsonb(new)
    );
  end if;

  return new;
end;
$$;
comment on function public.guard_membership_change() is
  'SECURITY DEFINER: enforces no-escalation and writes immutable role-change audit rows. '
  'Definer needed so the audit insert and role resolution are not blocked by RLS.';

create trigger trg_membership_guard
  before insert or update on public.facility_membership
  for each row execute function public.guard_membership_change();

-- ---------------------------------------------------------------------------
-- Row-Level Security (CLAUDE.md §3.5, §6) — enabled on EVERY table below.
-- Reads: facility members. Writes: role-gated via has_facility_role().
-- ---------------------------------------------------------------------------

alter table public.organization          enable row level security;
alter table public.facility              enable row level security;
alter table public.user_account          enable row level security;
alter table public.facility_membership   enable row level security;
alter table public.job_area              enable row level security;
alter table public.cert_type             enable row level security;
alter table public.job_area_required_cert enable row level security;
alter table public.audit_event           enable row level security;

-- organization: visible to anyone with a membership in one of its facilities.
create policy organization_select on public.organization
  for select using (
    deleted_at is null and exists (
      select 1 from public.facility f
      where f.org_id = organization.id
        and public.is_facility_member(f.id)
    )
  );
-- org create/update is an onboarding / org_admin+ action; gate updates to org_admin of
-- any facility in the org.
create policy organization_update on public.organization
  for update using (
    deleted_at is null and exists (
      select 1 from public.facility f
      where f.org_id = organization.id
        and public.has_facility_role(f.id, 'org_admin')
    )
  );

-- facility: members read; facility_manager+ update; org_admin+ create.
create policy facility_select on public.facility
  for select using (deleted_at is null and public.is_facility_member(id));
create policy facility_insert on public.facility
  for insert with check (
    exists (
      select 1 from public.facility f2
      where f2.org_id = facility.org_id
        and public.has_facility_role(f2.id, 'org_admin')
    )
  );
create policy facility_update on public.facility
  for update using (deleted_at is null and public.has_facility_role(id, 'facility_manager'))
  with check (public.has_facility_role(id, 'facility_manager'));

-- user_account: a user sees their own row; supervisors+ see accounts that share a
-- facility with them (needed to display assignees, authors, etc.).
create policy user_account_select on public.user_account
  for select using (
    id = auth.uid()
    or exists (
      select 1
      from public.facility_membership viewer
      join public.facility_membership target
        on target.facility_id = viewer.facility_id
      where viewer.user_id = auth.uid()
        and viewer.status = 'active' and viewer.deleted_at is null
        and target.user_id = user_account.id
        and public.has_facility_role(viewer.facility_id, 'supervisor')
    )
  );
create policy user_account_update_self on public.user_account
  for update using (id = auth.uid()) with check (id = auth.uid());

-- facility_membership: a user sees their own memberships; supervisor+ see all at the
-- facility. Writes require facility_manager+ (escalation guard trigger enforces the
-- "cannot grant above own rank" rule). NOTE: the first member of a brand-new facility is
-- provisioned via the service role (RLS bypassed), since no prior member exists.
create policy membership_select on public.facility_membership
  for select using (
    deleted_at is null and (
      user_id = auth.uid()
      or public.has_facility_role(facility_id, 'supervisor')
    )
  );
create policy membership_insert on public.facility_membership
  for insert with check (public.has_facility_role(facility_id, 'facility_manager'));
create policy membership_update on public.facility_membership
  for update using (public.has_facility_role(facility_id, 'facility_manager'))
  with check (public.has_facility_role(facility_id, 'facility_manager'));

-- Config tables: members read; facility_manager+ write (CLAUDE.md §5 admin-only config).
create policy job_area_select on public.job_area
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy job_area_write on public.job_area
  for all using (public.has_facility_role(facility_id, 'facility_manager'))
  with check (public.has_facility_role(facility_id, 'facility_manager'));

create policy cert_type_select on public.cert_type
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy cert_type_write on public.cert_type
  for all using (public.has_facility_role(facility_id, 'facility_manager'))
  with check (public.has_facility_role(facility_id, 'facility_manager'));

create policy jarc_select on public.job_area_required_cert
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy jarc_write on public.job_area_required_cert
  for all using (public.has_facility_role(facility_id, 'facility_manager'))
  with check (public.has_facility_role(facility_id, 'facility_manager'));

-- audit_event: read-only to supervisor+ within the facility. No customer role may
-- insert/update/delete directly — only SECURITY DEFINER triggers/functions write here.
create policy audit_select on public.audit_event
  for select using (
    facility_id is not null and public.has_facility_role(facility_id, 'supervisor')
  );
-- (No insert/update/delete policies: writes happen only via DEFINER functions.)
