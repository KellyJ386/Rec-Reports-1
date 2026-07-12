-- 0011_org_tree_writes.sql
-- Org-tree write path for the admin control center (idempotent throughout).
-- departments, employees, and certification_types shipped SELECT-only (0002/0003
-- read policies, hardened for soft-delete in 0009). This migration:
--   * adds INSERT/UPDATE/DELETE policies gated on admin.manage for the row's
--     facility, with matching WITH CHECK so a write can never move a row into a
--     facility the caller does not administer
--   * attaches the existing fn_audit_admin_change() trigger (0010) to each table
--     so every create/rename/soft-delete produces a 'config.changed' audit row
--
-- Idempotency conventions (mirroring 0009/0010): drop policy/trigger if exists
-- before every create.

-- ---------------------------------------------------------------------------
-- departments: admins manage the department tree within their facility.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can insert departments" on departments;
create policy "admins can insert departments" on departments
  for insert with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can update departments" on departments;
create policy "admins can update departments" on departments
  for update using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can delete departments" on departments;
create policy "admins can delete departments" on departments
  for delete using (has_permission(auth.uid(), facility_id, 'admin.manage'));

-- ---------------------------------------------------------------------------
-- employees: admins manage the employee roster within their facility.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can insert employees" on employees;
create policy "admins can insert employees" on employees
  for insert with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can update employees" on employees;
create policy "admins can update employees" on employees
  for update using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can delete employees" on employees;
create policy "admins can delete employees" on employees
  for delete using (has_permission(auth.uid(), facility_id, 'admin.manage'));

-- ---------------------------------------------------------------------------
-- certification_types: admins manage the certification catalog per facility.
-- ---------------------------------------------------------------------------
drop policy if exists "admins can insert certification types" on certification_types;
create policy "admins can insert certification types" on certification_types
  for insert with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can update certification types" on certification_types;
create policy "admins can update certification types" on certification_types
  for update using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can delete certification types" on certification_types;
create policy "admins can delete certification types" on certification_types
  for delete using (has_permission(auth.uid(), facility_id, 'admin.manage'));

-- ---------------------------------------------------------------------------
-- Attach the config-change auto-audit trigger (fn_audit_admin_change from 0010)
-- to each org-tree table. These tables carry facility_id, so the trigger's
-- default branch scopes the audit row to the row's facility.
-- ---------------------------------------------------------------------------
drop trigger if exists departments_audit_change on departments;
create trigger departments_audit_change
  after insert or update or delete on departments
  for each row execute function fn_audit_admin_change();

drop trigger if exists employees_audit_change on employees;
create trigger employees_audit_change
  after insert or update or delete on employees
  for each row execute function fn_audit_admin_change();

drop trigger if exists certification_types_audit_change on certification_types;
create trigger certification_types_audit_change
  after insert or update or delete on certification_types
  for each row execute function fn_audit_admin_change();
