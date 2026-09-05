-- ===========================================================================
-- 0032_incident_amendment_hardening.sql
-- IN-04 (plans/INCIDENTS_PLAN.md): closes a real RLS gap on incident_amendments.
--
-- Audit method: every migration touching incident_amendments was traced from
-- its creation forward. 0004_incidents.sql:96-105 creates the table and
-- enables RLS (0004:121); 0004:134 adds exactly one policy -- a SELECT,
-- "incident readers can read amendments", gated on incidents.read. No
-- subsequent migration (0009-0031, verified by grep across every file in
-- supabase/migrations/) ever adds an INSERT, UPDATE, or DELETE policy for
-- incident_amendments, and it was never attached to fn_block_audit_mutation
-- (that trigger was only ever wired to audit_events and incident_audit_events
-- in 0010_audit_backbone.sql:72-80).
--
-- Net effect before this migration: incident_amendments has RLS enabled with
-- a SELECT-only policy, so under RLS (any role other than the table owner /
-- service-role, which bypasses RLS entirely) INSERT is unconditionally
-- denied -- not because a policy blocks it, but because Postgres denies any
-- command with zero applicable permissive policies. There is today no
-- client-reachable path -- authenticated or otherwise -- to write an
-- amendment row at all; POST /incidents/:id/amendments (IN-04) would fail at
-- the database layer for every caller, including an incidents.manage holder,
-- the moment it tried to INSERT. This is a genuine gap, not a
-- defense-in-depth belt-and-suspenders case: without this migration the
-- amendments feature is inert under RLS.
--
-- This migration adds:
--   (a) an INSERT policy, gated on incidents.manage OR incidents.review --
--       matching POST /incidents/:id/amendments' HTTP-layer guard exactly
--       (src/lib/http/incidents-routes.mjs) -- plus fn_assert_same_facility
--       (0009) on incident_id, closing the same cross-tenant FK-injection
--       path 0009/0013/0017/etc. close for every other incident_* table's
--       write policy: a caller who holds the permission at facility A can
--       never point incident_id at a row that actually belongs to facility B
--       (or a mismatched facility_id/incident_id pair within their own
--       reach).
--   (b) an explicit append-only guard (BEFORE UPDATE OR DELETE trigger),
--       reusing fn_block_audit_mutation (0010, already generic on
--       tg_table_name) rather than duplicating its body. This is NOT
--       covering a gap the RLS-by-omission argument above already leaves
--       (with no UPDATE/DELETE policy, RLS already denies both under normal
--       operation for every non-owner role) -- it is defense-in-depth so the
--       append-only guarantee holds by construction even against a stray
--       future permissive UPDATE/DELETE policy, matching the load-bearing
--       precedent (incident_audit_events itself carries both the trigger AND
--       relies on no UPDATE/DELETE policy existing) rather than leaving
--       incident_amendments as the one audit-adjacent table protected by
--       omission alone.
--
-- Idempotency conventions (mirroring 0009-0031): drop policy/trigger if
-- exists before every create; create or replace for functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) INSERT policy: incidents.manage OR incidents.review, with
-- fn_assert_same_facility guarding incident_id against cross-tenant
-- injection. No UPDATE/DELETE policy is added -- amendments are append-only
-- by design (before/after snapshots that must never themselves be edited).
-- ---------------------------------------------------------------------------
drop policy if exists "incident managers can write amendments" on incident_amendments;
create policy "incident managers can write amendments" on incident_amendments
  for insert with check (
    (
      has_permission(auth.uid(), facility_id, 'incidents.manage')
      or has_permission(auth.uid(), facility_id, 'incidents.review')
    )
    and fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

-- ---------------------------------------------------------------------------
-- (b) Append-only guard, reusing fn_block_audit_mutation (0010:62-70,
-- search_path pinned in 0024:33-42) verbatim -- no redefinition needed, it
-- already raises generically off tg_table_name/tg_op.
-- ---------------------------------------------------------------------------
drop trigger if exists incident_amendments_block_mutation on incident_amendments;
create trigger incident_amendments_block_mutation
  before update or delete on incident_amendments
  for each row execute function fn_block_audit_mutation();
