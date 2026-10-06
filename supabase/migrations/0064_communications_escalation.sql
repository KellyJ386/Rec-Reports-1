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
--   * messages.ack_next_escalation_at (M-5) is the sweep's work queue: the
--     earliest instant the sweep needs to look at the message again. It is
--     stamped at publish (fn_messages_set_ack_next_escalation) and moved
--     forward by the sweep, so a message the sweep skips (escalation switched
--     off, waiting out the gap between tiers) leaves the candidate set
--     instead of permanently occupying one of its slots. Service-role-only,
--     like the two columns above.
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
--     authenticated session's key is nulled rather than recomputed, and the
--     trigger now fires on UPDATE as well (M-1), so no publisher can squat the
--     key a genuine escalation job needs, on INSERT or by re-keying a row.
--     A null key is still left alone (0062's schedule jobs rely on that).
--
-- notification_jobs is also written directly by communications.publish
-- holders through 0006's FOR ALL policy (left untouched here: recreating it
-- would have to re-derive 0058's incident policy interplay). The worker
-- trusts payload.recipients / channels / quietHoursBypass on every job, so
-- that policy was a way around CM-13's four-eyes rule (H-1).
-- fn_notification_jobs_client_guard (SECURITY INVOKER, so
-- current_user is the real session role) closes it for client sessions:
-- no message.emergency job, no quietHoursBypass except 0058's own
-- high/critical incident rule (an urgent message's quiet-hours-bypassing
-- publish job is written by publish_urgent_message(), never by the client,
-- NEW-1), no change to an existing row's event type, payload, dedupe key or
-- facility, and no client DELETE (NEW-2: a delete would silence an approved
-- broadcast and cascade its delivery record away). A SECURITY DEFINER
-- function's own writes run as the function owner and are not client
-- sessions, which is how approve_emergency_launch() enqueues the one
-- emergency job and publish_urgent_message() the one urgent publish job.
--
-- CM-13 -- emergency mode:
--   * emergency_alert_launches is the approval ledger (one row per message):
--     a communications.publish holder requests a launch for an unpublished
--     emergency-priority draft on an emergency-enabled channel; a different
--     PERSON (user_id, not just employee row) holding communications.publish
--     approves it by calling public.approve_emergency_launch(message_id).
--     That one SECURITY DEFINER function re-checks the caller's permission,
--     approves the launch, derives the recipient list from the message's own
--     audience rows, publishes the message, enqueues the single
--     message.emergency job (every channel, quietHoursBypass true) and stamps
--     the launch `launched` with the recipient count -- in one transaction, so
--     there is never a published emergency message without its job, nor a job
--     without an approved launch. A client session cannot move a launch to
--     `approved` or `launched` itself, nor publish an emergency message, nor
--     write the job (fn_emergency_alert_launches_guard_client,
--     fn_messages_guard_emergency_freeze, fn_notification_jobs_client_guard).
--   * fn_emergency_alert_launch_guard enforces the whole state machine,
--     attributes request/approval to the caller's own employee row, enforces
--     the tenant's communications.emergencyRequiresSecondApprover setting
--     (default true) in the database -- comparing people, not employee ids --
--     and binds the approval to a content hash (subject, body, audience set)
--     taken at request time.
--   * fn_messages_guard_emergency_publish: a message cannot become a
--     published emergency message (INSERT or UPDATE, any role) unless an
--     APPROVED launch row exists for it (never from `launched`, which would
--     be a republish). fn_messages_guard_emergency_freeze: once a launch
--     exists (or the message is a published emergency) a client session
--     cannot change its content, audience or published_at, and cannot
--     hard-delete it.
--   * emergency_alert_responses: one row per (message, employee), safe /
--     need_help. An employee may only write their own row (RLS WITH CHECK
--     AND trigger); publishers read the facility roll-up; there is no DELETE
--     policy (a safety record), and the foreign key from the message is
--     ON DELETE RESTRICT, as is the launch ledger's.
--
-- Client session test. A SECURITY DEFINER function runs as its owner, so
-- `current_user` inside it is not the caller's role; a direct PostgREST write
-- runs as `authenticated` (or `anon`). The guards below that must tell the two
-- apart are therefore SECURITY INVOKER trigger functions keyed on
-- `current_user in ('authenticated', 'anon')`. The service role (and the
-- definer functions) are not client sessions.
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
-- 2. messages.ack_escalation_level / ack_escalated_at / ack_next_escalation_at
-- + the guards that keep them service-role-only and keep the work queue
-- column current.
-- ---------------------------------------------------------------------------
alter table messages
  add column if not exists ack_escalation_level integer not null default 0
    check (ack_escalation_level between 0 and 3);
alter table messages
  add column if not exists ack_escalated_at timestamptz;
alter table messages
  add column if not exists ack_next_escalation_at timestamptz;

-- M-5: the sweep selects by readiness (ack_next_escalation_at <= now), not by
-- the oldest due date, so rows it skips cannot starve other tenants.
drop index if exists messages_ack_escalation_scan_idx;
create index if not exists messages_ack_escalation_scan_idx
  on messages(ack_next_escalation_at)
  where is_required_ack
    and published_at is not null
    and deleted_at is null
    and ack_escalation_level < 3
    and ack_next_escalation_at is not null;

-- Messages already published and awaiting acknowledgement when this migration
-- lands are due for the sweep's first look at their due time.
update messages
   set ack_next_escalation_at = greatest(ack_due_at, published_at)
 where is_required_ack
   and published_at is not null
   and ack_due_at is not null
   and deleted_at is null
   and ack_escalation_level < 3
   and ack_next_escalation_at is null;

create or replace function fn_messages_guard_ack_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: ack_escalation_level / ack_escalated_at / ack_next_escalation_at
  -- belong to the CM-10 sweep (a service-role session, where auth.uid() reads
  -- null). Any session with a JWT -- communications.publish included -- is
  -- rejected on both INSERT and UPDATE, so the ladder can be neither reset (to
  -- re-fire it) nor advanced (to silence it), and the work queue cannot be
  -- pushed out. (fn_messages_set_ack_next_escalation, which sorts after this
  -- trigger, maintains the queue column itself when publish data changes.)
  if auth.uid() is not null then
    -- A client may only publish "now": a backdated published_at would put the
    -- first escalation check in the past, and a past ack_due_at set after the
    -- fact would do the same.
    if new.published_at is not null
       and (tg_op = 'INSERT' or old.published_at is distinct from new.published_at)
       and (new.published_at > now() + interval '10 minutes'
            or new.published_at < now() - interval '10 minutes') then
      raise exception 'published_at must be the time the message is published'
        using errcode = '42501';
    end if;
    if new.is_required_ack and new.ack_due_at is not null
       and (tg_op = 'INSERT' or old.ack_due_at is distinct from new.ack_due_at)
       and new.published_at is not null
       and new.ack_due_at <= now() then
      raise exception 'ack_due_at must be later than the current time'
        using errcode = '23514';
    end if;
    if tg_op = 'INSERT' then
      if new.ack_escalation_level <> 0
         or new.ack_escalated_at is not null
         or new.ack_next_escalation_at is not null then
        raise exception 'ack_escalation_level/ack_escalated_at/ack_next_escalation_at may only be written by the escalation sweep (service role)'
          using errcode = '42501';
      end if;
    else
      if new.ack_escalation_level is distinct from old.ack_escalation_level
         or new.ack_escalated_at is distinct from old.ack_escalated_at
         or new.ack_next_escalation_at is distinct from old.ack_next_escalation_at then
        raise exception 'ack_escalation_level/ack_escalated_at/ack_next_escalation_at may only be written by the escalation sweep (service role)'
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

create or replace function fn_messages_set_ack_next_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: a published, required-ack message with a due time is due for the
  -- sweep's first look at the later of its due time and its publish time (the
  -- ladder never starts before the message went out). Recomputed whenever the
  -- publish data changes; the sweep moves it forward afterwards, and its own
  -- writes (level / next-look columns only) leave this branch alone.
  if new.is_required_ack
     and new.published_at is not null
     and new.ack_due_at is not null
     and new.deleted_at is null
     and new.ack_escalation_level < 3 then
    if tg_op = 'INSERT'
       or new.published_at is distinct from old.published_at
       or new.ack_due_at is distinct from old.ack_due_at
       or new.is_required_ack is distinct from old.is_required_ack
       or new.deleted_at is distinct from old.deleted_at then
      new.ack_next_escalation_at := greatest(new.ack_due_at, new.published_at);
    end if;
  else
    new.ack_next_escalation_at := null;
  end if;

  -- Guard 2: an acknowledgement due time must lie after the moment the message
  -- goes out, or the ladder would fire reminder, supervisor and manager tiers
  -- on three consecutive passes. For client sessions this is checked on the
  -- transition into published AND on any client change of either column
  -- afterwards (a publisher could otherwise move ack_due_at, or backdate
  -- published_at, into the past once the message is out). The publish route
  -- answers a clean 400 first.
  if auth.uid() is not null
     and new.is_required_ack
     and new.published_at is not null
     and new.ack_due_at is not null
     and (tg_op = 'INSERT'
          or old.published_at is null
          or new.ack_due_at is distinct from old.ack_due_at
          or new.published_at is distinct from old.published_at)
     and new.ack_due_at <= new.published_at then
    raise exception 'ack_due_at must be later than the time the message is published'
      using errcode = 'check_violation';
  end if;

  -- Guard 3: once a message is published its publish time is frozen for client
  -- sessions (the ladder anchors on it); the service role is unaffected. The
  -- transition INTO published (old.published_at null) is what the publish
  -- route and the definer publish functions perform.
  if auth.uid() is not null
     and tg_op = 'UPDATE'
     and old.published_at is not null
     and new.published_at is distinct from old.published_at then
    raise exception 'published_at cannot be changed once a message is published'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_set_ack_next_escalation on messages;
create trigger messages_set_ack_next_escalation
  before insert or update on messages
  for each row execute function fn_messages_set_ack_next_escalation();

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
-- name: 0058 is the only one). Guard 1 is its body, verbatim. The trigger now
-- also fires on UPDATE (M-1): a client could otherwise re-key an existing row
-- to the exact key the sweep computes. 0062 (scheduling) deliberately does not
-- redefine this function and relies on a NULL key being left untouched, which
-- the `if new.dedupe_key is not null` wrapper below preserves.
-- ---------------------------------------------------------------------------
create or replace function fn_notification_job_dedupe_key()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Guard 3 (0064, M-1): an UPDATE that touches nothing the key is derived
  -- from keeps the stored key as it is (the worker's status writes must not
  -- re-derive anything). Any change to the key's inputs, or to the key itself,
  -- falls through to the rewrite below, which gives a client a key the
  -- notification_jobs client guard then refuses as a change.
  if tg_op = 'UPDATE'
     and new.dedupe_key is not distinct from old.dedupe_key
     and new.event_type = old.event_type
     and new.facility_id = old.facility_id
     and new.payload_jsonb is not distinct from old.payload_jsonb then
    return new;
  end if;

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

drop trigger if exists notification_jobs_dedupe_key on notification_jobs;
create trigger notification_jobs_dedupe_key
  before insert or update on notification_jobs
  for each row execute function fn_notification_job_dedupe_key();

revoke execute on function fn_notification_job_dedupe_key() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_notification_job_dedupe_key() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4b. notification_jobs client guard (H-1, M-1). 0006's "communication
-- publishers can manage notifications" FOR ALL policy lets any
-- communications.publish holder insert and update jobs directly, and the
-- worker trusts payload.recipients / channels / quietHoursBypass on every job:
-- without this, one publisher could send the emergency broadcast (all four
-- channels, quiet hours bypassed) with no second approver.
--
-- SECURITY INVOKER on purpose: current_user is then the caller's own role
-- ('authenticated' / 'anon' for a PostgREST request), while a write made from
-- inside a SECURITY DEFINER function (approve_emergency_launch, 0062's
-- schedule notifications) runs as the function owner, and the service role
-- (the worker, the sweeps) is neither -- both are left alone. Trigger
-- functions need no EXECUTE grant to fire. The subqueries below run under the
-- caller's RLS exactly like 0058's INSERT policy predicate they copy.
-- ---------------------------------------------------------------------------
create or replace function fn_notification_jobs_client_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: only client sessions are constrained here. (A BEFORE DELETE
  -- trigger must hand back OLD, or the delete is silently skipped.)
  if current_user not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Guard 6 (NEW-2): a client session never deletes a notification job. No
  -- route does; 0006's FOR ALL policy still grants it, and a publisher could
  -- otherwise silence an approved emergency broadcast before the worker drains
  -- it, or erase a sent job and (through the notification_deliveries cascade)
  -- its delivery record.
  if tg_op = 'DELETE' then
    raise exception 'notification jobs cannot be deleted from a client session'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    -- Guard 2: the emergency broadcast job is written only by
    -- approve_emergency_launch().
    if new.event_type = 'message.emergency' then
      raise exception 'message.emergency jobs can only be created by approving an emergency launch'
        using errcode = '42501';
    end if;

    -- Guard 3: quietHoursBypass is accepted from a client in ONE shape only:
    -- 0058's INSERT policy predicate (an incident actor -- manage, review or
    -- escalate -- writing an incident event for a high/critical incident in
    -- this very facility). NEW-1: the urgent message's publish job used to be
    -- a second client-accepted shape, which left channels, recipients and copy
    -- to the caller and let the job be cancelled and written again; it is now
    -- written by publish_urgent_message() (a definer function, not a client
    -- session), which derives all of that on the server.
    if coalesce(new.payload_jsonb ->> 'quietHoursBypass', 'false') = 'true' then
      if not (
        new.event_type in ('incident.submitted', 'incident.escalated', 'incident.sla_breached')
        and (
          internal.has_permission(auth.uid(), new.facility_id, 'incidents.manage')
          or internal.has_permission(auth.uid(), new.facility_id, 'incidents.review')
          or internal.has_permission(auth.uid(), new.facility_id, 'incidents.escalate')
        )
        and exists (
          select 1 from incident_reports r
          where r.id::text = new.payload_jsonb ->> 'incidentId'
            and r.facility_id = new.facility_id
            and r.severity in ('high', 'critical')
        )
      ) then
        raise exception 'quietHoursBypass is not allowed on this notification job'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- Guard 4: what a job is (its type, payload, key, facility) never changes
  -- from a client session -- this is what stops a bypass flag, a recipient
  -- list or a pre-computed dedupe key being added to a row after the insert
  -- checks passed.
  if new.event_type is distinct from old.event_type
     or new.facility_id is distinct from old.facility_id
     or new.payload_jsonb is distinct from old.payload_jsonb
     or new.dedupe_key is distinct from old.dedupe_key then
    raise exception 'a notification job''s event type, payload, dedupe key and facility cannot be changed'
      using errcode = '42501';
  end if;

  -- Guard 5: an emergency or quiet-hours-bypassing job cannot be re-armed (a
  -- status reset would re-broadcast it). NEW-2: an approved emergency
  -- broadcast cannot be touched by a client at all -- not even cancelled, or a
  -- single publisher could silence what a second person approved. A bypassing
  -- incident job may only be cancelled, and only while it is still pending
  -- (cancelling a job the worker already sent is not a client's business).
  if old.event_type = 'message.emergency' then
    raise exception 'a message.emergency notification job cannot be changed from a client session'
      using errcode = '42501';
  end if;
  if coalesce(old.payload_jsonb ->> 'quietHoursBypass', 'false') = 'true' then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at')
       or (new.status is distinct from old.status and (new.status <> 'cancelled' or old.status <> 'pending')) then
      raise exception 'a quiet-hours-bypassing notification job can only be cancelled, and only while it is pending'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notification_jobs_client_guard on notification_jobs;
create trigger notification_jobs_client_guard
  before insert or update or delete on notification_jobs
  for each row execute function fn_notification_jobs_client_guard();

revoke execute on function fn_notification_jobs_client_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_notification_jobs_client_guard() from anon;
  end if;
end
$$;

-- Exactly one emergency broadcast job per message, whoever writes it.
create unique index if not exists notification_jobs_emergency_message_uidx
  on notification_jobs ((payload_jsonb ->> 'messageId'))
  where event_type = 'message.emergency';

-- NEW-1: exactly one quiet-hours-bypassing publish job per message, whoever
-- writes it (publish_urgent_message() in section 5c is the only writer a
-- publisher can reach). Created defensively: a database that already holds two
-- such rows for one message from before this slice keeps the in-function check
-- (publish_urgent_message() refuses to send a second one) instead of failing
-- the whole migration.
do $$
begin
  create unique index if not exists notification_jobs_urgent_publish_message_uidx
    on notification_jobs ((payload_jsonb ->> 'messageId'))
    where event_type = 'message.published'
      and payload_jsonb ->> 'quietHoursBypass' = 'true';
exception when unique_violation then
  raise warning 'notification_jobs_urgent_publish_message_uidx not created: duplicate urgent publish jobs already exist';
end
$$;

-- ---------------------------------------------------------------------------
-- 5. emergency_alert_launches -- the approval ledger (CM-13).
-- message_id is ON DELETE RESTRICT (M-4): the ledger is the approval record
-- and must not vanish with a hard-deleted message.
-- ---------------------------------------------------------------------------
create table if not exists emergency_alert_launches (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete restrict,
  requested_by_employee_id uuid not null references employees(id),
  requested_at timestamptz not null default now(),
  approved_by_employee_id uuid references employees(id),
  approved_at timestamptz,
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'launched', 'cancelled')),
  launched_at timestamptz,
  recipient_count integer check (recipient_count is null or recipient_count >= 0),
  -- M-3: sha256 of the message's subject, body and audience set as the
  -- request saw them (stamped by the guard; a client-supplied value is
  -- overwritten). Approval and launch fail if the content no longer matches.
  content_hash text,
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
-- malformed value is the shipped default, true. Only a real JSON boolean
-- counts (L-6: the string "false" is malformed, like the JS registry treats
-- it, and falls through to the next layer). SECURITY DEFINER so a publisher
-- without admin read access to those tables still gets the real answer
-- (read-only, no argument other than the facility id).
create or replace function fn_comms_emergency_requires_second_approver(p_facility_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  select fo.config_patch_jsonb -> 'communications.emergencyRequiresSecondApprover' into v_value
  from facility_module_overrides fo
  join modules m on m.id = fo.module_id
  where fo.facility_id = p_facility_id and m.code = 'communications';
  if v_value is not null and jsonb_typeof(v_value) = 'boolean' then
    return (v_value #>> '{}')::boolean;
  end if;

  select os.config_jsonb -> 'communications.emergencyRequiresSecondApprover' into v_value
  from organization_module_settings os
  join modules m on m.id = os.module_id
  join facilities f on f.organization_id = os.organization_id
  where f.id = p_facility_id and m.code = 'communications';
  if v_value is not null and jsonb_typeof(v_value) = 'boolean' then
    return (v_value #>> '{}')::boolean;
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

-- ---------------------------------------------------------------------------
-- 5a. Server-side audience resolution and the content hash (M-3, H-1b).
-- These mirror src/lib/communications.mjs's resolveMessageAudience and
-- communications-audience.mjs (employee / department / role / shift by id or
-- window, shifts live = not cancelled or deleted, assignments pending or
-- approved) so the recipient list the emergency job carries is derived in the
-- database from the message's own rows, never from a request. Internal
-- helpers: only the definer functions below call them.
-- ---------------------------------------------------------------------------
create or replace function internal.fn_emergency_window(p_rule jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_spec jsonb;
  v_kind text;
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_rule is null or jsonb_typeof(p_rule) <> 'object' then
    return null;
  end if;
  v_spec := coalesce(nullif(p_rule -> 'window', 'null'::jsonb), nullif(p_rule -> 'shiftWindow', 'null'::jsonb));
  if v_spec is null then
    return null;
  end if;
  if jsonb_typeof(v_spec) = 'string' then
    v_kind := lower(btrim(v_spec #>> '{}'));
    if v_kind in ('current', 'next') then
      return jsonb_build_object('kind', v_kind);
    end if;
    return null;
  end if;
  if jsonb_typeof(v_spec) <> 'object' then
    return null;
  end if;
  if jsonb_typeof(v_spec -> 'kind') = 'string' then
    v_kind := lower(btrim(v_spec ->> 'kind'));
    if v_kind in ('current', 'next') then
      return jsonb_build_object('kind', v_kind);
    end if;
    if v_kind <> 'range' then
      return null;
    end if;
  end if;
  begin
    v_from := coalesce(v_spec ->> 'from', v_spec ->> 'start')::timestamptz;
    v_to := coalesce(v_spec ->> 'to', v_spec ->> 'end')::timestamptz;
  exception when others then
    return null;
  end;
  if v_from is null or v_to is null or v_from >= v_to or v_to - v_from > interval '31 days' then
    return null;
  end if;
  return jsonb_build_object('kind', 'range', 'from', v_from, 'to', v_to);
end;
$$;

-- Generic over the message: both approve_emergency_launch() (CM-13) and
-- publish_urgent_message() (NEW-1) resolve their recipients here, so a
-- publisher never chooses who a quiet-hours-bypassing job pages.
create or replace function internal.fn_emergency_audience(p_message_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_facility uuid;
  v_recipients uuid[];
  v_unresolved integer;
begin
  select facility_id into v_facility from messages where id = p_message_id;
  if not found then
    return jsonb_build_object('recipients', '[]'::jsonb, 'unresolved', 0);
  end if;

  with aud as (
    select a.audience_type, a.audience_ref_id,
           case when a.audience_type = 'shift' and a.audience_ref_id is null
                then internal.fn_emergency_window(a.rule_jsonb) end as win,
           nullif(a.rule_jsonb ->> 'departmentId', '') as dept
    from message_audiences a
    where a.message_id = p_message_id
      and a.facility_id = v_facility
      and a.deleted_at is null
  ),
  -- NEW-3: the roster is the live employees of the facility. A soft-deleted
  -- (former) employee is never a recipient, however the audience reaches them
  -- (department, role, a named employee or a shift assignment); the filter on
  -- `emp` applies to every branch below through the final exists().
  emp as (
    select e.id, e.department_id, e.user_id, e.created_at
      from employees e
     where e.facility_id = v_facility and e.deleted_at is null
  ),
  picked as (
    select a.audience_ref_id as employee_id
      from aud a
     where a.audience_type = 'employee' and a.audience_ref_id is not null
    union
    select e.id
      from aud a join emp e on e.department_id = a.audience_ref_id
     where a.audience_type = 'department' and a.audience_ref_id is not null
    union
    -- NEW-3: one employee row per person. A user holding two employee rows in
    -- the facility is one recipient of a role audience, not two (the earliest
    -- row, the one approve_emergency_launch() also attributes to).
    select r.id
      from (
        select distinct on (m.user_id) e.id
          from aud a
          join memberships m on m.facility_id = v_facility and m.role_id = a.audience_ref_id and m.status = 'active'
          join emp e on e.user_id = m.user_id
         where a.audience_type = 'role' and a.audience_ref_id is not null
         order by m.user_id, e.created_at, e.id
      ) r
    union
    select sa.employee_id
      from shift_assignments sa
     where sa.facility_id = v_facility
       and sa.status in ('pending', 'approved')
       and sa.deleted_at is null
       and sa.shift_id in (
         select a.audience_ref_id
           from aud a
          where a.audience_type = 'shift' and a.audience_ref_id is not null
         union
         select s.id
           from aud a
           join schedule_shifts s
             on s.facility_id = v_facility
            and s.deleted_at is null
            and s.status <> 'cancelled'
            and (a.dept is null or s.department_id::text = a.dept)
          where a.win is not null
            and (
              (a.win ->> 'kind' = 'current' and s.starts_at <= p_at and p_at < s.ends_at)
              or (a.win ->> 'kind' = 'range'
                  and s.starts_at < (a.win ->> 'to')::timestamptz
                  and s.ends_at > (a.win ->> 'from')::timestamptz)
              or (a.win ->> 'kind' = 'next'
                  and s.starts_at > p_at
                  and s.starts_at <= p_at + interval '7 days'
                  and s.starts_at = (
                    select min(s2.starts_at)
                      from schedule_shifts s2
                     where s2.facility_id = v_facility
                       and s2.deleted_at is null
                       and s2.status <> 'cancelled'
                       and (a.dept is null or s2.department_id::text = a.dept)
                       and s2.starts_at > p_at
                       and s2.starts_at <= p_at + interval '7 days'
                  ))
            )
       )
  )
  select coalesce(array_agg(distinct p.employee_id order by p.employee_id), '{}'::uuid[]),
         (select count(*) from aud where audience_type = 'shift' and audience_ref_id is null and win is null)
    into v_recipients, v_unresolved
    from picked p
   where p.employee_id is not null
     and exists (select 1 from emp where emp.id = p.employee_id);

  return jsonb_build_object(
    'recipients', (select coalesce(jsonb_agg(r::text order by r), '[]'::jsonb) from unnest(v_recipients) as r),
    'unresolved', v_unresolved
  );
end;
$$;

create or replace function internal.fn_emergency_content_hash(p_message_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      m.channel_id::text || E'\x1f' || m.priority || E'\x1f' || m.subject || E'\x1f' || m.body_text || E'\x1f' ||
      coalesce((
        select string_agg(
                 a.audience_type || ':' || coalesce(a.audience_ref_id::text, '') || ':' || a.rule_jsonb::text,
                 E'\x1e' order by a.audience_type, a.audience_ref_id, a.rule_jsonb::text)
          from message_audiences a
         where a.message_id = m.id and a.deleted_at is null
      ), ''),
      'UTF8')),
    'hex')
  from messages m
  where m.id = p_message_id;
$$;

revoke execute on function internal.fn_emergency_window(jsonb) from public, authenticated;
revoke execute on function internal.fn_emergency_audience(uuid, timestamptz) from public, authenticated;
revoke execute on function internal.fn_emergency_content_hash(uuid) from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.fn_emergency_window(jsonb) from anon;
    revoke execute on function internal.fn_emergency_audience(uuid, timestamptz) from anon;
    revoke execute on function internal.fn_emergency_content_hash(uuid) from anon;
  end if;
end
$$;

create or replace function fn_emergency_alert_launch_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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

    -- Guard 8: the content the approver will be asked to approve is pinned at
    -- request time (subject, body, channel and audience set). A client-supplied
    -- hash is overwritten.
    new.content_hash := internal.fn_emergency_content_hash(new.message_id);

    new.requested_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- Guard 4: identity columns never change after the request.
  if new.facility_id is distinct from old.facility_id
     or new.message_id is distinct from old.message_id
     or new.requested_by_employee_id is distinct from old.requested_by_employee_id
     or new.requested_at is distinct from old.requested_at
     or new.content_hash is distinct from old.content_hash then
    raise exception 'emergency launch: facility, message, requester and content hash are immutable'
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
  -- the requester. The comparison is between PEOPLE (employees.user_id), not
  -- employee rows: a user holding two employee rows in one facility cannot
  -- request with one and approve with the other (M-2). approved_at is
  -- server-stamped.
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
    if fn_comms_emergency_requires_second_approver(new.facility_id)
       and (
         new.approved_by_employee_id = new.requested_by_employee_id
         or exists (
           select 1
           from employees approver
           join employees requester on requester.user_id = approver.user_id
           where approver.id = new.approved_by_employee_id
             and requester.id = new.requested_by_employee_id
         )
         or (v_actor is not null and exists (
           select 1 from employees requester
           where requester.id = new.requested_by_employee_id and requester.user_id = v_actor
         ))
       ) then
      raise exception 'emergency launch: a second approver (a different person than the requester) is required'
        using errcode = '42501';
    end if;
    -- Guard 9: the approval is for the content that was requested. A message
    -- whose subject, body, channel or audience changed since the request must
    -- be cancelled and requested again.
    if new.content_hash is distinct from internal.fn_emergency_content_hash(new.message_id) then
      raise exception 'emergency launch: the message content changed since the launch was requested'
        using errcode = 'check_violation';
    end if;
    new.approved_at := now();
  elsif new.approved_by_employee_id is distinct from old.approved_by_employee_id
        or new.approved_at is distinct from old.approved_at then
    raise exception 'emergency launch: approval data is write-once'
      using errcode = '42501';
  end if;

  -- Guard 7: the launch stamp and the recipient count are server-written, only
  -- on approved -> launched.
  if new.status = 'launched' and old.status = 'approved' then
    if new.recipient_count is null then
      raise exception 'emergency launch: a launch records its recipient count'
        using errcode = 'check_violation';
    end if;
    if new.content_hash is distinct from internal.fn_emergency_content_hash(new.message_id) then
      raise exception 'emergency launch: the message content changed since the launch was requested'
        using errcode = 'check_violation';
    end if;
    new.launched_at := now();
  elsif new.launched_at is distinct from old.launched_at
        or new.recipient_count is distinct from old.recipient_count then
    raise exception 'emergency launch: launched_at and recipient_count are stamped by the launch transition only'
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

-- Client-session guard (H-1b, L-2): a direct write cannot approve or launch.
-- The approval, the publish, the job and the `launched` stamp are one
-- transaction inside approve_emergency_launch(); a client may only request a
-- launch and cancel a pending one. SECURITY INVOKER so current_user is real.
create or replace function fn_emergency_alert_launches_guard_client()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: only client sessions (see the notification_jobs guard above).
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status and new.status in ('approved', 'launched') then
      raise exception 'emergency launches are approved and launched through approve_emergency_launch() only'
        using errcode = '42501';
    end if;
    if new.approved_by_employee_id is distinct from old.approved_by_employee_id
       or new.approved_at is distinct from old.approved_at
       or new.launched_at is distinct from old.launched_at
       or new.recipient_count is distinct from old.recipient_count then
      raise exception 'emergency launch approval and launch data are written by approve_emergency_launch() only'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists emergency_alert_launches_guard_client on emergency_alert_launches;
create trigger emergency_alert_launches_guard_client
  before insert or update on emergency_alert_launches
  for each row execute function fn_emergency_alert_launches_guard_client();

revoke execute on function fn_emergency_alert_launches_guard_client() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_emergency_alert_launches_guard_client() from anon;
  end if;
end
$$;

-- NEW-2: the launch's lifecycle is written to the append-only audit trail
-- (audit_events, 0010/0013: no client INSERT, no UPDATE/DELETE), the same
-- AFTER-trigger shape 0033 uses for report submissions. SECURITY DEFINER so the
-- row lands whoever the session is; the actor is the JWT subject when it names
-- an app user (a definer path such as approve_emergency_launch() keeps the
-- caller's JWT, so the approval and the launch are attributed to the approver).
create or replace function fn_emergency_alert_launch_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'emergency.launch_requested';
  elsif new.status is distinct from old.status then
    v_event := case new.status
      when 'approved' then 'emergency.launch_approved'
      when 'launched' then 'emergency.launch_launched'
      when 'cancelled' then 'emergency.launch_cancelled'
      else null
    end;
  end if;
  if v_event is null then
    return new;
  end if;

  if v_actor is not null and not exists (select 1 from app_users where id = v_actor) then
    v_actor := null;
  end if;

  insert into audit_events (facility_id, actor_user_id, event_type, entity_table, entity_id, event_payload)
  values (
    new.facility_id,
    v_actor,
    v_event,
    'emergency_alert_launches',
    new.id,
    jsonb_build_object(
      'messageId', new.message_id,
      'status', new.status,
      'requestedByEmployeeId', new.requested_by_employee_id,
      'approvedByEmployeeId', new.approved_by_employee_id,
      'recipientCount', new.recipient_count
    )
  );
  return new;
end;
$$;

drop trigger if exists emergency_alert_launches_audit on emergency_alert_launches;
create trigger emergency_alert_launches_audit
  after insert or update on emergency_alert_launches
  for each row execute function fn_emergency_alert_launch_audit();

revoke execute on function fn_emergency_alert_launch_audit() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_emergency_alert_launch_audit() from anon;
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
-- 5b. approve_emergency_launch (H-1b, L-2): the ONE place an emergency alert
-- is approved, published, enqueued and stamped launched. SECURITY DEFINER,
-- granted to `authenticated`, follows 0058's create_work_order_from_incident
-- pattern: re-checks the caller's own communications.publish, derives every
-- written value (recipients from the message's audience rows, the title and
-- body from the message, the channels and bypass flag from constants) and
-- takes only the message id from the caller. The launch row is locked first,
-- so a concurrent cancel or a second approver serializes behind it; any
-- failure (no recipients, content changed, job insert) rolls the whole thing
-- back, approval included. Failures carry PostgREST's PTnnn status codes.
-- ---------------------------------------------------------------------------
create or replace function internal.approve_emergency_launch(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_facility uuid;
  v_launch emergency_alert_launches%rowtype;
  v_message messages%rowtype;
  v_employee uuid;
  v_enabled boolean;
  v_now timestamptz := now();
  v_resolved jsonb;
  v_count integer;
begin
  if v_actor is null then
    raise exception 'approve_emergency_launch: authentication required'
      using errcode = '28000';
  end if;

  select facility_id into v_facility from emergency_alert_launches where message_id = p_message_id;
  if not found then
    raise exception 'no emergency launch has been requested for this message'
      using errcode = 'PT404';
  end if;
  if not internal.has_permission(v_actor, v_facility, 'communications.publish') then
    raise exception 'approve_emergency_launch: missing permission: communications.publish'
      using errcode = '42501';
  end if;

  -- Serialize with every other writer of this launch (cancel, a second
  -- approval) before reading any state that the decision depends on.
  select * into v_launch from emergency_alert_launches where message_id = p_message_id for update;
  select * into v_message from messages where id = p_message_id for update;
  if not found or v_message.facility_id <> v_launch.facility_id or v_message.deleted_at is not null then
    raise exception 'message not found' using errcode = 'PT404';
  end if;
  if v_launch.status = 'launched' then
    raise exception 'emergency already launched' using errcode = 'PT409';
  end if;
  if v_launch.status = 'cancelled' then
    raise exception 'emergency launch was cancelled' using errcode = 'PT409';
  end if;
  if v_message.published_at is not null then
    raise exception 'message already published' using errcode = 'PT409';
  end if;
  if v_message.priority <> 'emergency' then
    raise exception 'only a message with priority ''emergency'' can be launched as an emergency'
      using errcode = 'PT409';
  end if;
  select c.emergency_enabled into v_enabled from communication_channels c where c.id = v_message.channel_id;
  if v_enabled is not true then
    raise exception 'the message channel is not emergency-enabled' using errcode = 'PT409';
  end if;
  if v_launch.content_hash is distinct from internal.fn_emergency_content_hash(p_message_id) then
    raise exception 'the message content changed since the launch was requested; cancel it and request a new launch'
      using errcode = 'PT409';
  end if;

  select e.id into v_employee
    from employees e
   where e.facility_id = v_launch.facility_id and e.user_id = v_actor and e.deleted_at is null
   order by e.created_at, e.id
   limit 1;
  if v_employee is null then
    raise exception 'no employee record for this facility' using errcode = 'PT403';
  end if;

  -- The approval. The launch guard enforces a different PERSON than the
  -- requester (when the tenant requires one), attribution to the caller's own
  -- employee row, and the content hash.
  if v_launch.status = 'pending_approval' then
    update emergency_alert_launches
       set status = 'approved', approved_by_employee_id = v_employee
     where id = v_launch.id;
  end if;
  select * into v_launch from emergency_alert_launches where id = v_launch.id;
  if v_launch.status <> 'approved' or v_launch.approved_by_employee_id is null then
    raise exception 'emergency launch is not approved' using errcode = 'PT409';
  end if;
  if fn_comms_emergency_requires_second_approver(v_launch.facility_id) and exists (
       select 1
         from employees approver
         join employees requester on requester.user_id = approver.user_id
        where approver.id = v_launch.approved_by_employee_id
          and requester.id = v_launch.requested_by_employee_id
     ) then
    raise exception 'a second approver (a different person than the requester) is required'
      using errcode = 'PT403';
  end if;

  -- Recipients, derived from the message's own audience. An emergency that
  -- would reach nobody is refused without consuming the approval.
  v_resolved := internal.fn_emergency_audience(p_message_id, v_now);
  v_count := jsonb_array_length(v_resolved -> 'recipients');
  if v_count = 0 then
    raise exception 'the message audience resolves to no recipients' using errcode = 'PT409';
  end if;

  update messages
     set published_at = v_now, updated_at = v_now
   where id = p_message_id and published_at is null;

  begin
    insert into notification_jobs (facility_id, event_type, status, scheduled_for, payload_jsonb)
    values (
      v_launch.facility_id,
      'message.emergency',
      'pending',
      v_now,
      jsonb_build_object(
        'route_id', null,
        'priority', 'emergency',
        'channels', jsonb_build_array('in_app', 'push', 'sms', 'email'),
        'recipients', v_resolved -> 'recipients',
        'messageId', p_message_id,
        'quietHoursBypass', true,
        'emergency', true,
        'title', 'EMERGENCY: ' || left(v_message.subject, 200),
        'body', left(v_message.body_text, 500)
      )
    );
  exception when unique_violation then
    raise exception 'an emergency job already exists for this message' using errcode = 'PT409';
  end;

  update emergency_alert_launches
     set status = 'launched', recipient_count = v_count
   where id = v_launch.id;

  return jsonb_build_object(
    'launchId', v_launch.id,
    'status', 'launched',
    'publishedAt', v_now,
    'recipientCount', v_count,
    'channels', jsonb_build_array('in_app', 'push', 'sms', 'email'),
    'quietHoursBypass', true,
    'unresolvedAudiences', (v_resolved -> 'unresolved')
  );
end;
$$;

revoke execute on function internal.approve_emergency_launch(uuid) from public;
grant execute on function internal.approve_emergency_launch(uuid) to authenticated;

-- The approval queue (and the approver's view of what they are about to send):
-- the launches of one facility with the message body and the recipient count
-- the audience resolves to right now, from the same resolver the approval uses.
create or replace function internal.emergency_launch_queue(
  p_facility_id uuid,
  p_status text default 'pending_approval'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_rows jsonb;
begin
  if v_actor is null then
    raise exception 'emergency_launch_queue: authentication required'
      using errcode = '28000';
  end if;
  if not internal.has_permission(v_actor, p_facility_id, 'communications.publish') then
    raise exception 'emergency_launch_queue: missing permission: communications.publish'
      using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending_approval', 'approved', 'launched', 'cancelled') then
    raise exception 'status must be pending_approval, approved, launched or cancelled'
      using errcode = 'PT400';
  end if;

  select coalesce(jsonb_agg(q.entry order by q.requested_at desc), '[]'::jsonb)
    into v_rows
    from (
      select l.requested_at,
             to_jsonb(l) - 'content_hash'
             || jsonb_build_object(
                  'messages', jsonb_build_object('subject', m.subject, 'priority', m.priority, 'body_text', m.body_text),
                  'preview', case when l.status in ('pending_approval', 'approved') then (
                      select jsonb_build_object(
                               'recipientCount', jsonb_array_length(r.resolved -> 'recipients'),
                               'unresolvedAudiences', r.resolved -> 'unresolved')
                        from (select internal.fn_emergency_audience(l.message_id, now()) as resolved) r
                    ) end,
                  'contentChanged', l.status in ('pending_approval', 'approved')
                                    and l.content_hash is distinct from internal.fn_emergency_content_hash(l.message_id)
                ) as entry
        from emergency_alert_launches l
        join messages m on m.id = l.message_id
       where l.facility_id = p_facility_id
         and (p_status is null or l.status = p_status)
       order by l.requested_at desc
       limit 50
    ) q;
  return v_rows;
end;
$$;

revoke execute on function internal.emergency_launch_queue(uuid, text) from public;
grant execute on function internal.emergency_launch_queue(uuid, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.approve_emergency_launch(uuid) from anon;
    revoke execute on function internal.emergency_launch_queue(uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.approve_emergency_launch(uuid) to service_role;
    grant execute on function internal.emergency_launch_queue(uuid, text) to service_role;
  end if;
end
$$;

-- PostgREST only serves functions in its exposed schemas (`public`); these
-- thin SECURITY INVOKER wrappers are what the routes' pgRpc calls post to.
-- They carry no logic of their own.
create or replace function public.approve_emergency_launch(p_message_id uuid)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.approve_emergency_launch(p_message_id);
$$;

create or replace function public.emergency_launch_queue(
  p_facility_id uuid,
  p_status text default 'pending_approval'
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.emergency_launch_queue(p_facility_id, p_status);
$$;

revoke execute on function public.approve_emergency_launch(uuid) from public;
grant execute on function public.approve_emergency_launch(uuid) to authenticated;
revoke execute on function public.emergency_launch_queue(uuid, text) from public;
grant execute on function public.emergency_launch_queue(uuid, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.approve_emergency_launch(uuid) from anon;
    revoke execute on function public.emergency_launch_queue(uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.approve_emergency_launch(uuid) to service_role;
    grant execute on function public.emergency_launch_queue(uuid, text) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5c. publish_urgent_message (NEW-1): the ONE place an urgent message is
-- published together with its quiet-hours-bypassing job. The notification_jobs
-- client guard no longer accepts a client-written message.published bypass job
-- (its old "urgent-publish exception" left channels, recipients and copy to
-- the caller, needed no second approver and could be repeated after cancelling
-- the sent job). Same shape as approve_emergency_launch(): SECURITY DEFINER,
-- re-checks the caller's own communications.publish in the message's facility,
-- takes only the message id, and derives everything it writes -- the
-- recipients from the message's own audience rows (the resolver the emergency
-- flow uses), the channels from the constant below (kept equal to
-- channelsForPriority('urgent') in src/lib/communications.mjs by a structural
-- test), the title from the message's subject, bypass true -- in one
-- transaction, once per message (the message row lock, the in-function check
-- and notification_jobs_urgent_publish_message_uidx). Only an urgent,
-- unpublished, non-deleted message qualifies; failures carry PostgREST's PTnnn
-- status codes. Non-urgent messages never get a bypass job: the ordinary
-- publish route keeps writing their (bypass false) job itself.
-- ---------------------------------------------------------------------------
create or replace function internal.publish_urgent_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_facility uuid;
  v_message messages%rowtype;
  v_now timestamptz := now();
  v_resolved jsonb;
  v_count integer;
begin
  if v_actor is null then
    raise exception 'publish_urgent_message: authentication required'
      using errcode = '28000';
  end if;

  select facility_id into v_facility from messages where id = p_message_id;
  if not found then
    raise exception 'message not found' using errcode = 'PT404';
  end if;
  if not internal.has_permission(v_actor, v_facility, 'communications.publish') then
    raise exception 'publish_urgent_message: missing permission: communications.publish'
      using errcode = '42501';
  end if;

  -- Serialize with every other writer of this message (a second publish, an
  -- edit, a soft delete) before reading the state the decision depends on.
  select * into v_message from messages where id = p_message_id for update;
  if not found or v_message.facility_id <> v_facility or v_message.deleted_at is not null then
    raise exception 'message not found' using errcode = 'PT404';
  end if;
  if v_message.published_at is not null then
    raise exception 'message already published' using errcode = 'PT409';
  end if;
  if v_message.priority <> 'urgent' then
    raise exception 'only a message with priority ''urgent'' is published through publish_urgent_message'
      using errcode = 'PT409';
  end if;
  if v_message.is_required_ack and v_message.ack_due_at is not null and v_message.ack_due_at <= v_now then
    raise exception 'ack_due_at must be later than the time the message is published'
      using errcode = 'PT400';
  end if;
  if exists (
    select 1 from notification_jobs j
     where j.event_type = 'message.published'
       and j.payload_jsonb ->> 'messageId' = p_message_id::text
       and j.payload_jsonb ->> 'quietHoursBypass' = 'true'
  ) then
    raise exception 'an urgent publish job already exists for this message' using errcode = 'PT409';
  end if;

  v_resolved := internal.fn_emergency_audience(p_message_id, v_now);
  v_count := jsonb_array_length(v_resolved -> 'recipients');

  update messages
     set published_at = v_now, updated_at = v_now
   where id = p_message_id and published_at is null;

  begin
    insert into notification_jobs (facility_id, event_type, status, scheduled_for, payload_jsonb)
    values (
      v_facility,
      'message.published',
      'pending',
      v_now,
      jsonb_build_object(
        'route_id', null,
        'priority', 'urgent',
        'channels', jsonb_build_array('in_app', 'push'),
        'recipients', v_resolved -> 'recipients',
        'messageId', p_message_id,
        'quietHoursBypass', true,
        'publishedBy', v_actor,
        'title', left(v_message.subject, 200)
      )
    );
  exception when unique_violation then
    raise exception 'an urgent publish job already exists for this message' using errcode = 'PT409';
  end;

  return jsonb_build_object(
    'publishedAt', v_now,
    'recipientCount', v_count,
    'channels', jsonb_build_array('in_app', 'push'),
    'quietHoursBypass', true,
    'unresolvedAudiences', (v_resolved -> 'unresolved')
  );
end;
$$;

revoke execute on function internal.publish_urgent_message(uuid) from public;
grant execute on function internal.publish_urgent_message(uuid) to authenticated;

create or replace function public.publish_urgent_message(p_message_id uuid)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  select internal.publish_urgent_message(p_message_id);
$$;

revoke execute on function public.publish_urgent_message(uuid) from public;
grant execute on function public.publish_urgent_message(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function internal.publish_urgent_message(uuid) from anon;
    revoke execute on function public.publish_urgent_message(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function internal.publish_urgent_message(uuid) to service_role;
    grant execute on function public.publish_urgent_message(uuid) to service_role;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. messages: an emergency message cannot be published without an approved
-- launch, is frozen once a launch exists, and cannot be hard-deleted while a
-- launch or responses exist. The publish gate fires for every role, service
-- role included.
-- ---------------------------------------------------------------------------
create or replace function fn_messages_guard_emergency_publish()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: the transition INTO "published emergency message" (an INSERT that
  -- is already published, or an UPDATE that sets published_at / raises
  -- priority to emergency on a published row) requires an APPROVED
  -- emergency_alert_launches row for this very message. `launched` does not
  -- qualify (M-3): a launched message that is unpublished and published again
  -- would be a republish with no new approval; the only thing that moves a
  -- launch out of `approved` is approve_emergency_launch(), in the same
  -- transaction as the first publish.
  if new.priority = 'emergency'
     and new.published_at is not null
     and (tg_op = 'INSERT' or old.published_at is null or old.priority is distinct from 'emergency') then
    if not exists (
      select 1 from emergency_alert_launches l
      where l.message_id = new.id
        and l.facility_id = new.facility_id
        and l.status = 'approved'
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

-- M-3: once a launch exists (or the message is a published emergency) a client
-- session cannot change what was requested or approved: subject, body,
-- channel, priority, ack settings, author, facility and published_at are
-- frozen. Soft delete (deleted_at) stays possible. SECURITY INVOKER so the
-- definer path that publishes the message is not a client session; the
-- launch lookup runs under the caller's RLS, where a publisher sees exactly
-- the launches of the facility whose messages the update policy lets them
-- touch.
create or replace function fn_messages_guard_emergency_freeze()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_frozen boolean;
begin
  -- Guard 1: only client sessions.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Guard 2: frozen = a published emergency message, or any message with a
  -- live (pending, approved or launched) emergency launch.
  v_frozen := (old.priority = 'emergency' and old.published_at is not null)
    or exists (
      select 1 from emergency_alert_launches l
      where l.message_id = old.id and l.status in ('pending_approval', 'approved', 'launched')
    );
  if not v_frozen then
    return new;
  end if;

  if new.facility_id is distinct from old.facility_id
     or new.channel_id is distinct from old.channel_id
     or new.author_employee_id is distinct from old.author_employee_id
     or new.message_type is distinct from old.message_type
     or new.subject is distinct from old.subject
     or new.body_text is distinct from old.body_text
     or new.priority is distinct from old.priority
     or new.is_required_ack is distinct from old.is_required_ack
     or new.ack_due_at is distinct from old.ack_due_at
     or new.published_at is distinct from old.published_at then
    raise exception 'an emergency message is frozen once a launch has been requested; cancel the launch and write a new message'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_emergency_freeze on messages;
create trigger messages_guard_emergency_freeze
  before update on messages
  for each row execute function fn_messages_guard_emergency_freeze();

-- M-4: a message with an emergency launch or responses cannot be hard-deleted
-- by a client session (the ON DELETE RESTRICT foreign keys refuse it for
-- everyone else, with a less helpful message).
create or replace function fn_messages_guard_emergency_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: only client sessions.
  if current_user not in ('authenticated', 'anon') then
    return old;
  end if;
  if exists (select 1 from emergency_alert_launches l where l.message_id = old.id)
     or exists (select 1 from emergency_alert_responses r where r.message_id = old.id) then
    raise exception 'a message with an emergency launch or emergency responses cannot be deleted'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists messages_guard_emergency_delete on messages;
create trigger messages_guard_emergency_delete
  before delete on messages
  for each row execute function fn_messages_guard_emergency_delete();

-- M-3: the audience of a message with a live launch is frozen for client
-- sessions too (the content hash would catch it at approval; this refuses it
-- up front, and after the launch).
create or replace function fn_message_audiences_guard_emergency_freeze()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: only client sessions.
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from emergency_alert_launches l
    where l.message_id in (coalesce(old.message_id, new.message_id), coalesce(new.message_id, old.message_id))
      and l.status in ('pending_approval', 'approved', 'launched')
  ) then
    raise exception 'the audience of a message with an emergency launch is frozen'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists message_audiences_guard_emergency_freeze on message_audiences;
create trigger message_audiences_guard_emergency_freeze
  before insert or update or delete on message_audiences
  for each row execute function fn_message_audiences_guard_emergency_freeze();

revoke execute on function fn_messages_guard_emergency_publish() from public, authenticated;
revoke execute on function fn_messages_guard_ack_escalation() from public, authenticated;
revoke execute on function fn_messages_set_ack_next_escalation() from public, authenticated;
revoke execute on function fn_messages_guard_emergency_freeze() from public, authenticated;
revoke execute on function fn_messages_guard_emergency_delete() from public, authenticated;
revoke execute on function fn_message_audiences_guard_emergency_freeze() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_messages_guard_emergency_publish() from anon;
    revoke execute on function fn_messages_guard_ack_escalation() from anon;
    revoke execute on function fn_messages_set_ack_next_escalation() from anon;
    revoke execute on function fn_messages_guard_emergency_freeze() from anon;
    revoke execute on function fn_messages_guard_emergency_delete() from anon;
    revoke execute on function fn_message_audiences_guard_emergency_freeze() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. emergency_alert_responses (CM-13): "I am safe" / "need help".
-- message_id is ON DELETE RESTRICT (M-4): a safety record must not vanish with
-- a hard-deleted message.
-- ---------------------------------------------------------------------------
create table if not exists emergency_alert_responses (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  message_id uuid not null references messages(id) on delete restrict,
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
set search_path = public, pg_temp
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

-- ---------------------------------------------------------------------------
-- 8. communication_channels.emergency_enabled (L-3). 0038's publisher
-- FOR ALL policy lets any communications.publish holder switch the flag that
-- marks a channel as emergency-capable, which would make "a channel an admin
-- has marked emergency-enabled" a publisher-controlled gate. That policy is
-- left as it is (re-creating it would have to re-derive its latest
-- definition); instead a column guard requires admin.manage to turn the flag
-- on or change it from a client session. SECURITY INVOKER (current_user is the
-- caller's role); internal.has_permission is executable by `authenticated`.
-- ---------------------------------------------------------------------------
create or replace function fn_communication_channels_guard_emergency_enabled()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Guard 1: only client sessions; the service role and definer paths are the
  -- admin console's own writes.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- Guard 2: setting or changing the flag takes admin.manage in the channel's
  -- facility (a publisher may still create and edit ordinary channels).
  if (tg_op = 'INSERT' and new.emergency_enabled)
     or (tg_op = 'UPDATE' and new.emergency_enabled is distinct from old.emergency_enabled) then
    if not internal.has_permission(auth.uid(), new.facility_id, 'admin.manage') then
      raise exception 'communication_channels.emergency_enabled can only be changed by an admin.manage holder'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists communication_channels_guard_emergency_enabled on communication_channels;
create trigger communication_channels_guard_emergency_enabled
  before insert or update on communication_channels
  for each row execute function fn_communication_channels_guard_emergency_enabled();

revoke execute on function fn_communication_channels_guard_emergency_enabled() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_communication_channels_guard_emergency_enabled() from anon;
  end if;
end
$$;

notify pgrst, 'reload schema';
