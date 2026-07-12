-- ===========================================================================
-- 0020_has_permission_shadow_fix.sql
-- CRITICAL security fix for a name-shadowing bug in has_permission (0001).
--
-- has_permission's third parameter was named `permission_code`, identical to
-- role_permissions.permission_code. In the SQL body's final predicate
--   and rp.permission_code = permission_code
-- the unqualified right-hand `permission_code` resolves to the COLUMN in scope,
-- not the function parameter, so the predicate degrades to
--   rp.permission_code = rp.permission_code
-- which is always true for any existing row. The net effect: any active member
-- holding ANY single permission on a facility passed has_permission(..., 'X')
-- for EVERY X on that facility -- silently defeating every RLS policy and API
-- guard gated on a specific permission code (admin.manage, communications.publish,
-- training.manage, reports.submit, and so on).
--
-- Fix: reference the third parameter positionally as $3 in the predicate. $3 is
-- always the function argument and cannot be shadowed by a same-named column,
-- so the comparison binds the parameter, not role_permissions.permission_code.
-- The parameter NAME is deliberately left unchanged (renaming it would require
-- DROP FUNCTION, which would cascade-drop all ~97 RLS policies that depend on
-- has_permission), so CREATE OR REPLACE succeeds and no policy, call site, or
-- verify-migrations literal is affected.
-- ===========================================================================
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
      and rp.permission_code = $3
  );
$$;
