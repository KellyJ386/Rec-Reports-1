-- =============================================================================
-- 20260616181000_user_provisioning.sql
-- Phase 1.3 — auto-provision the public.user_account mirror when an auth user is created
-- (email signup or admin invite). MODULE_SPEC.md §5.3.
--
-- Append-only migration (CLAUDE.md §6).
-- =============================================================================

-- SECURITY DEFINER justification (CLAUDE.md §3.6): runs in the auth.users insert path
-- (no end-user JWT) and must write public.user_account regardless of RLS. Idempotent.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_account (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
comment on function public.handle_new_user() is
  'Mirrors auth.users -> public.user_account on signup/invite. SECURITY DEFINER (auth path).';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Strengthen the membership escalation guard: in addition to "cannot grant a role above
-- your own rank", a manager must not be able to MODIFY a membership whose current role
-- already outranks them (e.g. a facility_manager demoting an org_admin). create-or-replace
-- supersedes the Phase 0 version (append-only — CLAUDE.md §6).
-- ---------------------------------------------------------------------------
create or replace function public.guard_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_rank int;
begin
  -- Bootstrap (no JWT: seeding / first super_admin or org_admin provisioning) is allowed.
  if auth.uid() is null then
    return new;
  end if;

  actor_rank := public.role_rank(public.current_user_role_at(coalesce(new.facility_id, old.facility_id)));

  -- Cannot modify a membership whose current role outranks you.
  if tg_op = 'UPDATE' and old.role is not null and public.role_rank(old.role) > actor_rank then
    raise exception 'forbidden: target membership role % outranks actor (rank %)',
      old.role, actor_rank;
  end if;

  -- Cannot grant/modify to a role above your own rank.
  if tg_op in ('INSERT', 'UPDATE') and public.role_rank(new.role) > actor_rank then
    raise exception 'role escalation blocked: cannot grant % (rank %) — actor rank %',
      new.role, public.role_rank(new.role), actor_rank;
  end if;

  -- Audit any role change (CLAUDE.md §8).
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.role is distinct from old.role) then
    insert into public.audit_event (facility_id, actor_user_id, entity_type, entity_id, action, before, after)
    values (
      new.facility_id, auth.uid(), 'facility_membership', new.id,
      case when tg_op = 'INSERT' then 'role_grant' else 'role_change' end,
      case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
      to_jsonb(new)
    );
  end if;

  return new;
end;
$$;
