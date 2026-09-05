-- ===========================================================================
-- 0042_internal_helpers.sql
-- OP-05: move the security-definer scope/permission primitives off the
-- PostgREST-exposed `public` schema and into a new `internal` schema that
-- PostgREST never serves, then lock EXECUTE down to `authenticated` (and
-- `service_role`, where it exists) only.
--
-- Facts this migration relies on:
--   * 15 SECURITY DEFINER functions live in `public` today. PostgREST
--     exposes every function in every schema on its search path as
--     /rest/v1/rpc/<name>; nothing in `src/` calls any of them via rpc, so
--     every one of these 15 is reachable by any authenticated (or anon, on a
--     real Supabase project) caller for no functional reason.
--   * RLS policy expressions store the RESOLVED FUNCTION OID at CREATE
--     POLICY time, not the qualified name. `ALTER FUNCTION ... SET SCHEMA`
--     changes the function's schema in place without dropping/recreating it,
--     so its OID is unchanged and every one of the ~200 existing policies
--     that reference these six helpers keeps working with zero policy edits.
--     (Verified empirically after applying: see the pg_get_expr check in the
--     slice notes.)
--   * has_permission (both overloads, 0020/0022/0023) and
--     current_facility_ids (0009/0022) are `language sql` bodies that call
--     is_platform_admin(...) UNQUALIFIED, under `set search_path = public`.
--     Moving is_platform_admin to `internal` without re-pointing that
--     search_path breaks every permission check silently (the function still
--     resolves and returns, it just can never find is_platform_admin and
--     every policy check errors as "function is_platform_admin does not
--     exist" -- caught immediately by the RLS suite, but only if it's run).
--     Every one of the six moved functions gets its search_path repointed to
--     `internal, public` below so unqualified references inside their own
--     bodies (and any future ones) resolve without schema-qualifying every
--     call site by hand.
--   * The ten SECURITY DEFINER/INVOKER trigger functions listed below are
--     never meant to be called directly -- they only ever run via
--     `CREATE TRIGGER ... EXECUTE FUNCTION`, and Postgres checks EXECUTE
--     privilege on the trigger function at CREATE TRIGGER time, not at fire
--     time (the RLS suite proves the fire-time behavior is unaffected).
--     They stay in `public` (dropping/recreating to move schema would risk
--     detaching them from their triggers for no benefit -- the exposure this
--     migration closes is direct RPC invocation, not trigger execution), but
--     lose EXECUTE from `public`/`authenticated` so they can no longer be
--     invoked as /rest/v1/rpc/<name>.
--   * fn_report_template_version_immutable (0028) is the one trigger
--     function of the ten with NO `set search_path` at all -- the remaining
--     "function search_path mutable" advisor finding. Pinned here.
--   * CI's bootstrap (scripts/ci/rls-bootstrap-pre.sql) creates neither
--     `anon` nor `service_role` -- only `authenticated`. Every anon/
--     service_role grant or revoke below is guarded by an existence check so
--     this migration applies cleanly in CI and on a real Supabase project
--     alike.
--
-- Future migrations: reference these six helpers as internal.has_permission
-- (...), internal.current_facility_ids(), internal.fn_assert_same_facility
-- (...), internal.is_organization_admin(...), internal.is_platform_admin(...)
-- -- never bare/`public.`-qualified. scripts/verify-migrations.mjs enforces
-- this for every migration numbered >= 0043.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The internal schema. Nothing in it is reachable by PostgREST's default
--    exposed-schemas config (only `public`, and whatever an operator opts
--    in), and PUBLIC gets no privileges on it at all.
-- ---------------------------------------------------------------------------
create schema if not exists internal;

revoke all on schema internal from public;
grant usage on schema internal to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema internal to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Move the six scope/permission primitives. SET SCHEMA preserves the
--    function's OID, so every existing policy expression that already
--    resolved to it keeps resolving to the same function -- no policy is
--    touched by this migration.
-- ---------------------------------------------------------------------------
alter function public.current_facility_ids() set schema internal;
alter function public.has_permission(uuid, uuid, text) set schema internal;
alter function public.has_permission(uuid, uuid, uuid, text) set schema internal;
alter function public.fn_assert_same_facility(uuid, text, uuid) set schema internal;
alter function public.is_organization_admin(uuid, uuid) set schema internal;
alter function public.is_platform_admin(uuid) set schema internal;

-- ---------------------------------------------------------------------------
-- 3. Mandatory: repoint each moved function's own search_path so unqualified
--    references inside its body keep resolving. has_permission (both
--    overloads) and current_facility_ids call is_platform_admin(...)
--    unqualified; without this they raise "function is_platform_admin(uuid)
--    does not exist" the instant they're invoked after the move.
-- ---------------------------------------------------------------------------
alter function internal.current_facility_ids() set search_path = internal, public;
alter function internal.has_permission(uuid, uuid, text) set search_path = internal, public;
alter function internal.has_permission(uuid, uuid, uuid, text) set search_path = internal, public;
alter function internal.fn_assert_same_facility(uuid, text, uuid) set search_path = internal, public;
alter function internal.is_organization_admin(uuid, uuid) set search_path = internal, public;
alter function internal.is_platform_admin(uuid) set search_path = internal, public;

-- ---------------------------------------------------------------------------
-- 4. Lock down EXECUTE on everything now living in `internal`: PUBLIC and
--    anon (where it exists) get nothing, authenticated and service_role
--    (where it exists) get execute. Plain `create function` already grants
--    EXECUTE to PUBLIC by default, which is exactly the implicit exposure
--    this migration is closing -- the explicit revoke below removes it.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema internal from public;
grant execute on all functions in schema internal to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on all functions in schema internal from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on all functions in schema internal to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Trigger functions stay in `public` (they're wired to CREATE TRIGGER,
--    not called from policy expressions or app code) but lose direct-RPC
--    reachability: EXECUTE is checked at CREATE TRIGGER time, not at fire
--    time, so revoking it here does not affect any existing trigger.
-- ---------------------------------------------------------------------------
revoke execute on function public.fn_block_audit_mutation() from public, authenticated;
revoke execute on function public.fn_audit_admin_change() from public, authenticated;
revoke execute on function public.fn_protect_system_role() from public, authenticated;
revoke execute on function public.fn_audit_chain_link() from public, authenticated;
revoke execute on function public.fn_enforce_change_request_transition() from public, authenticated;
revoke execute on function public.fn_membership_department_facility() from public, authenticated;
revoke execute on function public.fn_report_template_version_immutable() from public, authenticated;
revoke execute on function public.fn_report_template_active_version_published() from public, authenticated;
revoke execute on function public.fn_report_submission_audit() from public, authenticated;
revoke execute on function public.fn_work_order_child_facility() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.fn_block_audit_mutation() from anon;
    revoke execute on function public.fn_audit_admin_change() from anon;
    revoke execute on function public.fn_protect_system_role() from anon;
    revoke execute on function public.fn_audit_chain_link() from anon;
    revoke execute on function public.fn_enforce_change_request_transition() from anon;
    revoke execute on function public.fn_membership_department_facility() from anon;
    revoke execute on function public.fn_report_template_version_immutable() from anon;
    revoke execute on function public.fn_report_template_active_version_published() from anon;
    revoke execute on function public.fn_report_submission_audit() from anon;
    revoke execute on function public.fn_work_order_child_facility() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. fn_report_template_version_immutable (0028) is the one trigger function
--    of the ten above that has never carried a `set search_path` -- the
--    remaining "function search_path mutable" advisor finding. Its body
--    (verbatim from 0028) only touches trigger-local pseudo-variables
--    (old/new) and raises via errcode, so `public` alone is a safe pin: no
--    identifier in the body needs any other schema.
-- ---------------------------------------------------------------------------
alter function public.fn_report_template_version_immutable() set search_path = public;

notify pgrst, 'reload schema';
