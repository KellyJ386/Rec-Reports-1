-- 0012_rbac_admin.sql
-- Identity & Permissions (RBAC) write path (idempotent throughout).
-- roles, role_permissions, and memberships shipped SELECT-only (0001:96-115).
-- This migration turns them into an audited management surface:
--   * roles gains is_system_role/active columns (DO-block guarded)
--   * INSERT/UPDATE/DELETE policies gated on admin.manage for the row's facility,
--     with matching WITH CHECK so a write can never move a row into a facility the
--     caller does not administer. role_permissions carries no facility_id, so its
--     policies resolve the facility by joining to the parent roles row.
--   * a BEFORE DELETE trigger protects system roles from deletion
--   * the existing fn_audit_admin_change() trigger (0010) is attached to roles,
--     role_permissions, and memberships so every grant/revoke/assignment produces
--     a 'config.changed' audit row -- the DB backstop privilege grants lacked.
--   * audit_events.entity_id is relaxed to nullable so composite-key config
--     tables (role_permissions has no id column) can be audited, mirroring the
--     facility_id relaxation in 0010.
--
-- Idempotency conventions (mirroring 0009/0010/0011): drop policy/trigger if
-- exists before every create; create or replace for functions; DO-block guards
-- for ALTERs.

-- ---------------------------------------------------------------------------
-- (a) Role classification columns. is_system_role marks the seeded system roles
-- (protected from deletion below); active lets an admin retire a custom role
-- without deleting it and orphaning its audit history.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'roles'
      and column_name = 'is_system_role'
  ) then
    alter table roles add column is_system_role boolean not null default false;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'roles'
      and column_name = 'active'
  ) then
    alter table roles add column active boolean not null default true;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- (b) Relax audit_events.entity_id to nullable. role_permissions has no id
-- column (its PK is role_id + permission_code), so fn_audit_admin_change writes
-- a null entity_id for it; the audit payload still carries the full before/after
-- row (role_id + permission_code). Guarded so the migration re-runs cleanly.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'audit_events'
      and a.attname = 'entity_id'
      and a.attnotnull
  ) then
    alter table audit_events alter column entity_id drop not null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- (c) roles: admins manage the role catalog within their facility.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can insert roles" on roles;
create policy "admins can insert roles" on roles
  for insert with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can update roles" on roles;
create policy "admins can update roles" on roles
  for update using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can delete roles" on roles;
create policy "admins can delete roles" on roles
  for delete using (has_permission(auth.uid(), facility_id, 'admin.manage'));

-- ---------------------------------------------------------------------------
-- (d) role_permissions: no facility_id column, so resolve the facility by
-- joining to the parent role. A caller may only grant/revoke on roles in a
-- facility they administer.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can insert role permissions" on role_permissions;
create policy "admins can insert role permissions" on role_permissions
  for insert with check (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and has_permission(auth.uid(), r.facility_id, 'admin.manage')
    )
  );

drop policy if exists "admins can update role permissions" on role_permissions;
create policy "admins can update role permissions" on role_permissions
  for update using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and has_permission(auth.uid(), r.facility_id, 'admin.manage')
    )
  ) with check (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and has_permission(auth.uid(), r.facility_id, 'admin.manage')
    )
  );

drop policy if exists "admins can delete role permissions" on role_permissions;
create policy "admins can delete role permissions" on role_permissions
  for delete using (
    exists (
      select 1 from roles r
      where r.id = role_permissions.role_id
        and has_permission(auth.uid(), r.facility_id, 'admin.manage')
    )
  );

-- ---------------------------------------------------------------------------
-- (e) memberships: admins manage who belongs to their facility and in what role.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can insert memberships" on memberships;
create policy "admins can insert memberships" on memberships
  for insert with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can update memberships" on memberships;
create policy "admins can update memberships" on memberships
  for update using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can delete memberships" on memberships;
create policy "admins can delete memberships" on memberships
  for delete using (has_permission(auth.uid(), facility_id, 'admin.manage'));

-- ---------------------------------------------------------------------------
-- (f) Protect system roles from deletion. Seeded system roles (Tenant Owner,
-- Compliance Admin, Ops Admin, Read-Only Auditor) are shared scaffolding; an
-- admin may retire them via active=false but never delete them. errcode
-- insufficient_privilege lets callers/tests distinguish this from an ordinary
-- error, matching the append-only guard convention (0010).
-- ---------------------------------------------------------------------------
create or replace function fn_protect_system_role()
returns trigger
language plpgsql
as $$
begin
  if old.is_system_role then
    raise exception 'Role % is a system role and cannot be deleted.', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

drop trigger if exists roles_protect_system_role on roles;
create trigger roles_protect_system_role
  before delete on roles
  for each row execute function fn_protect_system_role();

-- ---------------------------------------------------------------------------
-- (g) Attach the config-change auto-audit trigger (fn_audit_admin_change from
-- 0010) to the RBAC tables. roles and memberships carry facility_id, so the
-- trigger's default branch scopes the audit row to the row's facility;
-- role_permissions carries neither id nor facility_id, so its audit row is
-- scoped null but still captures the full before/after grant in its payload.
-- ---------------------------------------------------------------------------
drop trigger if exists roles_audit_change on roles;
create trigger roles_audit_change
  after insert or update or delete on roles
  for each row execute function fn_audit_admin_change();

drop trigger if exists role_permissions_audit_change on role_permissions;
create trigger role_permissions_audit_change
  after insert or update or delete on role_permissions
  for each row execute function fn_audit_admin_change();

drop trigger if exists memberships_audit_change on memberships;
create trigger memberships_audit_change
  after insert or update or delete on memberships
  for each row execute function fn_audit_admin_change();
