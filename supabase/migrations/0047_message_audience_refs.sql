-- ===========================================================================
-- 0047_message_audience_refs.sql
-- S-8: message_audiences.audience_ref_id is a polymorphic, unconstrained
-- (nullable, no FK) reference: `role` -> roles.id, `department` ->
-- departments.id, `shift` -> schedule_shifts.id, `employee` -> employees.id
-- (0006_communications.sql:32-41; resolved by audience_type in
-- src/lib/communications.mjs:64-90). Today's WITH CHECK
-- (0038_rls_audit_hardening.sql:409-416) only guards message_id -- a
-- communications.publish holder in Facility A can point audience_ref_id at
-- another facility's employee/department/shift/role and the row is accepted,
-- the same shape S-8's sibling migrations already closed for
-- distribution_list_members.member_ref_id (0019_review_hardening.sql:
-- 150-163) and work_order_updates/attachments (0035). This migration closes
-- it two ways, mirroring that split:
--   1. A WITH CHECK dispatch on audience_type, for every RLS-subject writer
--      (the "communication publishers can manage audiences" policy).
--   2. A BEFORE INSERT OR UPDATE trigger doing the identical per-type lookup,
--      for the service-role/worker path that bypasses RLS entirely (mirrors
--      fn_work_order_child_facility, 0035_work_order_facility_consistency.sql
--      :48-74) -- a policy predicate only ever runs for RLS-subject roles.
--
-- NULL audience_ref_id: `POST /messages/:id/audiences`
-- (src/lib/http/communications-routes.mjs:358-390) accepts
-- `audienceRefId ?? null` -- it does not require a ref today for any of the
-- four audience types, so a NULL ref is a legitimate (if currently unused by
-- any caller) row shape and both the policy and the trigger below leave it
-- alone rather than rejecting it. `resolveMessageAudience`
-- (src/lib/communications.mjs:64-90) resolves such a row to zero recipients
-- for every type, so this is inert, not a bypass -- the check is stricter
-- than "always require a ref" would be wrong to add here without also
-- changing the route's contract, which is out of scope for this migration.
--
-- Per 0042_internal_helpers.sql: has_permission and fn_assert_same_facility
-- now live in `internal` and must be referenced as internal.has_permission
-- (...) / internal.fn_assert_same_facility(...), never bare/public-qualified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. WITH CHECK dispatch, RLS-subject writers.
-- ---------------------------------------------------------------------------
drop policy if exists "communication publishers can manage audiences" on message_audiences;
create policy "communication publishers can manage audiences" on message_audiences
  for all
  using (internal.has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (
    internal.has_permission(auth.uid(), facility_id, 'communications.publish')
    and internal.fn_assert_same_facility(facility_id, 'messages', message_id)
    and (
      audience_ref_id is null
      or (audience_type = 'employee' and internal.fn_assert_same_facility(facility_id, 'employees', audience_ref_id))
      or (audience_type = 'department' and internal.fn_assert_same_facility(facility_id, 'departments', audience_ref_id))
      or (audience_type = 'shift' and internal.fn_assert_same_facility(facility_id, 'schedule_shifts', audience_ref_id))
      or (audience_type = 'role' and internal.fn_assert_same_facility(facility_id, 'roles', audience_ref_id))
    )
  );

-- ---------------------------------------------------------------------------
-- 2. BEFORE INSERT OR UPDATE trigger, the service-role/worker path. Dispatches
--    on audience_type the same way fn_assert_same_facility dispatches on
--    parent_table (dynamic SQL, since the parent table name varies by row),
--    but raises rather than returning a boolean the caller could ignore --
--    consistent with fn_work_order_child_facility's rationale for using a
--    trigger instead of folding this into a policy predicate alone: it must
--    hold no matter who, or what role, is writing.
-- ---------------------------------------------------------------------------
create or replace function fn_message_audience_ref_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_table text;
  parent_facility_id uuid;
begin
  if new.audience_ref_id is null then
    return new;
  end if;

  parent_table := case new.audience_type
    when 'employee' then 'employees'
    when 'department' then 'departments'
    when 'shift' then 'schedule_shifts'
    when 'role' then 'roles'
    else null
  end;

  -- An audience_type outside the four known values is rejected by the
  -- column's own check constraint before this trigger ever runs; this branch
  -- only guards against a future audience_type being added here without a
  -- matching parent_table entry.
  if parent_table is null then
    raise exception 'message_audiences.audience_type % has no known parent table for audience_ref_id', new.audience_type
      using errcode = 'check_violation';
  end if;

  execute format('select facility_id from %I where id = $1', parent_table)
    into parent_facility_id
    using new.audience_ref_id;

  if parent_facility_id is null or parent_facility_id <> new.facility_id then
    raise exception 'message_audiences.audience_ref_id must belong to the same facility as audience_type %', new.audience_type
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists message_audiences_ref_facility_consistency on message_audiences;
create trigger message_audiences_ref_facility_consistency
  before insert or update on message_audiences
  for each row execute function fn_message_audience_ref_facility();

-- Same OP-05 posture 0042 gave the other trigger functions: EXECUTE is
-- checked at CREATE TRIGGER time, not at fire time, so this does not affect
-- the trigger just created above -- it only closes direct-RPC reachability.
revoke execute on function fn_message_audience_ref_facility() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_message_audience_ref_facility() from anon;
  end if;
end
$$;
