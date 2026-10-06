-- ===========================================================================
-- 0062_scheduling_self_service.sql
-- Wave 3, Slice 3D: SC-10 (self-service tables), SC-11/12/13 (atomic
-- approvals), SC-14 (availability), SC-17 (notifications) --
-- plans/SCHEDULING_PLAN.md. (The plan's own file name for this migration,
-- 0025_scheduling_requests.sql, is stale: 0025 was taken long ago.)
--
-- 1. Permission catalog: schedule.approve.swaps, schedule.approve.time_off,
--    schedule.manage.open_shifts. Same live-database rule as 0034: the
--    catalog row AND the role grant both run here (a database that already
--    bootstrapped from a pre-this-migration seed.sql would otherwise never
--    see them), granted to every role that already holds schedule.manage.
--    schedule.manage ALSO satisfies swap and open-shift approvals (it already
--    confers direct assignment authority, so this adds no power) but does NOT
--    satisfy time-off approval, which stays its own governance surface.
--
-- 2. Four tables: open_shift_claims, shift_swap_requests, time_off_requests,
--    employee_availability. Policy model (no `for all` anywhere):
--      * employees read/create/cancel THEIR OWN rows (employees.user_id =
--        (select auth.uid()), the 0037 shape);
--      * approvers read the queue; NOBODY but the decision RPCs below can move
--        a request into approved/denied -- there is deliberately no manager
--        UPDATE policy on the three request tables, and the BEFORE UPDATE
--        guard triggers (Guard N labels) independently reject a decided
--        status unless the decision RPC stamped its transaction-local marker;
--      * every cross-row FK gets internal.fn_assert_same_facility in its
--        WITH CHECK.
--    Every create policy below is immediately preceded by drop policy if
--    exists. This migration re-creates NO pre-existing policy: the three
--    self-read policies on schedule_shifts/shift_assignments are NEW names
--    and purely additive (they widen reads to a caller's own published rows
--    and to published open shifts, nothing else).
--
-- 3. Approvals (SC-11/12/13): internal.decide_open_shift_claim /
--    decide_shift_swap / decide_time_off_request (p_request_id, p_decision,
--    p_reason), SECURITY DEFINER with a public. invoker wrapper each (0058's
--    create_work_order_from_incident grant pattern). Each re-checks the
--    caller's permission itself, loads every row it acts on itself (the only
--    client inputs are the request id, 'approve'|'deny' and a free-text
--    reason), re-validates certifications / overlap / time-off /
--    availability at decision time against the SERVER-READ facility
--    settings, and writes the assignment change and the decision in ONE
--    transaction. Each one: checks the caller's permission (against the facility
--    of an unlocked read of the row) BEFORE taking any lock; answers a missing
--    id and an id outside the caller's facilities identically (not found);
--    refuses a decider who is themself a party to the request (requester,
--    swap target, claimant); then locks the affected employee rows (ascending
--    id), then the shifts, then the request (always employee -> shift ->
--    request, so competing approvals serialise per employee and per shift and
--    never deadlock). It is idempotent on replay (the same decision again
--    returns the stored row with replay=true; the opposite decision is a 409).
--    Auditing goes through the existing fn_audit_admin_change trigger path
--    (attached to all four tables).
--    A shift swap that names a colleague also needs that colleague's consent:
--    internal.respond_to_shift_swap lets ONLY the named employee accept or
--    decline, and decide_shift_swap refuses to approve before acceptance.
--
-- 4. Notifications (SC-17): no authenticated notification_jobs write path is
--    added and 0058's incident-scoped INSERT policy is untouched. Decision
--    notifications are enqueued by the definer RPCs; publish notifications
--    by an AFTER UPDATE definer trigger on schedule_periods that fires when a
--    period becomes (or is re-) published at a version that has its
--    schedule_publications row, once per period + version.
--    fn_notification_job_dedupe_key (0058, re-created
--    by the communications slice) is deliberately NOT redefined here: its
--    non-message branch builds the key from payload.incidentId, which would
--    collapse every schedule job for one recipient onto one key. These jobs
--    are therefore written with dedupe_key NULL (the trigger leaves a null key
--    untouched, so no caller-influenced key exists at all) and are exactly-once
--    by construction: a request leaves 'pending' once, under a row lock, firing
--    its notification in that same transaction, and the publish trigger checks
--    for an existing job of the same period + version. An idempotent replay of
--    a decision returns before any notification is written.
--
-- 5. Hard-block time off (scheduling.timeOffConflictMode = 'hard-block') is
--    enforced in the database as well as in the decision RPCs: a BEFORE
--    trigger on shift_assignments refuses a live assignment for an employee
--    who has approved time off overlapping the shift, for every writer
--    including the service role and the definer paths. The facility settings
--    are served to ordinary members through a definer function limited to
--    `scheduling.*` keys, so the BFF resolves them the same way for every caller.
--
-- 6. Every SECURITY DEFINER function here pins search_path = public, pg_temp.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Permission catalog + role grants.
-- ---------------------------------------------------------------------------
insert into permissions (code, description) values
  ('schedule.approve.swaps', 'Approve or deny shift swap requests'),
  ('schedule.approve.time_off', 'Approve or deny time-off requests'),
  ('schedule.manage.open_shifts', 'Approve or deny open-shift claims')
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_code)
select rp.role_id, grants.code
from role_permissions rp
cross join (values
  ('schedule.approve.swaps'),
  ('schedule.approve.time_off'),
  ('schedule.manage.open_shifts')
) as grants(code)
where rp.permission_code = 'schedule.manage'
on conflict (role_id, permission_code) do nothing;

-- Notification event catalog rows for the three decision events (a facility
-- admin can only route an event that exists here; schedule.published already
-- exists from seed.sql). Same idempotent insert the seed uses.
insert into notification_events (code, severity, module_code, default_channels_jsonb) values
  ('schedule.claim_decided', 'info', 'scheduling', '["in_app"]'::jsonb),
  ('schedule.swap_decided', 'info', 'scheduling', '["in_app"]'::jsonb),
  ('schedule.time_off_decided', 'info', 'scheduling', '["in_app"]'::jsonb)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Server-side reads of the facility's scheduling settings, so the decision
-- RPCs never trust a caller-supplied enforcement mode. Resolution mirrors
-- settings-registry.mjs's effectiveConfig: the facility override layer wins
-- over the organization layer; an unset (or JSON null) key falls through and
-- the caller applies the registry default. Flat dotted keys, as stored by
-- the admin config routes.
-- ---------------------------------------------------------------------------
create or replace function internal.fn_scheduling_setting(p_facility_id uuid, p_key text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select fo.config_patch_jsonb ->> p_key
      from facility_module_overrides fo
      join modules m on m.id = fo.module_id
      where fo.facility_id = p_facility_id and m.code = 'scheduling'
    ),
    (
      select oms.config_jsonb ->> p_key
      from organization_module_settings oms
      join modules m on m.id = oms.module_id
      join facilities f on f.organization_id = oms.organization_id
      where f.id = p_facility_id and m.code = 'scheduling'
    )
  );
$$;

create or replace function internal.fn_scheduling_setting_int(p_facility_id uuid, p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when v ~ '^[0-9]{1,6}$' then v::integer
    else p_default
  end
  from (select internal.fn_scheduling_setting(p_facility_id, p_key) as v) s;
$$;

-- The same two layers, as data, for the BFF: ordinary facility members hold
-- neither settings table's SELECT (admin.manage only), so the BFF could not
-- resolve the mode switches through the caller's own client. Members of the
-- facility get ONLY the `scheduling.*` keys of each layer (never another
-- module's settings); anyone else gets empty layers. The BFF folds the layers
-- through settings-registry's effectiveConfig, exactly as before.
create or replace function internal.get_scheduling_config_layers(p_facility_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'orgLayer',
    case when p_facility_id in (select internal.current_facility_ids()) then coalesce((
      select jsonb_object_agg(e.key, e.value)
      from organization_module_settings oms
      join modules m on m.id = oms.module_id
      join facilities f on f.organization_id = oms.organization_id
      cross join lateral jsonb_each(
        case when jsonb_typeof(oms.config_jsonb) = 'object' then oms.config_jsonb else '{}'::jsonb end
      ) as e(key, value)
      where f.id = p_facility_id and m.code = 'scheduling' and e.key like 'scheduling.%'
    ), '{}'::jsonb) else '{}'::jsonb end,
    'facilityLayer',
    case when p_facility_id in (select internal.current_facility_ids()) then coalesce((
      select jsonb_object_agg(e.key, e.value)
      from facility_module_overrides fo
      join modules m on m.id = fo.module_id
      cross join lateral jsonb_each(
        case when jsonb_typeof(fo.config_patch_jsonb) = 'object' then fo.config_patch_jsonb else '{}'::jsonb end
      ) as e(key, value)
      where fo.facility_id = p_facility_id and m.code = 'scheduling' and e.key like 'scheduling.%'
    ), '{}'::jsonb) else '{}'::jsonb end
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. schedule_shifts.opened_at: when a shift became claimable, so the
-- scheduling.openShiftClaimWindowHours window has a server-owned start. The
-- trigger recomputes it on every write -- a client-sent value is ignored.
-- ---------------------------------------------------------------------------
alter table schedule_shifts add column if not exists opened_at timestamptz;

create or replace function fn_schedule_shift_opened_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'open' then
    if tg_op = 'INSERT' or old.status is distinct from 'open' then
      new.opened_at := now();
    else
      new.opened_at := old.opened_at;
    end if;
  else
    new.opened_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_shifts_opened_at on schedule_shifts;
create trigger schedule_shifts_opened_at
  before insert or update on schedule_shifts
  for each row execute function fn_schedule_shift_opened_at();

-- Open shifts that already exist before this migration get a start for their
-- claim window (updated_at is the best available proxy).
update schedule_shifts set opened_at = updated_at where status = 'open' and opened_at is null;

-- ---------------------------------------------------------------------------
-- 4. Tables.
-- ---------------------------------------------------------------------------
create table if not exists open_shift_claims (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  shift_id uuid not null references schedule_shifts(id) on delete cascade,
  claimant_employee_id uuid not null references employees(id),
  claim_status text not null default 'pending'
    check (claim_status in ('pending', 'approved', 'denied', 'withdrawn')),
  manager_id uuid references app_users(id),
  decided_at timestamptz,
  decision_reason text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint open_shift_claims_decision_shape
    check ((claim_status in ('approved', 'denied')) = (decided_at is not null)),
  constraint open_shift_claims_text_length
    check (char_length(decision_reason) <= 2000)
);

create table if not exists shift_swap_requests (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  offered_assignment_id uuid not null references shift_assignments(id) on delete cascade,
  requested_assignment_id uuid references shift_assignments(id) on delete cascade,
  requester_employee_id uuid not null references employees(id),
  target_employee_id uuid references employees(id),
  swap_type text not null check (swap_type in ('direct', 'drop_pickup')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  reason text,
  manager_id uuid references app_users(id),
  decided_at timestamptz,
  decision_reason text,
  -- The named colleague's answer (set only by internal.respond_to_shift_swap):
  -- a swap or named pickup cannot be approved before target_accepted_at.
  target_accepted_at timestamptz,
  target_declined_at timestamptz,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint shift_swap_requests_shape check (
    (swap_type = 'direct' and requested_assignment_id is not null and target_employee_id is not null)
    or (swap_type = 'drop_pickup' and requested_assignment_id is null)
  ),
  constraint shift_swap_requests_decision_shape
    check ((status in ('approved', 'denied')) = (decided_at is not null)),
  constraint shift_swap_requests_target_response_shape check (
    (target_accepted_at is null or target_declined_at is null)
    and ((target_accepted_at is null and target_declined_at is null) or target_employee_id is not null)
  ),
  constraint shift_swap_requests_text_length
    check (char_length(reason) <= 2000 and char_length(decision_reason) <= 2000)
);

create table if not exists time_off_requests (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_id uuid not null references employees(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  request_type text not null check (request_type in ('vacation', 'sick', 'unpaid', 'other')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'cancelled')),
  reason text,
  manager_id uuid references app_users(id),
  decided_at timestamptz,
  decision_notes text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint time_off_requests_window check (starts_at < ends_at and ends_at - starts_at <= interval '366 days'),
  -- One-directional: an approved request the employee later cancels keeps its
  -- decided_at as the record of the original decision.
  constraint time_off_requests_decision_shape
    check (status not in ('approved', 'denied') or decided_at is not null),
  constraint time_off_requests_text_length
    check (char_length(reason) <= 2000 and char_length(decision_notes) <= 2000)
);

create table if not exists employee_availability (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  weekday integer not null check (weekday between 0 and 6),
  available_start_local time,
  available_end_local time,
  unavailable boolean not null default false,
  effective_from date not null default current_date,
  effective_to date,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint employee_availability_window check (
    (unavailable and available_start_local is null and available_end_local is null)
    or (not unavailable and available_start_local is null and available_end_local is null)
    or (not unavailable and available_start_local is not null and available_end_local is not null
        and available_start_local < available_end_local)
  ),
  constraint employee_availability_effective check (effective_to is null or effective_to >= effective_from),
  constraint employee_availability_weekday_uidx unique (employee_id, weekday, effective_from)
);

-- Design section 11.3's critical indexes, plus the partial unique indexes the
-- guards lean on (one live claim per claimant per shift; one pending swap per
-- assignment on either side).
create index if not exists open_shift_claims_facility_status_idx
  on open_shift_claims(facility_id, claim_status, created_at desc) where deleted_at is null;
create unique index if not exists open_shift_claims_active_uidx
  on open_shift_claims(shift_id, claimant_employee_id)
  where claim_status in ('pending', 'approved') and deleted_at is null;
create index if not exists open_shift_claims_claimant_idx
  on open_shift_claims(claimant_employee_id) where deleted_at is null;

create index if not exists shift_swap_requests_facility_status_idx
  on shift_swap_requests(facility_id, status, created_at desc) where deleted_at is null;
create unique index if not exists shift_swap_requests_offered_pending_uidx
  on shift_swap_requests(offered_assignment_id) where status = 'pending' and deleted_at is null;
create unique index if not exists shift_swap_requests_requested_pending_uidx
  on shift_swap_requests(requested_assignment_id)
  where status = 'pending' and requested_assignment_id is not null and deleted_at is null;
create index if not exists shift_swap_requests_requester_idx
  on shift_swap_requests(requester_employee_id) where deleted_at is null;

create index if not exists time_off_requests_facility_employee_idx
  on time_off_requests(facility_id, employee_id, status, starts_at) where deleted_at is null;

create index if not exists employee_availability_facility_employee_idx
  on employee_availability(facility_id, employee_id, weekday) where deleted_at is null;

alter table open_shift_claims enable row level security;
alter table shift_swap_requests enable row level security;
alter table time_off_requests enable row level security;
alter table employee_availability enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Additive self-read helper + policies on the EXISTING scheduling tables.
-- A staff member with no schedule.read must still see (a) their own
-- assignments and shifts once the period is published and (b) published open
-- shifts they could claim. internal.fn_shift_period_published is a definer
-- boolean over a shift id, so these policies never recurse through the other
-- tables' RLS. Draft/review periods stay invisible to anyone without
-- schedule.read.
-- ---------------------------------------------------------------------------
create or replace function internal.fn_shift_period_published(p_shift_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from schedule_shifts s
    join schedule_periods p on p.id = s.schedule_period_id
    where s.id = p_shift_id
      and s.deleted_at is null
      and p.deleted_at is null
      and p.status = 'published'
  );
$$;

revoke execute on function internal.fn_shift_period_published(uuid) from public;
grant execute on function internal.fn_shift_period_published(uuid) to authenticated;

drop policy if exists "staff can read published open shifts" on schedule_shifts;
create policy "staff can read published open shifts" on schedule_shifts
  for select
  using (
    facility_id in (select internal.current_facility_ids())
    and deleted_at is null
    and status = 'open'
    and internal.fn_shift_period_published(id)
  );

drop policy if exists "employees can read their own published assignments" on shift_assignments;
create policy "employees can read their own published assignments" on shift_assignments
  for select
  using (
    deleted_at is null
    and internal.fn_shift_period_published(shift_id)
    and exists (
      select 1 from employees e
      where e.id = shift_assignments.employee_id
        and e.facility_id = shift_assignments.facility_id
        and e.user_id = (select auth.uid())
    )
  );

drop policy if exists "employees can read shifts they are assigned to" on schedule_shifts;
create policy "employees can read shifts they are assigned to" on schedule_shifts
  for select
  using (
    deleted_at is null
    and internal.fn_shift_period_published(id)
    and exists (
      select 1
      from shift_assignments a
      join employees e on e.id = a.employee_id
      where a.shift_id = schedule_shifts.id
        and a.status in ('pending', 'approved')
        and a.deleted_at is null
        and e.facility_id = schedule_shifts.facility_id
        and e.user_id = (select auth.uid())
    )
  );

-- Facility members read PUBLISHED periods (the week header the self-service
-- lists key on) and nothing else about the planning table: draft, review and
-- archived periods stay behind schedule.read / schedule.manage. Additive: the
-- existing "schedule readers can read periods" and manage policies are
-- untouched.
drop policy if exists "members can read published schedule periods" on schedule_periods;
create policy "members can read published schedule periods" on schedule_periods
  for select
  using (
    facility_id in (select internal.current_facility_ids())
    and deleted_at is null
    and status = 'published'
  );

-- ---------------------------------------------------------------------------
-- 6. Policies on the four new tables.
-- ---------------------------------------------------------------------------

-- open_shift_claims ---------------------------------------------------------
drop policy if exists "claimants can read their own open shift claims" on open_shift_claims;
create policy "claimants can read their own open shift claims" on open_shift_claims
  for select
  using (
    deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = open_shift_claims.claimant_employee_id
        and e.facility_id = open_shift_claims.facility_id
        and e.user_id = (select auth.uid())
    )
  );

drop policy if exists "open shift approvers can read open shift claims" on open_shift_claims;
create policy "open shift approvers can read open shift claims" on open_shift_claims
  for select
  using (
    deleted_at is null
    and (
      internal.has_permission((select auth.uid()), facility_id, 'schedule.manage.open_shifts')
      or internal.has_permission((select auth.uid()), facility_id, 'schedule.manage')
    )
  );

drop policy if exists "employees can create their own open shift claims" on open_shift_claims;
create policy "employees can create their own open shift claims" on open_shift_claims
  for insert
  with check (
    facility_id in (select internal.current_facility_ids())
    and claim_status = 'pending'
    and manager_id is null
    and decided_at is null
    and decision_reason is null
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = open_shift_claims.claimant_employee_id
        and e.facility_id = open_shift_claims.facility_id
        and e.user_id = (select auth.uid())
        and e.status = 'active'
    )
    and internal.fn_assert_same_facility(facility_id, 'schedule_shifts', shift_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', claimant_employee_id)
  );

drop policy if exists "claimants can withdraw their own open shift claims" on open_shift_claims;
create policy "claimants can withdraw their own open shift claims" on open_shift_claims
  for update
  using (
    claim_status = 'pending'
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = open_shift_claims.claimant_employee_id
        and e.facility_id = open_shift_claims.facility_id
        and e.user_id = (select auth.uid())
    )
  )
  with check (
    claim_status = 'withdrawn'
    and exists (
      select 1 from employees e
      where e.id = open_shift_claims.claimant_employee_id
        and e.facility_id = open_shift_claims.facility_id
        and e.user_id = (select auth.uid())
    )
    and internal.fn_assert_same_facility(facility_id, 'schedule_shifts', shift_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', claimant_employee_id)
  );

-- shift_swap_requests -------------------------------------------------------
drop policy if exists "requesters can read their own swap requests" on shift_swap_requests;
create policy "requesters can read their own swap requests" on shift_swap_requests
  for select
  using (
    deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = shift_swap_requests.requester_employee_id
        and e.facility_id = shift_swap_requests.facility_id
        and e.user_id = (select auth.uid())
    )
  );

-- The named colleague reads the requests addressed to them (they cannot
-- answer a request they cannot see); answering goes through
-- internal.respond_to_shift_swap, not a table write.
drop policy if exists "targets can read swap requests addressed to them" on shift_swap_requests;
create policy "targets can read swap requests addressed to them" on shift_swap_requests
  for select
  using (
    deleted_at is null
    and target_employee_id is not null
    and exists (
      select 1 from employees e
      where e.id = shift_swap_requests.target_employee_id
        and e.facility_id = shift_swap_requests.facility_id
        and e.user_id = (select auth.uid())
    )
  );

drop policy if exists "swap approvers can read swap requests" on shift_swap_requests;
create policy "swap approvers can read swap requests" on shift_swap_requests
  for select
  using (
    deleted_at is null
    and (
      internal.has_permission((select auth.uid()), facility_id, 'schedule.approve.swaps')
      or internal.has_permission((select auth.uid()), facility_id, 'schedule.manage')
    )
  );

drop policy if exists "employees can create their own swap requests" on shift_swap_requests;
create policy "employees can create their own swap requests" on shift_swap_requests
  for insert
  with check (
    facility_id in (select internal.current_facility_ids())
    and status = 'pending'
    and manager_id is null
    and decided_at is null
    and decision_reason is null
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = shift_swap_requests.requester_employee_id
        and e.facility_id = shift_swap_requests.facility_id
        and e.user_id = (select auth.uid())
        and e.status = 'active'
    )
    and internal.fn_assert_same_facility(facility_id, 'shift_assignments', offered_assignment_id)
    and internal.fn_assert_same_facility(facility_id, 'shift_assignments', requested_assignment_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', requester_employee_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', target_employee_id)
  );

drop policy if exists "requesters can cancel their own swap requests" on shift_swap_requests;
create policy "requesters can cancel their own swap requests" on shift_swap_requests
  for update
  using (
    status = 'pending'
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = shift_swap_requests.requester_employee_id
        and e.facility_id = shift_swap_requests.facility_id
        and e.user_id = (select auth.uid())
    )
  )
  with check (
    status = 'cancelled'
    and exists (
      select 1 from employees e
      where e.id = shift_swap_requests.requester_employee_id
        and e.facility_id = shift_swap_requests.facility_id
        and e.user_id = (select auth.uid())
    )
    and internal.fn_assert_same_facility(facility_id, 'shift_assignments', offered_assignment_id)
    and internal.fn_assert_same_facility(facility_id, 'shift_assignments', requested_assignment_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', requester_employee_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', target_employee_id)
  );

-- time_off_requests ---------------------------------------------------------
drop policy if exists "employees can read their own time off requests" on time_off_requests;
create policy "employees can read their own time off requests" on time_off_requests
  for select
  using (
    deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = time_off_requests.employee_id
        and e.facility_id = time_off_requests.facility_id
        and e.user_id = (select auth.uid())
    )
  );

-- schedule.manage may READ time off (a manager building a schedule needs to
-- see who is away) but may not decide it: deciding needs the dedicated code.
drop policy if exists "time off approvers and schedule managers can read time off" on time_off_requests;
create policy "time off approvers and schedule managers can read time off" on time_off_requests
  for select
  using (
    deleted_at is null
    and (
      internal.has_permission((select auth.uid()), facility_id, 'schedule.approve.time_off')
      or internal.has_permission((select auth.uid()), facility_id, 'schedule.manage')
    )
  );

drop policy if exists "employees can create their own time off requests" on time_off_requests;
create policy "employees can create their own time off requests" on time_off_requests
  for insert
  with check (
    facility_id in (select internal.current_facility_ids())
    and status = 'pending'
    and manager_id is null
    and decided_at is null
    and decision_notes is null
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = time_off_requests.employee_id
        and e.facility_id = time_off_requests.facility_id
        and e.user_id = (select auth.uid())
        and e.status = 'active'
    )
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

drop policy if exists "employees can cancel their own time off requests" on time_off_requests;
create policy "employees can cancel their own time off requests" on time_off_requests
  for update
  using (
    status in ('pending', 'approved')
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = time_off_requests.employee_id
        and e.facility_id = time_off_requests.facility_id
        and e.user_id = (select auth.uid())
    )
  )
  with check (
    status = 'cancelled'
    and exists (
      select 1 from employees e
      where e.id = time_off_requests.employee_id
        and e.facility_id = time_off_requests.facility_id
        and e.user_id = (select auth.uid())
    )
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- employee_availability -----------------------------------------------------
drop policy if exists "employees can read their own availability" on employee_availability;
create policy "employees can read their own availability" on employee_availability
  for select
  using (
    deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = employee_availability.employee_id
        and e.facility_id = employee_availability.facility_id
        and e.user_id = (select auth.uid())
    )
  );

drop policy if exists "schedule readers can read availability" on employee_availability;
create policy "schedule readers can read availability" on employee_availability
  for select
  using (
    deleted_at is null
    and internal.has_permission((select auth.uid()), facility_id, 'schedule.read')
  );

drop policy if exists "employees can create their own availability" on employee_availability;
create policy "employees can create their own availability" on employee_availability
  for insert
  with check (
    facility_id in (select internal.current_facility_ids())
    and deleted_at is null
    and exists (
      select 1 from employees e
      where e.id = employee_availability.employee_id
        and e.facility_id = employee_availability.facility_id
        and e.user_id = (select auth.uid())
        and e.status = 'active'
    )
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- No DELETE policy: removing a weekday rule is a soft delete (deleted_at),
-- which is this UPDATE.
drop policy if exists "employees can update their own availability" on employee_availability;
create policy "employees can update their own availability" on employee_availability
  for update
  using (
    exists (
      select 1 from employees e
      where e.id = employee_availability.employee_id
        and e.facility_id = employee_availability.facility_id
        and e.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from employees e
      where e.id = employee_availability.employee_id
        and e.facility_id = employee_availability.facility_id
        and e.user_id = (select auth.uid())
        and e.status = 'active'
    )
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- ---------------------------------------------------------------------------
-- 7. Guard triggers. SECURITY DEFINER (they read shifts/assignments the
-- requesting employee cannot see through RLS), search_path = public, pg_temp, execute
-- revoked from public/authenticated below (EXECUTE is checked at CREATE
-- TRIGGER only). The decision marker: the decide_* RPCs stamp the
-- transaction-local setting rr.schedule_decision with the id of the row they
-- are about to decide; a guard accepts a decided status (and any change to
-- the decision columns) only when that marker equals the row's own id.
-- ---------------------------------------------------------------------------

-- open_shift_claims ---------------------------------------------------------
create or replace function fn_open_shift_claim_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift schedule_shifts%rowtype;
  v_employee employees%rowtype;
  v_window integer;
  v_decided_by_rpc boolean;
begin
  if tg_op = 'INSERT' then
    -- Guard 1: a claim is created pending with no decision data, whoever
    -- inserts it (the INSERT policy says the same; this holds for every role).
    if new.claim_status <> 'pending' or new.manager_id is not null
       or new.decided_at is not null or new.decision_reason is not null then
      raise exception 'open_shift_claims: a claim must be created pending with no decision data.'
        using errcode = 'check_violation';
    end if;

    -- Guard 2: the claimant is an active employee of the claim's own facility.
    select * into v_employee from employees where id = new.claimant_employee_id;
    if not found or v_employee.facility_id <> new.facility_id
       or v_employee.deleted_at is not null or v_employee.status <> 'active' then
      raise exception 'open_shift_claims: the claimant must be an active employee of this facility.'
        using errcode = 'check_violation';
    end if;

    -- Guard 3: the shift is an open, not-yet-started shift of this facility in
    -- a PUBLISHED period -- a claim can never target a draft shift.
    select * into v_shift from schedule_shifts where id = new.shift_id;
    if not found or v_shift.facility_id <> new.facility_id or v_shift.deleted_at is not null then
      raise exception 'open_shift_claims: shift not found in this facility.'
        using errcode = 'check_violation';
    end if;
    if v_shift.status <> 'open' then
      raise exception 'open_shift_claims: this shift is not open for claims.'
        using errcode = 'check_violation';
    end if;
    if v_shift.starts_at <= now() then
      raise exception 'open_shift_claims: this shift has already started.'
        using errcode = 'check_violation';
    end if;
    if not internal.fn_shift_period_published(v_shift.id) then
      raise exception 'open_shift_claims: this shift is not in a published schedule period.'
        using errcode = 'check_violation';
    end if;

    -- Guard 4: the claim window (scheduling.openShiftClaimWindowHours, read
    -- server-side from the facility's settings) counts from the server-owned
    -- schedule_shifts.opened_at.
    v_window := internal.fn_scheduling_setting_int(new.facility_id, 'scheduling.openShiftClaimWindowHours', 48);
    if now() > coalesce(v_shift.opened_at, v_shift.updated_at) + make_interval(hours => v_window) then
      raise exception 'open_shift_claims: the claim window for this shift has closed.'
        using errcode = 'check_violation';
    end if;

    -- Guard 5: not already assigned to the shift being claimed.
    if exists (
      select 1 from shift_assignments a
      where a.shift_id = new.shift_id
        and a.employee_id = new.claimant_employee_id
        and a.status in ('pending', 'approved')
        and a.deleted_at is null
    ) then
      raise exception 'open_shift_claims: the claimant is already assigned to this shift.'
        using errcode = 'check_violation';
    end if;

    -- Guard 6: provenance is server-stamped, never client-chosen.
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- From here on, tg_op = 'UPDATE'.
  v_decided_by_rpc := coalesce(current_setting('rr.schedule_decision', true), '') = old.id::text;

  -- Guard 7: identity columns are immutable; a claim can never be re-pointed
  -- at another shift, claimant or facility.
  if new.facility_id is distinct from old.facility_id
     or new.shift_id is distinct from old.shift_id
     or new.claimant_employee_id is distinct from old.claimant_employee_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'open_shift_claims %: identity columns (facility, shift, claimant, provenance, deleted_at) are immutable.', old.id
      using errcode = 'check_violation';
  end if;

  -- Guard 8: status transition graph. pending -> approved | denied |
  -- withdrawn; every other status is terminal. Same-status updates are
  -- allowed only while the decision columns stay untouched (Guard 9).
  if new.claim_status is distinct from old.claim_status then
    if old.claim_status <> 'pending' or new.claim_status not in ('approved', 'denied', 'withdrawn') then
      raise exception 'open_shift_claims %: illegal transition % -> %.', old.id, old.claim_status, new.claim_status
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 9: approved/denied (and every decision column) is reachable only
  -- through internal.decide_open_shift_claim, which stamps the marker.
  if (new.claim_status in ('approved', 'denied') and new.claim_status is distinct from old.claim_status)
     or new.manager_id is distinct from old.manager_id
     or new.decided_at is distinct from old.decided_at
     or new.decision_reason is distinct from old.decision_reason then
    if not v_decided_by_rpc then
      raise exception 'open_shift_claims %: a claim can only be decided through decide_open_shift_claim.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 10: a denial always carries a reason.
  if new.claim_status = 'denied' and nullif(btrim(coalesce(new.decision_reason, '')), '') is null then
    raise exception 'open_shift_claims %: a denial requires a reason.', old.id
      using errcode = 'check_violation';
  end if;

  -- Guard 11: withdrawal is the claimant's own act.
  if new.claim_status = 'withdrawn' and old.claim_status <> 'withdrawn' and not v_decided_by_rpc then
    if auth.uid() is null or not exists (
      select 1 from employees e where e.id = old.claimant_employee_id and e.user_id = auth.uid()
    ) then
      raise exception 'open_shift_claims %: only the claimant can withdraw a claim.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists open_shift_claims_guard on open_shift_claims;
create trigger open_shift_claims_guard
  before insert or update on open_shift_claims
  for each row execute function fn_open_shift_claim_guard();

-- shift_swap_requests -------------------------------------------------------
create or replace function fn_shift_swap_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requester employees%rowtype;
  v_target employees%rowtype;
  v_offered shift_assignments%rowtype;
  v_requested shift_assignments%rowtype;
  v_shift schedule_shifts%rowtype;
  v_decided_by_rpc boolean;
begin
  if tg_op = 'INSERT' then
    -- Guard 1: created pending with no decision data.
    if new.status <> 'pending' or new.manager_id is not null
       or new.decided_at is not null or new.decision_reason is not null
       or new.target_accepted_at is not null or new.target_declined_at is not null then
      raise exception 'shift_swap_requests: a swap request must be created pending with no decision data.'
        using errcode = 'check_violation';
    end if;

    -- Guard 2: the requester is an active employee of this facility and the
    -- offered assignment is THEIR OWN live assignment on a future shift.
    select * into v_requester from employees where id = new.requester_employee_id;
    if not found or v_requester.facility_id <> new.facility_id
       or v_requester.deleted_at is not null or v_requester.status <> 'active' then
      raise exception 'shift_swap_requests: the requester must be an active employee of this facility.'
        using errcode = 'check_violation';
    end if;
    select * into v_offered from shift_assignments where id = new.offered_assignment_id;
    if not found or v_offered.facility_id <> new.facility_id or v_offered.deleted_at is not null
       or v_offered.status not in ('pending', 'approved')
       or v_offered.employee_id <> new.requester_employee_id then
      raise exception 'shift_swap_requests: the offered assignment must be the requester''s own live assignment.'
        using errcode = 'check_violation';
    end if;
    select * into v_shift from schedule_shifts where id = v_offered.shift_id;
    if not found or v_shift.deleted_at is not null or v_shift.status = 'cancelled' or v_shift.starts_at <= now() then
      raise exception 'shift_swap_requests: the offered shift is cancelled or has already started.'
        using errcode = 'check_violation';
    end if;

    -- Guard 3: a named counterpart is an active employee of this facility;
    -- a direct swap's requested assignment is THAT employee's own live
    -- assignment on a future shift, and differs from the offered one.
    if new.target_employee_id is not null then
      select * into v_target from employees where id = new.target_employee_id;
      if not found or v_target.facility_id <> new.facility_id
         or v_target.deleted_at is not null or v_target.status <> 'active'
         or v_target.id = new.requester_employee_id then
        raise exception 'shift_swap_requests: the target must be a different active employee of this facility.'
          using errcode = 'check_violation';
      end if;
    end if;
    if new.requested_assignment_id is not null then
      select * into v_requested from shift_assignments where id = new.requested_assignment_id;
      if not found or v_requested.facility_id <> new.facility_id or v_requested.deleted_at is not null
         or v_requested.status not in ('pending', 'approved')
         or v_requested.id = new.offered_assignment_id
         or v_requested.employee_id is distinct from new.target_employee_id then
        raise exception 'shift_swap_requests: the requested assignment must be the target''s own live assignment.'
          using errcode = 'check_violation';
      end if;
      select * into v_shift from schedule_shifts where id = v_requested.shift_id;
      if not found or v_shift.deleted_at is not null or v_shift.status = 'cancelled' or v_shift.starts_at <= now() then
        raise exception 'shift_swap_requests: the requested shift is cancelled or has already started.'
          using errcode = 'check_violation';
      end if;
    end if;

    -- Guard 4: provenance is server-stamped.
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- From here on, tg_op = 'UPDATE'.
  v_decided_by_rpc := coalesce(current_setting('rr.schedule_decision', true), '') = old.id::text;

  -- Guard 5: identity columns are immutable.
  if new.facility_id is distinct from old.facility_id
     or new.offered_assignment_id is distinct from old.offered_assignment_id
     or new.requested_assignment_id is distinct from old.requested_assignment_id
     or new.requester_employee_id is distinct from old.requester_employee_id
     or new.target_employee_id is distinct from old.target_employee_id
     or new.swap_type is distinct from old.swap_type
     or new.reason is distinct from old.reason
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'shift_swap_requests %: identity columns (facility, assignments, parties, type, reason, provenance, deleted_at) are immutable.', old.id
      using errcode = 'check_violation';
  end if;

  -- Guard 6: transition graph. pending -> approved | denied | cancelled |
  -- expired; every other status is terminal.
  if new.status is distinct from old.status then
    if old.status <> 'pending' or new.status not in ('approved', 'denied', 'cancelled', 'expired') then
      raise exception 'shift_swap_requests %: illegal transition % -> %.', old.id, old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 7: approved/denied/expired and every decision column are reachable
  -- only through internal.decide_shift_swap (or a future server-side expiry
  -- job that stamps the same marker); the named colleague's answer
  -- (target_accepted_at / target_declined_at) only through
  -- internal.respond_to_shift_swap, which stamps the same marker.
  if (new.status in ('approved', 'denied', 'expired') and new.status is distinct from old.status)
     or new.manager_id is distinct from old.manager_id
     or new.decided_at is distinct from old.decided_at
     or new.decision_reason is distinct from old.decision_reason
     or new.target_accepted_at is distinct from old.target_accepted_at
     or new.target_declined_at is distinct from old.target_declined_at then
    if not v_decided_by_rpc then
      raise exception 'shift_swap_requests %: a swap can only be decided through decide_shift_swap (and answered through respond_to_shift_swap).', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 8: a denial always carries a reason.
  if new.status = 'denied' and nullif(btrim(coalesce(new.decision_reason, '')), '') is null then
    raise exception 'shift_swap_requests %: a denial requires a reason.', old.id
      using errcode = 'check_violation';
  end if;

  -- Guard 9: cancellation is the requester's own act (or the named
  -- colleague's recorded decline, which respond_to_shift_swap stamps).
  if new.status = 'cancelled' and old.status <> 'cancelled' and not v_decided_by_rpc then
    if auth.uid() is null or not exists (
      select 1 from employees e where e.id = old.requester_employee_id and e.user_id = auth.uid()
    ) then
      raise exception 'shift_swap_requests %: only the requester can cancel a swap request.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists shift_swap_requests_guard on shift_swap_requests;
create trigger shift_swap_requests_guard
  before insert or update on shift_swap_requests
  for each row execute function fn_shift_swap_guard();

-- time_off_requests ---------------------------------------------------------
create or replace function fn_time_off_request_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee employees%rowtype;
  v_decided_by_rpc boolean;
begin
  if tg_op = 'INSERT' then
    -- Guard 1: created pending with no decision data.
    if new.status <> 'pending' or new.manager_id is not null
       or new.decided_at is not null or new.decision_notes is not null then
      raise exception 'time_off_requests: a request must be created pending with no decision data.'
        using errcode = 'check_violation';
    end if;

    -- Guard 2: an active employee of this facility, asking for a window that
    -- has not already ended.
    select * into v_employee from employees where id = new.employee_id;
    if not found or v_employee.facility_id <> new.facility_id
       or v_employee.deleted_at is not null or v_employee.status <> 'active' then
      raise exception 'time_off_requests: the requester must be an active employee of this facility.'
        using errcode = 'check_violation';
    end if;
    if new.ends_at <= now() then
      raise exception 'time_off_requests: the requested window has already ended.'
        using errcode = 'check_violation';
    end if;

    -- Guard 3: provenance is server-stamped.
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- From here on, tg_op = 'UPDATE'.
  v_decided_by_rpc := coalesce(current_setting('rr.schedule_decision', true), '') = old.id::text;

  -- Guard 4: identity columns (including the requested window) are immutable.
  if new.facility_id is distinct from old.facility_id
     or new.employee_id is distinct from old.employee_id
     or new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at
     or new.request_type is distinct from old.request_type
     or new.reason is distinct from old.reason
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'time_off_requests %: identity columns (facility, employee, window, type, reason, provenance, deleted_at) are immutable.', old.id
      using errcode = 'check_violation';
  end if;

  -- Guard 5: transition graph. pending -> approved | denied | cancelled;
  -- approved -> cancelled (the employee withdrawing before it starts);
  -- denied and cancelled are terminal.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending' and new.status in ('approved', 'denied', 'cancelled'))
      or (old.status = 'approved' and new.status = 'cancelled')
    ) then
      raise exception 'time_off_requests %: illegal transition % -> %.', old.id, old.status, new.status
        using errcode = 'check_violation';
    end if;
    if old.status = 'approved' and old.starts_at <= now() then
      raise exception 'time_off_requests %: approved time off that has already started cannot be cancelled.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 6: approved/denied and every decision column are reachable only
  -- through internal.decide_time_off_request.
  if (new.status in ('approved', 'denied') and new.status is distinct from old.status)
     or new.manager_id is distinct from old.manager_id
     or new.decided_at is distinct from old.decided_at
     or new.decision_notes is distinct from old.decision_notes then
    if not v_decided_by_rpc then
      raise exception 'time_off_requests %: a request can only be decided through decide_time_off_request.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Guard 7: a denial always carries notes.
  if new.status = 'denied' and nullif(btrim(coalesce(new.decision_notes, '')), '') is null then
    raise exception 'time_off_requests %: a denial requires a reason.', old.id
      using errcode = 'check_violation';
  end if;

  -- Guard 8: cancellation is the employee's own act.
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    if auth.uid() is null or not exists (
      select 1 from employees e where e.id = old.employee_id and e.user_id = auth.uid()
    ) then
      raise exception 'time_off_requests %: only the requesting employee can cancel a request.', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists time_off_requests_guard on time_off_requests;
create trigger time_off_requests_guard
  before insert or update on time_off_requests
  for each row execute function fn_time_off_request_guard();

-- employee_availability -----------------------------------------------------
create or replace function fn_employee_availability_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee employees%rowtype;
begin
  if tg_op = 'INSERT' then
    -- Guard 1: an employee of the row's own facility.
    select * into v_employee from employees where id = new.employee_id;
    if not found or v_employee.facility_id <> new.facility_id or v_employee.deleted_at is not null then
      raise exception 'employee_availability: the employee must belong to this facility.'
        using errcode = 'check_violation';
    end if;
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- Guard 2: a rule can never be re-pointed at another employee or facility.
  if new.facility_id is distinct from old.facility_id
     or new.employee_id is distinct from old.employee_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'employee_availability %: identity columns (facility, employee, provenance) are immutable.', old.id
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists employee_availability_guard on employee_availability;
create trigger employee_availability_guard
  before insert or update on employee_availability
  for each row execute function fn_employee_availability_guard();

-- Guard/stamp trigger functions are never callable by clients.
revoke execute on function fn_schedule_shift_opened_at() from public, authenticated;
revoke execute on function fn_open_shift_claim_guard() from public, authenticated;
revoke execute on function fn_shift_swap_guard() from public, authenticated;
revoke execute on function fn_time_off_request_guard() from public, authenticated;
revoke execute on function fn_employee_availability_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_schedule_shift_opened_at() from anon;
    revoke execute on function fn_open_shift_claim_guard() from anon;
    revoke execute on function fn_shift_swap_guard() from anon;
    revoke execute on function fn_time_off_request_guard() from anon;
    revoke execute on function fn_employee_availability_guard() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Audit: the existing config-change audit trigger (0010) on all four
-- tables, so every submission, withdrawal and decision lands in audit_events
-- with {before, after}, attributed to auth.uid() even when the write came
-- from a definer RPC.
-- ---------------------------------------------------------------------------
drop trigger if exists open_shift_claims_audit_change on open_shift_claims;
create trigger open_shift_claims_audit_change
  after insert or update or delete on open_shift_claims
  for each row execute function fn_audit_admin_change();

drop trigger if exists shift_swap_requests_audit_change on shift_swap_requests;
create trigger shift_swap_requests_audit_change
  after insert or update or delete on shift_swap_requests
  for each row execute function fn_audit_admin_change();

drop trigger if exists time_off_requests_audit_change on time_off_requests;
create trigger time_off_requests_audit_change
  after insert or update or delete on time_off_requests
  for each row execute function fn_audit_admin_change();

drop trigger if exists employee_availability_audit_change on employee_availability;
create trigger employee_availability_audit_change
  after insert or update or delete on employee_availability
  for each row execute function fn_audit_admin_change();

-- ---------------------------------------------------------------------------
-- 9. Notifications (SC-17).
--
-- 9a. (intentionally empty) fn_notification_job_dedupe_key is not redefined;
-- see the header note 4.

-- 9b. One in-app notification job for one employee, written by the definer
-- paths below. Not callable by clients.
create or replace function internal.fn_enqueue_schedule_notification(
  p_facility_id uuid,
  p_event_type text,
  p_source_id uuid,
  p_employee_id uuid,
  p_title text,
  p_body text,
  p_extra jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_employee_id is null then
    return;
  end if;
  insert into notification_jobs (facility_id, event_type, status, dedupe_key, payload_jsonb)
  values (
    p_facility_id,
    p_event_type,
    'pending',
    null,
    coalesce(p_extra, '{}'::jsonb) || jsonb_build_object(
      'sourceId', p_source_id,
      'recipients', jsonb_build_array(p_employee_id::text),
      'channels', jsonb_build_array('in_app'),
      'title', p_title,
      'body', p_body
    )
  );
end;
$$;

-- 9c. Publish notifications: one job per employee holding a live assignment
-- in the published period, enqueued in the SAME transaction that makes the
-- period published at a version. It runs when the PERIOD row becomes (or is
-- re-) published, not when a publication row is inserted, so it can only ever
-- announce the period's current published version, and only a version that has
-- its schedule_publications row. A period + version that already has a
-- 'schedule.published' job is never announced again.
create or replace function fn_schedule_period_publish_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_publication_id uuid;
begin
  if new.status <> 'published' or new.deleted_at is not null or coalesce(new.publish_version, 0) <= 0 then
    return new;
  end if;

  select p.id into v_publication_id
  from schedule_publications p
  where p.schedule_period_id = new.id
    and p.facility_id = new.facility_id
    and p.publish_version = new.publish_version;
  if not found then
    return new;
  end if;

  if exists (
    select 1 from notification_jobs j
    where j.facility_id = new.facility_id
      and j.event_type = 'schedule.published'
      and j.payload_jsonb ->> 'periodId' = new.id::text
      and j.payload_jsonb ->> 'publishVersion' = new.publish_version::text
  ) then
    return new;
  end if;

  insert into notification_jobs (facility_id, event_type, status, dedupe_key, payload_jsonb)
  select
    new.facility_id,
    'schedule.published',
    'pending',
    null,
    jsonb_build_object(
      'sourceId', v_publication_id,
      'periodId', new.id,
      'publishVersion', new.publish_version,
      'recipients', jsonb_build_array(r.employee_id::text),
      'channels', jsonb_build_array('in_app'),
      'title', 'Schedule published',
      'body', 'The schedule for the week of ' || new.week_start_date::text
        || ' was published (version ' || new.publish_version::text || '). Check your shifts.'
    )
  from (
    select distinct a.employee_id
    from shift_assignments a
    join schedule_shifts s on s.id = a.shift_id
    join employees e on e.id = a.employee_id
    where s.schedule_period_id = new.id
      and s.facility_id = new.facility_id
      and a.facility_id = new.facility_id
      and a.status in ('pending', 'approved')
      and a.deleted_at is null
      and s.deleted_at is null
      and e.deleted_at is null
      and e.status = 'active'
  ) r;

  return new;
end;
$$;

drop trigger if exists schedule_periods_publish_notify on schedule_periods;
create trigger schedule_periods_publish_notify
  after update of status, publish_version on schedule_periods
  for each row
  when (new.status = 'published'
        and (old.status is distinct from new.status or old.publish_version is distinct from new.publish_version))
  execute function fn_schedule_period_publish_notify();

revoke execute on function fn_schedule_period_publish_notify() from public, authenticated;
revoke execute on function internal.fn_enqueue_schedule_notification(uuid, text, uuid, uuid, text, text, jsonb) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_schedule_period_publish_notify() from anon;
    revoke execute on function internal.fn_enqueue_schedule_notification(uuid, text, uuid, uuid, text, text, jsonb) from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 10. Decision-time re-validation, shared by the three RPCs. Returns
-- {blocking: [...], warnings: [...]} for "may this employee work this shift
-- right now". Mirrors src/lib/scheduling.mjs's checkAssignmentEligibility
-- (which wires findMissingCertifications / shiftsOverlap on the JS side):
--   * certifications: every required cert type must be held, active and
--     unexpired on the shift date. Missing -> blocking, or a warning when the
--     facility's scheduling.certEnforcementMode is 'warning'.
--   * overlap/already-assigned: blocking when scheduling.conflictCheckEnabled
--     is not 'false' (already-assigned is always blocking).
--   * time off: an APPROVED overlap blocks only when
--     scheduling.timeOffConflictMode is 'hard-block' (default 'warning'); a
--     PENDING overlap is always a warning.
--   * availability: always a warning.
-- p_ignore_assignment_ids are assignments about to be cancelled by the same
-- decision (a swap's two legs), excluded from the overlap test.
-- ---------------------------------------------------------------------------
create or replace function internal.fn_assignment_blockers(
  p_employee_id uuid,
  p_shift_id uuid,
  p_ignore_assignment_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift schedule_shifts%rowtype;
  v_employee employees%rowtype;
  v_blocking jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_cert_mode text;
  v_conflict_enabled boolean;
  v_time_off_mode text;
  v_tz text;
  v_cert uuid;
  v_row record;
  v_avail employee_availability%rowtype;
  v_local_start timestamp;
  v_local_end timestamp;
begin
  select * into v_shift from schedule_shifts where id = p_shift_id;
  if not found then
    return jsonb_build_object(
      'blocking', jsonb_build_array(jsonb_build_object('code', 'shift_not_found', 'shiftId', p_shift_id)),
      'warnings', v_warnings
    );
  end if;

  select * into v_employee from employees where id = p_employee_id;
  if not found or v_employee.facility_id <> v_shift.facility_id
     or v_employee.deleted_at is not null or v_employee.status <> 'active' then
    return jsonb_build_object(
      'blocking', jsonb_build_array(jsonb_build_object('code', 'employee_ineligible', 'employeeId', p_employee_id)),
      'warnings', v_warnings
    );
  end if;

  v_cert_mode := coalesce(internal.fn_scheduling_setting(v_shift.facility_id, 'scheduling.certEnforcementMode'), 'hard-block');
  if v_cert_mode not in ('hard-block', 'warning') then
    v_cert_mode := 'hard-block';
  end if;
  v_conflict_enabled := internal.fn_scheduling_setting(v_shift.facility_id, 'scheduling.conflictCheckEnabled') is distinct from 'false';
  v_time_off_mode := coalesce(internal.fn_scheduling_setting(v_shift.facility_id, 'scheduling.timeOffConflictMode'), 'warning');
  if v_time_off_mode not in ('hard-block', 'warning') then
    v_time_off_mode := 'warning';
  end if;

  -- Certifications.
  foreach v_cert in array coalesce(v_shift.required_certification_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from employee_certifications ec
      where ec.employee_id = p_employee_id
        and ec.certification_type_id = v_cert
        and ec.deleted_at is null
        and ec.status = 'active'
        and (ec.expires_at is null or ec.expires_at >= v_shift.shift_date)
    ) then
      if v_cert_mode = 'warning' then
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
          'code', 'missing_certification', 'certificationTypeId', v_cert, 'employeeId', p_employee_id, 'shiftId', p_shift_id));
      else
        v_blocking := v_blocking || jsonb_build_array(jsonb_build_object(
          'code', 'missing_certification', 'certificationTypeId', v_cert, 'employeeId', p_employee_id, 'shiftId', p_shift_id));
      end if;
    end if;
  end loop;

  -- Already assigned / overlap with the employee's other live assignments.
  for v_row in
    select a.id as assignment_id, s.id as shift_id
    from shift_assignments a
    join schedule_shifts s on s.id = a.shift_id
    where a.employee_id = p_employee_id
      and a.facility_id = v_shift.facility_id
      and a.status in ('pending', 'approved')
      and a.deleted_at is null
      and s.deleted_at is null
      and s.status <> 'cancelled'
      and not (a.id = any (coalesce(p_ignore_assignment_ids, '{}'::uuid[])))
      and (
        s.id = p_shift_id
        or (v_conflict_enabled and s.starts_at < v_shift.ends_at and v_shift.starts_at < s.ends_at)
      )
  loop
    v_blocking := v_blocking || jsonb_build_array(jsonb_build_object(
      'code', case when v_row.shift_id = p_shift_id then 'already_assigned' else 'overlap' end,
      'employeeId', p_employee_id, 'assignmentId', v_row.assignment_id, 'shiftIds', jsonb_build_array(v_row.shift_id, p_shift_id)));
  end loop;

  -- Time off.
  for v_row in
    select t.id, t.status
    from time_off_requests t
    where t.employee_id = p_employee_id
      and t.facility_id = v_shift.facility_id
      and t.deleted_at is null
      and t.status in ('pending', 'approved')
      and t.starts_at < v_shift.ends_at
      and v_shift.starts_at < t.ends_at
  loop
    if v_row.status = 'approved' and v_time_off_mode = 'hard-block' then
      v_blocking := v_blocking || jsonb_build_array(jsonb_build_object(
        'code', 'time_off', 'timeOffRequestId', v_row.id, 'employeeId', p_employee_id, 'shiftId', p_shift_id));
    else
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', case when v_row.status = 'approved' then 'time_off' else 'time_off_pending' end,
        'timeOffRequestId', v_row.id, 'employeeId', p_employee_id, 'shiftId', p_shift_id));
    end if;
  end loop;

  -- Availability (always a warning).
  select coalesce(f.timezone, 'UTC') into v_tz from facilities f where f.id = v_shift.facility_id;
  select * into v_avail
  from employee_availability av
  where av.employee_id = p_employee_id
    and av.facility_id = v_shift.facility_id
    and av.deleted_at is null
    and av.weekday = extract(dow from v_shift.shift_date)::integer
    and av.effective_from <= v_shift.shift_date
    and (av.effective_to is null or av.effective_to >= v_shift.shift_date)
  order by av.effective_from desc
  limit 1;
  if found then
    v_local_start := v_shift.starts_at at time zone v_tz;
    v_local_end := v_shift.ends_at at time zone v_tz;
    if v_avail.unavailable then
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'unavailable', 'employeeId', p_employee_id, 'shiftId', p_shift_id));
    elsif v_avail.available_start_local is not null and (
      v_local_start::time < v_avail.available_start_local
      or v_local_end::date > v_local_start::date
      or v_local_end::time > v_avail.available_end_local
    ) then
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'outside_availability', 'employeeId', p_employee_id, 'shiftId', p_shift_id));
    end if;
  end if;

  return jsonb_build_object('blocking', v_blocking, 'warnings', v_warnings);
end;
$$;

-- Assigns (or revives) an approved assignment, returning its id.
create or replace function internal.fn_assign_employee_to_shift(
  p_facility_id uuid,
  p_shift_id uuid,
  p_employee_id uuid,
  p_assignment_type text,
  p_actor uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- Serialise every assignment of one employee (the decision RPCs already hold
  -- this lock; taking it again in the same transaction is free).
  perform 1 from employees where id = p_employee_id order by id for update;

  insert into shift_assignments (facility_id, shift_id, employee_id, assignment_type, status, assigned_by)
  values (
    p_facility_id, p_shift_id, p_employee_id, p_assignment_type, 'approved',
    (select u.id from app_users u where u.id = p_actor)
  )
  on conflict (shift_id, employee_id, assignment_type) do update
    set status = 'approved',
        assigned_by = excluded.assigned_by,
        deleted_at = null,
        updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- Hard-block time off, enforced for EVERY writer of shift_assignments (the
-- service role and the definer paths included): while the facility's
-- scheduling.timeOffConflictMode is 'hard-block', a live assignment cannot be
-- created -- or revived, or moved to another shift or employee -- for an
-- employee who has approved time off overlapping the shift. SECURITY DEFINER
-- because the writer (a schedule.manage holder without schedule.approve.time_off)
-- cannot read time_off_requests, and the mode lives in tables only
-- admin.manage can read. The employee row is locked first, the same lock the
-- decision RPCs take before approving time off, so an approval and an
-- assignment for one employee never interleave unseen.
create or replace function fn_shift_assignment_time_off_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift schedule_shifts%rowtype;
  v_mode text;
  v_time_off uuid;
begin
  if new.deleted_at is not null or new.status not in ('pending', 'approved') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.deleted_at is null
     and old.status in ('pending', 'approved')
     and old.shift_id = new.shift_id
     and old.employee_id = new.employee_id then
    return new;
  end if;

  perform 1 from employees where id = new.employee_id order by id for update;

  select * into v_shift from schedule_shifts where id = new.shift_id;
  if not found or v_shift.deleted_at is not null or v_shift.status = 'cancelled' then
    return new;
  end if;

  v_mode := coalesce(internal.fn_scheduling_setting(v_shift.facility_id, 'scheduling.timeOffConflictMode'), 'warning');
  if v_mode <> 'hard-block' then
    return new;
  end if;

  select t.id into v_time_off
  from time_off_requests t
  where t.employee_id = new.employee_id
    and t.facility_id = v_shift.facility_id
    and t.status = 'approved'
    and t.deleted_at is null
    and t.starts_at < v_shift.ends_at
    and v_shift.starts_at < t.ends_at
  limit 1;
  if found then
    raise exception 'shift_assignments: the employee has approved time off during this shift (scheduling.timeOffConflictMode is hard-block).'
      using errcode = 'PT409', detail = jsonb_build_object('code', 'time_off', 'timeOffRequestId', v_time_off)::text;
  end if;
  return new;
end;
$$;

drop trigger if exists shift_assignments_time_off_guard on shift_assignments;
create trigger shift_assignments_time_off_guard
  before insert or update on shift_assignments
  for each row execute function fn_shift_assignment_time_off_guard();

revoke execute on function fn_shift_assignment_time_off_guard() from public, authenticated;
revoke execute on function internal.get_scheduling_config_layers(uuid) from public;
grant execute on function internal.get_scheduling_config_layers(uuid) to authenticated;
revoke execute on function internal.fn_assignment_blockers(uuid, uuid, uuid[]) from public, authenticated;
revoke execute on function internal.fn_assign_employee_to_shift(uuid, uuid, uuid, text, uuid) from public, authenticated;
revoke execute on function internal.fn_scheduling_setting(uuid, text) from public, authenticated;
revoke execute on function internal.fn_scheduling_setting_int(uuid, text, integer) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_shift_assignment_time_off_guard() from anon;
    revoke execute on function internal.get_scheduling_config_layers(uuid) from anon;
    revoke execute on function internal.fn_assignment_blockers(uuid, uuid, uuid[]) from anon;
    revoke execute on function internal.fn_assign_employee_to_shift(uuid, uuid, uuid, text, uuid) from anon;
    revoke execute on function internal.fn_scheduling_setting(uuid, text) from anon;
    revoke execute on function internal.fn_scheduling_setting_int(uuid, text, integer) from anon;
    revoke execute on function internal.fn_shift_period_published(uuid) from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 11. internal.decide_open_shift_claim (SC-11).
-- Deny needs a reason. Approve re-validates, in this order, under the
-- claimant's and the shift's row locks: the shift is still open, unstarted,
-- unfilled and in a published period; the claim was filed inside the claim
-- window; the claimant is still eligible (certifications, overlap, time off,
-- availability); then in ONE transaction creates the assignment, marks the
-- shift assigned, decides the claim and auto-denies every competing pending
-- claim on that shift.
-- The claim window is a limit on WHEN a claim may be filed (the insert guard
-- enforces it against the server-owned opened_at); a manager may legitimately
-- decide after the window has closed, so approval re-checks that the claim
-- itself was filed inside the window as the facility's setting reads now, not
-- that the window is still open at decision time.
-- ---------------------------------------------------------------------------
create or replace function internal.decide_open_shift_claim(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_claim open_shift_claims%rowtype;
  v_shift schedule_shifts%rowtype;
  v_shift_id uuid;
  v_facility_id uuid;
  v_claimant_id uuid;
  v_blockers jsonb;
  v_assignment_id uuid;
  v_actor_user uuid;
  v_sibling record;
  v_denied jsonb := '[]'::jsonb;
  v_target_status text;
  v_window integer;
begin
  if v_actor is null then
    raise exception 'decide_open_shift_claim: authentication required' using errcode = '28000';
  end if;
  if v_decision not in ('approve', 'deny') then
    raise exception 'decide_open_shift_claim: decision must be approve or deny' using errcode = '22023';
  end if;
  if v_decision = 'deny' and v_reason is null then
    raise exception 'decide_open_shift_claim: a denial requires a reason' using errcode = 'check_violation';
  end if;
  v_target_status := case v_decision when 'approve' then 'approved' else 'denied' end;

  -- Unlocked read to learn the facility, shift and claimant. A missing id and
  -- an id outside the caller's facilities answer identically.
  select shift_id, facility_id, claimant_employee_id into v_shift_id, v_facility_id, v_claimant_id
  from open_shift_claims where id = p_request_id and deleted_at is null;
  if not found or v_facility_id not in (select internal.current_facility_ids()) then
    raise exception 'decide_open_shift_claim: request not found' using errcode = 'P0002';
  end if;

  -- The permission is checked BEFORE any lock is taken, so an unauthorised
  -- caller can neither hold a lock nor learn anything else.
  if not (
    internal.has_permission(v_actor, v_facility_id, 'schedule.manage.open_shifts')
    or internal.has_permission(v_actor, v_facility_id, 'schedule.manage')
  ) then
    raise exception 'decide_open_shift_claim: missing permission: schedule.manage.open_shifts' using errcode = '42501';
  end if;

  -- A decider cannot be the claimant.
  if exists (
    select 1 from employees e
    where e.id = v_claimant_id and e.facility_id = v_facility_id and e.user_id = v_actor
  ) then
    raise exception 'decide_open_shift_claim: you cannot decide a request you are a party to' using errcode = '42501';
  end if;

  -- Lock order everywhere: employee -> shift -> request.
  perform 1 from employees where id = v_claimant_id order by id for update;
  select * into v_shift from schedule_shifts where id = v_shift_id for update;
  select * into v_claim from open_shift_claims where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'decide_open_shift_claim: request not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: the same decision again returns the stored row.
  if v_claim.claim_status = v_target_status then
    return jsonb_build_object('request', to_jsonb(v_claim), 'decided', false, 'replay', true,
      'warnings', '[]'::jsonb, 'denied_claim_ids', '[]'::jsonb);
  end if;
  if v_claim.claim_status <> 'pending' then
    raise exception 'decide_open_shift_claim: claim is already %', v_claim.claim_status using errcode = 'PT409';
  end if;

  select u.id into v_actor_user from app_users u where u.id = v_actor;
  perform set_config('rr.schedule_decision', v_claim.id::text, true);

  if v_decision = 'deny' then
    update open_shift_claims
      set claim_status = 'denied', manager_id = v_actor_user, decided_at = now(), decision_reason = v_reason
      where id = v_claim.id
      returning * into v_claim;
    perform internal.fn_enqueue_schedule_notification(
      v_claim.facility_id, 'schedule.claim_decided', v_claim.id, v_claim.claimant_employee_id,
      'Open shift claim denied', 'Your claim on an open shift was denied: ' || v_reason,
      jsonb_build_object('requestType', 'open_shift_claim', 'decision', 'denied'));
    perform set_config('rr.schedule_decision', '', true);
    return jsonb_build_object('request', to_jsonb(v_claim), 'decided', true, 'replay', false,
      'warnings', '[]'::jsonb, 'denied_claim_ids', '[]'::jsonb);
  end if;

  -- Approve: re-validate against the shift as it is NOW.
  if v_shift.id is null or v_shift.deleted_at is not null or v_shift.facility_id <> v_claim.facility_id then
    raise exception 'decide_open_shift_claim: the shift no longer exists' using errcode = 'PT409';
  end if;
  if v_shift.status <> 'open' then
    raise exception 'decide_open_shift_claim: the shift is no longer open' using errcode = 'PT409';
  end if;
  if v_shift.starts_at <= now() then
    raise exception 'decide_open_shift_claim: the shift has already started' using errcode = 'PT409';
  end if;
  if not internal.fn_shift_period_published(v_shift.id) then
    raise exception 'decide_open_shift_claim: the shift is no longer in a published schedule period' using errcode = 'PT409';
  end if;
  v_window := internal.fn_scheduling_setting_int(v_claim.facility_id, 'scheduling.openShiftClaimWindowHours', 48);
  if v_claim.created_at > coalesce(v_shift.opened_at, v_shift.updated_at) + make_interval(hours => v_window) then
    raise exception 'decide_open_shift_claim: the claim was filed after the claim window for this shift closed' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from shift_assignments a
    where a.shift_id = v_shift.id and a.status in ('pending', 'approved') and a.deleted_at is null
  ) then
    raise exception 'decide_open_shift_claim: the shift already has an assignment' using errcode = 'PT409';
  end if;

  v_blockers := internal.fn_assignment_blockers(v_claim.claimant_employee_id, v_shift.id, '{}'::uuid[]);
  if jsonb_array_length(v_blockers -> 'blocking') > 0 then
    raise exception 'decide_open_shift_claim: the claimant is not eligible for this shift'
      using errcode = 'PT409', detail = v_blockers::text;
  end if;

  v_assignment_id := internal.fn_assign_employee_to_shift(
    v_claim.facility_id, v_shift.id, v_claim.claimant_employee_id, 'primary', v_actor);
  update schedule_shifts set status = 'assigned', updated_at = now() where id = v_shift.id;

  update open_shift_claims
    set claim_status = 'approved', manager_id = v_actor_user, decided_at = now(), decision_reason = v_reason
    where id = v_claim.id
    returning * into v_claim;
  perform internal.fn_enqueue_schedule_notification(
    v_claim.facility_id, 'schedule.claim_decided', v_claim.id, v_claim.claimant_employee_id,
    'Open shift claim approved', 'Your claim on an open shift was approved. Check your schedule.',
    jsonb_build_object('requestType', 'open_shift_claim', 'decision', 'approved'));

  -- Auto-deny every competing pending claim on the same shift.
  for v_sibling in
    select id from open_shift_claims
    where shift_id = v_shift.id and id <> v_claim.id and claim_status = 'pending' and deleted_at is null
    order by created_at, id
    for update
  loop
    perform set_config('rr.schedule_decision', v_sibling.id::text, true);
    update open_shift_claims
      set claim_status = 'denied', manager_id = v_actor_user, decided_at = now(),
          decision_reason = 'Another claim was approved for this shift.'
      where id = v_sibling.id;
    v_denied := v_denied || jsonb_build_array(v_sibling.id);
    perform internal.fn_enqueue_schedule_notification(
      v_claim.facility_id, 'schedule.claim_decided', v_sibling.id,
      (select claimant_employee_id from open_shift_claims where id = v_sibling.id),
      'Open shift claim denied', 'Your claim on an open shift was denied: another claim was approved for this shift.',
      jsonb_build_object('requestType', 'open_shift_claim', 'decision', 'denied'));
  end loop;
  perform set_config('rr.schedule_decision', '', true);

  return jsonb_build_object('request', to_jsonb(v_claim), 'decided', true, 'replay', false,
    'assignment_id', v_assignment_id, 'warnings', v_blockers -> 'warnings', 'denied_claim_ids', v_denied);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. internal.decide_shift_swap (SC-12).
-- direct: requester's offered assignment <-> target's requested assignment.
-- drop_pickup: the offered assignment moves to the named target, or, with no
-- target, is cancelled and the shift reopened. A request that names a
-- colleague cannot be APPROVED before that colleague accepted it
-- (internal.respond_to_shift_swap); a denial never waits for them. Approval
-- re-validates that both assignments are STILL the live assignments the
-- request named (a reassigned or cancelled one makes the swap stale -> 409),
-- then certifications / overlap / time off / availability for BOTH incoming
-- employees, ignoring the two assignments the swap itself removes.
-- ---------------------------------------------------------------------------
create or replace function internal.decide_shift_swap(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_swap shift_swap_requests%rowtype;
  v_offered shift_assignments%rowtype;
  v_requested shift_assignments%rowtype;
  v_offered_shift schedule_shifts%rowtype;
  v_requested_shift schedule_shifts%rowtype;
  v_shift_ids uuid[];
  v_blockers jsonb;
  v_blocking jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_ignore uuid[];
  v_actor_user uuid;
  v_assignment_ids jsonb := '[]'::jsonb;
  v_new_id uuid;
  v_target_status text;
begin
  if v_actor is null then
    raise exception 'decide_shift_swap: authentication required' using errcode = '28000';
  end if;
  if v_decision not in ('approve', 'deny') then
    raise exception 'decide_shift_swap: decision must be approve or deny' using errcode = '22023';
  end if;
  if v_decision = 'deny' and v_reason is null then
    raise exception 'decide_shift_swap: a denial requires a reason' using errcode = 'check_violation';
  end if;
  v_target_status := case v_decision when 'approve' then 'approved' else 'denied' end;

  select * into v_swap from shift_swap_requests where id = p_request_id and deleted_at is null;
  if not found or v_swap.facility_id not in (select internal.current_facility_ids()) then
    raise exception 'decide_shift_swap: request not found' using errcode = 'P0002';
  end if;

  if not (
    internal.has_permission(v_actor, v_swap.facility_id, 'schedule.approve.swaps')
    or internal.has_permission(v_actor, v_swap.facility_id, 'schedule.manage')
  ) then
    raise exception 'decide_shift_swap: missing permission: schedule.approve.swaps' using errcode = '42501';
  end if;

  -- A decider cannot be either party to the swap.
  if exists (
    select 1 from employees e
    where e.facility_id = v_swap.facility_id and e.user_id = v_actor
      and e.id in (v_swap.requester_employee_id, coalesce(v_swap.target_employee_id, v_swap.requester_employee_id))
  ) then
    raise exception 'decide_shift_swap: you cannot decide a request you are a party to' using errcode = '42501';
  end if;

  -- Lock order everywhere: employees (ascending id) -> shifts (ascending id)
  -- -> request.
  perform 1 from employees
    where id = any (array_remove(array[v_swap.requester_employee_id, v_swap.target_employee_id], null))
    order by id for update;
  select array_agg(distinct a.shift_id order by a.shift_id) into v_shift_ids
  from shift_assignments a
  where a.id in (v_swap.offered_assignment_id, coalesce(v_swap.requested_assignment_id, v_swap.offered_assignment_id));
  perform 1 from schedule_shifts where id = any (coalesce(v_shift_ids, '{}'::uuid[])) order by id for update;

  select * into v_swap from shift_swap_requests where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'decide_shift_swap: request not found' using errcode = 'P0002';
  end if;

  if v_swap.status = v_target_status then
    return jsonb_build_object('request', to_jsonb(v_swap), 'decided', false, 'replay', true,
      'warnings', '[]'::jsonb, 'assignment_ids', '[]'::jsonb);
  end if;
  if v_swap.status <> 'pending' then
    raise exception 'decide_shift_swap: swap request is already %', v_swap.status using errcode = 'PT409';
  end if;
  if v_decision = 'approve' and v_swap.target_employee_id is not null and v_swap.target_accepted_at is null then
    raise exception 'decide_shift_swap: the colleague named in this request has not accepted it yet' using errcode = 'PT409';
  end if;

  select u.id into v_actor_user from app_users u where u.id = v_actor;
  perform set_config('rr.schedule_decision', v_swap.id::text, true);

  if v_decision = 'deny' then
    update shift_swap_requests
      set status = 'denied', manager_id = v_actor_user, decided_at = now(), decision_reason = v_reason
      where id = v_swap.id
      returning * into v_swap;
    perform internal.fn_enqueue_schedule_notification(
      v_swap.facility_id, 'schedule.swap_decided', v_swap.id, v_swap.requester_employee_id,
      'Shift swap denied', 'Your shift swap request was denied: ' || v_reason,
      jsonb_build_object('requestType', 'shift_swap', 'decision', 'denied'));
    perform set_config('rr.schedule_decision', '', true);
    return jsonb_build_object('request', to_jsonb(v_swap), 'decided', true, 'replay', false,
      'warnings', '[]'::jsonb, 'assignment_ids', '[]'::jsonb);
  end if;

  -- Approve: both legs must still be exactly what the request named.
  select * into v_offered from shift_assignments where id = v_swap.offered_assignment_id for update;
  if not found or v_offered.deleted_at is not null or v_offered.status not in ('pending', 'approved')
     or v_offered.employee_id <> v_swap.requester_employee_id then
    raise exception 'decide_shift_swap: stale request: the offered assignment changed' using errcode = 'PT409';
  end if;
  select * into v_offered_shift from schedule_shifts where id = v_offered.shift_id;
  if v_offered_shift.deleted_at is not null or v_offered_shift.status = 'cancelled' or v_offered_shift.starts_at <= now() then
    raise exception 'decide_shift_swap: stale request: the offered shift is cancelled or has started' using errcode = 'PT409';
  end if;
  v_ignore := array[v_offered.id];

  if v_swap.swap_type = 'direct' then
    select * into v_requested from shift_assignments where id = v_swap.requested_assignment_id for update;
    if not found or v_requested.deleted_at is not null or v_requested.status not in ('pending', 'approved')
       or v_requested.employee_id is distinct from v_swap.target_employee_id then
      raise exception 'decide_shift_swap: stale request: the requested assignment changed' using errcode = 'PT409';
    end if;
    select * into v_requested_shift from schedule_shifts where id = v_requested.shift_id;
    if v_requested_shift.deleted_at is not null or v_requested_shift.status = 'cancelled' or v_requested_shift.starts_at <= now() then
      raise exception 'decide_shift_swap: stale request: the requested shift is cancelled or has started' using errcode = 'PT409';
    end if;
    v_ignore := v_ignore || v_requested.id;
  end if;

  -- Re-validate each INCOMING employee against the shift they would take.
  if v_swap.target_employee_id is not null then
    v_blockers := internal.fn_assignment_blockers(v_swap.target_employee_id, v_offered_shift.id, v_ignore);
    v_blocking := v_blocking || (v_blockers -> 'blocking');
    v_warnings := v_warnings || (v_blockers -> 'warnings');
  end if;
  if v_swap.swap_type = 'direct' then
    v_blockers := internal.fn_assignment_blockers(v_swap.requester_employee_id, v_requested_shift.id, v_ignore);
    v_blocking := v_blocking || (v_blockers -> 'blocking');
    v_warnings := v_warnings || (v_blockers -> 'warnings');
  end if;
  if jsonb_array_length(v_blocking) > 0 then
    raise exception 'decide_shift_swap: a participant is not eligible for the shift they would take'
      using errcode = 'PT409', detail = jsonb_build_object('blocking', v_blocking, 'warnings', v_warnings)::text;
  end if;

  -- Writes: one transaction.
  update shift_assignments set status = 'cancelled', updated_at = now() where id = v_offered.id;
  if v_swap.target_employee_id is not null then
    v_new_id := internal.fn_assign_employee_to_shift(
      v_swap.facility_id, v_offered_shift.id, v_swap.target_employee_id, v_offered.assignment_type, v_actor);
    v_assignment_ids := v_assignment_ids || jsonb_build_array(v_new_id);
  else
    -- A drop with no named pickup reopens the shift for claims.
    update schedule_shifts set status = 'open', updated_at = now() where id = v_offered_shift.id;
  end if;
  if v_swap.swap_type = 'direct' then
    update shift_assignments set status = 'cancelled', updated_at = now() where id = v_requested.id;
    v_new_id := internal.fn_assign_employee_to_shift(
      v_swap.facility_id, v_requested_shift.id, v_swap.requester_employee_id, v_requested.assignment_type, v_actor);
    v_assignment_ids := v_assignment_ids || jsonb_build_array(v_new_id);
  end if;

  update shift_swap_requests
    set status = 'approved', manager_id = v_actor_user, decided_at = now(), decision_reason = v_reason
    where id = v_swap.id
    returning * into v_swap;
  perform set_config('rr.schedule_decision', '', true);

  perform internal.fn_enqueue_schedule_notification(
    v_swap.facility_id, 'schedule.swap_decided', v_swap.id, v_swap.requester_employee_id,
    'Shift swap approved', 'Your shift swap request was approved. Check your schedule.',
    jsonb_build_object('requestType', 'shift_swap', 'decision', 'approved'));
  if v_swap.target_employee_id is not null then
    perform internal.fn_enqueue_schedule_notification(
      v_swap.facility_id, 'schedule.swap_decided', v_swap.id, v_swap.target_employee_id,
      'Shift swap approved', 'A shift swap involving you was approved. Check your schedule.',
      jsonb_build_object('requestType', 'shift_swap', 'decision', 'approved'));
  end if;

  return jsonb_build_object('request', to_jsonb(v_swap), 'decided', true, 'replay', false,
    'warnings', v_warnings, 'assignment_ids', v_assignment_ids);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12b. internal.respond_to_shift_swap: the named colleague's consent. ONLY the
-- employee a pending request names as its target can call it (anyone else,
-- the requester included, gets the same not-found as a missing id).
-- 'accept' stamps target_accepted_at (decide_shift_swap needs it before an
-- approval); 'decline' stamps target_declined_at and ends the request
-- (status 'cancelled'). Repeating the same answer is a replay; the opposite
-- answer, or any answer to a request that is no longer pending, is a 409.
-- ---------------------------------------------------------------------------
create or replace function internal.respond_to_shift_swap(
  p_request_id uuid,
  p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_response text := lower(btrim(coalesce(p_response, '')));
  v_swap shift_swap_requests%rowtype;
begin
  if v_actor is null then
    raise exception 'respond_to_shift_swap: authentication required' using errcode = '28000';
  end if;
  if v_response not in ('accept', 'decline') then
    raise exception 'respond_to_shift_swap: response must be accept or decline' using errcode = '22023';
  end if;

  select * into v_swap from shift_swap_requests where id = p_request_id and deleted_at is null;
  if not found or v_swap.target_employee_id is null or not exists (
    select 1 from employees e
    where e.id = v_swap.target_employee_id and e.facility_id = v_swap.facility_id
      and e.user_id = v_actor and e.deleted_at is null and e.status = 'active'
  ) then
    raise exception 'respond_to_shift_swap: request not found' using errcode = 'P0002';
  end if;

  select * into v_swap from shift_swap_requests where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'respond_to_shift_swap: request not found' using errcode = 'P0002';
  end if;

  if v_response = 'accept' and v_swap.target_accepted_at is not null then
    return jsonb_build_object('request', to_jsonb(v_swap), 'replay', true);
  end if;
  if v_response = 'decline' and v_swap.target_declined_at is not null then
    return jsonb_build_object('request', to_jsonb(v_swap), 'replay', true);
  end if;
  if v_swap.status <> 'pending' or v_swap.target_accepted_at is not null or v_swap.target_declined_at is not null then
    raise exception 'respond_to_shift_swap: this request can no longer be answered' using errcode = 'PT409';
  end if;
  if v_swap.swap_type = 'direct' and v_response = 'accept' and not exists (
    select 1 from shift_assignments a
    where a.id = v_swap.requested_assignment_id and a.employee_id = v_swap.target_employee_id
      and a.status in ('pending', 'approved') and a.deleted_at is null
  ) then
    raise exception 'respond_to_shift_swap: your assignment named in this request has changed' using errcode = 'PT409';
  end if;

  perform set_config('rr.schedule_decision', v_swap.id::text, true);
  if v_response = 'accept' then
    update shift_swap_requests set target_accepted_at = now() where id = v_swap.id returning * into v_swap;
  else
    update shift_swap_requests set target_declined_at = now(), status = 'cancelled' where id = v_swap.id returning * into v_swap;
  end if;
  perform set_config('rr.schedule_decision', '', true);

  perform internal.fn_enqueue_schedule_notification(
    v_swap.facility_id, 'schedule.swap_decided', v_swap.id, v_swap.requester_employee_id,
    case v_response when 'accept' then 'Shift swap accepted' else 'Shift swap declined' end,
    case v_response
      when 'accept' then 'Your colleague accepted your shift swap request; it now awaits manager approval.'
      else 'Your colleague declined your shift swap request.'
    end,
    jsonb_build_object('requestType', 'shift_swap', 'decision', case v_response when 'accept' then 'accepted' else 'declined' end));

  return jsonb_build_object('request', to_jsonb(v_swap), 'replay', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. internal.decide_time_off_request (SC-13). Needs the dedicated
-- schedule.approve.time_off code (schedule.manage does NOT satisfy it) and a
-- decider who is not the requesting employee. The employee's own live
-- assignments overlapping the window are returned as warnings -- or, when
-- scheduling.timeOffConflictMode is 'hard-block', block the approval until a
-- manager has reassigned them.
-- ---------------------------------------------------------------------------
create or replace function internal.decide_time_off_request(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_request time_off_requests%rowtype;
  v_facility_id uuid;
  v_employee_id uuid;
  v_employee employees%rowtype;
  v_actor_user uuid;
  v_mode text;
  v_affected jsonb;
  v_target_status text;
begin
  if v_actor is null then
    raise exception 'decide_time_off_request: authentication required' using errcode = '28000';
  end if;
  if v_decision not in ('approve', 'deny') then
    raise exception 'decide_time_off_request: decision must be approve or deny' using errcode = '22023';
  end if;
  if v_decision = 'deny' and v_reason is null then
    raise exception 'decide_time_off_request: a denial requires a reason' using errcode = 'check_violation';
  end if;
  v_target_status := case v_decision when 'approve' then 'approved' else 'denied' end;

  -- Unlocked read, then the permission check, BEFORE any lock.
  select facility_id, employee_id into v_facility_id, v_employee_id
  from time_off_requests where id = p_request_id and deleted_at is null;
  if not found or v_facility_id not in (select internal.current_facility_ids()) then
    raise exception 'decide_time_off_request: request not found' using errcode = 'P0002';
  end if;

  if not internal.has_permission(v_actor, v_facility_id, 'schedule.approve.time_off') then
    raise exception 'decide_time_off_request: missing permission: schedule.approve.time_off' using errcode = '42501';
  end if;

  -- A decider cannot approve or deny their own time off.
  if exists (
    select 1 from employees e
    where e.id = v_employee_id and e.facility_id = v_facility_id and e.user_id = v_actor
  ) then
    raise exception 'decide_time_off_request: you cannot decide a request you are a party to' using errcode = '42501';
  end if;

  -- Lock order everywhere: employee -> shift -> request.
  perform 1 from employees where id = v_employee_id order by id for update;
  select * into v_request from time_off_requests where id = p_request_id and deleted_at is null for update;
  if not found then
    raise exception 'decide_time_off_request: request not found' using errcode = 'P0002';
  end if;

  if v_request.status = v_target_status then
    return jsonb_build_object('request', to_jsonb(v_request), 'decided', false, 'replay', true,
      'warnings', '[]'::jsonb, 'affected_assignments', '[]'::jsonb);
  end if;
  if v_request.status <> 'pending' then
    raise exception 'decide_time_off_request: request is already %', v_request.status using errcode = 'PT409';
  end if;

  select u.id into v_actor_user from app_users u where u.id = v_actor;
  perform set_config('rr.schedule_decision', v_request.id::text, true);

  if v_decision = 'deny' then
    update time_off_requests
      set status = 'denied', manager_id = v_actor_user, decided_at = now(), decision_notes = v_reason
      where id = v_request.id
      returning * into v_request;
    perform internal.fn_enqueue_schedule_notification(
      v_request.facility_id, 'schedule.time_off_decided', v_request.id, v_request.employee_id,
      'Time off denied', 'Your time-off request was denied: ' || v_reason,
      jsonb_build_object('requestType', 'time_off', 'decision', 'denied'));
    perform set_config('rr.schedule_decision', '', true);
    return jsonb_build_object('request', to_jsonb(v_request), 'decided', true, 'replay', false,
      'warnings', '[]'::jsonb, 'affected_assignments', '[]'::jsonb);
  end if;

  -- Approve: the window must still be in the future and the employee active.
  select * into v_employee from employees where id = v_request.employee_id;
  if not found or v_employee.facility_id <> v_request.facility_id
     or v_employee.deleted_at is not null or v_employee.status <> 'active' then
    raise exception 'decide_time_off_request: the employee is no longer active in this facility' using errcode = 'PT409';
  end if;
  if v_request.ends_at <= now() then
    raise exception 'decide_time_off_request: the requested window has already ended' using errcode = 'PT409';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('assignmentId', a.id, 'shiftId', s.id)), '[]'::jsonb)
  into v_affected
  from shift_assignments a
  join schedule_shifts s on s.id = a.shift_id
  where a.employee_id = v_request.employee_id
    and a.facility_id = v_request.facility_id
    and a.status in ('pending', 'approved')
    and a.deleted_at is null
    and s.deleted_at is null
    and s.status <> 'cancelled'
    and s.starts_at < v_request.ends_at
    and v_request.starts_at < s.ends_at;

  v_mode := coalesce(internal.fn_scheduling_setting(v_request.facility_id, 'scheduling.timeOffConflictMode'), 'warning');
  if v_mode = 'hard-block' and jsonb_array_length(v_affected) > 0 then
    raise exception 'decide_time_off_request: the employee still has assignments in this window'
      using errcode = 'PT409', detail = jsonb_build_object('blocking', v_affected)::text;
  end if;

  update time_off_requests
    set status = 'approved', manager_id = v_actor_user, decided_at = now(), decision_notes = v_reason
    where id = v_request.id
    returning * into v_request;
  perform set_config('rr.schedule_decision', '', true);
  perform internal.fn_enqueue_schedule_notification(
    v_request.facility_id, 'schedule.time_off_decided', v_request.id, v_request.employee_id,
    'Time off approved', 'Your time-off request was approved.',
    jsonb_build_object('requestType', 'time_off', 'decision', 'approved'));

  return jsonb_build_object('request', to_jsonb(v_request), 'decided', true, 'replay', false,
    'warnings', case when jsonb_array_length(v_affected) > 0
      then jsonb_build_array(jsonb_build_object('code', 'assignments_in_window', 'assignments', v_affected))
      else '[]'::jsonb end,
    'affected_assignments', v_affected);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Grants + public invoker wrappers (0058's create_work_order_from_incident
-- pattern): the definer function is executable by authenticated only, and
-- PostgREST serves the thin wrapper in `public`.
-- ---------------------------------------------------------------------------
revoke execute on function internal.decide_open_shift_claim(uuid, text, text) from public;
grant execute on function internal.decide_open_shift_claim(uuid, text, text) to authenticated;
revoke execute on function internal.decide_shift_swap(uuid, text, text) from public;
grant execute on function internal.decide_shift_swap(uuid, text, text) to authenticated;
revoke execute on function internal.decide_time_off_request(uuid, text, text) from public;
grant execute on function internal.decide_time_off_request(uuid, text, text) to authenticated;
revoke execute on function internal.respond_to_shift_swap(uuid, text) from public;
grant execute on function internal.respond_to_shift_swap(uuid, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.decide_open_shift_claim(uuid, text, text) from anon;
    revoke execute on function internal.decide_shift_swap(uuid, text, text) from anon;
    revoke execute on function internal.decide_time_off_request(uuid, text, text) from anon;
    revoke execute on function internal.respond_to_shift_swap(uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.decide_open_shift_claim(uuid, text, text) to service_role;
    grant execute on function internal.decide_shift_swap(uuid, text, text) to service_role;
    grant execute on function internal.decide_time_off_request(uuid, text, text) to service_role;
    grant execute on function internal.respond_to_shift_swap(uuid, text) to service_role;
    grant execute on function internal.get_scheduling_config_layers(uuid) to service_role;
  end if;
end
$$;

create or replace function public.decide_open_shift_claim(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.decide_open_shift_claim(p_request_id, p_decision, p_reason);
$$;

create or replace function public.decide_shift_swap(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.decide_shift_swap(p_request_id, p_decision, p_reason);
$$;

create or replace function public.decide_time_off_request(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.decide_time_off_request(p_request_id, p_decision, p_reason);
$$;

create or replace function public.respond_to_shift_swap(
  p_request_id uuid,
  p_response text
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.respond_to_shift_swap(p_request_id, p_response);
$$;

create or replace function public.get_scheduling_config_layers(p_facility_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select internal.get_scheduling_config_layers(p_facility_id);
$$;

revoke execute on function public.decide_open_shift_claim(uuid, text, text) from public;
grant execute on function public.decide_open_shift_claim(uuid, text, text) to authenticated;
revoke execute on function public.decide_shift_swap(uuid, text, text) from public;
grant execute on function public.decide_shift_swap(uuid, text, text) to authenticated;
revoke execute on function public.decide_time_off_request(uuid, text, text) from public;
grant execute on function public.decide_time_off_request(uuid, text, text) to authenticated;
revoke execute on function public.respond_to_shift_swap(uuid, text) from public;
grant execute on function public.respond_to_shift_swap(uuid, text) to authenticated;
revoke execute on function public.get_scheduling_config_layers(uuid) from public;
grant execute on function public.get_scheduling_config_layers(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.decide_open_shift_claim(uuid, text, text) from anon;
    revoke execute on function public.decide_shift_swap(uuid, text, text) from anon;
    revoke execute on function public.decide_time_off_request(uuid, text, text) from anon;
    revoke execute on function public.respond_to_shift_swap(uuid, text) from anon;
    revoke execute on function public.get_scheduling_config_layers(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.decide_open_shift_claim(uuid, text, text) to service_role;
    grant execute on function public.decide_shift_swap(uuid, text, text) to service_role;
    grant execute on function public.decide_time_off_request(uuid, text, text) to service_role;
    grant execute on function public.respond_to_shift_swap(uuid, text) to service_role;
    grant execute on function public.get_scheduling_config_layers(uuid) to service_role;
  end if;
end
$$;

notify pgrst, 'reload schema';
