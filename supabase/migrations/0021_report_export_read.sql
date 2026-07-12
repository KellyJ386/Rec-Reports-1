-- ===========================================================================
-- 0021_report_export_read.sql
-- Make the dedicated reports.export permission functional on its own.
--
-- The generic export route (workflow-routes.mjs) authorizes report_submissions
-- export on 'reports.export', but report_submissions' SELECT RLS is gated only
-- on 'reports.read'. Every other exportable table maps its export code to the
-- same code its SELECT policy requires; report_submissions is the lone divergence.
-- While has_permission was always-true (pre-0020) this was masked; now that it
-- is strict, a role holding only 'reports.export' passes the route guard but is
-- filtered to zero rows by RLS, silently returning an empty (header-only) export.
--
-- Fix: allow report_submissions SELECT for holders of EITHER 'reports.read' OR
-- 'reports.export', so the export permission is meaningful in isolation while
-- read access is unchanged for reports.read holders. Idempotent (drop-before-create).
-- ===========================================================================
drop policy if exists "report readers can read submissions" on report_submissions;
create policy "report readers can read submissions" on report_submissions
  for select using (
    (
      has_permission(auth.uid(), facility_id, 'reports.read')
      or has_permission(auth.uid(), facility_id, 'reports.export')
    )
    and deleted_at is null
  );
