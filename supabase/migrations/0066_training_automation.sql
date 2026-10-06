-- ===========================================================================
-- 0066_training_automation.sql
-- Wave 3, Slice 3F: TR-09 (certification-rule / role-rule auto-assignment),
-- TR-10 (incident-triggered corrective training), TR-11 (certification expiry
-- evaluator) -- plans/TRAINING_PLAN.md.
--
-- TR-09 -- training_assignment_rules: "employees who hold role R" (role
-- rule) or "employees with a certification gap for type C" (certification
-- rule, optionally narrowed to a role) get course X. The evaluator
-- (src/lib/training-auto-assign.mjs, drain key trainingAutoAssign) runs under
-- the service role and inserts training_assignments rows with source_type
-- 'role_rule' / 'certification_rule' and source_ref_id = the rule id, so the
-- EXISTING 0007 unique (employee_id, course_id, source_type, source_ref_id)
-- is the (employee, course, rule) idempotency key. Because the evaluator
-- bypasses RLS, fn_training_assignment_rule_guard enforces "never across
-- facilities" for EVERY writer: a rule-sourced assignment must name a real
-- rule of its own facility whose type and course match, for an employee and
-- course of that same facility.
--
-- TR-10 builds ON 0058's incident_training_triggers (triggers are recorded
-- for any incident manager/reviewer and become assignments only for training
-- managers; that route is untouched). This migration adds:
--   * a narrow additive SELECT policy so a training.manage holder (who need
--     not hold incidents.read) can see pending triggers;
--   * incident_training_trigger_conversions: one row per converted trigger
--     (UNIQUE(trigger_id)) linking it to its training_assignments row. The
--     conversion route is idempotent through that unique key AND through the
--     assignment's own (employee, course, 'incident_rule', trigger id) key,
--     and the audit trail is the fn_audit_admin_change trigger on this table.
--
-- TR-11 -- training_cert_notices: the evaluator's CLAIM ledger. Before the
-- evaluator emits an expiry event/notification for (certification, kind,
-- lead days, expiry date) it inserts the claim row (unique -> exactly once);
-- a failure after the claim deletes it again so the next pass retries
-- (the work-order-sla-scan claim-revert pattern). Written only by the
-- service role: no authenticated INSERT/UPDATE/DELETE policy exists.
-- notification_jobs is NOT touched -- 0058's incident-scoped INSERT policy is
-- not widened and its dedupe_key trigger (which would collapse every cert
-- notice of one recipient into one key) is deliberately not used; the
-- evaluator runs service-role and dedupes through this ledger.
--
-- Idempotency conventions (mirroring 0009-0065): create table if not exists,
-- drop-policy-if-exists immediately before every create policy, split
-- per-operation policies, definer functions carry `set search_path = public`
-- with EXECUTE revoked from public/authenticated (anon guarded), every
-- internal.* helper call schema-qualified.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) training_assignment_rules (TR-09)
-- ---------------------------------------------------------------------------
create table if not exists training_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  rule_type text not null check (rule_type in ('certification', 'role')),
  certification_type_id uuid references certification_types(id),
  role_id uuid references roles(id),
  course_id uuid not null references courses(id),
  gap_statuses text[] not null default array['missing', 'expired', 'expiring']::text[],
  due_days integer check (due_days is null or (due_days >= 1 and due_days <= 365)),
  active boolean not null default true,
  last_evaluated_at timestamptz,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint training_assignment_rules_shape check (
    (rule_type = 'certification' and certification_type_id is not null)
    or (rule_type = 'role' and role_id is not null and certification_type_id is null)
  ),
  constraint training_assignment_rules_gap_statuses check (
    cardinality(gap_statuses) > 0
    and gap_statuses <@ array['missing', 'expired', 'expiring']::text[]
  )
);

create unique index if not exists training_assignment_rules_identity_uidx
  on training_assignment_rules (
    facility_id,
    rule_type,
    coalesce(certification_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(role_id, '00000000-0000-0000-0000-000000000000'::uuid),
    course_id
  );
create index if not exists training_assignment_rules_active_idx
  on training_assignment_rules(active, last_evaluated_at nulls first);

alter table training_assignment_rules enable row level security;

drop policy if exists "training readers can read assignment rules" on training_assignment_rules;
create policy "training readers can read assignment rules" on training_assignment_rules
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.read'));

drop policy if exists "training managers can create assignment rules" on training_assignment_rules;
create policy "training managers can create assignment rules" on training_assignment_rules
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'certification_types', certification_type_id)
    and internal.fn_assert_same_facility(facility_id, 'roles', role_id)
    and internal.fn_assert_same_facility(facility_id, 'courses', course_id)
  );

drop policy if exists "training managers can update assignment rules" on training_assignment_rules;
create policy "training managers can update assignment rules" on training_assignment_rules
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'certification_types', certification_type_id)
    and internal.fn_assert_same_facility(facility_id, 'roles', role_id)
    and internal.fn_assert_same_facility(facility_id, 'courses', course_id)
  );

drop policy if exists "training managers can delete assignment rules" on training_assignment_rules;
create policy "training managers can delete assignment rules" on training_assignment_rules
  for delete
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

drop trigger if exists training_assignment_rules_audit_change on training_assignment_rules;
create trigger training_assignment_rules_audit_change
  after insert or update or delete on training_assignment_rules
  for each row execute function fn_audit_admin_change();

-- Guard on the EXISTING training_assignments table (no policy is re-created):
-- rule-sourced assignments are only ever valid when they point at a real rule
-- of the same facility, for an employee and course of that facility.
create or replace function fn_training_assignment_rule_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule training_assignment_rules%rowtype;
  v_employee_facility uuid;
  v_course_facility uuid;
begin
  if new.source_type not in ('role_rule', 'certification_rule') then
    return new;
  end if;

  -- Guard 1: an automatic assignment must name the rule that produced it.
  if new.source_ref_id is null then
    raise exception 'a % assignment must carry its rule id in source_ref_id', new.source_type
      using errcode = 'check_violation';
  end if;

  select * into v_rule from training_assignment_rules where id = new.source_ref_id;
  -- Guard 2: the rule must exist in the assignment's own facility.
  if not found or v_rule.facility_id <> new.facility_id then
    raise exception 'assignment rule % does not exist in facility %', new.source_ref_id, new.facility_id
      using errcode = 'check_violation';
  end if;

  -- Guard 3: the rule's type and course must match the assignment.
  if (new.source_type = 'role_rule' and v_rule.rule_type <> 'role')
     or (new.source_type = 'certification_rule' and v_rule.rule_type <> 'certification')
     or v_rule.course_id <> new.course_id then
    raise exception 'assignment does not match rule %', new.source_ref_id
      using errcode = 'check_violation';
  end if;

  -- Guard 4: employee and course must belong to the assignment's facility
  -- (this trigger also binds the RLS-bypassing service-role evaluator).
  select facility_id into v_employee_facility from employees where id = new.employee_id;
  select facility_id into v_course_facility from courses where id = new.course_id;
  if v_employee_facility is distinct from new.facility_id or v_course_facility is distinct from new.facility_id then
    raise exception 'rule assignment crosses facilities' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists training_assignments_rule_guard on training_assignments;
create trigger training_assignments_rule_guard
  before insert or update of facility_id, employee_id, course_id, source_type, source_ref_id on training_assignments
  for each row execute function fn_training_assignment_rule_guard();

revoke execute on function fn_training_assignment_rule_guard() from public, authenticated;

-- ---------------------------------------------------------------------------
-- (b) TR-10: incident_training_trigger_conversions + manager read access.
-- ---------------------------------------------------------------------------
-- Additive SELECT for training managers (0058's own two policies on
-- incident_training_triggers are not touched). Without it a training.manage
-- holder lacking incidents.read could never see the triggers they are
-- supposed to convert.
drop policy if exists "training managers can read incident training triggers" on incident_training_triggers;
create policy "training managers can read incident training triggers" on incident_training_triggers
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

create table if not exists incident_training_trigger_conversions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  trigger_id uuid not null references incident_training_triggers(id) on delete cascade,
  assignment_id uuid not null references training_assignments(id) on delete cascade,
  converted_by uuid references app_users(id),
  converted_at timestamptz not null default now(),
  unique (trigger_id)
);

create index if not exists incident_training_trigger_conversions_facility_idx
  on incident_training_trigger_conversions(facility_id);

alter table incident_training_trigger_conversions enable row level security;

drop policy if exists "training managers can read trigger conversions" on incident_training_trigger_conversions;
create policy "training managers can read trigger conversions" on incident_training_trigger_conversions
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

drop policy if exists "training managers can create trigger conversions" on incident_training_trigger_conversions;
create policy "training managers can create trigger conversions" on incident_training_trigger_conversions
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'training.manage')
    and internal.fn_assert_same_facility(facility_id, 'incident_training_triggers', trigger_id)
    and internal.fn_assert_same_facility(facility_id, 'training_assignments', assignment_id)
  );

-- A conversion links a trigger to the incident_rule assignment created FROM
-- that trigger, for the same employee -- nothing else.
create or replace function fn_trigger_conversion_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trigger_employee uuid;
  v_assignment_employee uuid;
  v_assignment_source text;
  v_assignment_ref uuid;
begin
  select employee_id into v_trigger_employee from incident_training_triggers where id = new.trigger_id;
  select employee_id, source_type, source_ref_id
    into v_assignment_employee, v_assignment_source, v_assignment_ref
    from training_assignments where id = new.assignment_id;
  -- Guard 1: the assignment must be the incident_rule assignment for THIS trigger.
  if v_assignment_source is distinct from 'incident_rule' or v_assignment_ref is distinct from new.trigger_id then
    raise exception 'assignment % is not the incident_rule assignment for trigger %', new.assignment_id, new.trigger_id
      using errcode = 'check_violation';
  end if;
  -- Guard 2: ...and for the employee the trigger names.
  if v_assignment_employee is distinct from v_trigger_employee then
    raise exception 'assignment employee does not match the trigger employee' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists incident_training_trigger_conversions_guard on incident_training_trigger_conversions;
create trigger incident_training_trigger_conversions_guard
  before insert on incident_training_trigger_conversions
  for each row execute function fn_trigger_conversion_guard();

revoke execute on function fn_trigger_conversion_guard() from public, authenticated;

drop trigger if exists incident_training_trigger_conversions_audit_change on incident_training_trigger_conversions;
create trigger incident_training_trigger_conversions_audit_change
  after insert or update or delete on incident_training_trigger_conversions
  for each row execute function fn_audit_admin_change();

-- ---------------------------------------------------------------------------
-- (c) TR-11: training_cert_notices -- the expiry evaluator's claim ledger.
-- ---------------------------------------------------------------------------
create table if not exists training_cert_notices (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_certification_id uuid not null references employee_certifications(id) on delete cascade,
  notice_kind text not null check (notice_kind in ('expiring', 'expired')),
  lead_days integer not null default 0 check (lead_days >= 0),
  cert_expires_at date not null,
  created_at timestamptz not null default now(),
  unique (employee_certification_id, notice_kind, lead_days, cert_expires_at)
);

create index if not exists training_cert_notices_facility_idx
  on training_cert_notices(facility_id, created_at desc);

alter table training_cert_notices enable row level security;

drop policy if exists "training managers can read cert notices" on training_cert_notices;
create policy "training managers can read cert notices" on training_cert_notices
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'training.manage'));

-- Cross-facility rows are impossible even for the service role: the notice's
-- facility must equal its certification's facility.
create or replace function fn_cert_notice_facility_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_facility uuid;
begin
  select facility_id into v_facility from employee_certifications where id = new.employee_certification_id;
  -- Guard 1: the notice's facility is its certification's facility.
  if v_facility is distinct from new.facility_id then
    raise exception 'cert notice facility does not match the certification facility' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists training_cert_notices_facility_guard on training_cert_notices;
create trigger training_cert_notices_facility_guard
  before insert on training_cert_notices
  for each row execute function fn_cert_notice_facility_guard();

revoke execute on function fn_cert_notice_facility_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_training_assignment_rule_guard() from anon;
    revoke execute on function fn_trigger_conversion_guard() from anon;
    revoke execute on function fn_cert_notice_facility_guard() from anon;
  end if;
end
$$;

notify pgrst, 'reload schema';
