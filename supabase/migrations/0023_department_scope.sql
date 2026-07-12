-- ===========================================================================
-- 0023_department_scope.sql
-- Department-level permission scoping (the called-out decision point deferred
-- by the admin control center plan, now required for department-level
-- delegation).
--
-- Model: memberships gain a NULLABLE department_id. NULL (every pre-existing
-- row) means the membership is facility-wide and behaves exactly as before; a
-- non-null department_id narrows the membership's PERMISSIONS to that
-- department. Narrowing applies to permission checks only -- a
-- department-scoped member is still a facility member for member-level reads
-- (current_facility_ids is unchanged on purpose), because delegation is about
-- admin writes, not about hiding the facility they work in.
--
-- Scope semantics:
--   * has_permission(user, facility, code)              -- 3-arg, unchanged
--     signature: now true only via FACILITY-WIDE memberships (department_id
--     is null) or the platform bypass (0022). A department-scoped membership
--     no longer passes facility-scope checks: that is the entire point of
--     narrowing, and no existing row is affected because they all have NULL.
--   * has_permission(user, facility, department, code)  -- NEW 4-arg overload
--     for department-scoped rows: true via a facility-wide membership, a
--     membership scoped to that same department, or the platform bypass.
--
-- The 3-arg function keeps its exact signature (CREATE OR REPLACE -- see
-- 0020/0022 headers for why a signature change is forbidden) and its $3
-- positional predicate. The 4-arg overload names its last parameter
-- permission_code too, so it references it positionally as $4 for the same
-- shadowing reason. Overload resolution keeps every existing 3-arg policy
-- call unambiguous.
--
-- Department-scoped policies land where rows actually carry a department:
-- department_settings switches to the 4-arg check, so a department-scoped
-- admin.manage membership can manage its own department's settings and
-- nothing else. Facility-wide admins keep managing all of them.
-- ===========================================================================

alter table memberships
  add column if not exists department_id uuid references departments(id) on delete set null;

create index if not exists memberships_department_idx
  on memberships(department_id)
  where department_id is not null;

-- Integrity: a membership's department must belong to the membership's own
-- facility (cross-facility department grants would silently scope to another
-- tenant's tree). Enforced by trigger so every write path is covered.
create or replace function fn_membership_department_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  department_facility_id uuid;
begin
  if new.department_id is null then
    return new;
  end if;
  select facility_id into department_facility_id from departments where id = new.department_id;
  if department_facility_id is null or department_facility_id <> new.facility_id then
    raise exception 'membership department must belong to the membership facility'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists memberships_department_facility on memberships;
create trigger memberships_department_facility
  before insert or update on memberships
  for each row execute function fn_membership_department_facility();

-- ---------------------------------------------------------------------------
-- 3-arg has_permission: facility scope now requires a facility-wide
-- membership (department_id is null). Signature unchanged; platform bypass
-- (0022) and the $3 positional predicate (0020) preserved.
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
      and m.department_id is null
      and rp.permission_code = $3
  );
$$;

-- ---------------------------------------------------------------------------
-- 4-arg overload for department-scoped rows: facility-wide membership OR a
-- membership scoped to exactly this department (positional $4 -- the last
-- parameter's name shadows role_permissions.permission_code, same as $3 in
-- the 3-arg form).
-- ---------------------------------------------------------------------------
create or replace function has_permission(check_user_id uuid, check_facility_id uuid, check_department_id uuid, permission_code text)
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
      and (m.department_id is null or m.department_id = check_department_id)
      and rp.permission_code = $4
  );
$$;

-- ---------------------------------------------------------------------------
-- department_settings: the one shipped table whose rows carry a department.
-- Department-scoped admin.manage now manages its own department's settings.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can manage department settings" on department_settings;
create policy "admins can manage department settings" on department_settings
  for all
  using (has_permission(auth.uid(), facility_id, department_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, department_id, 'admin.manage'));
