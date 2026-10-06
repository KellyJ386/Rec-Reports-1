-- Verification intent: CM-10 / CM-12 / CM-13 (0064_communications_escalation.sql),
-- including the Slice 3E security review fixes (H-1, M-1..M-6, L-1..L-7).
-- Covers:
--   1. Structure: RLS enabled on message_escalation_events,
--      emergency_alert_launches and emergency_alert_responses; split
--      per-operation policies only (no `for all`), no DELETE policy on any of
--      them, no write policy at all on the append-only escalation ledger; the
--      message FKs of the launch ledger and the responses are ON DELETE
--      RESTRICT (M-4); the client-session guards are SECURITY INVOKER and the
--      definer functions are locked down; every `-- Guard N` of the launch
--      guard is present.
--   2. CM-10: messages.ack_escalation_level / ack_escalated_at (and the M-5
--      work-queue column ack_next_escalation_at) are writable only by a
--      service-role session (auth.uid() null); message_escalation_events is
--      append-only, unique per (message, level), readable by publishers only.
--   3. fn_notification_job_dedupe_key (0058, re-created): per-(message, level)
--      key, a client's key dropped (no squatting), 0058's incident formula
--      carried forward, UPDATE can no longer re-key a row (M-1), a NULL key from
--      the service role is left alone (0062's schedule jobs).
--   4. H-1: a communications.publish holder cannot insert a message.emergency
--      job, cannot add quietHoursBypass outside 0058's incident rule and an
--      urgent message's own publish job, cannot change a job's type, payload,
--      key or facility, cannot re-arm an emergency job; the service role and the
--      definer path are untouched; one emergency job per message.
--   5. CM-13 launch ledger: request attribution, content hash stamped, client
--      sessions cannot approve or launch (L-2), a user with two employee rows
--      cannot approve their own request (M-2).
--   6. approve_emergency_launch(): permission, second PERSON, content-hash
--      match (M-3), the message frozen from request on, single-transaction
--      approve + publish + job + launched, recipients derived server-side,
--      nothing consumed when the audience is empty, cancel races, republish
--      from launched impossible, hard delete blocked (M-4).
--   7. The tenant setting accepts only a real JSON boolean (L-6).
--   8. emergency_alert_responses: own response only.
--   9. Server-side audience resolution (employee, department, role, shift by
--      id and by window), the approval queue, M-5 queue column + ack due
--      validation, L-3 emergency_enabled column guard.
--  10. Second review round: NEW-1 (the urgent publish is the definer function
--      publish_urgent_message(); no client-written bypass job, no repeat after a
--      cancel), NEW-2 (no client DELETE of a job, no client change to a
--      message.emergency job, the launch lifecycle audited), NEW-3 (the audience
--      resolver skips soft-deleted employees and counts a person once), M-5
--      residual (ack_due_at / published_at after publish).
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

create function pg_temp.as_user(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end;
$$;

insert into auth.users (id, email) values
  ('64000000-0000-0000-0000-0000000000a1', 'ce-pub1@test'),
  ('64000000-0000-0000-0000-0000000000a2', 'ce-pub2@test'),
  ('64000000-0000-0000-0000-0000000000a3', 'ce-reader@test'),
  ('64000000-0000-0000-0000-0000000000a4', 'ce-bpub@test'),
  ('64000000-0000-0000-0000-0000000000a5', 'ce-nocomms@test'),
  ('64000000-0000-0000-0000-0000000000a6', 'ce-admin@test'),
  ('64000000-0000-0000-0000-0000000000a7', 'ce-incident@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('64000000-0000-0000-0000-0000000000a1', 'CE Publisher One', 'ce-pub1@test'),
  ('64000000-0000-0000-0000-0000000000a2', 'CE Publisher Two', 'ce-pub2@test'),
  ('64000000-0000-0000-0000-0000000000a3', 'CE Reader', 'ce-reader@test'),
  ('64000000-0000-0000-0000-0000000000a4', 'CE Facility B Publisher', 'ce-bpub@test'),
  ('64000000-0000-0000-0000-0000000000a5', 'CE No Comms', 'ce-nocomms@test'),
  ('64000000-0000-0000-0000-0000000000a6', 'CE Admin Publisher', 'ce-admin@test'),
  ('64000000-0000-0000-0000-0000000000a7', 'CE Incident Reviewer', 'ce-incident@test')
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
  ('64000000-0000-0000-0000-0000000000d4', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CE B Publisher'),
  ('64000000-0000-0000-0000-0000000000d5', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE Admin Publisher'),
  ('64000000-0000-0000-0000-0000000000d6', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE Incident Reviewer')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('64000000-0000-0000-0000-0000000000d1', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d1', 'communications.publish'),
  ('64000000-0000-0000-0000-0000000000d2', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d3', 'reports.read'),
  ('64000000-0000-0000-0000-0000000000d4', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d4', 'communications.publish'),
  ('64000000-0000-0000-0000-0000000000d5', 'communications.read'),
  ('64000000-0000-0000-0000-0000000000d5', 'communications.publish'),
  ('64000000-0000-0000-0000-0000000000d5', 'admin.manage'),
  ('64000000-0000-0000-0000-0000000000d6', 'incidents.read'),
  ('64000000-0000-0000-0000-0000000000d6', 'incidents.review')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('64000000-0000-0000-0000-0000000000b1', '64000000-0000-0000-0000-0000000000a1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d1', 'active'),
  ('64000000-0000-0000-0000-0000000000b2', '64000000-0000-0000-0000-0000000000a2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d1', 'active'),
  ('64000000-0000-0000-0000-0000000000b3', '64000000-0000-0000-0000-0000000000a3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d2', 'active'),
  ('64000000-0000-0000-0000-0000000000b4', '64000000-0000-0000-0000-0000000000a4', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '64000000-0000-0000-0000-0000000000d4', 'active'),
  ('64000000-0000-0000-0000-0000000000b5', '64000000-0000-0000-0000-0000000000a5', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d3', 'active'),
  ('64000000-0000-0000-0000-0000000000b6', '64000000-0000-0000-0000-0000000000a6', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d5', 'active'),
  ('64000000-0000-0000-0000-0000000000b7', '64000000-0000-0000-0000-0000000000a7', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000d6', 'active')
on conflict (id) do nothing;

insert into departments (id, facility_id, name) values
  ('64000000-0000-0000-0000-00000000d001', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE Aquatics'),
  ('64000000-0000-0000-0000-00000000d002', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE Front Desk')
on conflict (id) do nothing;

insert into employees (id, facility_id, user_id, first_name, last_name, department_id) values
  ('64000000-0000-0000-0000-0000000000e1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a1', 'Pat', 'PublisherOne', null),
  ('64000000-0000-0000-0000-0000000000e2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a2', 'Sam', 'PublisherTwo', null),
  ('64000000-0000-0000-0000-0000000000e3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a3', 'Rae', 'Reader', '64000000-0000-0000-0000-00000000d001'),
  ('64000000-0000-0000-0000-0000000000e4', '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '64000000-0000-0000-0000-0000000000a4', 'Bo', 'FacilityB', null),
  ('64000000-0000-0000-0000-0000000000e5', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a5', 'Nic', 'NoComms', null),
  -- M-2: a SECOND employee row for the same person (publisher one) in the same facility.
  ('64000000-0000-0000-0000-0000000000e9', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000a1', 'Pat', 'PublisherOneAlt', null)
on conflict (id) do nothing;

-- NEW-3: a soft-deleted (former) employee who is still on the department roster, and the
-- second row of publisher one created later than the first.
insert into employees (id, facility_id, user_id, first_name, last_name, department_id, deleted_at) values
  ('64000000-0000-0000-0000-0000000000ea', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'Ex', 'Staff', '64000000-0000-0000-0000-00000000d001', now() - interval '30 days')
on conflict (id) do nothing;
update employees set created_at = now() + interval '1 second' where id = '64000000-0000-0000-0000-0000000000e9';

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
  ('64000000-0000-0000-0000-0000000000f8', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 3', 'Move inside', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000f9', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Resolution', 'x', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000fa', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 10', 'Shelter', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000fb', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 11', 'Shelter', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000fc', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Storm 12', 'Shelter', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000fd', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', '64000000-0000-0000-0000-0000000000e1', 'Unpublished draft', 'x', 'emergency', false, null, null),
  ('64000000-0000-0000-0000-0000000000fe', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Urgent published', 'x', 'urgent', false, null, now() - interval '1 hour'),
  ('64000000-0000-0000-0000-0000000000ff', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Urgent draft', 'x', 'urgent', false, null, null)
on conflict (id) do nothing;

-- NEW-1 / NEW-3 drafts: two urgent drafts, an ordinary draft and an urgent required-ack draft
-- with a due time already in the past.
insert into messages (id, facility_id, channel_id, author_employee_id, subject, body_text, priority, is_required_ack, ack_due_at, published_at) values
  ('64000000-0000-0000-0000-00000000f201', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Pool closed', 'Chlorine leak, secret body', 'urgent', false, null, null),
  ('64000000-0000-0000-0000-00000000f202', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Urgent audience probe', 'x', 'urgent', false, null, null),
  ('64000000-0000-0000-0000-00000000f203', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Ordinary draft', 'x', 'normal', false, null, null),
  ('64000000-0000-0000-0000-00000000f204', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Urgent past due', 'x', 'urgent', true, now() - interval '1 day', null)
on conflict (id) do nothing;
insert into message_audiences (id, facility_id, message_id, audience_type, audience_ref_id) values
  ('64000000-0000-0000-0000-0000f2010001', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000f201', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64000000-0000-0000-0000-0000f2010002', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000f201', 'employee', '64000000-0000-0000-0000-0000000000ea'),
  ('64000000-0000-0000-0000-0000f2020001', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000f202', 'department', '64000000-0000-0000-0000-00000000d001'),
  ('64000000-0000-0000-0000-0000f2020002', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000f202', 'role', '64000000-0000-0000-0000-0000000000d1')
on conflict (id) do nothing;

-- Audiences, written by the owner before any launch exists (a launch freezes them).
insert into message_audiences (id, facility_id, message_id, audience_type, audience_ref_id) values
  ('64000000-0000-0000-0000-00000000a101', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', 'employee', '64000000-0000-0000-0000-0000000000e2'),
  ('64000000-0000-0000-0000-00000000a102', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64000000-0000-0000-0000-00000000a201', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64000000-0000-0000-0000-00000000a801', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f8', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64000000-0000-0000-0000-00000000aa01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fa', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64000000-0000-0000-0000-00000000ab01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fb', 'employee', '64000000-0000-0000-0000-0000000000e3')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Structure.
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_count integer;
  v_def text;
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

  -- M-4: the message FKs of the ledger and the safety records restrict deletes.
  foreach v_table in array array['emergency_alert_launches', 'emergency_alert_responses'] loop
    select count(*) into v_count from pg_constraint c
    where c.conrelid = ('public.' || v_table)::regclass and c.contype = 'f'
      and c.confrelid = 'public.messages'::regclass and c.confdeltype = 'r';
    if v_count <> 1 then
      raise exception 'CE FAIL: % must reference messages ON DELETE RESTRICT', v_table;
    end if;
  end loop;

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

  -- The re-created dedupe function carries every generation of guards, and
  -- fires on UPDATE as well as INSERT (M-1).
  v_def := pg_get_functiondef('public.fn_notification_job_dedupe_key()'::regprocedure);
  if v_def not like '%Guard 1%' or v_def not like '%Guard 2%' or v_def not like '%Guard 3%'
     or v_def not like '%incidentId%' or v_def not like '%escalationId%' then
    raise exception 'CE FAIL: fn_notification_job_dedupe_key lost a guard';
  end if;
  select count(*) into v_count from pg_trigger t
  where t.tgrelid = 'public.notification_jobs'::regclass and t.tgname = 'notification_jobs_dedupe_key'
    and (t.tgtype & 4) <> 0 and (t.tgtype & 16) <> 0;
  if v_count <> 1 then
    raise exception 'CE FAIL: the dedupe trigger must fire on INSERT and UPDATE';
  end if;

  -- The launch guard still carries all of its guards (1-7 shipped first, 8-9 are the
  -- content-hash guards).
  v_def := pg_get_functiondef('public.fn_emergency_alert_launch_guard()'::regprocedure);
  foreach v_table in array array['Guard 1', 'Guard 2', 'Guard 3', 'Guard 4', 'Guard 5', 'Guard 6', 'Guard 7', 'Guard 8', 'Guard 9'] loop
    if v_def not like '%' || v_table || '%' then
      raise exception 'CE FAIL: fn_emergency_alert_launch_guard lost %', v_table;
    end if;
  end loop;

  -- None of the definer functions is callable by a signed-in user, except the
  -- two sanctioned RPCs (and their invoker wrappers).
  foreach v_table in array array[
    'public.fn_notification_job_dedupe_key()',
    'public.fn_messages_guard_ack_escalation()',
    'public.fn_messages_set_ack_next_escalation()',
    'public.fn_messages_guard_emergency_publish()',
    'public.fn_emergency_alert_launch_guard()',
    'public.fn_emergency_alert_response_guard()',
    'public.fn_comms_emergency_requires_second_approver(uuid)',
    'internal.fn_emergency_window(jsonb)',
    'internal.fn_emergency_audience(uuid, timestamptz)',
    'internal.fn_emergency_content_hash(uuid)',
    -- the SECURITY INVOKER trigger guards are not exposed either
    'public.fn_notification_jobs_client_guard()',
    'public.fn_emergency_alert_launches_guard_client()',
    'public.fn_messages_guard_emergency_freeze()',
    'public.fn_messages_guard_emergency_delete()',
    'public.fn_message_audiences_guard_emergency_freeze()',
    'public.fn_communication_channels_guard_emergency_enabled()'
  ] loop
    if has_function_privilege('authenticated', v_table::regprocedure, 'execute') then
      raise exception 'CE FAIL: authenticated can execute %', v_table;
    end if;
  end loop;
  foreach v_table in array array[
    'internal.approve_emergency_launch(uuid)',
    'public.approve_emergency_launch(uuid)',
    'internal.emergency_launch_queue(uuid, text)',
    'public.emergency_launch_queue(uuid, text)'
  ] loop
    if not has_function_privilege('authenticated', v_table::regprocedure, 'execute') then
      raise exception 'CE FAIL: authenticated cannot execute %', v_table;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    if has_function_privilege('anon', 'public.approve_emergency_launch(uuid)'::regprocedure, 'execute')
       or has_function_privilege('anon', 'internal.approve_emergency_launch(uuid)'::regprocedure, 'execute') then
      raise exception 'CE FAIL: anon can execute approve_emergency_launch';
    end if;
  end if;

  -- The guards that must distinguish a client session from a definer path are
  -- SECURITY INVOKER (current_user would be the owner otherwise); the one-shot
  -- RPC and the helpers are SECURITY DEFINER with a pinned search_path.
  foreach v_table in array array[
    'public.fn_notification_jobs_client_guard()',
    'public.fn_emergency_alert_launches_guard_client()',
    'public.fn_messages_guard_emergency_freeze()',
    'public.fn_messages_guard_emergency_delete()',
    'public.fn_message_audiences_guard_emergency_freeze()',
    'public.fn_communication_channels_guard_emergency_enabled()'
  ] loop
    if (select prosecdef from pg_proc where oid = v_table::regprocedure) then
      raise exception 'CE FAIL: % must be SECURITY INVOKER', v_table;
    end if;
  end loop;
  foreach v_table in array array[
    'internal.approve_emergency_launch(uuid)',
    'internal.emergency_launch_queue(uuid, text)',
    'internal.fn_emergency_audience(uuid, timestamptz)',
    'internal.fn_emergency_content_hash(uuid)'
  ] loop
    if not (select prosecdef from pg_proc where oid = v_table::regprocedure)
       or not exists (select 1 from pg_proc where oid = v_table::regprocedure and 'search_path=public, pg_temp' = any (proconfig)) then
      raise exception 'CE FAIL: % must be SECURITY DEFINER with search_path = public, pg_temp', v_table;
    end if;
  end loop;
  -- The one-shot function locks the launch row (serializes with cancel) and the
  -- wrapper adds no logic of its own.
  v_def := pg_get_functiondef('internal.approve_emergency_launch(uuid)'::regprocedure);
  if v_def not like '%for update%' or v_def not like '%communications.publish%' or v_def not like '%fn_emergency_audience%' then
    raise exception 'CE FAIL: approve_emergency_launch lost its row lock, permission re-check or server-side audience';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.approve_emergency_launch(uuid)'::regprocedure) then
    raise exception 'CE FAIL: the public approve_emergency_launch wrapper must be SECURITY INVOKER';
  end if;

  -- M-5: the sweep's work queue is indexed.
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'messages_ack_escalation_scan_idx'
                 and indexdef like '%ack_next_escalation_at%') then
    raise exception 'CE FAIL: the ack escalation scan index is not on ack_next_escalation_at';
  end if;
  -- One emergency job per message, whoever writes it.
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notification_jobs_emergency_message_uidx'
                 and indexdef like '%UNIQUE%') then
    raise exception 'CE FAIL: the one-emergency-job-per-message index is missing';
  end if;

  -- NEW-1: one quiet-hours-bypassing publish job per message, and the urgent publish is
  -- the one-shot definer function (locks the message row, re-checks the permission,
  -- resolves the audience on the server) behind an invoker wrapper.
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notification_jobs_urgent_publish_message_uidx'
                 and indexdef like '%UNIQUE%' and indexdef like '%message.published%') then
    raise exception 'CE FAIL: the one-urgent-publish-job-per-message index is missing';
  end if;
  foreach v_table in array array['internal.publish_urgent_message(uuid)', 'public.publish_urgent_message(uuid)'] loop
    if not has_function_privilege('authenticated', v_table::regprocedure, 'execute') then
      raise exception 'CE FAIL: authenticated cannot execute %', v_table;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_function_privilege('anon', 'public.publish_urgent_message(uuid)'::regprocedure, 'execute')
          or has_function_privilege('anon', 'internal.publish_urgent_message(uuid)'::regprocedure, 'execute')) then
    raise exception 'CE FAIL: anon can execute publish_urgent_message';
  end if;
  if not (select prosecdef from pg_proc where oid = 'internal.publish_urgent_message(uuid)'::regprocedure)
     or not exists (select 1 from pg_proc where oid = 'internal.publish_urgent_message(uuid)'::regprocedure and 'search_path=public, pg_temp' = any (proconfig)) then
    raise exception 'CE FAIL: internal.publish_urgent_message must be SECURITY DEFINER with search_path = public, pg_temp';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.publish_urgent_message(uuid)'::regprocedure) then
    raise exception 'CE FAIL: the public publish_urgent_message wrapper must be SECURITY INVOKER';
  end if;
  v_def := pg_get_functiondef('internal.publish_urgent_message(uuid)'::regprocedure);
  if v_def not like '%for update%' or v_def not like '%communications.publish%' or v_def not like '%fn_emergency_audience%'
     or v_def not like '%in_app%' or v_def like '%sms%' or v_def like '%email%' then
    raise exception 'CE FAIL: publish_urgent_message lost its row lock, permission re-check or server-side audience, or widened its channels';
  end if;
  if has_function_privilege('authenticated', 'public.fn_emergency_alert_launch_audit()'::regprocedure, 'execute') then
    raise exception 'CE FAIL: authenticated can execute the launch audit trigger function';
  end if;

  -- NEW-1 / NEW-2: the client guard keeps its labelled guards, has no message.published
  -- bypass exception any more, and also fires on DELETE (tgtype: 8 = DELETE).
  v_def := pg_get_functiondef('public.fn_notification_jobs_client_guard()'::regprocedure);
  foreach v_table in array array['Guard 1', 'Guard 2', 'Guard 3', 'Guard 4', 'Guard 5', 'Guard 6'] loop
    if v_def not like '%' || v_table || '%' then
      raise exception 'CE FAIL: fn_notification_jobs_client_guard lost %', v_table;
    end if;
  end loop;
  if v_def like '%''message.published''%' then
    raise exception 'CE FAIL: the client guard still has a message.published exception';
  end if;
  select count(*) into v_count from pg_trigger t
  where t.tgrelid = 'public.notification_jobs'::regclass and t.tgname = 'notification_jobs_client_guard'
    and (t.tgtype & 4) <> 0 and (t.tgtype & 8) <> 0 and (t.tgtype & 16) <> 0;
  if v_count <> 1 then
    raise exception 'CE FAIL: the client guard must fire on INSERT, UPDATE and DELETE';
  end if;
  -- NEW-2: the launch lifecycle is audited.
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.emergency_alert_launches'::regclass
                 and t.tgname = 'emergency_alert_launches_audit' and (t.tgtype & 4) <> 0 and (t.tgtype & 16) <> 0) then
    raise exception 'CE FAIL: the emergency launch audit trigger is missing';
  end if;
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

-- M-1: the dedupe trigger now fires on UPDATE, and the client guard refuses a
-- re-key outright. A publisher cannot move a row onto the key the sweep will
-- compute for a genuine (message, level) escalation, nor onto an incident key.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'M-1: a publisher cannot re-key a job to the sweep''s level-3 key',
  $q$update notification_jobs
     set dedupe_key = '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:message.ack_escalated_manager:64000000-0000-0000-0000-0000000000f6:3'
     where id = '64000000-0000-0000-0000-000000000a04'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-1: a publisher cannot re-key an incident job either',
  $q$update notification_jobs set dedupe_key = 'anything' where id = '64000000-0000-0000-0000-000000000a03'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-1: a publisher cannot clear a job''s dedupe key',
  $q$update notification_jobs set dedupe_key = null where id = '64000000-0000-0000-0000-000000000a01'$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);
-- The genuine level-3 escalation insert is therefore not suppressed.
select pg_temp.expect_rows(
  'M-1: the sweep''s genuine level-3 job still lands (nothing squats its key)',
  $q$insert into notification_jobs (facility_id, event_type, status, dedupe_key, payload_jsonb)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.ack_escalated_manager', 'pending', 'x',
             '{"messageId":"64000000-0000-0000-0000-0000000000f6","escalationLevel":3,"recipients":["64000000-0000-0000-0000-0000000000e2"]}'::jsonb)
     on conflict (dedupe_key) do nothing$q$,
  1
);
-- A service-role status write leaves the stored key alone (Guard 3 of the trigger).
update notification_jobs set status = 'sent' where id = '64000000-0000-0000-0000-000000000a01';
do $$
begin
  if (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a01')
     <> '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:message.ack_overdue:64000000-0000-0000-0000-0000000000f6:1' then
    raise exception 'CE FAIL: a status update changed a stored dedupe key';
  end if;
end;
$$;
-- 0062 (scheduling): a NULL key from the service role is left alone, on INSERT and UPDATE,
-- and two such jobs do not collapse.
insert into notification_jobs (id, facility_id, event_type, status, dedupe_key, payload_jsonb) values
  ('64000000-0000-0000-0000-000000000a11', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'schedule.published', 'pending', null,
   '{"recipients":["64000000-0000-0000-0000-0000000000e3"],"channels":["in_app"]}'::jsonb),
  ('64000000-0000-0000-0000-000000000a12', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'schedule.published', 'pending', null,
   '{"recipients":["64000000-0000-0000-0000-0000000000e3"],"channels":["in_app"]}'::jsonb);
update notification_jobs set status = 'sent' where id in ('64000000-0000-0000-0000-000000000a11', '64000000-0000-0000-0000-000000000a12');
do $$
begin
  if (select count(*) from notification_jobs where id in ('64000000-0000-0000-0000-000000000a11', '64000000-0000-0000-0000-000000000a12')) <> 2
     or (select count(*) from notification_jobs where id in ('64000000-0000-0000-0000-000000000a11', '64000000-0000-0000-0000-000000000a12') and dedupe_key is not null) <> 0 then
    raise exception 'CE FAIL: a null-key service-role job was given a key or collapsed';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. H-1: the notification_jobs client guard. 0006's FOR ALL publisher policy is
-- untouched; the trigger is what keeps the worker-trusted payload honest.
-- ---------------------------------------------------------------------------
insert into incident_reports (id, facility_id, incident_no, report_type, status, severity, occurred_at, location_text, summary) values
  ('64000000-0000-0000-0000-00000000c0a1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE-HIGH-1', 'incident', 'submitted', 'high', now(), 'pool', 'high severity'),
  ('64000000-0000-0000-0000-00000000c0a2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CE-LOW-1', 'incident', 'submitted', 'low', now(), 'pool', 'low severity')
on conflict (id) do nothing;

select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'H-1: a publisher cannot insert a message.emergency job (no launch, bypass, all channels)',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.emergency',
      '{"channels":["in_app","push","sms","email"],"quietHoursBypass":true,"emergency":true,"recipients":["64000000-0000-0000-0000-0000000000e3"],"title":"EMERGENCY"}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: not even without the bypass flag',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.emergency', '{"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: quietHoursBypass on an arbitrary event type is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'schedule.published', '{"quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: quietHoursBypass on a message publish job for an ORDINARY message is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-0000000000f6","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: ... for an emergency draft is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-0000000000f1","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: ... for an urgent message that is not published yet is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-0000000000ff","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: an incident-looking bypass job from a publisher without incident rights is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'incident.escalated',
      '{"incidentId":"64000000-0000-0000-0000-00000000c0a1","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: a message job cannot borrow a high incident id to get the bypass',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"incidentId":"64000000-0000-0000-0000-00000000c0a1","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['42501']
);
-- NEW-1: CM-03's urgent publish is NOT a client-writable shape any more. Whatever the
-- state of an urgent message, a publisher cannot write its bypassing publish job
-- directly: not with the plain shape the old route sent, and not with forged channels,
-- recipients outside the audience and forged copy (probe G3).
select pg_temp.expect_error(
  'NEW-1: the plain bypassing publish job of a PUBLISHED urgent message is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-0000000000fe","quietHoursBypass":true,"recipients":["64000000-0000-0000-0000-0000000000e3"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-1 (G3): forged channels, recipients outside the audience and forged copy are rejected',
  $q$insert into notification_jobs (facility_id, event_type, dedupe_key, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published', 'k',
      '{"messageId":"64000000-0000-0000-0000-0000000000fe","quietHoursBypass":true,"channels":["in_app","push","sms","email"],
        "recipients":["64000000-0000-0000-0000-0000000000e2","64000000-0000-0000-0000-0000000000e3","64000000-0000-0000-0000-0000000000e5"],
        "title":"EMERGENCY: evacuate now","body":"forged by one publisher"}'::jsonb)$q$,
  array['42501']
);
-- An ordinary job without the flag is unaffected.
select pg_temp.expect_rows(
  'H-1: an ordinary publish job without the flag is unaffected',
  $q$insert into notification_jobs (id, facility_id, event_type, payload_jsonb) values
     ('64000000-0000-0000-0000-000000000a22', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-0000000000f6","recipients":["64000000-0000-0000-0000-0000000000e3"],"channels":["in_app"]}'::jsonb)$q$,
  1
);
-- UPDATE: nothing about what a job is can change from a client session.
select pg_temp.expect_error(
  'H-1: a publisher cannot add quietHoursBypass to an existing job',
  $q$update notification_jobs set payload_jsonb = payload_jsonb || '{"quietHoursBypass":true}'::jsonb
     where id = '64000000-0000-0000-0000-000000000a22'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: a publisher cannot rewrite a job''s recipients or channels',
  $q$update notification_jobs set payload_jsonb = jsonb_set(payload_jsonb, '{channels}', '["sms","push"]'::jsonb)
     where id = '64000000-0000-0000-0000-000000000a22'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: a publisher cannot turn a job into a message.emergency job',
  $q$update notification_jobs set event_type = 'message.emergency' where id = '64000000-0000-0000-0000-000000000a22'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: a publisher cannot move a job to another facility',
  $q$update notification_jobs set facility_id = '64bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where id = '64000000-0000-0000-0000-000000000a22'$q$,
  array['42501', '23514']
);
-- Cancelling is fine, and so is rescheduling an ordinary job.
select pg_temp.expect_rows(
  'H-1: a publisher can still cancel an ordinary job',
  $q$update notification_jobs set status = 'cancelled' where id = '64000000-0000-0000-0000-000000000a22'$q$,
  1
);
-- NEW-2: a client cannot delete a job either (0006's FOR ALL policy still grants it).
select pg_temp.expect_error(
  'NEW-2: a publisher cannot delete an ordinary notification job',
  $q$delete from notification_jobs where id = '64000000-0000-0000-0000-000000000a22'$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);
insert into notification_jobs (id, facility_id, event_type, status, payload_jsonb) values
  ('64000000-0000-0000-0000-000000000a24', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'incident.escalated', 'sent',
   '{"incidentId":"64000000-0000-0000-0000-00000000c0a1","quietHoursBypass":true,"recipients":["x"]}'::jsonb);
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'H-1: a sent bypassing job cannot be reset to pending (re-broadcast) by a client',
  $q$update notification_jobs set status = 'pending', attempts = 0 where id = '64000000-0000-0000-0000-000000000a24'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-1 (G6c): a SENT bypassing job cannot be cancelled by a client either (cancel is for pending jobs only)',
  $q$update notification_jobs set status = 'cancelled' where id = '64000000-0000-0000-0000-000000000a24'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-2: a bypassing job cannot be deleted by a client',
  $q$delete from notification_jobs where id = '64000000-0000-0000-0000-000000000a24'$q$,
  array['42501']
);
reset role;

-- 0058's rule is preserved for incident actors: bypass only for a high/critical incident
-- in this facility; their un-flagged jobs are unaffected.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a7');
set local role authenticated;
select pg_temp.expect_rows(
  'H-1: an incident reviewer can still insert a bypass job for a HIGH incident (0058)',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'incident.escalated',
      '{"incidentId":"64000000-0000-0000-0000-00000000c0a1","escalationId":"e1","quietHoursBypass":true,"recipients":["r1"]}'::jsonb)$q$,
  1
);
select pg_temp.expect_error(
  'H-1: ... and is still refused the bypass for a LOW incident (0058)',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'incident.escalated',
      '{"incidentId":"64000000-0000-0000-0000-00000000c0a2","escalationId":"e2","quietHoursBypass":true,"recipients":["r1"]}'::jsonb)$q$,
  array['42501']
);
select pg_temp.expect_error(
  'H-1: ... and cannot write a message.emergency job even with an incident id',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.emergency',
      '{"incidentId":"64000000-0000-0000-0000-00000000c0a1","quietHoursBypass":true,"recipients":["r1"]}'::jsonb)$q$,
  array['42501', '23514']
);
select pg_temp.expect_error(
  'NEW-1: ... and still cannot send a message.published bypass job (not an incident event)',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-0000000000fe","incidentId":"64000000-0000-0000-0000-00000000c0a1","quietHoursBypass":true}'::jsonb)$q$,
  array['42501']
);
reset role;
-- A bypassing job that is still pending can be cancelled by a publisher (the one change a
-- client keeps): 0058's pending incident job from the reviewer above.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_rows(
  'NEW-1: a pending bypassing job can still be cancelled by a client',
  $q$update notification_jobs set status = 'cancelled' where event_type = 'incident.escalated' and status = 'pending'
     and payload_jsonb ->> 'escalationId' = 'e1' and payload_jsonb ->> 'quietHoursBypass' = 'true'$q$,
  1
);
reset role;

-- The service role (no JWT claims) is untouched: it writes message.emergency / bypass
-- jobs freely (the worker, the sweeps, the definer path all run this way), and a
-- service-role status update on a bypassing job is allowed.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_rows(
  'H-1: the service role is not constrained by the client guard',
  $q$insert into notification_jobs (id, facility_id, event_type, payload_jsonb) values
     ('64000000-0000-0000-0000-000000000a23', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.emergency',
      '{"messageId":"64000000-0000-0000-0000-0000000000f5","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  1
);
select pg_temp.expect_rows(
  'H-1: the service role can update a bypassing job (the worker''s status writes)',
  $q$update notification_jobs set status = 'sent', attempts = 1 where id = '64000000-0000-0000-0000-000000000a23'$q$,
  1
);
select pg_temp.expect_error(
  'H-1: one emergency job per message, even for the service role',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.emergency', '{"messageId":"64000000-0000-0000-0000-0000000000f5"}'::jsonb)$q$,
  array['23505']
);
-- NEW-2: the delete trigger hands OLD back for a non-client session, so the owner's delete
-- is not silently swallowed (a BEFORE DELETE trigger returning NEW would cancel it).
delete from notification_jobs where id = '64000000-0000-0000-0000-000000000a23';
do $$
begin
  if exists (select 1 from notification_jobs where id = '64000000-0000-0000-0000-000000000a23') then
    raise exception 'CE FAIL: NEW-2 the delete guard swallowed a non-client delete';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. NEW-1: publish_urgent_message() -- the urgent publish is one definer call. It
-- re-checks the permission, derives the recipients from the message's own audience (a
-- soft-deleted former employee excluded), takes the channels from the urgent mapping and
-- the title from the subject, sends no body, bypasses quiet hours, and happens once.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a3');
set local role authenticated;
select pg_temp.expect_error(
  'NEW-1: a reader cannot publish an urgent message',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f201')$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-1: nor through the internal function directly',
  $q$select internal.publish_urgent_message('64000000-0000-0000-0000-00000000f201')$q$,
  array['42501']
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.expect_error(
  'NEW-1: another facility''s publisher cannot publish facility A''s urgent message',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f201')$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'NEW-1: publish_urgent_message needs a signed-in person',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f201')$q$,
  array['28000']
);
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'NEW-1: an unknown message is a 404',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f2ee')$q$,
  array['PT404']
);
select pg_temp.expect_error(
  'NEW-1: an ordinary (non-urgent) draft is refused: only urgent messages take the bypass',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f203')$q$,
  array['PT409']
);
select pg_temp.expect_error(
  'NEW-1: an emergency draft is refused: it goes through the approval flow',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-0000000000f8')$q$,
  array['PT409']
);
select pg_temp.expect_error(
  'NEW-1: an already-published urgent message is refused (no repeat page)',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-0000000000fe')$q$,
  array['PT409']
);
select pg_temp.expect_error(
  'NEW-1: a required-ack urgent message already past due is refused before anything is written',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f204')$q$,
  array['PT400']
);
reset role;
do $$
begin
  if exists (select 1 from messages where id in ('64000000-0000-0000-0000-00000000f203', '64000000-0000-0000-0000-00000000f204', '64000000-0000-0000-0000-0000000000f8') and published_at is not null)
     or exists (select 1 from notification_jobs where payload_jsonb ->> 'messageId' in
                ('64000000-0000-0000-0000-00000000f203', '64000000-0000-0000-0000-00000000f204', '64000000-0000-0000-0000-0000000000f8')) then
    raise exception 'CE FAIL: a refused urgent publish left a published message or a job behind';
  end if;
end;
$$;

-- The definer path succeeds for the publisher.
create temp table ce_urgent (r jsonb);
grant all on ce_urgent to authenticated;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into ce_urgent select public.publish_urgent_message('64000000-0000-0000-0000-00000000f201');
reset role;
do $$
declare
  v_job notification_jobs%rowtype;
  v_result jsonb;
begin
  select r into v_result from ce_urgent;
  if (v_result ->> 'recipientCount')::int <> 1 or (v_result ->> 'quietHoursBypass')::boolean is not true
     or v_result -> 'channels' <> '["in_app","push"]'::jsonb or v_result ->> 'publishedAt' is null then
    raise exception 'CE FAIL: unexpected urgent publish result %', v_result;
  end if;
  if (select published_at from messages where id = '64000000-0000-0000-0000-00000000f201') is null then
    raise exception 'CE FAIL: the urgent message was not published';
  end if;
  if (select count(*) from notification_jobs where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201') <> 1 then
    raise exception 'CE FAIL: expected exactly one job for the urgent message';
  end if;
  select * into v_job from notification_jobs where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201';
  if v_job.event_type <> 'message.published' or v_job.status <> 'pending'
     or v_job.facility_id <> '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     or (v_job.payload_jsonb ->> 'quietHoursBypass') <> 'true'
     or v_job.payload_jsonb -> 'channels' <> '["in_app","push"]'::jsonb
     or v_job.payload_jsonb -> 'recipients' <> '["64000000-0000-0000-0000-0000000000e3"]'::jsonb
     or v_job.payload_jsonb ->> 'title' <> 'Pool closed'
     or v_job.payload_jsonb ? 'body'
     or v_job.payload_jsonb ->> 'priority' <> 'urgent'
     or v_job.dedupe_key is not null then
    raise exception 'CE FAIL: the urgent publish job is not the server-derived one: %', v_job.payload_jsonb;
  end if;
end;
$$;

-- Once, per message.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'NEW-1: the same urgent message cannot be published twice',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f201')$q$,
  array['PT409']
);
-- ...and the client still cannot write its own bypassing job for it (G3 / G6d shapes).
select pg_temp.expect_error(
  'NEW-1 (G3): a direct bypassing job for the now-published urgent message is rejected',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-00000000f201","quietHoursBypass":true,"channels":["in_app","push","sms","email"],"recipients":["64000000-0000-0000-0000-0000000000e2"],"title":"EMERGENCY: forged"}'::jsonb)$q$,
  array['42501']
);
-- A bypassing job is not editable by a client while pending, beyond a cancel.
select pg_temp.expect_error(
  'NEW-1: the bypassing job cannot be marked sent by a client',
  $q$update notification_jobs set status = 'sent' where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-1: nor rescheduled',
  $q$update notification_jobs set scheduled_for = now() + interval '1 minute' where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-2: nor deleted',
  $q$delete from notification_jobs where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201'$q$,
  array['42501']
);
reset role;

-- The worker (service role) marks it sent; its status writes are untouched.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_rows(
  'NEW-1: the service role (the worker) marks the urgent publish job sent',
  $q$update notification_jobs set status = 'sent', attempts = attempts + 1, updated_at = now()
     where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201'$q$,
  1
);
select pg_temp.expect_error(
  'NEW-1: one bypassing publish job per message, even for the service role',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-00000000f201","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  array['23505']
);
-- The cancel-and-repeat chain (G6c, G6d): after the worker sent it, the publisher can neither
-- cancel the sent job nor write a fresh one.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'NEW-1 (G6c): the publisher cannot cancel the SENT bypassing job',
  $q$update notification_jobs set status = 'cancelled' where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-1: nor re-arm it',
  $q$update notification_jobs set status = 'pending' where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f201'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-1 (G6d): so no fresh bypassing job for the same message can follow',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.published',
      '{"messageId":"64000000-0000-0000-0000-00000000f201","quietHoursBypass":true,"channels":["push","email"],"recipients":["64000000-0000-0000-0000-0000000000e2"],"title":"EMERGENCY again"}'::jsonb)$q$,
  array['42501']
);
reset role;

-- NEW-3 through the same function: the audience of f202 is the department (a live member,
-- a soft-deleted former member) plus the publisher role (two users, one with two employee
-- rows): three people, not five.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_rows(
  'NEW-3: publishing the audience probe',
  $q$select public.publish_urgent_message('64000000-0000-0000-0000-00000000f202')$q$,
  1
);
reset role;
do $$
declare
  v_job notification_jobs%rowtype;
begin
  select * into v_job from notification_jobs where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-00000000f202';
  if v_job.payload_jsonb -> 'recipients' <> '["64000000-0000-0000-0000-0000000000e1","64000000-0000-0000-0000-0000000000e2","64000000-0000-0000-0000-0000000000e3"]'::jsonb then
    raise exception 'CE FAIL: NEW-3 the urgent audience over-delivers: %', v_job.payload_jsonb -> 'recipients';
  end if;
end;
$$;

-- NEW-1 + 0062: a NULL-key job written the way 3D's definer functions write it (no dedupe
-- key, no bypass) is untouched by both the client guard and the dedupe trigger.
select set_config('request.jwt.claims', '', true);
insert into notification_jobs (id, facility_id, event_type, status, payload_jsonb) values
  ('64000000-0000-0000-0000-000000000a25', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'schedule.published', 'pending',
   '{"recipients":["64000000-0000-0000-0000-0000000000e3"],"channels":["in_app"]}'::jsonb);
do $$
begin
  if (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a25') is not null then
    raise exception 'CE FAIL: a NULL dedupe key was rewritten';
  end if;
end;
$$;
update notification_jobs set status = 'sent' where id = '64000000-0000-0000-0000-000000000a25';
do $$
begin
  if (select dedupe_key from notification_jobs where id = '64000000-0000-0000-0000-000000000a25') is not null then
    raise exception 'CE FAIL: a worker status write re-keyed a NULL-key job';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. CM-13: the launch ledger -- requests.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
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
-- The happy request. A client-supplied content hash is overwritten (M-3).
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id, content_hash) values
  ('64000000-0000-0000-0000-000000000b01', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e1', 'forged');
do $$
declare
  v_hash text;
begin
  select content_hash into v_hash from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b01';
  if v_hash is null or v_hash = 'forged' or length(v_hash) <> 64 then
    raise exception 'CE FAIL: the content hash was not stamped server-side (%)', v_hash;
  end if;
end;
$$;
select pg_temp.expect_error(
  'one launch per message',
  $q$insert into emergency_alert_launches (facility_id, message_id, requested_by_employee_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000e1')$q$,
  array['23505']
);
select pg_temp.expect_error(
  'the content hash is immutable',
  $q$update emergency_alert_launches set content_hash = 'x' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);

-- L-2 / H-1b: a client session cannot move a launch to approved or launched itself,
-- not even the requester with a second employee row (M-2), nor stamp the count.
select pg_temp.expect_error(
  'L-2: a client cannot approve a launch directly (the requester, default setting)',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-2: ... nor with the requester''s SECOND employee row',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e9'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'L-2: a client cannot jump a launch to launched with a forged count',
  $q$update emergency_alert_launches set status = 'launched', recipient_count = 99999
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501', '23514']
);
select pg_temp.expect_error(
  'L-2: a client cannot stamp a recipient count',
  $q$update emergency_alert_launches set recipient_count = 5 where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
reset role;

-- Another publisher: cannot approve directly either, under their own or anyone's identity.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'L-2: a second publisher cannot approve with a direct update either',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e2'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'a launch cannot jump from pending to launched',
  $q$update emergency_alert_launches set status = 'launched' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501', '23514']
);
select pg_temp.expect_error(
  'the requester identity is immutable',
  $q$update emergency_alert_launches set requested_by_employee_id = '64000000-0000-0000-0000-0000000000e2'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
reset role;

-- The database guard itself (no client guard involved: the service role / owner path,
-- auth.uid() null) still enforces attribution, the second PERSON and the content hash.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'M-2: an approval by the requester''s own employee row is refused',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-2: an approval by a DIFFERENT employee row of the same person is refused',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e9'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'approval needs an approver',
  $q$update emergency_alert_launches set status = 'approved' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['23514']
);

-- ---------------------------------------------------------------------------
-- 6. approve_emergency_launch(): who may call it, and what it refuses.
-- ---------------------------------------------------------------------------
-- The reader, the no-comms employee and another facility's publisher.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a3');
set local role authenticated;
select pg_temp.expect_error(
  'a reader cannot call approve_emergency_launch',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['42501']
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.expect_error(
  'another facility''s publisher cannot call approve_emergency_launch',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['42501']
);
reset role;
-- Not signed in at all (service role, claims empty): the function needs a person.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'approve_emergency_launch needs a signed-in person',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['28000']
);
-- No launch requested for this message.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'no launch has been requested for this message',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f4')$q$,
  array['PT404']
);
reset role;

-- The requester (by either of their employee rows) is never the second approver.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'M-2: the requester cannot approve through the function (second approver required)',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['42501']
);
reset role;
do $$
begin
  if (select status from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b01') <> 'pending_approval'
     or (select published_at from messages where id = '64000000-0000-0000-0000-0000000000f1') is not null
     or exists (select 1 from notification_jobs where event_type = 'message.emergency') then
    raise exception 'CE FAIL: a refused approval left state behind';
  end if;
end;
$$;

-- M-3: from the moment of the request the message is frozen for client sessions.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'M-3: the subject of a launch-requested message cannot be changed by a client',
  $q$update messages set subject = 'EVACUATE NOW' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: nor the body',
  $q$update messages set body_text = 'attacker text' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: nor the priority',
  $q$update messages set priority = 'normal' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: nor the channel',
  $q$update messages set channel_id = '64000000-0000-0000-0000-0000000000c2' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: nor publishing it directly (CM-13 gate: nothing approved yet)',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: its audience cannot gain a row',
  $q$insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', 'employee', '64000000-0000-0000-0000-0000000000e5')$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: nor lose one',
  $q$delete from message_audiences where id = '64000000-0000-0000-0000-00000000a102'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: nor have one re-pointed',
  $q$update message_audiences set audience_ref_id = '64000000-0000-0000-0000-0000000000e5' where id = '64000000-0000-0000-0000-00000000a102'$q$,
  array['42501']
);
-- Other columns of a frozen draft (and the soft delete) stay editable.
select pg_temp.expect_rows(
  'M-3: updated_at on a frozen draft is not frozen',
  $q$update messages set updated_at = now() where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  1
);
-- An ordinary message's audience is not affected by the freeze.
select pg_temp.expect_rows(
  'M-3: an ordinary draft''s audience can still be edited',
  $q$insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f4', 'employee', '64000000-0000-0000-0000-0000000000e3')$q$,
  1
);
reset role;

-- M-3: the approval is for the content that was requested. A change the freeze did not
-- stop (the owner path here stands in for any writer that bypasses it) fails the hash.
select set_config('request.jwt.claims', '', true);
update messages set body_text = 'rewritten after the request' where id = '64000000-0000-0000-0000-0000000000f1';
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'M-3: approval fails when the body changed since the request',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['PT409']
);
reset role;
select set_config('request.jwt.claims', '', true);
update messages set body_text = 'Move inside' where id = '64000000-0000-0000-0000-0000000000f1';
insert into message_audiences (id, facility_id, message_id, audience_type, audience_ref_id) values
  ('64000000-0000-0000-0000-00000000a1ff', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', 'employee', '64000000-0000-0000-0000-0000000000e5');
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'M-3: approval fails when the audience changed since the request',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['PT409']
);
reset role;
-- ...and the guard refuses a direct approval of changed content for any writer.
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'M-3: the launch guard refuses to approve changed content',
  $q$update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e2'
     where id = '64000000-0000-0000-0000-000000000b01'$q$,
  array['23514']
);
delete from message_audiences where id = '64000000-0000-0000-0000-00000000a1ff';

-- A message that resolves to nobody is refused without consuming the approval.
-- (f9 has no audience at all.)
update messages set subject = 'Resolution' where id = '64000000-0000-0000-0000-0000000000f9';
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b09', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', '64000000-0000-0000-0000-0000000000e1');
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'an emergency that would reach nobody is refused',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f9')$q$,
  array['PT409']
);
reset role;
do $$
begin
  if (select status from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b09') <> 'pending_approval'
     or (select approved_by_employee_id from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b09') is not null
     or (select published_at from messages where id = '64000000-0000-0000-0000-0000000000f9') is not null then
    raise exception 'CE FAIL: a refused empty-audience approval consumed the approval or published the message';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The happy path: one transaction approves, publishes, enqueues, stamps launched.
-- ---------------------------------------------------------------------------
create temp table ce_result (r jsonb);
grant all on ce_result to authenticated;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
insert into ce_result select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1');
reset role;
do $$
declare
  v_launch emergency_alert_launches%rowtype;
  v_job notification_jobs%rowtype;
  v_result jsonb;
begin
  select r into v_result from ce_result;
  select * into v_launch from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b01';
  if v_launch.status <> 'launched' or v_launch.launched_at is null or v_launch.approved_at is null then
    raise exception 'CE FAIL: the launch is not stamped launched/approved: %', to_jsonb(v_launch);
  end if;
  if v_launch.approved_by_employee_id <> '64000000-0000-0000-0000-0000000000e2' or v_launch.recipient_count <> 2 then
    raise exception 'CE FAIL: wrong approver or recipient count: %', to_jsonb(v_launch);
  end if;
  if (v_result ->> 'recipientCount')::int <> 2 or v_result ->> 'status' <> 'launched' or (v_result ->> 'quietHoursBypass')::boolean is not true then
    raise exception 'CE FAIL: unexpected result %', v_result;
  end if;
  if (select published_at from messages where id = '64000000-0000-0000-0000-0000000000f1') is null then
    raise exception 'CE FAIL: the message was not published';
  end if;
  if (select count(*) from notification_jobs where event_type = 'message.emergency') <> 1 then
    raise exception 'CE FAIL: expected exactly one message.emergency job, found %', (select count(*) from notification_jobs where event_type = 'message.emergency');
  end if;
  select * into v_job from notification_jobs where event_type = 'message.emergency';
  if v_job.status <> 'pending' or v_job.facility_id <> '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then
    raise exception 'CE FAIL: unexpected job %', to_jsonb(v_job);
  end if;
  if (v_job.payload_jsonb ->> 'quietHoursBypass') <> 'true'
     or v_job.payload_jsonb -> 'channels' <> '["in_app","push","sms","email"]'::jsonb
     or v_job.payload_jsonb ->> 'messageId' <> '64000000-0000-0000-0000-0000000000f1'
     or v_job.payload_jsonb -> 'recipients' <> '["64000000-0000-0000-0000-0000000000e2","64000000-0000-0000-0000-0000000000e3"]'::jsonb
     or v_job.payload_jsonb ->> 'title' <> 'EMERGENCY: Storm 1'
     or v_job.payload_jsonb ->> 'body' <> 'Move inside'
     or v_job.dedupe_key is not null then
    raise exception 'CE FAIL: the emergency job payload is not the server-derived one: %', v_job.payload_jsonb;
  end if;
end;
$$;

-- A second approval, or a second launch, is refused.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'an already-launched emergency cannot be approved again',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f1')$q$,
  array['PT409']
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;

-- M-3 after the launch: the published, launched emergency is frozen for a client.
select pg_temp.expect_error(
  'M-3: the launched message''s subject cannot be rewritten',
  $q$update messages set subject = 'EVACUATE NOW', body_text = 'attacker text' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: its published_at cannot be re-dated (the 72 h banner window)',
  $q$update messages set published_at = now() + interval '1 minute' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: it cannot be unpublished by a client',
  $q$update messages set published_at = null where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: it cannot be re-prioritised',
  $q$update messages set priority = 'urgent' where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-3: it cannot gain an audience row',
  $q$insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f1', 'employee', '64000000-0000-0000-0000-0000000000e5')$q$,
  array['42501']
);
-- L-2: the ledger of a launched alert is out of the update policy's reach, and a launched row is terminal.
select pg_temp.expect_rows(
  'a launched alert cannot be updated through RLS',
  $q$update emergency_alert_launches set recipient_count = 99 where id = '64000000-0000-0000-0000-000000000b01'$q$,
  0
);
select pg_temp.expect_rows(
  'L-2: a launched alert cannot be cancelled',
  $q$update emergency_alert_launches set status = 'cancelled' where id = '64000000-0000-0000-0000-000000000b01'$q$,
  0
);
-- M-4: the hard delete of a launched message is refused.
select pg_temp.expect_error(
  'M-4: a publisher cannot hard-delete a message that has a launch',
  $q$delete from messages where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
-- M-4: an emergency job cannot be re-armed after the fact.
select pg_temp.expect_error(
  'H-1: the launched emergency job cannot be edited (rescheduled or re-armed) by a client',
  $q$update notification_jobs set scheduled_for = now() + interval '1 hour', attempts = 0 where event_type = 'message.emergency'$q$,
  array['42501']
);
-- NEW-2: nor silenced. A single publisher (the requester included) can neither cancel the
-- approved broadcast (A14b) nor delete it, which would also cascade its deliveries away (A13).
select pg_temp.expect_error(
  'NEW-2 (A14b): the requester cannot cancel the approved emergency job',
  $q$update notification_jobs set status = 'cancelled' where event_type = 'message.emergency'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-2: nor change its status in any other way',
  $q$update notification_jobs set status = 'failed' where event_type = 'message.emergency'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-2 (A13): the requester cannot delete the emergency job',
  $q$delete from notification_jobs where event_type = 'message.emergency'$q$,
  array['42501']
);
reset role;
-- The worker (service role) still drives the job's status, and the guard also holds after it
-- sent (a delete would cascade the delivery record).
select set_config('request.jwt.claims', '', true);
update notification_jobs set status = 'sent', attempts = 1 where event_type = 'message.emergency';
insert into notification_deliveries (facility_id, job_id, employee_id, channel, status)
  select facility_id, id, '64000000-0000-0000-0000-0000000000e2', 'in_app', 'sent' from notification_jobs where event_type = 'message.emergency';
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'NEW-2 (A13b): a sent emergency job and its deliveries cannot be deleted by a client',
  $q$delete from notification_jobs where event_type = 'message.emergency'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'NEW-2: nor cancelled after it was sent',
  $q$update notification_jobs set status = 'cancelled' where event_type = 'message.emergency'$q$,
  array['42501']
);
reset role;
do $$
begin
  if (select count(*) from notification_jobs where event_type = 'message.emergency') <> 1
     or (select count(*) from notification_deliveries d join notification_jobs j on j.id = d.job_id where j.event_type = 'message.emergency') <> 1 then
    raise exception 'CE FAIL: NEW-2 the emergency job or its delivery record was lost';
  end if;
  -- NEW-2: the lifecycle of the launch is in the audit trail, attributed to the right people.
  if (select count(*) from audit_events where entity_table = 'emergency_alert_launches'
        and entity_id = '64000000-0000-0000-0000-000000000b01' and event_type = 'emergency.launch_requested'
        and actor_user_id = '64000000-0000-0000-0000-0000000000a1') <> 1
     or (select count(*) from audit_events where entity_table = 'emergency_alert_launches'
           and entity_id = '64000000-0000-0000-0000-000000000b01' and event_type = 'emergency.launch_approved'
           and actor_user_id = '64000000-0000-0000-0000-0000000000a2') <> 1
     or (select count(*) from audit_events where entity_table = 'emergency_alert_launches'
           and entity_id = '64000000-0000-0000-0000-000000000b01' and event_type = 'emergency.launch_launched'
           and actor_user_id = '64000000-0000-0000-0000-0000000000a2'
           and (event_payload ->> 'recipientCount')::int = 2) <> 1 then
    raise exception 'CE FAIL: NEW-2 the emergency launch lifecycle is not in audit_events: %',
      (select jsonb_agg(event_type || ':' || coalesce(actor_user_id::text, '-')) from audit_events where entity_table = 'emergency_alert_launches');
  end if;
end;
$$;

select set_config('request.jwt.claims', '', true);
-- M-4: even for the owner the foreign keys restrict.
select pg_temp.expect_error(
  'M-4: the ON DELETE RESTRICT foreign key refuses the owner too',
  $q$delete from messages where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['23001', '23503']
);

-- M-3: republish from launched is impossible for every writer. A second launched
-- emergency (Storm 10): the owner can unpublish it (the transition INTO published is what
-- is gated) but not publish it again, because only an APPROVED launch qualifies and a
-- launch leaves `approved` exactly once, inside approve_emergency_launch().
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b0a', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fa', '64000000-0000-0000-0000-0000000000e1');
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_rows(
  'the second emergency launches',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000fa')$q$,
  1
);
reset role;
select set_config('request.jwt.claims', '', true);
update messages set published_at = null where id = '64000000-0000-0000-0000-0000000000fa';
select pg_temp.expect_error(
  'M-3: republish from launched is refused, even for the owner',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000fa'$q$,
  array['42501']
);
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'M-3: republish from launched is refused for a client',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000fa'$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 8. The tenant setting (L-6) and the flows it changes.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into modules (id, code, name, category, default_enabled) values
  ('64000000-0000-0000-0000-000000000c0d', 'communications', 'Communications', 'operations', true)
on conflict (code) do nothing;

do $$
declare
  v_mod uuid;
  v_fac constant uuid := '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_org constant uuid := '64111111-1111-1111-1111-111111111111';
begin
  select id into v_mod from modules where code = 'communications';
  delete from facility_module_overrides where facility_id = v_fac and module_id = v_mod;
  delete from organization_module_settings where organization_id = v_org and module_id = v_mod;

  if fn_comms_emergency_requires_second_approver(v_fac) is not true then
    raise exception 'CE FAIL: the default must be to require a second approver';
  end if;

  insert into facility_module_overrides (facility_id, module_id, config_patch_jsonb)
    values (v_fac, v_mod, '{"communications.emergencyRequiresSecondApprover": false}');
  if fn_comms_emergency_requires_second_approver(v_fac) is not false then
    raise exception 'CE FAIL: a JSON boolean false at the facility must turn the rule off';
  end if;

  -- L-6: only a real JSON boolean counts. The string "false", "False", 0 and null are
  -- malformed and fall through to the next layer (here: the default, true).
  update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": "false"}'
    where facility_id = v_fac and module_id = v_mod;
  if fn_comms_emergency_requires_second_approver(v_fac) is not true then
    raise exception 'CE FAIL: L-6 the JSON string "false" must not turn the rule off';
  end if;
  update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": "False"}'
    where facility_id = v_fac and module_id = v_mod;
  if fn_comms_emergency_requires_second_approver(v_fac) is not true then
    raise exception 'CE FAIL: L-6 the JSON string "False" must not turn the rule off';
  end if;
  update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": 0}'
    where facility_id = v_fac and module_id = v_mod;
  if fn_comms_emergency_requires_second_approver(v_fac) is not true then
    raise exception 'CE FAIL: L-6 the number 0 must not turn the rule off';
  end if;
  update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": null}'
    where facility_id = v_fac and module_id = v_mod;
  if fn_comms_emergency_requires_second_approver(v_fac) is not true then
    raise exception 'CE FAIL: L-6 a JSON null must not turn the rule off';
  end if;

  -- Layering: a malformed facility value falls through to the organization layer.
  insert into organization_module_settings (organization_id, module_id, enabled, config_jsonb)
    values (v_org, v_mod, true, '{"communications.emergencyRequiresSecondApprover": false}');
  if fn_comms_emergency_requires_second_approver(v_fac) is not false then
    raise exception 'CE FAIL: a malformed facility value must fall through to the organization layer';
  end if;
  update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": true}'
    where facility_id = v_fac and module_id = v_mod;
  if fn_comms_emergency_requires_second_approver(v_fac) is not true then
    raise exception 'CE FAIL: a facility true must win over an organization false';
  end if;
  delete from organization_module_settings where organization_id = v_org and module_id = v_mod;
  delete from facility_module_overrides where facility_id = v_fac and module_id = v_mod;
end;
$$;

-- A publisher cannot write the setting or call its function (X3/X4 of the review).
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'a publisher cannot write the setting',
  $q$insert into facility_module_overrides (facility_id, module_id, config_patch_jsonb)
     select '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', id, '{"communications.emergencyRequiresSecondApprover": false}' from modules where code = 'communications'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'a publisher cannot call the setting function',
  $q$select fn_comms_emergency_requires_second_approver('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$q$,
  array['42501']
);
reset role;

-- With the facility override a JSON boolean false, a single publisher can approve their
-- own request through the function (Storm 2).
select set_config('request.jwt.claims', '', true);
insert into facility_module_overrides (facility_id, module_id, config_patch_jsonb)
select '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', m.id, '{"communications.emergencyRequiresSecondApprover": false}'::jsonb
from modules m where m.code = 'communications';
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b02', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f2', '64000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_rows(
  'with the setting off, a single publisher can approve and launch their own request',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f2')$q$,
  1
);
reset role;
do $$
begin
  if (select status from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b02') <> 'launched'
     or (select published_at from messages where id = '64000000-0000-0000-0000-0000000000f2') is null then
    raise exception 'CE FAIL: the setting-off launch did not complete';
  end if;
end;
$$;

-- L-6 end to end: the string "false" is malformed, so the rule still applies (Storm 3).
select set_config('request.jwt.claims', '', true);
update facility_module_overrides set config_patch_jsonb = '{"communications.emergencyRequiresSecondApprover": "false"}'::jsonb
where facility_id = '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b03', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f8', '64000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_error(
  'L-6: a string "false" setting still requires a second approver',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000f8')$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);
delete from facility_module_overrides where facility_id = '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- ---------------------------------------------------------------------------
-- 9. Cancel, and the ledger's service-role path.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b0c', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fc', '64000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_rows(
  'a pending launch can be cancelled',
  $q$update emergency_alert_launches set status = 'cancelled' where id = '64000000-0000-0000-0000-000000000b0c'$q$,
  1
);
select pg_temp.expect_rows(
  'a cancelled launch is out of the update policy''s reach',
  $q$update emergency_alert_launches set status = 'cancelled' where id = '64000000-0000-0000-0000-000000000b0c'$q$,
  0
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.expect_error(
  'a cancelled launch cannot be approved',
  $q$select public.approve_emergency_launch('64000000-0000-0000-0000-0000000000fc')$q$,
  array['PT409']
);
reset role;

-- The ledger's own state machine for a writer that is not a client session (owner here):
-- approved -> launched needs the recipient count, and an APPROVED launch is what lets the
-- message be published at all (Storm 11).
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into emergency_alert_launches (id, facility_id, message_id, requested_by_employee_id) values
  ('64000000-0000-0000-0000-000000000b0b', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fb', '64000000-0000-0000-0000-0000000000e1');
reset role;
select set_config('request.jwt.claims', '', true);
update emergency_alert_launches set status = 'approved', approved_by_employee_id = '64000000-0000-0000-0000-0000000000e2', approved_at = '2000-01-01'
 where id = '64000000-0000-0000-0000-000000000b0b';
do $$
begin
  if (select approved_at from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b0b') < now() - interval '1 minute' then
    raise exception 'CE FAIL: approved_at was caller-controlled';
  end if;
end;
$$;
select pg_temp.expect_error(
  'approval data is write-once',
  $q$update emergency_alert_launches set approved_by_employee_id = '64000000-0000-0000-0000-0000000000e1' where id = '64000000-0000-0000-0000-000000000b0b'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'an approved launch cannot go back to pending',
  $q$update emergency_alert_launches set status = 'pending_approval' where id = '64000000-0000-0000-0000-000000000b0b'$q$,
  array['23514']
);
select pg_temp.expect_error(
  'a launch stamp needs a recipient count',
  $q$update emergency_alert_launches set status = 'launched' where id = '64000000-0000-0000-0000-000000000b0b'$q$,
  array['23514']
);
-- A client still cannot publish an approved-but-unlaunched emergency, nor stamp it.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'H-1: a client cannot publish the approved emergency itself (no job would be queued)',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000fb'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'L-2: a client cannot stamp the approved launch launched',
  $q$update emergency_alert_launches set status = 'launched', recipient_count = 2 where id = '64000000-0000-0000-0000-000000000b0b'$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_rows(
  'the approved emergency publishes for a non-client writer',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000fb'$q$,
  1
);
update emergency_alert_launches set status = 'launched', recipient_count = 1 where id = '64000000-0000-0000-0000-000000000b0b';
do $$
begin
  if (select launched_at from emergency_alert_launches where id = '64000000-0000-0000-0000-000000000b0b') is null then
    raise exception 'CE FAIL: launched_at was not stamped';
  end if;
end;
$$;
select pg_temp.expect_error(
  'a launched alert is terminal even for the owner',
  $q$update emergency_alert_launches set recipient_count = 99 where id = '64000000-0000-0000-0000-000000000b0b'$q$,
  array['23514']
);

-- Readers cannot see or touch the ledger; other facilities cannot either.
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a3');
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
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fd', '64000000-0000-0000-0000-0000000000e3')$q$,
  array['42501']
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a4');
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
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fd', '64000000-0000-0000-0000-0000000000e4')$q$,
  array['42501', '23514']
);
select pg_temp.expect_rows(
  'another facility''s publisher cannot cancel a launch here',
  $q$update emergency_alert_launches set status = 'cancelled' where facility_id = '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$q$,
  0
);
reset role;

-- ---------------------------------------------------------------------------
-- 10. The messages gate (CM-13): nothing becomes a published emergency without an
-- approved launch.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'a published emergency message cannot be inserted directly',
  $q$insert into messages (facility_id, channel_id, subject, body_text, priority, published_at)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', 's', 'b', 'emergency', now())$q$,
  array['42501']
);
select pg_temp.expect_error(
  'an emergency draft without a launch cannot be published',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000fd'$q$,
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
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error(
  'the gate applies to the owner too',
  $q$insert into messages (facility_id, channel_id, subject, body_text, priority, published_at)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c1', 's', 'b', 'emergency', now())$q$,
  array['42501']
);

-- ---------------------------------------------------------------------------
-- 11. emergency_alert_responses: own response only.
-- ---------------------------------------------------------------------------
-- f1 is now a published emergency message in facility A (launched through
-- approve_emergency_launch); fd is an emergency draft that is not published.
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
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000fd', '64000000-0000-0000-0000-0000000000e3', 'safe')$q$,
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


-- M-4: a message that has safety responses cannot be hard-deleted by a client (and the
-- foreign key refuses everyone else).
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'M-4: a publisher cannot hard-delete a message that has emergency responses',
  $q$delete from messages where id = '64000000-0000-0000-0000-0000000000f1'$q$,
  array['42501']
);
reset role;

-- ---------------------------------------------------------------------------
-- 12. The approval queue and the approver's view (M-3: body and recipient count).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
do $$
declare
  v_rows jsonb;
  v_row jsonb;
begin
  v_rows := public.emergency_launch_queue('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pending_approval');
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) <> 2 then
    raise exception 'CE FAIL: the queue should hold the two pending launches, got %', v_rows;
  end if;
  select e into v_row from jsonb_array_elements(v_rows) e where e ->> 'id' = '64000000-0000-0000-0000-000000000b09';
  if v_row ->> 'id' <> '64000000-0000-0000-0000-000000000b09'
     or v_row ->> 'status' <> 'pending_approval'
     or v_row -> 'messages' ->> 'subject' <> 'Resolution'
     or v_row -> 'messages' ->> 'body_text' <> 'x'
     or (v_row -> 'preview' ->> 'recipientCount')::int <> 0
     or (v_row ->> 'contentChanged')::boolean is not false
     or v_row ? 'content_hash' then
    raise exception 'CE FAIL: unexpected queue entry %', v_row;
  end if;
  -- Launched rows are listed without a preview; the status filter is validated.
  v_rows := public.emergency_launch_queue('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'launched');
  if jsonb_array_length(v_rows) < 2 or exists (
       select 1 from jsonb_array_elements(v_rows) e where e -> 'preview' is not null and e -> 'preview' <> 'null'::jsonb) then
    raise exception 'CE FAIL: launched queue entries should carry no preview: %', v_rows;
  end if;
end;
$$;
select pg_temp.expect_error(
  'the queue validates its status filter',
  $q$select public.emergency_launch_queue('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bogus')$q$,
  array['PT400']
);
reset role;
-- The audience (and hence the count the approver sees, and the hash) moves with the message.
select set_config('request.jwt.claims', '', true);
insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000e5');
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a2');
set local role authenticated;
do $$
declare
  v_row jsonb;
begin
  select e into v_row from jsonb_array_elements(public.emergency_launch_queue('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pending_approval')) e
   where e ->> 'id' = '64000000-0000-0000-0000-000000000b09';
  if (v_row -> 'preview' ->> 'recipientCount')::int <> 2 or (v_row ->> 'contentChanged')::boolean is not true then
    raise exception 'CE FAIL: the queue did not show the live recipient count / changed content: %', v_row;
  end if;
end;
$$;
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a3');
set local role authenticated;
select pg_temp.expect_error(
  'a reader cannot read the approval queue',
  $q$select public.emergency_launch_queue('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null)$q$,
  array['42501']
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.expect_error(
  'another facility''s publisher cannot read this queue',
  $q$select public.emergency_launch_queue('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null)$q$,
  array['42501']
);
reset role;
select set_config('request.jwt.claims', '', true);
delete from message_audiences where message_id = '64000000-0000-0000-0000-0000000000f9';

-- ---------------------------------------------------------------------------
-- 13. Server-side audience resolution (the recipient list of the emergency job).
-- ---------------------------------------------------------------------------
insert into schedule_periods (id, facility_id, week_start_date, week_end_date) values
  ('64000000-0000-0000-0000-00000000e001', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', current_date - 3, current_date + 30);
insert into schedule_shifts (id, facility_id, schedule_period_id, department_id, role_code, shift_date, starts_at, ends_at, status) values
  ('64000000-0000-0000-0000-0000000005c1', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000e001', '64000000-0000-0000-0000-00000000d001', 'guard', current_date, now() - interval '1 hour', now() + interval '3 hours', 'published'),
  ('64000000-0000-0000-0000-0000000005c2', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000e001', '64000000-0000-0000-0000-00000000d002', 'desk', current_date + 1, now() + interval '1 day', now() + interval '1 day 8 hours', 'published'),
  ('64000000-0000-0000-0000-0000000005c3', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000e001', '64000000-0000-0000-0000-00000000d001', 'guard', current_date + 10, now() + interval '10 days', now() + interval '10 days 8 hours', 'published'),
  ('64000000-0000-0000-0000-0000000005c4', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-00000000e001', '64000000-0000-0000-0000-00000000d001', 'guard', current_date, now() - interval '30 minutes', now() + interval '1 hour', 'cancelled');
insert into shift_assignments (facility_id, shift_id, employee_id, status) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c1', '64000000-0000-0000-0000-0000000000e1', 'approved'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c1', '64000000-0000-0000-0000-0000000000e2', 'pending'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c1', '64000000-0000-0000-0000-0000000000e5', 'declined'),
  -- NEW-3: a soft-deleted employee still holding an approved assignment is not paged
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c1', '64000000-0000-0000-0000-0000000000ea', 'approved'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c2', '64000000-0000-0000-0000-0000000000e3', 'approved'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c3', '64000000-0000-0000-0000-0000000000e9', 'approved'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000005c4', '64000000-0000-0000-0000-0000000000e5', 'approved');

create function pg_temp.expect_audience(p_label text, p_expected text[], p_unresolved integer default 0) returns void
language plpgsql as $$
declare
  v_result jsonb := internal.fn_emergency_audience('64000000-0000-0000-0000-0000000000f9', now());
  v_got text[];
  v_want text[];
begin
  select coalesce(array_agg(x order by x), '{}') into v_got from jsonb_array_elements_text(v_result -> 'recipients') x;
  select coalesce(array_agg('64000000-0000-0000-0000-0000000000' || e order by '64000000-0000-0000-0000-0000000000' || e), '{}')
    into v_want from unnest(p_expected) e;
  if v_got is distinct from v_want or (v_result ->> 'unresolved')::int <> p_unresolved then
    raise exception 'CE FAIL (%): expected % (unresolved %) but got % (unresolved %)', p_label, v_want, p_unresolved, v_got, v_result ->> 'unresolved';
  end if;
  delete from message_audiences where message_id = '64000000-0000-0000-0000-0000000000f9';
end;
$$;

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000e5');
select pg_temp.expect_audience('employee audience', array['e5']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'department', '64000000-0000-0000-0000-00000000d001');
select pg_temp.expect_audience('department audience (NEW-3: the soft-deleted former member is not a recipient)', array['e3']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000ea');
select pg_temp.expect_audience('NEW-3: naming a soft-deleted employee directly reaches nobody', array[]::text[]);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'department', null);
select pg_temp.expect_audience('a department audience without a ref reaches nobody', array[]::text[]);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'role', '64000000-0000-0000-0000-0000000000d2');
select pg_temp.expect_audience('role audience (reader role)', array['e3']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'role', '64000000-0000-0000-0000-0000000000d1');
select pg_temp.expect_audience('NEW-3: role audience (publisher role: publisher one''s two employee rows count once, the earliest)', array['e1', 'e2']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'department', '64000000-0000-0000-0000-00000000d001'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'role', '64000000-0000-0000-0000-0000000000d1');
select pg_temp.expect_audience('NEW-3 (A10): department + role = 3 people (not 5): a soft-deleted member out, one user''s two rows once', array['e1', 'e2', 'e3']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', '64000000-0000-0000-0000-0000000005c1');
select pg_temp.expect_audience('specific shift: pending and approved assignees, not declined', array['e1', 'e2']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{"window":"current"}');
select pg_temp.expect_audience('window current (a cancelled shift is not live)', array['e1', 'e2']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{"window":{"kind":"current"},"departmentId":"64000000-0000-0000-0000-00000000d002"}');
select pg_temp.expect_audience('window current narrowed to another department', array[]::text[]);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{"window":"current","departmentId":"64000000-0000-0000-0000-00000000d001"}');
select pg_temp.expect_audience('window current narrowed to its department', array['e1', 'e2']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{"window":" NEXT "}');
select pg_temp.expect_audience('window next (case and whitespace insensitive)', array['e3']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{"shiftWindow":"next","departmentId":"64000000-0000-0000-0000-00000000d001"}');
select pg_temp.expect_audience('window next within a department whose next shift is beyond the 7 day look-ahead', array[]::text[]);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null,
   json_build_object('window', json_build_object('from', now() - interval '2 hours', 'to', now() + interval '2 days'))::jsonb);
select pg_temp.expect_audience('explicit range overlapping two live shifts', array['e1', 'e2', 'e3']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null,
   json_build_object('window', json_build_object('from', now() - interval '1 day', 'to', now() + interval '40 days'))::jsonb);
select pg_temp.expect_audience('a range longer than 31 days is unresolved', array[]::text[], 1);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{}');
select pg_temp.expect_audience('a ref-less shift audience without a window is unresolved', array[]::text[], 1);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, rule_jsonb) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'shift', null, '{"window":"sometime"}');
select pg_temp.expect_audience('a malformed window is unresolved, never everybody', array[]::text[], 1);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000e3'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'department', '64000000-0000-0000-0000-00000000d001'),
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000e5');
select pg_temp.expect_audience('overlapping audiences are deduplicated', array['e3', 'e5']);

insert into message_audiences (facility_id, message_id, audience_type, audience_ref_id, deleted_at) values
  ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000f9', 'employee', '64000000-0000-0000-0000-0000000000e5', now());
select pg_temp.expect_audience('a soft-deleted audience row is ignored', array[]::text[]);

-- ---------------------------------------------------------------------------
-- 14. M-5: the sweep's work-queue column, and the ack due-time validation.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'M-5: a publisher cannot move a message in or out of the sweep''s queue',
  $q$update messages set ack_next_escalation_at = now() + interval '30 days' where id = '64000000-0000-0000-0000-0000000000f6'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-5: a publisher cannot insert a message with a pre-set queue time',
  $q$insert into messages (facility_id, channel_id, subject, body_text, ack_next_escalation_at)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', 's', 'b', now())$q$,
  array['42501']
);
-- Publishing a required-ack message with a future due time queues it at the due time.
insert into messages (id, facility_id, channel_id, author_employee_id, subject, body_text, is_required_ack, ack_due_at) values
  ('64000000-0000-0000-0000-0000000000a9', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Future ack', 'x', true, now() + interval '2 days');
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a9') is not null then
    raise exception 'CE FAIL: a draft must not be queued for escalation';
  end if;
end;
$$;
update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000a9';
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a9')
     is distinct from (select ack_due_at from messages where id = '64000000-0000-0000-0000-0000000000a9') then
    raise exception 'CE FAIL: M-5 publishing did not queue the message at its due time';
  end if;
end;
$$;
-- M-5 residual: once published, neither column can be moved to bring the ladder forward.
select pg_temp.expect_error(
  'M-5 (M5b): a publisher cannot move ack_due_at into the past after publishing',
  $q$update messages set ack_due_at = now() - interval '5 days' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  array['23514']
);
select pg_temp.expect_error(
  'M-5 (M5c): nor backdate published_at (it is frozen once set)',
  $q$update messages set published_at = now() - interval '6 days' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  array['42501']
);
-- Round-3 residual: a draft cannot be published with a backdated time, nor
-- inserted already published in the past.
insert into messages (id, facility_id, channel_id, author_employee_id, subject, body_text)
values ('64000000-0000-0000-0000-0000000000b9', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Backdate draft', 'x');
select pg_temp.expect_error(
  'M-5 (M5j): publishing cannot backdate published_at',
  $q$update messages set published_at = now() - interval '5 days' where id = '64000000-0000-0000-0000-0000000000b9'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-5 (M5k): inserting an already-published row cannot backdate it',
  $q$insert into messages (facility_id, channel_id, author_employee_id, subject, body_text, published_at) values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Backdated', 'x', now() - interval '5 days')$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-5: nor move it later, or clear it',
  $q$update messages set published_at = now() + interval '1 hour' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'M-5: nor set both at once so the due time still follows the (new) publish time',
  $q$update messages set published_at = now() - interval '9 days', ack_due_at = now() - interval '8 days' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  array['42501']
);
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a9')
     is distinct from (select ack_due_at from messages where id = '64000000-0000-0000-0000-0000000000a9') then
    raise exception 'CE FAIL: M-5 (M5e) the rejected updates moved the queue time';
  end if;
end;
$$;
-- A later due time after publishing is an ordinary edit and re-queues the message.
select pg_temp.expect_rows(
  'M-5: a publisher can still extend the due time after publishing',
  $q$update messages set ack_due_at = now() + interval '4 days' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  1
);
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a9')
     is distinct from (select ack_due_at from messages where id = '64000000-0000-0000-0000-0000000000a9') then
    raise exception 'CE FAIL: M-5 extending the due time did not re-queue the message';
  end if;
end;
$$;
-- A due time in the past at publish is refused (the ladder would fire three tiers in a row).
insert into messages (id, facility_id, channel_id, author_employee_id, subject, body_text, is_required_ack, ack_due_at) values
  ('64000000-0000-0000-0000-0000000000a8', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Past ack', 'x', true, now() - interval '1 day');
select pg_temp.expect_error(
  'M-5: publishing a required-ack message that is already past due is refused',
  $q$update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000a8'$q$,
  array['23514']
);
select pg_temp.expect_error(
  'M-5: so is inserting one already published',
  $q$insert into messages (facility_id, channel_id, subject, body_text, is_required_ack, ack_due_at, published_at)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', 's', 'b', true, now() - interval '1 hour', now())$q$,
  array['23514']
);
-- A message that needs no acknowledgement is not queued.
update messages set published_at = now() where id = '64000000-0000-0000-0000-0000000000ff';
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000ff') is not null then
    raise exception 'CE FAIL: a message without required acknowledgement was queued';
  end if;
end;
$$;
reset role;

-- The service role (the sweep) owns the column: it can push a message out and the queue
-- value survives unrelated edits, but changing the due time re-queues the message.
select set_config('request.jwt.claims', '', true);
update messages set ack_next_escalation_at = now() + interval '5 days' where id = '64000000-0000-0000-0000-0000000000a9';
update messages set updated_at = now() where id = '64000000-0000-0000-0000-0000000000a9';
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a9') < now() + interval '4 days' then
    raise exception 'CE FAIL: an unrelated update reset the sweep''s queue time';
  end if;
end;
$$;
update messages set ack_due_at = now() + interval '3 days' where id = '64000000-0000-0000-0000-0000000000a9';
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a9')
     is distinct from (select ack_due_at from messages where id = '64000000-0000-0000-0000-0000000000a9') then
    raise exception 'CE FAIL: changing the due time did not re-queue the message';
  end if;
end;
$$;
-- Legacy / service-role publish with a past due time anchors the ladder at the publish time.
insert into messages (id, facility_id, channel_id, author_employee_id, subject, body_text, is_required_ack, ack_due_at, published_at) values
  ('64000000-0000-0000-0000-0000000000a7', '64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '64000000-0000-0000-0000-0000000000c2', '64000000-0000-0000-0000-0000000000e1', 'Legacy ack', 'x', true, now() - interval '3 days', now() - interval '1 day');
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a7')
     <> (select published_at from messages where id = '64000000-0000-0000-0000-0000000000a7') then
    raise exception 'CE FAIL: the ladder must not start before the publish time';
  end if;
end;
$$;
update messages set ack_escalation_level = 3 where id = '64000000-0000-0000-0000-0000000000a7';
do $$
begin
  if (select ack_next_escalation_at from messages where id = '64000000-0000-0000-0000-0000000000a7') is not null then
    raise exception 'CE FAIL: a fully escalated message must leave the queue';
  end if;
end;
$$;

-- NEW-2: a cancelled launch is in the audit trail too (section 9 cancelled one).
do $$
begin
  if not exists (select 1 from audit_events where entity_table = 'emergency_alert_launches' and event_type = 'emergency.launch_cancelled') then
    raise exception 'CE FAIL: NEW-2 no emergency.launch_cancelled audit event was written';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. L-3: communication_channels.emergency_enabled is an admin.manage flag.
-- ---------------------------------------------------------------------------
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.expect_error(
  'L-3: a publisher cannot switch a channel to emergency-enabled',
  $q$update communication_channels set emergency_enabled = true where id = '64000000-0000-0000-0000-0000000000c2'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'L-3: nor switch an emergency channel off',
  $q$update communication_channels set emergency_enabled = false where id = '64000000-0000-0000-0000-0000000000c1'$q$,
  array['42501']
);
select pg_temp.expect_error(
  'L-3: nor create a channel that is already emergency-enabled',
  $q$insert into communication_channels (facility_id, channel_type, name, emergency_enabled)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'emergency', 'CE Sneaky', true)$q$,
  array['42501']
);
select pg_temp.expect_rows(
  'L-3: a publisher can still create an ordinary channel',
  $q$insert into communication_channels (facility_id, channel_type, name, emergency_enabled)
     values ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'department', 'CE Ordinary Two', false)$q$,
  1
);
select pg_temp.expect_rows(
  'L-3: and rename channels (the flag itself unchanged)',
  $q$update communication_channels set name = 'CE Ordinary Renamed' where id = '64000000-0000-0000-0000-0000000000c2'$q$,
  1
);
reset role;
select pg_temp.as_user('64000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.expect_rows(
  'L-3: an admin.manage holder can switch the flag',
  $q$update communication_channels set emergency_enabled = true where id = '64000000-0000-0000-0000-0000000000c2'$q$,
  1
);
reset role;
select set_config('request.jwt.claims', '', true);
update communication_channels set emergency_enabled = false where id = '64000000-0000-0000-0000-0000000000c2';

-- The service role (a role that is neither authenticated nor anon) is not a client session:
-- the same writes the guards refuse a publisher are permitted for it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;
grant all on notification_jobs, messages, emergency_alert_launches, message_audiences, communication_channels to service_role;
set local role service_role;
select pg_temp.expect_rows(
  'H-1: a service_role session writes a message.emergency job (the guards constrain client sessions only)',
  $q$insert into notification_jobs (facility_id, event_type, payload_jsonb) values
     ('64aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.emergency', '{"messageId":"64000000-0000-0000-0000-0000000000f5","quietHoursBypass":true,"recipients":["x"]}'::jsonb)$q$,
  1
);
select pg_temp.expect_rows(
  'H-1: ... and rewrites a job''s payload',
  $q$update notification_jobs set payload_jsonb = payload_jsonb || '{"note":"sweep"}'::jsonb where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-0000000000f5'$q$,
  1
);
select pg_temp.expect_rows(
  'M-5: ... and moves a message in the sweep''s queue',
  $q$update messages set ack_next_escalation_at = now() + interval '1 hour' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  1
);
select pg_temp.expect_rows(
  'NEW-2: ... and deletes a job (a delete from a non-client session is not constrained)',
  $q$delete from notification_jobs where payload_jsonb ->> 'messageId' = '64000000-0000-0000-0000-0000000000f5'$q$,
  1
);
select pg_temp.expect_rows(
  'M-5: ... and re-dates a published message (the service role is not frozen)',
  $q$update messages set published_at = now() - interval '1 minute' where id = '64000000-0000-0000-0000-0000000000a9'$q$,
  1
);
reset role;

rollback;
