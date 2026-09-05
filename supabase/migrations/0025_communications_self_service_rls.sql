-- ===========================================================================
-- 0025_communications_self_service_rls.sql
-- CM-01 (plans/COMMUNICATIONS_PLAN.md): close the remaining gaps in the
-- self-service write policies 0009 gave message_receipts/message_acknowledgements.
--
-- 0009 already let an employee insert/update their OWN receipt/acknowledgement
-- row (matched via employees.user_id = auth.uid()), gated by
-- communications.read. Two gaps remained, both fixed here:
--
--   1. Facility consistency was checked only against employees.facility_id,
--      never against the parent message's facility_id. facility_id is
--      caller-supplied on insert, so a caller with communications.read on
--      Facility A could insert/update a row with facility_id = A but
--      message_id pointing at a message that actually belongs to Facility B --
--      a cross-tenant write RLS should have blocked. Closed with
--      fn_assert_same_facility(facility_id, 'messages', message_id) (0009
--      helper), the same join-based guard used against messages/templates/
--      distribution lists elsewhere (0009/0015/0016/0017/0019).
--   2. Publishers (communications.publish) had no write path onto these two
--      tables at all -- unlike every other communications table in 0006
--      (channels/messages/audiences), which grant publishers "for all". That
--      blocks a legitimate manager_override acknowledgement (or a delivery
--      correction on someone else's receipt) recorded on another employee's
--      behalf. Added as a second, additive policy per table.
--
-- Idempotent (drop policy if exists immediately precedes each create policy,
-- required from 0009 onward by scripts/verify-migrations.mjs). Existing
-- SELECT policies on both tables (0006, untouched by 0009) are left as-is.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- message_receipts: re-assert the 0009 self-service policies with the added
-- facility-consistency check against the parent message.
-- ---------------------------------------------------------------------------
drop policy if exists "employees can record their own receipts" on message_receipts;
create policy "employees can record their own receipts" on message_receipts
  for insert with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and exists (
      select 1 from employees e
      where e.id = message_receipts.employee_id
        and e.facility_id = message_receipts.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "employees can update their own receipts" on message_receipts;
create policy "employees can update their own receipts" on message_receipts
  for update using (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and exists (
      select 1 from employees e
      where e.id = message_receipts.employee_id
        and e.facility_id = message_receipts.facility_id
        and e.user_id = auth.uid()
    )
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and exists (
      select 1 from employees e
      where e.id = message_receipts.employee_id
        and e.facility_id = message_receipts.facility_id
        and e.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- message_acknowledgements: same hardening.
-- ---------------------------------------------------------------------------
drop policy if exists "employees can record their own acknowledgements" on message_acknowledgements;
create policy "employees can record their own acknowledgements" on message_acknowledgements
  for insert with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and exists (
      select 1 from employees e
      where e.id = message_acknowledgements.employee_id
        and e.facility_id = message_acknowledgements.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "employees can update their own acknowledgements" on message_acknowledgements;
create policy "employees can update their own acknowledgements" on message_acknowledgements
  for update using (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and exists (
      select 1 from employees e
      where e.id = message_acknowledgements.employee_id
        and e.facility_id = message_acknowledgements.facility_id
        and e.user_id = auth.uid()
    )
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and exists (
      select 1 from employees e
      where e.id = message_acknowledgements.employee_id
        and e.facility_id = message_acknowledgements.facility_id
        and e.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Publisher manage-level write: communications.publish holders can write any
-- employee's receipt/acknowledgement row in facilities they publish to (e.g. a
-- manager_override acknowledgement, or correcting another employee's delivery
-- receipt), still facility-consistent with the parent message. Additive to the
-- self-service policies above and the 0006 reader SELECT policy -- Postgres
-- RLS ORs permissive policies together, so publishers keep every capability
-- they already had.
-- ---------------------------------------------------------------------------
drop policy if exists "communication publishers can manage receipts" on message_receipts;
create policy "communication publishers can manage receipts" on message_receipts
  for all using (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  );

drop policy if exists "communication publishers can manage acknowledgements" on message_acknowledgements;
create policy "communication publishers can manage acknowledgements" on message_acknowledgements
  for all using (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  );
