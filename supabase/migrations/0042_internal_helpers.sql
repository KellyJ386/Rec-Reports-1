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

-- ---------------------------------------------------------------------------
-- 7. L-2: 0042's revoke sweep above (step 5) covers the ten trigger
--    functions, but missed three OTHER public-schema functions that were
--    also added by 0040/0041 and are just as reachable as
--    /rest/v1/rpc/<name> today: fn_storage_attachment_module(text) and
--    fn_storage_attachment_facility_id(text) (pure invoker string parsers --
--    no privilege exposure either way, but inconsistent with this
--    migration's own stated goal) and fn_attachment_path_facility() (0041,
--    SECURITY DEFINER -- the same class of exposure OP-05 exists to close,
--    even though its body only touches trigger-local NEW and errors out
--    with "record \"new\" is not assigned yet" if ever called directly via
--    RPC rather than as a real BEFORE INSERT/UPDATE trigger, so this is
--    belt-and-suspenders, not a live hole).
--
--    fn_storage_attachment_module/fn_storage_attachment_facility_id are
--    deliberately left OUT of this revoke: they are invoker functions
--    referenced directly inside the storage.objects SELECT policy (0040),
--    and unlike a SECURITY DEFINER helper called through has_permission(),
--    Postgres re-checks EXECUTE on an invoker function used inside a policy
--    expression against the CALLING role every time the policy evaluates --
--    revoking authenticated's EXECUTE here would make every attachment read
--    fail with "permission denied for function fn_storage_attachment_*",
--    not just close an unused RPC path. authenticated keeps EXECUTE on
--    those two for exactly that reason; PUBLIC never had it revoked either
--    (plain `create function` grants EXECUTE to PUBLIC by default) since
--    doing so would revoke authenticated's inherited grant too on a role
--    with no separate GRANT of its own -- so PUBLIC is left alone for these
--    two specifically, and only fn_attachment_path_facility (never called
--    from a policy expression, only from CREATE TRIGGER) is revoked below.
-- ---------------------------------------------------------------------------
revoke execute on function public.fn_attachment_path_facility() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.fn_attachment_path_facility() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. H-2: make internal.* resolvable by BARE name for the duration of every
--    migration-apply session, restoring replayability of 0001-0041.
--
--    ALTER FUNCTION ... SET SCHEMA (step 2 above) preserves each moved
--    helper's OID, so the ~200 already-created policy expressions in
--    0002-0041 that reference has_permission/current_facility_ids/
--    fn_assert_same_facility/is_organization_admin/is_platform_admin
--    UNQUALIFIED keep resolving correctly the first time those files are
--    applied (that resolution happened once, at each file's own original
--    CREATE POLICY time, before the helpers ever moved). But every one of
--    those ~200 policies is written as a `drop policy if exists` /
--    `create policy` PAIR (the 0009+ idempotency convention this repo's own
--    scripts/verify-migrations.mjs enforces) -- and a REPLAY of any of
--    those files against a database that has already run this migration
--    executes the drop (which always succeeds) and then re-resolves the
--    bare helper name at the new CREATE POLICY time, by which point the
--    helper no longer lives in `public` and the session's default
--    search_path (`"$user", public`) can no longer find it: the create
--    fails, and the table is left with that policy MISSING until someone
--    notices and re-applies by hand. Confirmed against a live database
--    (re-applying 0031/0038/0040 post-0042 each throw "function
--    has_permission(...) does not exist" and leave storage.objects with
--    zero SELECT policies).
--
--    Fixed by putting `internal` on every NEW session's default
--    search_path at the database level, so a bare reference in a REPLAYED
--    0002-0041 file resolves exactly like it did the first time, with zero
--    edits to any of those ~200 policy bodies. `alter database ... set`
--    only takes effect for sessions started AFTER this runs -- the current
--    session (this migration's own) is unaffected, which is fine, since
--    nothing after this point in 0042 depends on it -- but it means any
--    verification of this fix (including the CI idempotency probe added
--    alongside this migration) must open a FRESH psql/connection to observe
--    the new search_path.
-- ---------------------------------------------------------------------------
do $$
begin
  execute format('alter database %I set search_path = public, internal', current_database());
exception
  when insufficient_privilege then
    -- A runner that does not own the database (some CI/self-hosted setups)
    -- cannot change its defaults. Supabase's `postgres` role owns the
    -- database, so production takes the happy path; elsewhere the operator
    -- must set search_path = public, internal on the database or role
    -- before replaying migrations numbered below 0042.
    raise notice '0042: could not set the database search_path (insufficient privilege); set "search_path = public, internal" on the database or migration role manually before re-applying older migrations';
end
$$;

notify pgrst, 'reload schema';
