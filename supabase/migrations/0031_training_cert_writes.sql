-- ===========================================================================
-- 0031_training_cert_writes.sql
-- TR-04/TR-03 (plans/TRAINING_PLAN.md): write-side RLS for
-- employee_certifications and certification_events (0003/0007). Both tables
-- have carried SELECT-only policies since they were created -- 0009 hardened
-- the employee_certifications reader policy for soft-delete, and 0007's lone
-- certification_events policy is a reader too -- so there has never been an
-- INSERT/UPDATE path for either. The BFF authenticates every request with the
-- CALLER's own JWT (not the service-role key), so the cert lifecycle routes
-- landing in this batch (issue/renew/revoke + the evidence-upload event) need
-- real policies here, not just an application-layer permission check.
--
--   * employee_certifications -- INSERT/UPDATE gated on training.manage, with
--     a join-based fn_assert_same_facility (0009) guard on BOTH FK parents
--     (certification_type_id -> certification_types, employee_id ->
--     employees) so a cross-facility cert can never be issued or retargeted,
--     mirroring 0017_cert_policy.sql's certification_role_requirements
--     policy almost exactly (same two-parent shape). Split insert/update
--     policies (not a single "for all") since there is deliberately no
--     DELETE path -- revocation is a status='revoked' UPDATE, never a row
--     deletion. UPDATE's USING carries "and deleted_at is null" (0026
--     convention); WITH CHECK is left free of that predicate for the same
--     reason 0026 documents.
--   * certification_events -- INSERT gated on training.manage, with
--     fn_assert_same_facility on employee_certification_id so an event can
--     never be attached to a cert in a different facility than the one the
--     caller has training.manage in. No UPDATE or DELETE policy at all --
--     append-only by omission, the same posture 0030_storage.sql documents
--     for storage.objects writes: with RLS enabled and no permissive policy
--     for a command, Postgres filters every row out of that command's view
--     (an effective "using (false)"), so an UPDATE/DELETE attempt affects
--     zero rows rather than raising -- there is no legitimate path that ever
--     needs to touch an event after it is written, so there is nothing to
--     carve an exception for.
--
-- Idempotency conventions (mirroring 0009-0028): drop policy if exists
-- immediately before every create policy; no other changes to policy names
-- or the permission codes they check.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- employee_certifications: insert (issue) + update (renew/revoke/correct).
-- ---------------------------------------------------------------------------
drop policy if exists "training managers can insert employee certifications" on employee_certifications;
create policy "training managers can insert employee certifications" on employee_certifications
  for insert with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'certification_types', certification_type_id)
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

drop policy if exists "training managers can update employee certifications" on employee_certifications;
create policy "training managers can update employee certifications" on employee_certifications
  for update using (has_permission(auth.uid(), facility_id, 'training.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'certification_types', certification_type_id)
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- ---------------------------------------------------------------------------
-- certification_events: insert only (append-only). No update/delete policy.
-- ---------------------------------------------------------------------------
drop policy if exists "training managers can insert certification events" on certification_events;
create policy "training managers can insert certification events" on certification_events
  for insert with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'employee_certifications', employee_certification_id)
  );
