-- ===========================================================================
-- 0035_work_order_facility_consistency.sql
-- WO-08 finding: a probe added to supabase/tests/work_orders_scope.sql proved
-- (verified empirically against a live Postgres 16 instance) that a
-- work_orders.manage holder scoped to Facility A can INSERT a
-- work_order_updates row that claims facility_id = A (their own permitted
-- facility) while work_order_id points at a work order that actually belongs
-- to Facility B. The same shape applies to work_order_attachments. Two
-- independent reasons this slips through today:
--
--   1. The "work order managers can manage updates"/"...manage attachments"
--      WITH CHECK (0005, untouched by 0026) only verifies the ACTOR's own
--      work_orders.manage permission on the facility_id the row claims -- it
--      never compares that facility_id against the parent work_orders row's
--      facility_id, unlike work_orders' OWN manage policy, which since 0013
--      has carried fn_assert_same_facility(facility_id, 'assets', asset_id).
--   2. Foreign key constraint enforcement in Postgres runs with the
--      privileges of the constraint's owning role (the table owner), which
--      bypasses RLS on the referenced table by default -- so the plain
--      work_order_id FK does not, by itself, require the inserting role to
--      be able to SEE the referenced work order, only that it exist.
--
-- This is a data-integrity invariant (a child row must agree with its own
-- parent), not an authorization question -- the same distinction 0023 drew
-- when it added fn_membership_department_facility as a BEFORE INSERT OR
-- UPDATE TRIGGER rather than folding the check into a WITH CHECK clause: a
-- trigger fires for every write regardless of the connecting role (including
-- a future service-role/background-job caller that bypasses RLS entirely),
-- while a policy predicate only ever runs for RLS-subject roles. This
-- migration mirrors that pattern rather than 0009/0013's
-- fn_assert_same_facility-in-WITH-CHECK idiom, specifically because the
-- invariant must hold no matter who -- or what role -- is writing.
--
-- fn_work_order_child_facility(): generic BEFORE INSERT OR UPDATE trigger
-- function for any table shaped like (facility_id, work_order_id); raises
-- check_violation when the child row's facility_id disagrees with its parent
-- work_orders row's facility_id. Applied to work_order_updates and
-- work_order_attachments -- the two work_orders child tables that carry both
-- columns (work_orders itself references assets/departments/employees, not
-- another work_orders row, so it is out of scope here; those FKs are the
-- JS-level responsibility WO-09 took on, since the DB affords no home for a
-- symmetric trigger there without inventing a self-referential shape).
--
-- Idempotent (mirroring 0009/0023/0026): create-or-replace the function,
-- drop-if-exists then create each trigger.
-- ===========================================================================

create or replace function fn_work_order_child_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_facility_id uuid;
begin
  select facility_id into parent_facility_id from work_orders where id = new.work_order_id;
  if parent_facility_id is null or parent_facility_id <> new.facility_id then
    raise exception 'work order child row facility_id must match its parent work order facility_id'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists work_order_updates_facility_consistency on work_order_updates;
create trigger work_order_updates_facility_consistency
  before insert or update on work_order_updates
  for each row execute function fn_work_order_child_facility();

drop trigger if exists work_order_attachments_facility_consistency on work_order_attachments;
create trigger work_order_attachments_facility_consistency
  before insert or update on work_order_attachments
  for each row execute function fn_work_order_child_facility();
