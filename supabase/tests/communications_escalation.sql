-- Verification intent: CM-10 / CM-12 / CM-13 (0064_communications_escalation.sql).
-- Covers:
--   1. Structure: RLS enabled on message_escalation_events,
--      emergency_alert_launches and emergency_alert_responses; split
--      per-operation policies only (no `for all`), no DELETE policy on any of
--      them, no write policy at all on the append-only escalation ledger.
--   2. CM-10: messages.ack_escalation_level / ack_escalated_at are writable
--      only by a service-role session (auth.uid() null); an authenticated
--      publisher is rejected on INSERT and UPDATE. message_escalation_events
--      is append-only even for the owner (UPDATE/DELETE blocked), unique per
--      (message, level), readable by publishers only, and unwritable by any
--      authenticated session.
--   3. fn_notification_job_dedupe_key (0058, re-created): the ack-escalation
--      key is computed per (message, level) so two messages with the same
--      first recipient never collide, an authenticated session's key for
--      those event types is dropped (no key squatting), and 0058's incident
--      formula is carried forward verbatim. 0058's incident-scoped
--      notification_jobs policies are untouched (the policy set and the
--      guarded INSERT predicate are asserted against pg_policies, and no
--      policy was added).
--   4. CM-13: emergency_alert_launches -- request attributed to the caller's
--      own employee, unpublished emergency-priority draft on an
--      emergency-enabled channel in the same facility only, second approver
--      enforced by the tenant setting (default on, off via the facility
--      override), approval attributed to the caller's own employee, the
--      state machine, write-once approval data.
--   5. messages cannot become a published emergency message without an
--      approved launch (INSERT or UPDATE), and ordinary messages are
--      unaffected.
--   6. emergency_alert_responses: an employee records and changes ONLY their
--      own response (reader, publisher, other-facility and no-comms callers
--      are all rejected for anyone else's), server-stamped responded_at,
--      published-emergency messages only, publishers read the roll-up,
--      readers see only their own row, and no one can delete.
-- Runs inside a transaction that is rolled back, so no fixture persists.
begin;

create function pg_temp.expect_error(label text, stmt text, expected text[]) returns void
language plpgsql as $$
begin
  execute stmt;
  raise exception 'CE FAIL (%): expected one of % but the statement succeeded', label, expected;
exception
  when others then
    if sqlerrm like 'CE FAIL%' then
      raise;
    end if;
    if not (sqlstate = any (expected)) then
      raise exception 'CE FAIL (%): expected sqlstate in % but got % (%)', label, expected, sqlstate, sqlerrm;
    end if;
end;
$$;

create function pg_temp.expect_rows(label text, stmt text, expected integer) returns void
language plpgsql as $$
declare
  v_count integer;
begin
  execute stmt;
  get diagnostics v_count = row_count;
  if v_count <> expected then
    raise exception 'CE FAIL (%): expected % affected rows, got %', label, expected, v_count;
  end if;
end;
$$;

insert into auth.users (id, email) values
  ('64000000-0000-0000-0000-0000000000a1', 'ce-pub1@test'),
  ('64000000-0000-0000-0000-0000000000a2', 'ce-pub2@test'),
  ('64000000-0000-0000-0000-0000000000a3', 'ce-reader@test'),
  ('64000000-0000-0000-0000-0000000000a4', 'ce-bpub@test'),
  ('64000000-0000-0000-0000-0000000000a5', 'ce-nocomms@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('64000000-0000-0000-0000-0000000000a1', 'CE Publisher One', 'ce-pub1@test'),
  ('64000000-0000-0000-0000-0000000000a2', 'CE Publisher Two', 'ce-pub2@test'),
  ('64000000-0000-0000-0000-0000000000a3', 'CE Reader', 'ce-reader@test'),
  ('64000000-0000-0000-0000-0000000000a4', 'CE Facility B Publisher', 'ce-bpub@test'),
  ('64000000-0000-0000-0000-0000000000a5', 'CE No Comms', 'ce-nocomms@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('64111111-1111-1111-1111-111111111111', 'CE Org A'),
  ('64222222-2222-2222-2222-222222222222', 'CE Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64111111-1111-1111-1111-111111111111', 'CE Facility A'),
  ('64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '64222222-2222-2222-2222-222222222222', 'CE Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('64000000-0000-0000-0000-0000000000d1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE Publisher'),
  ('64000000-0000-0000-0000-0000000000d2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE Reader'),
  ('64000000-0000-0000-0000-0000000000d3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE No Comms'),
  ('64000000-0000-0000-0000-0000000000d4', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CE B Publisher')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('64000000-0000-0000-0000-0000000000d1', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d1', 'communications.publish'),
  ('64000000-0000-0000-0000-0000000000d2', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d3', 'reports.read'),
  ('64000000-0000-0000-0000-0000000000d4', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d4', 'communications.publish')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('64000000-0000-0000-0000-0000000000b1', '64000000-0000-0000-0000-0000000000a1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d1', 'active'),
  ('64000000-0000-0000-0000-0000000000b2', '64000000-0000-0000-0000-0000000000a2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d1', 'active'),
  ('64000000-0000-0000-0000-0000000000b3', '64000000-0000-0000-0000-0000000000a3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d2', 'active'),
  ('64000000-0000-0000-0000-0000000000b4', '64000000-0000-0000-0000-0000000000a4', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '64000000-0000-0000-0000-0000000000d4', 'active'),
  ('64000000-0000-0000-0000-0000000000b5', '64000000-0000-0000-0000-0000000000a5', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d3', 'active')
on conflict (id) do nothing;

insert into employees (id, facility_id, user_id, first_name, last_name) values
  ('64000000-0000-0000-0000-0000000000e1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a1', 'Pat', 'PublisherOne'),
  ('64000000-0000-0000-0000-0000000000e2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a2', 'Sam', 'PublisherTwo'),
  ('64000000-0000-0000-0000-0000000000e3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a3', 'Rae', 'Reader'),
  ('64000000-0000-0000-0000-0000000000e4', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '64000000-0000-0000-0000-0000000000a4', 'Bo', 'FacilityB'),
  ('64000000-0000-0000-0000-0000000000e5', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a5', 'Nic', 'NoComms')
on conflict (id) do nothing;

insert into communication_channels (id, facility_id, channel_type, name, emergency_enabled) values
  ('64000000-0000-0000-0000-0000000000c1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'emergency', 'CE Emergency A', true),
  ('64000000-0000-0000-0000-0000000000c2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facility', 'CE Ordinary A', false),
  ('64000000-0000-0000-0000-0000000000c3', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'emergency', 'CE Emergency B', true)
on conflict (id) do nothing;

-- Drafts (the owner writes, bypassing RLS; no claims set so auth.uid() is null).
insert into messages (id, facility_id, channel_id, author_employee_id, subject, body_text, priority, is_required_ack, ack_due_at, published_at) values
  ('64000000-0000-0000-0000-0000000000f1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 1', 'Move inside', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000f2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 2', 'Move inside', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000f3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Not enabled', 'x', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000f4', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Urgent only', 'x', 'urgent', false, null, null),
  ('64000000-0000-0000-0000-0000000000f5', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '64000000-0000-0000-0000-0000000000c3', '64000000-0000-0000-0000-0000000000e4', 'Facility B storm', 'x', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000f6', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Ack 1', 'x', 'normal', true, now() - interval '2 days', now() - interval '5 days'),
  ('64000000-0000-0000-0000-0000000000f7', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Ack 2', 'x', 'normal', true, now() - interval '2 days', now() - interval '5 days'),
  ('64000000-0000-0000-0000-0000000000f8', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 3', 'Move inside', 'emergency', false, null, null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Structure.
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_count integer;
begin
  foreach v_table in array array['message_escalation_events', 'emergency_alert_launches', 'emergency_alert_responses'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_table)::regclass) then
      raise exception 'CE FAIL: RLS is not enabled on %', v_table;
    end if;
    select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = v_table and cmd = 'ALL';
    if v_count <> 0 then
      raise exception 'CE FAIL: % has a for-all policy; policies must be split per operation', v_table;
    end if;
    select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = v_table and cmd = 'DELETE';
    if v_count <> 0 then
      raise exception 'CE FAIL: % has a DELETE policy', v_table;
    end if;
  end loop;

  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'message_escalation_events' and cmd <> 'SELECT';
  if v_count <> 0 then
    raise exception 'CE FAIL: message_escalation_events has a write policy (only the service role may write)';
  end if;

  -- The guarded WITH CHECK of the self-service response policies, asserted in full
  -- so a later redefinition cannot drop a guard silently.
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'emergency_alert_responses' and cmd = 'INSERT'
    and with_check like '%communications.read%'
    and (length(with_check) - length(replace(with_check, 'fn_assert_same_facility', ''))) / length('fn_assert_same_facility') = 2
    and with_check like '%user_id%';
  if v_count <> 1 then
    raise exception 'CE FAIL: the emergency response INSERT policy does not carry its full guard list (read permission, same-facility on message and employee, own employee)';
  end if;
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'emergency_alert_responses' and cmd = 'UPDATE'
    and with_check like '%communications.read%'
    and (length(with_check) - length(replace(with_check, 'fn_assert_same_facility', ''))) / length('fn_assert_same_facility') = 2
    and with_check like '%user_id%' and qual like '%user_id%';
  if v_count <> 1 then
    raise exception 'CE FAIL: the emergency response UPDATE policy does not carry its full guard list';
  end if;
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'emergency_alert_launches' and cmd = 'INSERT'
    and with_check like '%communications.publish%'
    and (length(with_check) - length(replace(with_check, 'fn_assert_same_facility', ''))) / length('fn_assert_same_facility') = 2;
  if v_count <> 1 then
    raise exception 'CE FAIL: the emergency launch INSERT policy does not guard message_id and requested_by_employee_id';
  end if;
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'emergency_alert_launches' and cmd = 'UPDATE'
    and with_check like '%communications.publish%'
    and (length(with_check) - length(replace(with_check, 'fn_assert_same_facility', ''))) / length('fn_assert_same_facility') = 3;
  if v_count <> 1 then
    raise exception 'CE FAIL: the emergency launch UPDATE policy does not guard message_id, requested_by_employee_id and approved_by_employee_id';
  end if;

  -- 0058's incident-scoped notification_jobs policies are not widened, and
  -- this migration added no authenticated notification_jobs policy of its own.
  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'notification_jobs';
  if v_count <> 3 then
    raise exception 'CE FAIL: notification_jobs should still have exactly its 3 policies, found %', v_count;
  end if;
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'notification_jobs' and policyname = 'incident actors can insert incident notification jobs'
    and cmd = 'INSERT'
    and with_check like '%incident.submitted%' and with_check like '%incident.escalated%' and with_check like '%incident.sla_breached%'
    and with_check like '%quietHoursBypass%' and with_check like '%severity%' and with_check not like '%message.%';
  if v_count <> 1 then
    raise exception 'CE FAIL: 0058''s incident notification_jobs INSERT policy changed';
  end if;

  -- The re-created dedupe function carries both generations of guards.
  if pg_get_functiondef('public.fn_notification_job_dedupe_key()'::regprocedure) not like '%Guard 1%'
     or pg_get_functiondef('public.fn_notification_job_dedupe_key()'::regprocedure) not like '%Guard 2%'
     or pg_get_functiondef('public.fn_notification_job_dedupe_key()'::regprocedure) not like '%incidentId%'
     or pg_get_functiondef('public.fn_notification_job_dedupe_key()'::regprocedure) not like '%escalationId%' then
    raise exception 'CE FAIL: fn_notification_job_dedupe_key lost a guard';
  end if;

  -- None of the new definer functions is callable by a signed-in user.
  foreach v_table in array array[
    'public.fn_notification_job_dedupe_key()',
    'public.fn_messages_guard_ack_escalation()',
    'public.fn_messages_guard_emergency_publish()',
    'public.fn_emergency_alert_launch_guard()',
    'public.fn_emergency_alert_response_guard()',
    'public.fn_comms_emergency_requires_second_approver(uuid)'
  ] loop
    if has_function_privilege('authenticated', v_table::regprocedure, 'execute') then
      raise exception 'CE FAIL: authenticated can execute %', v_table;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. CM-10: the escalation columns and the append-only ledger.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

select pg_temp.expect_error(
  'publisher cannot advance ack_escalation_level',
  $q$update messages set ack_escalation_level = 3 where id = '64000000-0000-0000-0000-0000000000f6'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'publisher cannot stamp ack_escalated_at',
  $q$update messages set ack_escalated_at = now() where id = '64000000-0000-0000-0000-0000000000f6'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'publisher cannot insert a message with a pre-set escalation level',
  $q$insert into messages (facility_id, channel_id, subject, body_text, ack_escalation_level)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', 's', 'b', 2)$q$,
  array['42501']
);
-- An ordinary update that leaves the columns alone still works.
select pg_temp.expect_rows(
  'publisher can still edit other message columns',
  $q$update messages set body_text = 'edited' where id = '64000000-0000-0000-0000-0000000000f6'$q$,
  1
);
select pg_temp.expect_error(
  'publisher cannot write the escalation ledger',
  $q$insert into message_escalation_events (facility_id, message_id, level, tier, event_code)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f6', 1, 'reminder', 'message.ack_overdue')$q$,
  array['42501']
);
reset role;

-- Service role (no claims): the sweep's writes.
select set_config('request.jwt.claims', '', true);
update messages set ack_escalation_level = 1, ack_escalated_at = now() where id = '64000000-0000-0000-0000-0000000000f6';
do $$
begin
  if (select ack_escalation_level from messages where id = '64000000-0000-0000-0000-0000000000f6') <> 1 then
    raise exception 'CE FAIL: the service role could not advance ack_escalation_level';
  end if;
end;
$$;
insert into message_escalation_events (id, facility_id, message_id, level, tier, event_code, recipient_count, dedupe_key) values
  ('64000000-0000-0000-0000-000000000e01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f6', 1, 'reminder', 'message.ack_overdue', 2, 'k1');

select pg_temp.expect_error(
  'the ledger is unique per (message, level)',
  $q$insert into message_escalation_events (facility_id, message_id, level, tier, event_code)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f6', 1, 'reminder', 'message.ack_overdue')$q$,
  array['23505']
);
select pg_temp.expect_error(
  'the ledger rejects an update, even from the owner',
  $q$update message_escalation_events set recipient_count = 99 where id = '64000000-0000-0000-0000-000000000e01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'the ledger rejects a delete, even from the owner',
  $q$delete from message_escalation_events where id = '64000000-0000-0000-0000-000000000e01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'the ledger rejects a level outside 1..3',
  $q$insert into message_escalation_events (facility_id, message_id, level, tier, event_code)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f7', 4, 'manager', 'x')$q$,
  array['23514']
);

-- Reads: publishers see it, readers and other tenants do not.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from message_escalation_events) <> 1 then
    raise exception 'CE FAIL: a publisher could not read the escalation ledger';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from message_escalation_events) <> 0 then
    raise exception 'CE FAIL: a plain reader could read the escalation ledger';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from message_escalation_events) <> 0 then
    raise exception 'CE FAIL: another facility''s publisher could read the escalation ledger';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. The re-created dedupe-key trigger.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into notification_jobs (id, facility_id, event_type, payload_jsonb, dedupe_key) values
  ('64000000-0000-0000-0000-000000000a01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.ack_overdue',
   '{"messageId":"64000000-0000-0000-0000-0000000000f6","escalationLevel":1,"recipients":["64000000-0000-0000-0000-0000000000e3"]}'::jsonb, 'client-chosen'),
  ('64000000-0000-0000-0000-000000000a02', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.ack_overdue',
   '{"messageId":"64000000-0000-0000-0000-0000000000f7","escalationLevel":1,"recipients":["64000000-0000-0000-0000-0000000000e3"]}'::jsonb, 'client-chosen');
do $$
begin
  if (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a01')
     <> '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:message.ack_overdue:64000000-0000-0000-0000-0000000000f6:1' then
    raise exception 'CE FAIL: the ack-escalation dedupe key was not recomputed per (message, level): %',
      (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a01');
  end if;
  if (select count(distinct dedupe_key) from notification_jobs where id in ('64000000-0000-0000-0000-000000000a01', '64000000-0000-0000-0000-000000000a02')) <> 2 then
    raise exception 'CE FAIL: two messages with the same first recipient collided on one dedupe key';
  end if;
end;
$$;
-- Same (message, level) again with ignore-duplicates semantics: a no-op.
insert into notification_jobs (facility_id, event_type, payload_jsonb, dedupe_key)
values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.ack_overdue',
        '{"messageId":"64000000-0000-0000-0000-0000000000f6","escalationLevel":1,"recipients":["64000000-0000-0000-0000-0000000000e1"]}'::jsonb, 'x')
on conflict (dedupe_key) do nothing;
do $$
begin
  if (select count(*) from notification_jobs where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-0000000000f6') <> 1 then
    raise exception 'CE FAIL: a duplicate (message, level) escalation job was inserted';
  end if;
end;
$$;
-- 0058's incident formula is carried forward for every other event type.
insert into notification_jobs (id, facility_id, event_type, payload_jsonb, dedupe_key) values
  ('64000000-0000-0000-0000-000000000a03', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'incident.sla_breached',
   '{"incidentId":"inc-1","escalationId":"esc-1","recipients":["emp-9"]}'::jsonb, 'zzz');
do $$
begin
  if (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a03')
     <> '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:incident.sla_breached:inc-1:esc-1:emp-9' then
    raise exception 'CE FAIL: 0058''s incident dedupe formula was not carried forward';
  end if;
end;
$$;

-- An authenticated publisher cannot squat a (message, level) key: for these
-- event types their key is dropped (the row is still insertable under the
-- pre-existing 0006 publisher policy, just without a key).
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into notification_jobs (id, facility_id, event_type, payload_jsonb, dedupe_key) values
  ('64000000-0000-0000-0000-000000000a04', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.ack_escalated_manager',
   '{"messageId":"64000000-0000-0000-0000-0000000000f6","escalationLevel":3,"recipients":["x"]}'::jsonb, 'squat');
reset role;
do $$
begin
  if (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a04') is not null then
    raise exception 'CE FAIL: an authenticated session kept a dedupe key on an ack-escalation job';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. CM-13: the launch ledger.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

select pg_temp.expect_error(
  'requested_by must be the caller''s own employee',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e2')$q$,
  array['42501']
);
select pg_temp.expect_error(
  'a non-emergency-priority draft cannot be launched',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f4', '64000000-0000-0000-0000-0000000000e1')$q$,
  array['23514']
);
select pg_temp.expect_error(
  'a channel that is not emergency-enabled cannot launch',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f3', '64000000-0000-0000-0000-0000000000e1')$q$,
  array['23514']
);
select pg_temp.expect_error(
  'a launch cannot point at another facility''s message',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f5', '64000000-0000-0000-0000-0000000000e1')$q$,
  array['42501', '23514']
);
select pg_temp.expect_error(
  'a launch cannot be born approved',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id, status, approved_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e1', 'approved', '64000000-0000-0000-0000-0000000000e1')$q$,
  array['23514']
);
-- The happy request.
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_error(
  'one launch per message',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e1')$q$,
  array['23505']
);

-- Second approver required by default: the requester cannot approve their own.
select pg_temp.expect_error(
  'the requester cannot approve their own launch (default setting)',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
reset role;

-- Another publisher: cannot approve under someone else's identity, can approve as themselves.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_error(
  'approval is attributed to the caller''s own employee',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e3'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'approval needs an approver',
  $q$update emergency_alert_launches set status = 'approved' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['23514']
);
select pg_temp.expect_error(
  'a launch cannot jump from pending to launched',
  $q$update emergency_alert_launches set status = 'launched' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['23514']
);

-- Before approval, the message cannot be published as an emergency (CM-13 gate).
select pg_temp.expect_error(
  'an unapproved emergency message cannot be published',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);

update emergency_alert_launches
set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e2', approved_at = '2000-01-01'
where id = '64000000-0000-0000-0000-000000000b01';
do $$
declare
  v_row emergency_alert_launches%rowtype;
begin
  select * into v_row from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b01';
  if v_row.status <> 'approved' or v_row.approved_by_employee_id <> '64000000-0000-0000-0000-0000000000e2' then
    raise exception 'CE FAIL: the second publisher could not approve';
  end if;
  if v_row.approved_at < now() - interval '1 minute' then
    raise exception 'CE FAIL: approved_at was client-controlled';
  end if;
end;
$$;
select pg_temp.expect_error(
  'approval data is write-once',
  $q$update emergency_alert_launches set approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'an approved launch cannot go back to pending',
  $q$update emergency_alert_launches set status = 'pending_approval' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['23514']
);
select pg_temp.expect_error(
  'the requester identity is immutable',
  $q$update emergency_alert_launches set requested_by_employee_id = '64000000-0000-0000-0000-0000000000e2'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);

-- ---------------------------------------------------------------------------
-- 5. The messages gate, now that the launch is approved.
-- ---------------------------------------------------------------------------
select pg_temp.expect_error(
  'a published emergency message cannot be inserted directly',
  $q$insert into messages (facility_id, channel_id, subject, body_text, priority, published_at)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', 's', 'b', 'emergency', now())$q$,
  array['42501']
);
select pg_temp.expect_error(
  'a different emergency draft without a launch still cannot be published',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000f2'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'a published ordinary message cannot be raised to emergency',
  $q$update messages set priority = 'emergency' where id = '64000000-0000-0000-0000-0000000000f6'$q$,
  array['42501']
);
-- Ordinary messages are unaffected.
select pg_temp.expect_rows(
  'an ordinary draft still publishes',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000f4'$q$,
  1
);
-- The approved emergency publishes.
select pg_temp.expect_rows(
  'the approved emergency publishes',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  1
);
update emergency_alert_launches set status = 'launched', recipient_count = 3 where id = '64000000-0000-0000-0000-000000000b01';
do $$
begin
  if (select launched_at from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b01') is null then
    raise exception 'CE FAIL: launched_at was not stamped';
  end if;
end;
$$;
-- A launched alert is out of the update policy's reach for a signed-in user...
select pg_temp.expect_rows(
  'a launched alert cannot be updated through RLS',
  $q$update emergency_alert_launches set recipient_count = 99 where id = '64000000-0000-0000-0000-000000000b01'$q$,
  0
);
reset role;
-- ...and the guard trigger refuses it for any other writer too.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'a launched alert is terminal even for the owner',
  $q$update emergency_alert_launches set recipient_count = 99 where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['23514']
);

-- Readers cannot see or touch the ledger; other facilities cannot either.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from emergency_alert_launches) <> 0 then
    raise exception 'CE FAIL: a plain reader could read the launch ledger';
  end if;
end;
$$;
select pg_temp.expect_error(
  'a reader cannot request a launch',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e3')$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from emergency_alert_launches) <> 0 then
    raise exception 'CE FAIL: another facility''s publisher could read the launch ledger';
  end if;
end;
$$;
select pg_temp.expect_error(
  'another facility''s publisher cannot request a launch for this facility',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e4')$q$,
  array['42501', '23514']
);
reset role;

-- The tenant setting: a facility override turns the second-approver rule off, a
-- malformed value falls back to the secure default.
select set_config('request.jwt.claims', '', true);
insert into modules (id, code, name, category, default_enabled) values
  ('64000000-0000-0000-0000-000000000c0d', 'communications', 'Communications', 'operations', true)
on conflict (code) do nothing;
insert into facility_module_overrides (facility_id, module_id, config_patch_jsonb)
select '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', m.id, '{"communications.emergencyRequiresSecondApprover": false}'::jsonb
from modules m where m.code = 'communications';

select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b02', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_rows(
  'with the setting off, a single publisher can approve their own request',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1'
     where id = '64000000-0000-0000-0000-000000000b02'$q$,
  1
);
reset role;

select set_config('request.jwt.claims', '', true);
update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": "maybe"}'::jsonb
where facility_id = '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b03', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f8', '64000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_error(
  'a malformed setting value falls back to requiring a second approver',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1'
     where id = '64000000-0000-0000-0000-000000000b03'$q$,
  array['42501']
);
reset role;

-- ---------------------------------------------------------------------------
-- 6. emergency_alert_responses: own response only.
-- ---------------------------------------------------------------------------
-- f1 is now a published emergency message in facility A; f2 is an approved but
-- unpublished one.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
insert into emergency_alert_responses (id, facility_id, message_id, employee_id, response, responded_at) values
  ('64000000-0000-0000-0000-000000000d01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e3', 'need_help', '2000-01-01');
do $$
begin
  if (select responded_at from emergency_alert_responses where id = '64000000-0000-0000-0000-000000000d01') < now() - interval '1 minute' then
    raise exception 'CE FAIL: responded_at was client-controlled';
  end if;
end;
$$;
select pg_temp.expect_error(
  'a reader cannot answer for another employee',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e2', 'safe')$q$,
  array['42501']
);
select pg_temp.expect_error(
  'no answer on a message that is not a published emergency alert',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e3', 'safe')$q$,
  array['23514']
);
select pg_temp.expect_error(
  'no answer on an ordinary message',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f6', '64000000-0000-0000-0000-0000000000e3', 'safe')$q$,
  array['23514']
);
select pg_temp.expect_error(
  'only safe / need_help are valid',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e3', 'maybe')$q$,
  array['23514']
);
select pg_temp.expect_error(
  'a note is capped at 500 characters',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response, note)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e3', 'safe', repeat('x', 501))$q$,
  array['23514']
);
-- Changing one's own answer is allowed...
select pg_temp.expect_rows(
  'a reader can change their own response',
  $q$update emergency_alert_responses set response = 'safe' where id = '64000000-0000-0000-0000-000000000d01'$q$,
  1
);
-- ...re-pointing the row at someone else is not.
select pg_temp.expect_error(
  'a response cannot be re-pointed at another employee',
  $q$update emergency_alert_responses set employee_id = '64000000-0000-0000-0000-0000000000e2' where id = '64000000-0000-0000-0000-000000000d01'$q$,
  array['42501']
);
select pg_temp.expect_rows(
  'nobody can delete a response (no DELETE policy)',
  $q$delete from emergency_alert_responses where id = '64000000-0000-0000-0000-000000000d01'$q$,
  0
);
reset role;

-- A publisher answers only for themselves, and cannot forge a colleague's answer.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_error(
  'a publisher cannot answer for a reader',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e3', 'safe')$q$,
  array['42501']
);
select pg_temp.expect_rows(
  'a publisher cannot overwrite a reader''s answer (the row is outside the update policy)',
  $q$update emergency_alert_responses set response = 'need_help' where id = '64000000-0000-0000-0000-000000000d01'$q$,
  0
);
do $$
begin
  if (select response from emergency_alert_responses where id = '64000000-0000-0000-0000-000000000d01') <> 'safe' then
    raise exception 'CE FAIL: a publisher changed a reader''s response';
  end if;
end;
$$;
insert into emergency_alert_responses (id, facility_id, message_id, employee_id, response) values
  ('64000000-0000-0000-0000-000000000d02', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e1', 'safe');
-- The publisher's roll-up read sees every responder in the facility.
do $$
begin
  if (select count(*) from emergency_alert_responses where message_id = '64000000-0000-0000-0000-0000000000f1') <> 2 then
    raise exception 'CE FAIL: the publisher roll-up did not see both responses';
  end if;
end;
$$;
reset role;

-- Other facility and no-comms callers cannot answer.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_error(
  'another facility''s employee cannot answer here',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e4', 'safe')$q$,
  array['42501', '23514']
);
do $$
begin
  if (select count(*) from emergency_alert_responses) <> 0 then
    raise exception 'CE FAIL: another facility could read emergency responses';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_error(
  'an employee without communications.read cannot answer',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e5', 'safe')$q$,
  array['42501']
);
reset role;

-- A plain reader sees only their own row.
select set_config('request.jwt.claims', '{"sub":"64000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from emergency_alert_responses) <> 1 then
    raise exception 'CE FAIL: a plain reader saw something other than their own response (%)', (select count(*) from emergency_alert_responses);
  end if;
end;
$$;
reset role;

-- The service role (no claims) is not bound to the own-employee rule but is still
-- bound to the message state.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'even the service role cannot answer on an unpublished emergency message',
  $q$insert into emergency_alert_responses (facility_id, message_id, employee_id, response)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f8', '64000000-0000-0000-0000-0000000000e3', 'safe')$q$,
  array['23514']
);

rollback;
