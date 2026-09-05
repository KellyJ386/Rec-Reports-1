-- Verification intent: CM-01 (plans/COMMUNICATIONS_PLAN.md) self-service RLS
-- on message_receipts/message_acknowledgements (0009, hardened by 0025).
-- An authenticated employee with communications.read may insert/update ONLY
-- their own (employees.user_id = auth.uid()) receipt/acknowledgement row, and
-- only for a message that actually shares the row's facility_id
-- (fn_assert_same_facility against messages). communications.publish holders
-- additionally get manage-level write onto any employee's row (e.g. a
-- manager_override acknowledgement). Runs against a migrated database inside
-- a rolled-back transaction, so no fixture persists. RLS denials surface as
-- insufficient_privilege (SQLSTATE 42501).
begin;

-- Two organizations/facilities so the cross-facility case is a real foreign
-- tenant, not just a second row in the same tenant.
insert into auth.users (id, email) values
  ('25000000-0000-0000-0000-0000000000a1', 'cm01-alice@test'),
  ('25000000-0000-0000-0000-0000000000a2', 'cm01-bob@test'),
  ('25000000-0000-0000-0000-0000000000a3', 'cm01-carol@test'),
  ('25000000-0000-0000-0000-0000000000a4', 'cm01-dana@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('25000000-0000-0000-0000-0000000000a1', 'Alice Reader', 'cm01-alice@test'),
  ('25000000-0000-0000-0000-0000000000a2', 'Bob Reader', 'cm01-bob@test'),
  ('25000000-0000-0000-0000-0000000000a3', 'Carol NoComms', 'cm01-carol@test'),
  ('25000000-0000-0000-0000-0000000000a4', 'Dana Publisher', 'cm01-dana@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('25111111-1111-1111-1111-111111111111', 'CM01 Org A'),
  ('25222222-2222-2222-2222-222222222222', 'CM01 Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25111111-1111-1111-1111-111111111111', 'CM01 Facility A'),
  ('25bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '25222222-2222-2222-2222-222222222222', 'CM01 Facility B')
on conflict (id) do nothing;

-- Roles: reader (communications.read only), no-comms (unrelated permission),
-- publisher (communications.read + communications.publish). All in Facility A.
insert into roles (id, facility_id, name) values
  ('25000000-0000-0000-0000-0000000000d1', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CM01 Reader'),
  ('25000000-0000-0000-0000-0000000000d2', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CM01 No Comms'),
  ('25000000-0000-0000-0000-0000000000d3', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CM01 Publisher')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('25000000-0000-0000-0000-0000000000d1', 'communications.read'),
  ('25000000-0000-0000-0000-0000000000d2', 'reports.read'),
  ('25000000-0000-0000-0000-0000000000d3', 'communications.read'),
  ('25000000-0000-0000-0000-0000000000d3', 'communications.publish')
on conflict do nothing;

-- Alice and Bob are plain readers; Carol has no communications.read at all;
-- Dana is a publisher. All four are memberships of Facility A.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('25000000-0000-0000-0000-0000000000b1', '25000000-0000-0000-0000-0000000000a1', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000d1', 'active'),
  ('25000000-0000-0000-0000-0000000000b2', '25000000-0000-0000-0000-0000000000a2', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000d1', 'active'),
  ('25000000-0000-0000-0000-0000000000b3', '25000000-0000-0000-0000-0000000000a3', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000d2', 'active'),
  ('25000000-0000-0000-0000-0000000000b4', '25000000-0000-0000-0000-0000000000a4', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000d3', 'active')
on conflict (id) do nothing;

-- Employee rows (id deliberately distinct from the owning user's id, exactly
-- like production -- employees.id is its own PK, not the auth user id).
insert into employees (id, facility_id, user_id, first_name, last_name) values
  ('25000000-0000-0000-0000-0000000000e1', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000a1', 'Alice', 'Reader'),
  ('25000000-0000-0000-0000-0000000000e2', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000a2', 'Bob', 'Reader'),
  ('25000000-0000-0000-0000-0000000000e3', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000a3', 'Carol', 'NoComms'),
  ('25000000-0000-0000-0000-0000000000e4', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000a4', 'Dana', 'Publisher')
on conflict (id) do nothing;

-- One channel + message per facility (owner writes, bypassing RLS).
insert into communication_channels (id, facility_id, channel_type, name) values
  ('25000000-0000-0000-0000-0000000000c1', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'facility', 'CM01 Channel A'),
  ('25000000-0000-0000-0000-0000000000c2', '25bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'facility', 'CM01 Channel B')
on conflict (id) do nothing;

insert into messages (id, facility_id, channel_id, subject, body_text, is_required_ack) values
  ('25000000-0000-0000-0000-0000000000f1', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000c1', 'Facility A Notice', 'Body A', true),
  ('25000000-0000-0000-0000-0000000000f2', '25bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '25000000-0000-0000-0000-0000000000c2', 'Facility B Notice', 'Body B', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Act as Alice (communications.read on Facility A only).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"25000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

-- Allowed: Alice records her own receipt for the Facility A message.
do $$
begin
  insert into message_receipts (id, facility_id, message_id, employee_id, delivered_at) values
    ('25000000-0000-0000-0000-000000000091', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e1', now());
exception
  when insufficient_privilege then
    raise exception 'CM01 FAIL: Alice was denied inserting her own receipt';
end;
$$;

-- Allowed: Alice then marks it read (update her own row).
do $$
begin
  update message_receipts set read_at = now()
  where id = '25000000-0000-0000-0000-000000000091';
  if not exists (select 1 from message_receipts where id = '25000000-0000-0000-0000-000000000091' and read_at is not null) then
    raise exception 'CM01 FAIL: Alice''s own-receipt update did not apply';
  end if;
exception
  when insufficient_privilege then
    raise exception 'CM01 FAIL: Alice was denied updating her own receipt';
end;
$$;

-- Allowed: Alice records her own acknowledgement for the Facility A message.
do $$
begin
  insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state, acknowledged_at, ack_method) values
    ('25000000-0000-0000-0000-000000000096', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e1', 'acknowledged', now(), 'button');
exception
  when insufficient_privilege then
    raise exception 'CM01 FAIL: Alice was denied inserting her own acknowledgement';
end;
$$;

-- Denied: Alice cannot insert a receipt for Bob's employee_id.
do $$
begin
  begin
    insert into message_receipts (id, facility_id, message_id, employee_id, delivered_at) values
      ('25000000-0000-0000-0000-000000000092', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e2', now());
    raise exception 'CM01 FAIL: Alice inserted a receipt owned by another employee (Bob)';
  exception
    when insufficient_privilege then null; -- expected: employee_id does not map to Alice's user_id
  end;
end;
$$;

-- Denied: Alice cannot insert an acknowledgement for Bob's employee_id.
do $$
begin
  begin
    insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state) values
      ('25000000-0000-0000-0000-000000000097', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e2', 'acknowledged');
    raise exception 'CM01 FAIL: Alice inserted an acknowledgement owned by another employee (Bob)';
  exception
    when insufficient_privilege then null; -- expected: employee_id does not map to Alice's user_id
  end;
end;
$$;

-- Denied: cross-facility insert. facility_id = A (where Alice has
-- communications.read and employees.facility_id matches), but message_id
-- points at the Facility B message -- fn_assert_same_facility must catch this
-- even though the row-level facility_id/employee checks alone would pass.
do $$
begin
  begin
    insert into message_receipts (id, facility_id, message_id, employee_id, delivered_at) values
      ('25000000-0000-0000-0000-000000000093', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f2', '25000000-0000-0000-0000-0000000000e1', now());
    raise exception 'CM01 FAIL: a receipt was inserted whose facility_id does not match its message''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

do $$
begin
  begin
    insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state) values
      ('25000000-0000-0000-0000-000000000098', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f2', '25000000-0000-0000-0000-0000000000e1', 'acknowledged');
    raise exception 'CM01 FAIL: an acknowledgement was inserted whose facility_id does not match its message''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Act as Carol (member of Facility A, but her role has no communications.read
-- at all -- the has_permission gate must deny even a fully-own-row insert).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"25000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  begin
    insert into message_receipts (id, facility_id, message_id, employee_id, delivered_at) values
      ('25000000-0000-0000-0000-000000000094', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e3', now());
    raise exception 'CM01 FAIL: Carol (no communications.read) inserted her own receipt';
  exception
    when insufficient_privilege then null; -- expected: has_permission(communications.read) failed
  end;
end;
$$;

do $$
begin
  begin
    insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state) values
      ('25000000-0000-0000-0000-000000000099', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e3', 'acknowledged');
    raise exception 'CM01 FAIL: Carol (no communications.read) inserted her own acknowledgement';
  exception
    when insufficient_privilege then null; -- expected: has_permission(communications.read) failed
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Act as Dana (communications.publish). A publisher may record an
-- acknowledgement/receipt for ANOTHER employee (e.g. manager_override), which
-- the self-service policies alone would never allow.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"25000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state, acknowledged_at, ack_method) values
    ('25000000-0000-0000-0000-00000000009a', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e2', 'acknowledged', now(), 'manager_override');
exception
  when insufficient_privilege then
    raise exception 'CM01 FAIL: a communications.publish holder was denied a manager_override acknowledgement for another employee';
end;
$$;

do $$
begin
  insert into message_receipts (id, facility_id, message_id, employee_id, delivered_at) values
    ('25000000-0000-0000-0000-000000000095', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f1', '25000000-0000-0000-0000-0000000000e2', now());
exception
  when insufficient_privilege then
    raise exception 'CM01 FAIL: a communications.publish holder was denied recording another employee''s receipt';
end;
$$;

-- Denied even for a publisher: still facility-consistent with the message.
do $$
begin
  begin
    insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state) values
      ('25000000-0000-0000-0000-00000000009b', '25aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '25000000-0000-0000-0000-0000000000f2', '25000000-0000-0000-0000-0000000000e2', 'acknowledged');
    raise exception 'CM01 FAIL: a publisher inserted an acknowledgement whose facility_id does not match its message''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it even for publishers
  end;
end;
$$;

reset role;

rollback;
