-- ===========================================================================
-- 0036_training_progress_writes.sql
-- TR-06 (plans/TRAINING_PLAN.md): write-side RLS for training_progress
-- (0007). Since 0007, training_progress has carried only the two policies
-- every training table got there -- a training.read SELECT and a
-- training.manage "for all" -- so there has never been a write path for the
-- employee the progress row is actually about. The new
-- POST /training-assignments/:id/modules/:moduleId/progress route (TR-06)
-- authenticates with the CALLER's own JWT (not the service-role key), so a
-- self-service progress write needs a real policy here, not just an
-- application-layer permission check -- the same gap 0025 closed for
-- message_receipts/message_acknowledgements and 0031 closed for
-- employee_certifications.
--
--   * Self-service INSERT/UPDATE gated on training.read (matching the read
--     policy's permission code -- an employee working through their own
--     assigned training needs to be able to see it, not manage everyone
--     else's), restricted to the row's OWN employee via a join from
--     training_assignments to employees (assignment_id ->
--     training_assignments.employee_id -> employees.id, employees.user_id =
--     auth.uid()), mirroring 0025's employees.user_id = auth.uid() shape.
--   * fn_assert_same_facility(facility_id, 'training_assignments',
--     assignment_id) and fn_assert_same_facility(facility_id,
--     'course_modules', module_id) block cross-facility FK injection on
--     both parents, mirroring 0031's two-parent shape for
--     employee_certifications (certification_type_id + employee_id).
--   * training.manage keeps its existing "for all" override from 0007
--     (untouched here) -- a manager can still write/correct any employee's
--     progress row in facilities they manage. The self-service policies
--     below are additive (Postgres RLS ORs permissive policies together).
--
-- No DELETE policy for self-service: an employee corrects a progress row by
-- re-upserting (unique(assignment_id, module_id) backs the upsert), never by
-- deleting it. training.manage's "for all" still covers a manager-initiated
-- delete if one is ever needed.
--
-- Idempotency conventions (mirroring 0009-0031): drop policy if exists
-- immediately before every create policy.
-- ===========================================================================

drop policy if exists "employees can record their own training progress" on training_progress;
create policy "employees can record their own training progress" on training_progress
  for insert with check (
    has_permission(auth.uid(), facility_id, 'training.read')
    and fn_assert_same_facility(facility_id, 'training_assignments', assignment_id)
    and fn_assert_same_facility(facility_id, 'course_modules', module_id)
    and exists (
      select 1 from training_assignments ta
      join employees e on e.id = ta.employee_id
      where ta.id = training_progress.assignment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "employees can update their own training progress" on training_progress;
create policy "employees can update their own training progress" on training_progress
  for update using (
    has_permission(auth.uid(), facility_id, 'training.read')
    and exists (
      select 1 from training_assignments ta
      join employees e on e.id = ta.employee_id
      where ta.id = training_progress.assignment_id
        and e.user_id = auth.uid()
    )
  ) with check (
    has_permission(auth.uid(), facility_id, 'training.read')
    and fn_assert_same_facility(facility_id, 'training_assignments', assignment_id)
    and fn_assert_same_facility(facility_id, 'course_modules', module_id)
    and exists (
      select 1 from training_assignments ta
      join employees e on e.id = ta.employee_id
      where ta.id = training_progress.assignment_id
        and e.user_id = auth.uid()
    )
  );
