-- ===========================================================================
-- 0024_advisor_hardening.sql
-- Supabase security-advisor fix: "function has a role mutable search_path".
--
-- Every trigger/helper function added by 0009+ already pins `set search_path`
-- in its header (verified across 0009, 0010, 0012's fn_audit_admin_change,
-- 0019, 0020, 0022, 0023) EXCEPT three trigger functions whose latest
-- definitions never carried a SET clause at all:
--   * fn_block_audit_mutation()              -- latest def: 0010:62
--   * fn_protect_system_role()               -- latest def: 0012:156
--   * fn_enforce_change_request_transition() -- latest def: 0014:38
-- With no SET clause, these three run with whatever search_path the calling
-- session/role has (its "role search_path"), which is what the advisor flags
-- as mutable: a role could set an unusual search_path and have it followed
-- by the function body. Pinning search_path to '' closes that off completely
-- -- more conservative than the `public` pin used elsewhere in this repo,
-- and safe here specifically because all three bodies are self-contained:
-- they only touch trigger-local pseudo-variables (new/old/tg_op/tg_table_name)
-- and now(), a pg_catalog function that resolves under an empty search_path
-- regardless (pg_catalog is always implicitly searched first, whether or not
-- it appears in search_path) -- so no identifier in any of the three bodies
-- needs schema-qualification.
--
-- This migration only adds `set search_path = ''` to each function's header;
-- every other line is copied verbatim from its latest source definition
-- (0010/0012/0014 respectively) to preserve behavior exactly. It does not
-- touch SECURITY DEFINER/INVOKER posture or any GRANT/REVOKE -- none of the
-- three is SECURITY DEFINER today, and that owner decision is out of scope
-- here (tracked separately as OP-05).
--
-- Idempotent: `create or replace function` re-applies cleanly, and none of
-- the three functions' signatures change, so every existing trigger that
-- references them by name keeps working without being re-created.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_block_audit_mutation(): BEFORE UPDATE OR DELETE trigger on audit_events /
-- incident_audit_events (attached in 0010). Body verbatim from 0010:62-70.
-- ---------------------------------------------------------------------------
create or replace function fn_block_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Audit records are append-only; % on % is not permitted.', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_protect_system_role(): BEFORE DELETE trigger on roles (attached in
-- 0012). Body verbatim from 0012:156-167.
-- ---------------------------------------------------------------------------
create or replace function fn_protect_system_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_system_role then
    raise exception 'Role % is a system role and cannot be deleted.', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_enforce_change_request_transition(): BEFORE UPDATE trigger on
-- admin_change_requests (attached in 0014). Body verbatim from 0014:38-74.
-- ---------------------------------------------------------------------------
create or replace function fn_enforce_change_request_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status = 'draft' and new.status = 'pending_review')
    or (old.status = 'pending_review' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'published')
  ) then
    raise exception 'Illegal change request transition from % to %.', old.status, new.status
      using errcode = 'insufficient_privilege';
  end if;

  if new.status in ('approved', 'rejected') then
    if new.reviewed_by is null or new.reviewed_at is null then
      raise exception 'reviewed_by and reviewed_at are required when moving a change request to %.', new.status
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.status = 'approved' and new.reviewed_by = new.requested_by then
    raise exception 'A change request cannot be self-approved (reviewed_by must differ from requested_by).'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  return new;
end;
$$;
