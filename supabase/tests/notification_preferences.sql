-- Verification intent: CM-07 (plans/COMMUNICATIONS_PLAN.md) self-service RLS
-- on employee_device_tokens/employee_notification_preferences (0037). An
-- authenticated employee may insert/update ONLY their own
-- (employees.user_id = auth.uid()) device-token/preferences row -- with NO
-- additional communications.read permission gate, unlike
-- message_receipts/message_acknowledgements (0025) -- and only when
-- facility_id matches the referenced employee's actual facility
-- (fn_assert_same_facility against employees). communications.publish
-- holders additionally get manage-level write onto any employee's row (e.g.
-- revoking a departed employee's stale token). Runs against a migrated
-- database inside a rolled-back transaction, so no fixture persists. RLS
-- denials surface as insufficient_privilege (SQLSTATE 42501).
begin;

-- Two organizations/facilities so the cross-facility case is a real foreign
-- tenant, not just a second row in the same tenant.
insert into auth.users (id, email) values
  ('37000000-0000-0000-0000-0000000000a1', 'cm07-alice@test'),
  ('37000000-0000-0000-0000-0000000000a2', 'cm07-bob@test'),
  ('37000000-0000-0000-0000-0000000000a3', 'cm07-carol@test'),
  ('37000000-0000-0000-0000-0000000000a4', 'cm07-dana@test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('37000000-0000-0000-0000-0000000000a1', 'Alice Reader', 'cm07-alice@test'),
  ('37000000-0000-0000-0000-0000000000a2', 'Bob Reader', 'cm07-bob@test'),
  ('37000000-0000-0000-0000-0000000000a3', 'Carol NoComms', 'cm07-carol@test'),
  ('37000000-0000-0000-0000-0000000000a4', 'Dana Publisher', 'cm07-dana@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('37111111-1111-1111-1111-111111111111', 'CM07 Org A'),
  ('37222222-2222-2222-2222-222222222222', 'CM07 Org B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37111111-1111-1111-1111-111111111111', 'CM07 Facility A'),
  ('37bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '37222222-2222-2222-2222-222222222222', 'CM07 Facility B')
on conflict (id) do nothing;

-- Roles: reader (communications.read only, NOT publish), no-comms (unrelated
-- permission -- deliberately used to prove self-service needs no
-- communications.read at all here, unlike message_receipts/acks), publisher
-- (communications.read + communications.publish). All in Facility A.
insert into roles (id, facility_id, name) values
  ('37000000-0000-0000-0000-0000000000d1', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CM07 Reader'),
  ('37000000-0000-0000-0000-0000000000d2', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CM07 No Comms'),
  ('37000000-0000-0000-0000-0000000000d3', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CM07 Publisher')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('37000000-0000-0000-0000-0000000000d1', 'communications.read'),
  ('37000000-0000-0000-0000-0000000000d2', 'reports.read'),
  ('37000000-0000-0000-0000-0000000000d3', 'communications.read'),
  ('37000000-0000-0000-0000-0000000000d3', 'communications.publish')
on conflict do nothing;

-- Alice, Bob, Carol, Dana are memberships of Facility A; Eve is a Facility B
-- employee with no Facility A membership at all, used for the
-- cross-facility case.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('37000000-0000-0000-0000-0000000000b1', '37000000-0000-0000-0000-0000000000a1', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000d1', 'active'),
  ('37000000-0000-0000-0000-0000000000b2', '37000000-0000-0000-0000-0000000000a2', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000d1', 'active'),
  ('37000000-0000-0000-0000-0000000000b3', '37000000-0000-0000-0000-0000000000a3', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000d2', 'active'),
  ('37000000-0000-0000-0000-0000000000b4', '37000000-0000-0000-0000-0000000000a4', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000d3', 'active')
on conflict (id) do nothing;

-- Employee rows (id deliberately distinct from the owning user's id, exactly
-- like production -- employees.id is its own PK, not the auth user id).
-- 'e5' is a Facility B employee (no owning user needed -- it only exists so
-- fn_assert_same_facility has a real cross-facility parent row to catch).
insert into employees (id, facility_id, user_id, first_name, last_name) values
  ('37000000-0000-0000-0000-0000000000e1', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000a1', 'Alice', 'Reader'),
  ('37000000-0000-0000-0000-0000000000e2', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000a2', 'Bob', 'Reader'),
  ('37000000-0000-0000-0000-0000000000e3', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000a3', 'Carol', 'NoComms'),
  ('37000000-0000-0000-0000-0000000000e4', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000a4', 'Dana', 'Publisher'),
  ('37000000-0000-0000-0000-0000000000e5', '37bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null, 'Eve', 'FacilityB')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Act as Alice (communications.read on Facility A, no communications.publish).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"37000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

-- Allowed: Alice registers her own device token.
do $$
begin
  insert into employee_device_tokens (id, facility_id, employee_id, platform, token) values
    ('37000000-0000-0000-0000-000000000091', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e1', 'ios', 'cm07-token-alice-1');
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: Alice was denied inserting her own device token';
end;
$$;

-- Allowed: Alice refreshes it (self-update).
do $$
begin
  update employee_device_tokens set last_seen_at = now()
  where id = '37000000-0000-0000-0000-000000000091';
  if not exists (select 1 from employee_device_tokens where id = '37000000-0000-0000-0000-000000000091' and last_seen_at is not null) then
    raise exception 'CM07 FAIL: Alice''s own-token update did not apply';
  end if;
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: Alice was denied updating her own device token';
end;
$$;

-- Allowed: Alice writes her own notification preferences.
do $$
begin
  insert into employee_notification_preferences (id, facility_id, employee_id, push_enabled, quiet_hours_start, quiet_hours_end) values
    ('37000000-0000-0000-0000-000000000096', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e1', false, '20:00', '07:00');
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: Alice was denied inserting her own notification preferences';
end;
$$;

-- Denied: Alice cannot insert a device token owned by Bob.
do $$
begin
  begin
    insert into employee_device_tokens (id, facility_id, employee_id, platform, token) values
      ('37000000-0000-0000-0000-000000000092', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e2', 'ios', 'cm07-token-bob-1');
    raise exception 'CM07 FAIL: Alice inserted a device token owned by another employee (Bob)';
  exception
    when insufficient_privilege then null; -- expected: employee_id does not map to Alice's user_id
  end;
end;
$$;

-- Denied: Alice cannot insert notification preferences owned by Bob.
do $$
begin
  begin
    insert into employee_notification_preferences (id, facility_id, employee_id) values
      ('37000000-0000-0000-0000-000000000097', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e2');
    raise exception 'CM07 FAIL: Alice inserted notification preferences owned by another employee (Bob)';
  exception
    when insufficient_privilege then null; -- expected: employee_id does not map to Alice's user_id
  end;
end;
$$;

-- Denied: cross-facility insert. facility_id = A, but employee_id (Eve)
-- actually belongs to Facility B -- fn_assert_same_facility must catch this
-- even though "employee_id belongs to nobody I am" alone would not (Eve has
-- no owning user_id, so the ownership EXISTS clause would already fail on
-- its own; this variant proves the facility check is a real, independent
-- gate by using Alice's OWN employee id but a mismatched facility_id).
do $$
begin
  begin
    insert into employee_device_tokens (id, facility_id, employee_id, platform, token) values
      ('37000000-0000-0000-0000-000000000093', '37bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '37000000-0000-0000-0000-0000000000e1', 'ios', 'cm07-token-cross-facility');
    raise exception 'CM07 FAIL: a device token was inserted whose facility_id does not match its employee''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

do $$
begin
  begin
    insert into employee_notification_preferences (id, facility_id, employee_id) values
      ('37000000-0000-0000-0000-000000000098', '37bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '37000000-0000-0000-0000-0000000000e1');
    raise exception 'CM07 FAIL: notification preferences were inserted whose facility_id does not match the employee''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Act as Carol (member of Facility A, role has NO communications.read at
-- all). Unlike message_receipts/message_acknowledgements (0025), the
-- self-service device-token/preferences policies carry no has_permission
-- gate -- ownership + facility consistency is the whole check -- so Carol's
-- own-row write must still succeed.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"37000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  insert into employee_device_tokens (id, facility_id, employee_id, platform, token) values
    ('37000000-0000-0000-0000-000000000094', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e3', 'android', 'cm07-token-carol-1');
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: Carol (no communications.read) was denied inserting her own device token';
end;
$$;

do $$
begin
  insert into employee_notification_preferences (id, facility_id, employee_id, push_enabled) values
    ('37000000-0000-0000-0000-000000000099', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e3', true);
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: Carol (no communications.read) was denied inserting her own notification preferences';
end;
$$;

-- Still denied for Carol: another employee's row, even her own facility.
do $$
begin
  begin
    insert into employee_device_tokens (id, facility_id, employee_id, platform, token) values
      ('37000000-0000-0000-0000-00000000009a', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e1', 'ios', 'cm07-token-carol-tries-alice');
    raise exception 'CM07 FAIL: Carol inserted a device token owned by another employee (Alice)';
  exception
    when insufficient_privilege then null; -- expected: employee_id does not map to Carol's user_id
  end;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Act as Dana (communications.publish). A publisher may manage ANOTHER
-- employee's device token/preferences (e.g. revoking a departed employee's
-- stale token), which the self-service policies alone would never allow --
-- but still not across facilities.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"37000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  update employee_device_tokens set revoked_at = now()
  where id = '37000000-0000-0000-0000-000000000091'; -- Alice's token
  if not exists (select 1 from employee_device_tokens where id = '37000000-0000-0000-0000-000000000091' and revoked_at is not null) then
    raise exception 'CM07 FAIL: a communications.publish holder''s revoke of another employee''s token did not apply';
  end if;
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: a communications.publish holder was denied revoking another employee''s device token';
end;
$$;

do $$
begin
  insert into employee_notification_preferences (id, facility_id, employee_id, push_enabled) values
    ('37000000-0000-0000-0000-00000000009b', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e2', false);
exception
  when insufficient_privilege then
    raise exception 'CM07 FAIL: a communications.publish holder was denied setting another employee''s notification preferences';
end;
$$;

-- Denied even for a publisher: still facility-consistent with the employee.
do $$
begin
  begin
    insert into employee_device_tokens (id, facility_id, employee_id, platform, token) values
      ('37000000-0000-0000-0000-00000000009c', '37aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '37000000-0000-0000-0000-0000000000e5', 'ios', 'cm07-token-publisher-cross-facility');
    raise exception 'CM07 FAIL: a publisher inserted a device token whose facility_id does not match its employee''s facility';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it even for publishers
  end;
end;
$$;

reset role;

rollback;
