-- ===========================================================================
-- 0045_read_and_audit_policies.sql
-- S-6: audit forgery, HR/certification reads, org-admin semantics.
--
-- Ground rule (0042_internal_helpers.sql): current_facility_ids,
-- has_permission, fn_assert_same_facility, is_organization_admin and
-- is_platform_admin now live in schema `internal`, which PostgREST never
-- exposes. ALTER FUNCTION ... SET SCHEMA preserved their OIDs, so every
-- policy created BEFORE 0042 that referenced them unqualified keeps working
-- without edits. Any NEW `create policy` written from here on must call them
-- schema-qualified (`internal.has_permission(...)`, etc.) because CREATE
-- POLICY resolves the name against search_path at parse time, and `internal`
-- is not on it by default.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (1) Audit forgery: audit_events accepts no client-side INSERT at all.
--
-- 0019_review_hardening.sql tightened the audit_events INSERT policy from
-- "any member" to "admin.manage / org-admin", reasoning that legitimate
-- writes all flow through fn_audit_admin_change() (0010), a SECURITY DEFINER
-- trigger that bypasses RLS entirely -- so a client-facing INSERT policy on
-- audit_events was never load-bearing for any real write path, only for
-- forgery: an admin.manage holder (or org admin) could still hand-craft an
-- audit_events row with an arbitrary event_type/payload/actor and have it
-- accepted, because WITH CHECK only constrains which facility/org the row
-- claims to belong to, not its content.
--
-- Confirmed before this drop (grep across src/lib/http, src/lib/admin,
-- src/lib/*.mjs): nothing in the app calls pgInsert(client, "audit_events",
-- ...) or otherwise POSTs to audit_events directly. Every write is one of:
--   * fn_audit_admin_change() (0010/0018), attached to every admin/config
--     table (facilities, departments, employees, roles, feature_flag_rules,
--     tenant_subscriptions, ...), SECURITY DEFINER, bypasses RLS.
--   * fn_audit_chain_link() (0013), the BEFORE INSERT hash-chain trigger,
--     runs regardless of which policy let the INSERT through.
-- (incident_audit_events is a separate table with its own, unchanged, INSERT
-- policy -- owned by the incidents-routes.mjs work in this same wave, not
-- touched here.)
--
-- Dropping this policy with nothing to replace it leaves audit_events with
-- RLS enabled and zero permissive INSERT policies for `authenticated`, so
-- Postgres denies every client-side INSERT by default (42501,
-- insufficient_privilege) -- including from an admin.manage holder -- while
-- the definer triggers, which bypass RLS, are completely unaffected.
drop policy if exists "admins can write audit events" on audit_events;

-- ---------------------------------------------------------------------------
-- (2) HR/certification reads (0009_rls_hardening.sql:133-143 shape).
--
-- employee_certifications carries real HR data (issue/expiry dates, evidence
-- paths) tied to one specific employee. Today ANY facility member can read
-- ANY employee's certification rows (facility_id in current_facility_ids()),
-- which is broader than necessary: a training.read holder legitimately needs
-- facility-wide visibility (compliance dashboards, gap reports), but a plain
-- member should only ever see their OWN certifications -- which is exactly
-- what the wallet route (training-routes.mjs, GET
-- /facilities/:facilityId/employee-certifications with no ?employeeId=) already
-- relies on: it only asserts facility membership at the app layer and lets
-- RLS narrow the result set to the caller's own employee row. The self-read
-- clause below is what keeps that route working -- without it, a
-- non-training.read caller's own wallet would come back empty.
drop policy if exists "members can read employee certifications" on employee_certifications;
create policy "members can read employee certifications" on employee_certifications
  for select using (
    (
      internal.has_permission(auth.uid(), facility_id, 'training.read')
      or exists (
        select 1 from employees e
        where e.id = employee_certifications.employee_id and e.user_id = auth.uid()
      )
    )
    and deleted_at is null
  );

-- certification_types is left UNCHANGED (still the 0009 member-readable
-- policy: facility_id in (select current_facility_ids()) and deleted_at is
-- null -- that policy predates 0042 and its function reference still
-- resolves by preserved OID, so no recreate is needed here). Decision: types
-- are a facility's catalog of certification kinds ("CPR", "Fire Safety", ...)
-- with no employee-identifying or otherwise sensitive fields -- they are not
-- personal data, and every module that lists certification types for a
-- picker/dropdown (scheduling, training UI) does so for any facility member,
-- not just training.read holders. Tightening this table would break those
-- pickers for no privacy benefit, so it stays broadly member-readable.
--
-- employees is likewise left UNCHANGED (still facility_id in
-- current_facility_ids(), i.e. any facility member). The schedule board
-- (GET /facilities/:facilityId/shift-assignments and friends) reads employees
-- to render names against shifts for every member who can see the schedule,
-- not just those holding a dedicated employees-read permission that does not
-- exist in the permission catalog; RLS has no column-level projection, so
-- there is no way to expose only the "safe" columns (name) while hiding HR
-- fields (employee_no) to a subset of members without either adding a new
-- permission code (out of scope for this migration) or duplicating the table.
-- Documented here per the S-6 plan note rather than changed.

-- ---------------------------------------------------------------------------
-- (3) requireOrgAdmin -> organization_admins row (SQL side needs no change).
--
-- src/lib/http/guard.mjs's pre-0019 requireOrgAdmin/requireAuthOrgAdmin
-- (admin.manage on ANY one facility of the org implies org-wide authority)
-- was the JS mirror of the SQL is_organization_admin rule 0019 REMOVED
-- (0019_review_hardening.sql:120-137: is_organization_admin now requires an
-- explicit organization_admins row). The SQL side already enforces the
-- correct rule via internal.is_organization_admin and the "org members can
-- read org admins" policy below (0009_rls_hardening.sql:73-77, unchanged --
-- any member of the org may read that org's organization_admins rows, which
-- is what lets guard.mjs's new requireAuthOrgAdminRow query it under the
-- caller's own client and get a real 0-or-1-row answer instead of an RLS
-- error). This migration makes no schema change for (3); the fix is entirely
-- in src/lib/http/guard.mjs (requireAuthOrgAdminRow) and its call sites in
-- src/lib/http/admin-routes.mjs and src/lib/http/billing-routes.mjs.
