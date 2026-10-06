-- ===========================================================================
-- 0064_communications_escalation.sql
-- Wave 3, Slice 3E: CM-10 (required-acknowledgement escalation ladder),
-- CM-12 (shift-targeted messaging -- no schema change, see below) and CM-13
-- (emergency mode). See plans/COMMUNICATIONS_PLAN.md and
-- plans/WAVES_1_4_IMPLEMENTATION_PLAN.md's Wave 3 3E row (Opus-level review
-- on CM-13: the quiet-hours bypass).
--
-- Every helper call is schema-qualified internal.<name>(...) per 0042's
-- convention. Idempotent throughout (add column if not exists, create
-- table if not exists, drop policy/trigger if exists before every create,
-- create or replace for functions). Nothing here touches 0052-0061,
-- internal.enqueue_report_workflow or the mint RPCs, and 0058's
-- incident-scoped notification_jobs INSERT/SELECT policies are NOT widened
-- or re-created.
--
-- CM-12 (shift targeting) needs no schema: the `shift` audience keeps
-- message_audiences.audience_ref_id = a schedule_shifts.id (or null), which
-- 0048's fn_assert_same_facility dispatch (policy + trigger) already guards;
-- the window ("current" / "next" / a { from, to } range, optionally narrowed
-- to a department) lives in the existing rule_jsonb column and is evaluated
-- by src/lib/communications.mjs against schedule_shifts/shift_assignments.
--
-- CM-10 -- escalation ladder:
--   * messages.ack_escalation_level / ack_escalated_at record the last ladder
--     level the sweep completed. They are the sweep's CAS claim: the sweep
--     (service role) moves level N-1 -> N before any side effect and moves it
--     back, compare-and-set on the exact stamped value, if a side effect
--     fails. An authenticated session can never write either column
--     (fn_messages_guard_ack_escalation, same `auth.uid() is not null` test
--     0060 uses for the SLA columns), otherwise a publisher could reset the
--     level to re-fire the ladder or push it to 3 to silence it.
--   * message_escalation_events is the permanent, append-only record of each
--     (message, level) escalation -- UNIQUE (message_id, level) is the
--     idempotency primitive. Written only by the sweep (no INSERT policy for
--     `authenticated` at all); readable by communications.publish holders.
--   * fn_notification_job_dedupe_key (0058) is re-created, carrying forward
--     its original rewrite verbatim (Guard 1) and adding the ack-escalation
--     event types (Guard 2). Without this the 0058 trigger would overwrite
--     the sweep's per-(message, level) key with its incident formula
--     (facility:event::n/a:<first recipient>), collapsing every message's
--     escalation to the same first recipient into one "duplicate" and
--     silently dropping the later alerts. For these event types an
--     authenticated session's key is nulled rather than recomputed, so no
--     publisher can squat the key a genuine escalation job needs (0058's
--     NEW-1 concern, closed for this event family).
--
-- CM-13 -- emergency mode:
--   * emergency_alert_launches is the approval ledger (one row per message):
--     a communications.publish holder requests a launch for an unpublished
--     emergency-priority draft on an emergency-enabled channel; a (by default
--     different) communications.publish holder approves it; the approver's
--     route then publishes the message, enqueues the quiet-hours-bypassing
--     job and stamps the row launched. fn_emergency_alert_launch_guard
--     enforces the whole state machine, attributes request/approval to the
--     caller's own employee row, and enforces the tenant's
--     communications.emergencyRequiresSecondApprover setting (default true)
--     in the database, not just the route.
--   * fn_messages_guard_emergency_publish: a message cannot become a
--     published emergency message (INSERT or UPDATE, any role) unless an
--     approved/launched launch row exists for it -- so the ordinary publish
--     route, a raw PostgREST PATCH and the legacy publishNow shortcut all
--     fail closed.
--   * emergency_alert_responses: one row per (message, employee), safe /
--     need_help. An employee may only write their own row (RLS WITH CHECK
--     AND trigger); publishers read the facility roll-up; there is no DELETE
--     policy (a safety record).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Notification event catalog: the two escalation tiers above the existing
-- message.ack_overdue (0016's seed, the level-1 reminder), and the emergency
-- broadcast. notification_routes.event_code references this catalog, so a
-- facility can only wire a supervisor/manager distribution list to a code that
-- exists here.
-- ---------------------------------------------------------------------------
insert into notification_events (code, severity, module_code, default_channels_jsonb) values
  ('message.ack_escalated_supervisor', 'warning', 'communications', '["in_app","email"]'::jsonb),
  ('message.ack_escalated_manager', 'critical', 'communications', '["in_app","email","sms"]'::jsonb),
  ('message.emergency', 'critical', 'communications', '["in_app","push","sms","email"]'::jsonb)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. messages.ack_escalation_level / ack_escalated_at + the guard that keeps
-- them service-role-only.
-- ---------------------------------------------------------------------------
alter table messages
  add column if not exists ack_escalation_level integer not null default 0
    check (ack_escalation_level between 0 and 3);
alter table messages
  add column if not exists ack_escalated_at timestamptz;

create index if not exists messages_ack_escalation_scan_idx
  on messages(ack_due_at)
  where is_required_ack and published_at is not null and deleted_at is null and ack_escalation_level < 3;

create or replace function fn_messages_guard_ack_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard 1: ack_escalation_level / ack_escalated_at belong to the CM-10 sweep
  -- (a service-role session, where auth.uid() reads null). Any session with a
  -- JWT -- communications.publish included -- is rejected on both INSERT and
  -- UPDATE, so the ladder can be neither reset (to re-fire it) nor advanced
  -- (to silence it).
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      if new.ack_escalation_level <> 0 or new.ack_escalated_at is not null then
        raise exception 'ack_escalation_level/ack_escalated_at may only be written by the escalation sweep (service role)'
          using errcode = '42501';
      end if;
    else
      if new.ack_escalation_level is distinct from old.ack_escalation_level
         or new.ack_escalated_at is distinct from old.ack_escalated_at then
        raise exception 'ack_escalation_level/ack_escalated_at may only be written by the escalation sweep (service role)'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_ack_escalation on messages;
create trigger messages_guard_ack_escalation
  before insert or update on messages
  for each row execute function fn_messages_guard_ack_escalation();

-- ---------------------------------------------------------------------------
-- 3. message_escalation_events -- append-only (CM-10).
-- ---------------------------------------------------------------------------
create table if not exists message_escalation_events (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  level integer not null check (level between 1 and 3),
  tier text not null check (tier in ('reminder', 'supervisor', 'manager')),
  event_code text not null,
  recipient_count integer not null default 0 check (recipient_count >= 0),
  dedupe_key text,
  details_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (message_id, level)
);

create index if not exists message_escalation_events_facility_idx
  on message_escalation_events(facility_id, created_at desc);

alter table message_escalation_events enable row level security;

drop policy if exists "communication publishers can read escalation events" on message_escalation_events;
create policy "communication publishers can read escalation events" on message_escalation_events
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'communications.publish'));

-- No INSERT/UPDATE/DELETE policy: only the service-role sweep writes, and the
-- trigger below keeps even that append-only (reusing fn_block_audit_mutation,
-- 0010/0024, exactly as 0032 does for incident_amendments).
drop trigger if exists message_escalation_events_block_mutation on message_escalation_events;
create trigger message_escalation_events_block_mutation
  before update or delete on message_escalation_events
  for each row execute function fn_block_audit_mutation();

-- ---------------------------------------------------------------------------
-- 4. fn_notification_job_dedupe_key (0058) re-created. LATEST prior
-- definition: 0058_incident_cross_module.sql (grepped every migration for the
-- name: 0058 is the only one). Guard 1 is its body, verbatim.
-- ---------------------------------------------------------------------------
create or replace function fn_notification_job_dedupe_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.dedupe_key is not null then
    if new.event_type not in ('message.ack_overdue', 'message.ack_escalated_supervisor', 'message.ack_escalated_manager') then
      -- Guard 1 (0058, M2): a caller-supplied non-null dedupe_key is
      -- OVERWRITTEN with a value computed purely from the row's own validated
      -- columns, never from whatever string the client sent.
      new.dedupe_key := new.facility_id::text || ':' || new.event_type || ':' ||
        coalesce(new.payload_jsonb ->> 'incidentId', '') || ':' ||
        coalesce(new.payload_jsonb ->> 'escalationId', 'n/a') || ':' ||
        coalesce(new.payload_jsonb -> 'recipients' ->> 0, '');
    elsif auth.uid() is not null then
      -- Guard 2 (0064, CM-10): the escalation ladder's per-(message, level)
      -- key may only be held by the service-role sweep (auth.uid() null); an
      -- authenticated session's key is dropped, so a publisher cannot
      -- pre-insert a row occupying the key the genuine escalation job needs.
      new.dedupe_key := null;
    else
      -- Guard 2 (0064, CM-10), service-role path: computed from the row's own
      -- facility_id / event_type / messageId / escalationLevel, so every
      -- (message, level) has exactly one key and distinct messages never
      -- collide on a shared first recipient.
      new.dedupe_key := new.facility_id::text || ':' || new.event_type || ':' ||
        coalesce(new.payload_jsonb ->> 'messageId', '') || ':' ||
        coalesce(new.payload_jsonb ->> 'escalationLevel', 'n/a');
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function fn_notification_job_dedupe_key() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_notification_job_dedupe_key() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. emergency_alert_launches -- the approval ledger (CM-13).
-- ---------------------------------------------------------------------------
create table if not exists emergency_alert_launches (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  requested_by_employee_id uuid not null references employees(id),
  requested_at timestamptz not null default now(),
  approved_by_employee_id uuid references employees(id),
  approved_at timestamptz,
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'launched', 'cancelled')),
  launched_at timestamptz,
  recipient_count integer check (recipient_count is null or recipient_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id)
);

create index if not exists emergency_alert_launches_facility_status_idx
  on emergency_alert_launches(facility_id, status, requested_at desc);

alter table emergency_alert_launches enable row level security;

-- Tenant setting lookup for the guard below. The registry key lives in
-- facility_module_overrides.config_patch_jsonb (facility layer) or
-- organization_module_settings.config_jsonb (organization layer); an unset or
-- malformed value is the shipped default, true. SECURITY DEFINER so a
-- publisher without admin read access to those tables still gets the real
-- answer (read-only, no argument other than the facility id).
create or replace function fn_comms_emergency_requires_second_approver(p_facility_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_value text;
begin
  select fo.config_patch_jsonb ->> 'communications.emergencyRequiresSecondApprover' into v_value
  from facility_module_overrides fo
  join modules m on m.id = fo.module_id
  where fo.facility_id = p_facility_id and m.code = 'communications';
  if v_value in ('true', 'false') then
    return v_value::boolean;
  end if;

  select os.config_jsonb ->> 'communications.emergencyRequiresSecondApprover' into v_value
  from organization_module_settings os
  join modules m on m.id = os.module_id
  join facilities f on f.organization_id = os.organization_id
  where f.id = p_facility_id and m.code = 'communications';
  if v_value in ('true', 'false') then
    return v_value::boolean;
  end if;

  return true;
end;
$$;

revoke execute on function fn_comms_emergency_requires_second_approver(uuid) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_comms_emergency_requires_second_approver(uuid) from anon;
  end if;
end
$$;

create or replace function fn_emergency_alert_launch_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_message messages%rowtype;
  v_emergency_enabled boolean;
begin
  if tg_op = 'INSERT' then
    -- Guard 1: a launch can only be requested for an unpublished,
    -- emergency-priority draft in the SAME facility, on an emergency-enabled
    -- channel.
    select * into v_message from messages where id = new.message_id;
    if not found or v_message.facility_id <> new.facility_id or v_message.deleted_at is not null then
      raise exception 'emergency launch: message not found in this facility'
        using errcode = 'check_violation';
    end if;
    if v_message.published_at is not null then
      raise exception 'emergency launch: message is already published'
        using errcode = 'check_violation';
    end if;
    if v_message.priority <> 'emergency' then
      raise exception 'emergency launch: message priority must be emergency'
        using errcode = 'check_violation';
    end if;
    select c.emergency_enabled into v_emergency_enabled
      from communication_channels c where c.id = v_message.channel_id;
    if v_emergency_enabled is not true then
      raise exception 'emergency launch: the message channel is not emergency-enabled'
        using errcode = 'check_violation';
    end if;

    -- Guard 2: a launch is born pending, with no approver and no launch stamp.
    if new.status <> 'pending_approval'
       or new.approved_by_employee_id is not null
       or new.approved_at is not null
       or new.launched_at is not null
       or new.recipient_count is not null then
      raise exception 'emergency launch: a new request must be pending_approval with no approval or launch data'
        using errcode = 'check_violation';
    end if;

    -- Guard 3: the request is attributed to the caller's own employee row.
    if v_actor is not null and not exists (
      select 1 from employees e
      where e.id = new.requested_by_employee_id and e.facility_id = new.facility_id and e.user_id = v_actor
    ) then
      raise exception 'emergency launch: requested_by_employee_id must be the caller''s own employee'
        using errcode = '42501';
    end if;

    new.requested_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- Guard 4: identity columns never change after the request.
  if new.facility_id is distinct from old.facility_id
     or new.message_id is distinct from old.message_id
     or new.requested_by_employee_id is distinct from old.requested_by_employee_id
     or new.requested_at is distinct from old.requested_at then
    raise exception 'emergency launch: facility, message and requester are immutable'
      using errcode = '42501';
  end if;

  -- Guard 5: the state machine. pending_approval -> approved | cancelled,
  -- approved -> launched | cancelled; launched and cancelled are terminal.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending_approval' and new.status in ('approved', 'cancelled'))
      or (old.status = 'approved' and new.status in ('launched', 'cancelled'))
    ) then
      raise exception 'emergency launch: illegal status transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  elsif old.status in ('launched', 'cancelled') then
    raise exception 'emergency launch: a % launch cannot be edited', old.status
      using errcode = 'check_violation';
  end if;

  -- Guard 6: approval is attributed to the caller's own employee row, and
  -- (per communications.emergencyRequiresSecondApprover, default true) is not
  -- the requester. approved_at is server-stamped.
  if new.status = 'approved' and old.status = 'pending_approval' then
    if new.approved_by_employee_id is null then
      raise exception 'emergency launch: approval requires approved_by_employee_id'
        using errcode = 'check_violation';
    end if;
    if v_actor is not null and not exists (
      select 1 from employees e
      where e.id = new.approved_by_employee_id and e.facility_id = new.facility_id and e.user_id = v_actor
    ) then
      raise exception 'emergency launch: approved_by_employee_id must be the caller''s own employee'
        using errcode = '42501';
    end if;
    if new.approved_by_employee_id = new.requested_by_employee_id
       and fn_comms_emergency_requires_second_approver(new.facility_id) then
      raise exception 'emergency launch: a second approver (not the requester) is required'
        using errcode = '42501';
    end if;
    new.approved_at := now();
  elsif new.approved_by_employee_id is distinct from old.approved_by_employee_id
        or new.approved_at is distinct from old.approved_at then
    raise exception 'emergency launch: approval data is write-once'
      using errcode = '42501';
  end if;

  -- Guard 7: the launch stamp is server-written, only on approved -> launched.
  if new.status = 'launched' and old.status = 'approved' then
    new.launched_at := now();
  elsif new.launched_at is distinct from old.launched_at then
    raise exception 'emergency launch: launched_at is stamped by the launch transition only'
      using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists emergency_alert_launches_guard on emergency_alert_launches;
create trigger emergency_alert_launches_guard
  before insert or update on emergency_alert_launches
  for each row execute function fn_emergency_alert_launch_guard();

revoke execute on function fn_emergency_alert_launch_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_emergency_alert_launch_guard() from anon;
  end if;
end
$$;

drop policy if exists "communication publishers can read emergency launches" on emergency_alert_launches;
create policy "communication publishers can read emergency launches" on emergency_alert_launches
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'communications.publish'));

drop policy if exists "communication publishers can request emergency launches" on emergency_alert_launches;
create policy "communication publishers can request emergency launches" on emergency_alert_launches
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'communications.publish')
    and internal.fn_assert_same_facility(facility_id, 'messages', message_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', requested_by_employee_id)
  );

drop policy if exists "communication publishers can approve emergency launches" on emergency_alert_launches;
create policy "communication publishers can approve emergency launches" on emergency_alert_launches
  for update
  using (
    internal.has_permission((select auth.uid()), facility_id, 'communications.publish')
    and status in ('pending_approval', 'approved')
  )
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'communications.publish')
    and internal.fn_assert_same_facility(facility_id, 'messages', message_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', requested_by_employee_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', approved_by_employee_id)
  );

-- No DELETE policy: the ledger is the approval record.

-- ---------------------------------------------------------------------------
-- 6. messages: an emergency message cannot be published without an approved
-- launch. Fires for every role, service role included.
-- ---------------------------------------------------------------------------
create or replace function fn_messages_guard_emergency_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard 1: the transition INTO "published emergency message" (an INSERT that
  -- is already published, or an UPDATE that sets published_at / raises
  -- priority to emergency on a published row) requires an approved or
  -- launched emergency_alert_launches row for this very message.
  if new.priority = 'emergency'
     and new.published_at is not null
     and (tg_op = 'INSERT' or old.published_at is null or old.priority is distinct from 'emergency') then
    if not exists (
      select 1 from emergency_alert_launches l
      where l.message_id = new.id
        and l.facility_id = new.facility_id
        and l.status in ('approved', 'launched')
    ) then
      raise exception 'emergency messages can only be published through an approved emergency launch'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_emergency_publish on messages;
create trigger messages_guard_emergency_publish
  before insert or update on messages
  for each row execute function fn_messages_guard_emergency_publish();

revoke execute on function fn_messages_guard_emergency_publish() from public, authenticated;
revoke execute on function fn_messages_guard_ack_escalation() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_messages_guard_emergency_publish() from anon;
    revoke execute on function fn_messages_guard_ack_escalation() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. emergency_alert_responses (CM-13): "I am safe" / "need help".
-- ---------------------------------------------------------------------------
create table if not exists emergency_alert_responses (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  response text not null check (response in ('safe', 'need_help')),
  note text check (note is null or char_length(note) <= 500),
  responded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, employee_id)
);

create index if not exists emergency_alert_responses_facility_message_idx
  on emergency_alert_responses(facility_id, message_id, response);

alter table emergency_alert_responses enable row level security;

create or replace function fn_emergency_alert_response_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_message messages%rowtype;
begin
  -- Guard 1: only a published emergency message of the same facility takes
  -- responses.
  select * into v_message from messages where id = new.message_id;
  if not found
     or v_message.facility_id <> new.facility_id
     or v_message.priority <> 'emergency'
     or v_message.published_at is null then
    raise exception 'emergency response: message is not a published emergency message in this facility'
      using errcode = 'check_violation';
  end if;

  -- Guard 2: an authenticated caller may only record their OWN response
  -- (defense in depth beside the RLS WITH CHECK; nobody -- a publisher
  -- included -- answers on someone else's behalf).
  if v_actor is not null and not exists (
    select 1 from employees e
    where e.id = new.employee_id and e.facility_id = new.facility_id and e.user_id = v_actor
  ) then
    raise exception 'emergency response: employee_id must be the caller''s own employee'
      using errcode = '42501';
  end if;

  -- Guard 3: identity columns are immutable; the timestamp is server-written.
  if tg_op = 'UPDATE' then
    if new.facility_id is distinct from old.facility_id
       or new.message_id is distinct from old.message_id
       or new.employee_id is distinct from old.employee_id then
      raise exception 'emergency response: facility, message and employee are immutable'
        using errcode = '42501';
    end if;
  end if;
  new.responded_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists emergency_alert_responses_guard on emergency_alert_responses;
create trigger emergency_alert_responses_guard
  before insert or update on emergency_alert_responses
  for each row execute function fn_emergency_alert_response_guard();

revoke execute on function fn_emergency_alert_response_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_emergency_alert_response_guard() from anon;
  end if;
end
$$;

drop policy if exists "employees can read their own emergency responses" on emergency_alert_responses;
create policy "employees can read their own emergency responses" on emergency_alert_responses
  for select
  using (
    internal.has_permission((select auth.uid()), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = emergency_alert_responses.employee_id
        and e.facility_id = emergency_alert_responses.facility_id
        and e.user_id = (select auth.uid())
    )
  );

drop policy if exists "communication publishers can read the emergency roll-up" on emergency_alert_responses;
create policy "communication publishers can read the emergency roll-up" on emergency_alert_responses
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'communications.publish'));

drop policy if exists "employees can record their own emergency responses" on emergency_alert_responses;
create policy "employees can record their own emergency responses" on emergency_alert_responses
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'communications.read')
    and internal.fn_assert_same_facility(facility_id, 'messages', message_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
    and exists (
      select 1 from employees e
      where e.id = emergency_alert_responses.employee_id
        and e.facility_id = emergency_alert_responses.facility_id
        and e.user_id = (select auth.uid())
    )
  );

drop policy if exists "employees can update their own emergency responses" on emergency_alert_responses;
create policy "employees can update their own emergency responses" on emergency_alert_responses
  for update
  using (
    internal.has_permission((select auth.uid()), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = emergency_alert_responses.employee_id
        and e.facility_id = emergency_alert_responses.facility_id
        and e.user_id = (select auth.uid())
    )
  )
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'communications.read')
    and internal.fn_assert_same_facility(facility_id, 'messages', message_id)
    and internal.fn_assert_same_facility(facility_id, 'employees', employee_id)
    and exists (
      select 1 from employees e
      where e.id = emergency_alert_responses.employee_id
        and e.facility_id = emergency_alert_responses.facility_id
        and e.user_id = (select auth.uid())
    )
  );

-- No DELETE policy: an emergency response is a safety record.

notify pgrst, 'reload schema';
