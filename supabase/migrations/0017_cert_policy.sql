-- 0017_cert_policy.sql
-- Certification policy -- design 3.7 (idempotent throughout).
-- Gives the Phase 5 scheduling.certEnforcementMode registry key a real backing
-- table, plus a small policy/cadence layer:
--   * certification_role_requirements -- "role R at facility F requires cert C"
--                                        with an optional per-requirement
--                                        enforcement_mode override
--   * certification_policies          -- trigger/cadence/action rules (expiry,
--                                        assignment, schedule) with a jsonb body
--
-- Reads are open to any facility member; writes are gated on the EXISTING
-- 'training.manage' code from the 16-code catalog (cert governance lives with
-- training). Both tables carry fn_audit_admin_change (0010) so config mutations
-- land in the append-only audit trail like every other admin config table.
--
-- certification_role_requirements references two facility-scoped parents
-- (certification_types, roles); both are protected with a join-based WITH CHECK
-- via fn_assert_same_facility (0009) so a cross-facility requirement cannot be
-- injected.
--
-- Idempotency conventions (mirroring 0009-0016): drop policy/trigger if exists
-- before every create; create table/index if not exists.

-- ---------------------------------------------------------------------------
-- (a) certification_role_requirements -- which certification a role must hold.
-- enforcement_mode is NULLABLE on purpose: a NULL means "defer to the facility's
-- scheduling.certEnforcementMode registry setting" (see cert-policy.mjs
-- effectiveEnforcementMode); a non-null value ('hard-block'|'warning') overrides
-- it for this specific requirement. required_level names how strong the
-- requirement is (default 'required').
-- ---------------------------------------------------------------------------
create table if not exists certification_role_requirements (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  certification_type_id uuid not null references certification_types(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  required_level text not null default 'required',
  enforcement_mode text check (enforcement_mode in ('hard-block', 'warning')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, certification_type_id, role_id)
);

-- ---------------------------------------------------------------------------
-- (b) certification_policies -- trigger/cadence/action rules. trigger_type keys
-- the lifecycle moment (expiry reminder cadence, assignment-time gating,
-- schedule-publish gating); cadence_rule_jsonb / action_jsonb carry the shape
-- (e.g. {"daysBefore":[30,7,1]} and {"notify":"distribution_list",...}).
-- ---------------------------------------------------------------------------
create table if not exists certification_policies (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  trigger_type text not null check (trigger_type in ('expiry', 'assignment', 'schedule')),
  cadence_rule_jsonb jsonb not null default '{}'::jsonb,
  action_jsonb jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cert_role_requirements_role_idx
  on certification_role_requirements(facility_id, role_id) where active;
create index if not exists cert_role_requirements_type_idx
  on certification_role_requirements(facility_id, certification_type_id) where active;
create index if not exists certification_policies_facility_idx
  on certification_policies(facility_id, trigger_type) where active;

alter table certification_role_requirements enable row level security;
alter table certification_policies enable row level security;

-- Reads: any facility member. Writes: training.manage on the row's facility,
-- plus facility consistency for both FK parents.
drop policy if exists "members can read cert role requirements" on certification_role_requirements;
create policy "members can read cert role requirements" on certification_role_requirements
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "training managers can manage cert role requirements" on certification_role_requirements;
create policy "training managers can manage cert role requirements" on certification_role_requirements
  for all using (has_permission(auth.uid(), facility_id, 'training.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'certification_types', certification_type_id)
    and fn_assert_same_facility(facility_id, 'roles', role_id)
  );

drop policy if exists "members can read certification policies" on certification_policies;
create policy "members can read certification policies" on certification_policies
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "training managers can manage certification policies" on certification_policies;
create policy "training managers can manage certification policies" on certification_policies
  for all using (has_permission(auth.uid(), facility_id, 'training.manage'))
  with check (has_permission(auth.uid(), facility_id, 'training.manage'));

drop trigger if exists cert_role_requirements_audit_change on certification_role_requirements;
create trigger cert_role_requirements_audit_change
  after insert or update or delete on certification_role_requirements
  for each row execute function fn_audit_admin_change();

drop trigger if exists certification_policies_audit_change on certification_policies;
create trigger certification_policies_audit_change
  after insert or update or delete on certification_policies
  for each row execute function fn_audit_admin_change();
