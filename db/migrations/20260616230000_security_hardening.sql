-- =============================================================================
-- 20260616230000_security_hardening.sql
-- Phase 6.1 — fixes for findings from the security audit (see SECURITY_AUDIT.md).
-- Append-only migration (CLAUDE.md §6).
-- =============================================================================

-- [HIGH] F-1: views run with the view OWNER's rights by default, which BYPASSES RLS on the
-- underlying tables. staff_certification_status must enforce the querying user's RLS so it
-- cannot leak another facility's certifications. (Postgres 15+ security_invoker.)
alter view public.staff_certification_status set (security_invoker = on);

-- [MEDIUM] F-2: sop_version was readable by any facility member regardless of the parent
-- SOP's visibility_role. Gate it through the parent SOP (whose own RLS encodes visibility).
drop policy if exists sop_version_select on public.sop_version;
create policy sop_version_select on public.sop_version
  for select using (
    exists (select 1 from public.sop s where s.id = sop_version.sop_id)
  );

-- [MEDIUM] F-3: pin search_path on SECURITY INVOKER helpers used inside RLS policies to
-- prevent search_path-hijack ambiguity (the DEFINER functions were already pinned).
alter function public.role_rank(public.facility_role)            set search_path = public, pg_temp;
alter function public.has_facility_role(uuid, public.facility_role) set search_path = public, pg_temp;
alter function public.is_facility_member(uuid)                   set search_path = public, pg_temp;
alter function public.can_read_report(uuid, text)                set search_path = public, pg_temp;
alter function public.can_write_report(uuid, text)               set search_path = public, pg_temp;
alter function public.cert_computed_status(date, int)            set search_path = public, pg_temp;
alter function public.set_updated_at()                           set search_path = public, pg_temp;
alter function public.set_report_child_facility()                set search_path = public, pg_temp;

-- [LOW] F-6: audit EOD submit/lock as a report state change (CLAUDE.md §8). The injury /
-- incident state machine is already audited via guard_report_state; extend coverage to EOD.
create or replace function public.audit_eod_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.audit_event (facility_id, actor_user_id, entity_type, entity_id, action, before, after)
    values (new.facility_id, auth.uid(), 'eod_report', new.id, 'status_change', to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;
comment on function public.audit_eod_state() is
  'SECURITY DEFINER: writes immutable audit rows for EOD status changes (CLAUDE.md §8).';

create trigger eod_report_audit
  after update on public.eod_report
  for each row execute function public.audit_eod_state();
