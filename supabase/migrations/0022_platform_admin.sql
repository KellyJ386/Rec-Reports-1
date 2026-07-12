-- ===========================================================================
-- 0022_platform_admin.sql
-- Platform-level cross-organization super-admin scope (deferred item from the
-- admin control center plan, now needed as the platform takes on multiple
-- tenants).
--
-- Design: a `platform_admins` roster (service-role provisioned, like org
-- provisioning in 0009) plus an `is_platform_admin(user)` primitive, folded
-- into the two scope helpers every policy already calls:
--
--   * current_facility_ids() -- platform admins see every facility, so all
--     membership-based read policies extend to them without per-table edits.
--   * has_permission(...)    -- platform admins pass every permission check,
--     so all ~97 permission-gated policies extend to them without edits.
--
-- Both helpers are redefined with CREATE OR REPLACE and their exact existing
-- signatures. Changing either signature would require DROP FUNCTION, which
-- cascade-drops every dependent RLS policy (see 0020's header) -- do not do
-- that. has_permission keeps the positional $3 predicate from 0020 (the
-- parameter name `permission_code` still shadows the column).
--
-- Provisioning is deliberately service-role-only: there are NO client write
-- policies on platform_admins. Granting platform scope is an operator action,
-- never something an in-app admin can do to themselves.
-- ===========================================================================

create table if not exists platform_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists platform_admins_user_idx on platform_admins(user_id);

alter table platform_admins enable row level security;

create or replace function is_platform_admin(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from platform_admins pa
    where pa.user_id = check_user_id
  );
$$;

-- Platform admins may read the roster (who else holds platform scope); nobody
-- else can see it, and no client role can write it.
drop policy if exists "platform admins can read the platform roster" on platform_admins;
create policy "platform admins can read the platform roster" on platform_admins
  for select using (is_platform_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- current_facility_ids: platform admins are in scope for every facility, so
-- every `... in (select current_facility_ids())` read policy covers them.
-- Signature unchanged (see header).
-- ---------------------------------------------------------------------------
create or replace function current_facility_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select facility_id from memberships where user_id = auth.uid() and status = 'active'
  union
  select id from facilities where is_platform_admin(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- has_permission: platform admins pass every check. Signature unchanged and
-- the $3 positional predicate from 0020 is preserved (the third parameter's
-- name still shadows role_permissions.permission_code).
-- ---------------------------------------------------------------------------
create or replace function has_permission(check_user_id uuid, check_facility_id uuid, permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_platform_admin(check_user_id) or exists (
    select 1
    from memberships m
    join role_permissions rp on rp.role_id = m.role_id
    where m.user_id = check_user_id
      and m.facility_id = check_facility_id
      and m.status = 'active'
      and rp.permission_code = $3
  );
$$;
