-- Verification intent: the Phase 7 forms (0015) and notifications (0016) RLS
-- gates hold. Writes to custom_fields / form_definitions require
-- reports.template.manage on the row's facility; form_field_bindings and
-- distribution_list_members additionally require facility consistency with
-- their parent (fn_assert_same_facility join-based WITH CHECK); notification
-- routes and distribution lists require communications.publish. Runs against a
-- migrated database inside a rolled-back transaction, so no fixture persists.
-- RLS denials surface as insufficient_privilege (SQLSTATE 42501).
begin;

insert into auth.users (id, email) values
  ('88888888-8888-8888-8888-888888888888', 'forms-admin@p7.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('88888888-8888-8888-8888-888888888888', 'Forms Admin', 'forms-admin@p7.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('81111111-1111-1111-1111-111111111111', 'Org P7 A'),
  ('82222222-2222-2222-2222-222222222222', 'Org P7 B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '81111111-1111-1111-1111-111111111111', 'P7 Facility A'),
  ('8bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '82222222-2222-2222-2222-222222222222', 'P7 Facility B')
on conflict (id) do nothing;

-- Admin A holds reports.template.manage + communications.publish in Facility A only.
insert into roles (id, facility_id, name) values
  ('8c000000-0000-0000-0000-0000000000c1', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'P7 Admin Role A')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('8c000000-0000-0000-0000-0000000000c1', 'reports.template.manage'),
  ('8c000000-0000-0000-0000-0000000000c1', 'communications.publish')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('8d000000-0000-0000-0000-0000000000d1', '88888888-8888-8888-8888-888888888888', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '8c000000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- Seed (as owner, bypassing RLS) a form_definition and a distribution list that
-- live in the FOREIGN Facility B, to prove cross-facility binding is blocked.
insert into form_definitions (id, facility_id, module_code, form_code, version_no, status, schema_jsonb) values
  ('8e000000-0000-0000-0000-0000000000e2', '8bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'daily_reports', 'b_form', 1, 'draft', '{}'::jsonb)
on conflict (id) do nothing;

insert into distribution_lists (id, facility_id, name) values
  ('8f000000-0000-0000-0000-0000000000f2', '8bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B List')
on conflict (id) do nothing;

-- A known notification event so notification_routes' FK resolves.
insert into notification_events (id, code, severity, module_code, default_channels_jsonb) values
  ('8a000000-0000-0000-0000-0000000000a1', 'p7.test_event', 'info', 'daily_reports', '["in_app"]'::jsonb)
on conflict (code) do nothing;

-- Act as Admin A.
select set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888888","role":"authenticated"}', true);
set local role authenticated;

-- Allowed: create a custom field in own Facility A.
do $$
begin
  insert into custom_fields (id, facility_id, entity_type, key, label, data_type) values
    ('8c100000-0000-0000-0000-000000000001', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'report', 'pool_ready', 'Pool ready', 'select');
exception
  when insufficient_privilege then
    raise exception 'P7 FAIL: template manager was denied creating a custom field in own facility';
end;
$$;

-- Denied: create a custom field in foreign Facility B (no perms there).
do $$
begin
  begin
    insert into custom_fields (id, facility_id, entity_type, key, label, data_type) values
      ('8c100000-0000-0000-0000-000000000002', '8bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'report', 'x_key', 'X', 'text');
    raise exception 'P7 FAIL: custom field was created in a foreign facility';
  exception
    when insufficient_privilege then null; -- expected: RLS blocked the write
  end;
end;
$$;

-- Allowed: create a form definition in own Facility A.
do $$
begin
  insert into form_definitions (id, facility_id, module_code, form_code, version_no, status, schema_jsonb) values
    ('8e000000-0000-0000-0000-0000000000e1', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'daily_reports', 'a_form', 1, 'draft', '{}'::jsonb);
exception
  when insufficient_privilege then
    raise exception 'P7 FAIL: template manager was denied creating a form definition in own facility';
end;
$$;

-- Allowed: bind a field to the SAME-facility form definition.
do $$
begin
  insert into form_field_bindings (id, facility_id, form_definition_id, field_key, display_order) values
    ('8e100000-0000-0000-0000-000000000001', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '8e000000-0000-0000-0000-0000000000e1', 'pool_ready', 0);
exception
  when insufficient_privilege then
    raise exception 'P7 FAIL: template manager was denied a same-facility field binding';
end;
$$;

-- Denied: bind a field whose facility (A) does not match its parent form
-- definition's facility (B). has_permission(A) passes, but the join-based
-- fn_assert_same_facility WITH CHECK fails.
do $$
begin
  begin
    insert into form_field_bindings (id, facility_id, form_definition_id, field_key, display_order) values
      ('8e100000-0000-0000-0000-000000000002', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '8e000000-0000-0000-0000-0000000000e2', 'pool_ready', 0);
    raise exception 'P7 FAIL: a cross-facility form field binding was allowed';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

-- Allowed: create a notification route in own Facility A (communications.publish).
do $$
begin
  insert into notification_routes (id, facility_id, event_code, priority, route_jsonb) values
    ('8a100000-0000-0000-0000-000000000001', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'p7.test_event', 10, '{"channels":["in_app"]}'::jsonb);
exception
  when insufficient_privilege then
    raise exception 'P7 FAIL: publisher was denied creating a notification route in own facility';
end;
$$;

-- Denied: create a notification route in foreign Facility B.
do $$
begin
  begin
    insert into notification_routes (id, facility_id, event_code, priority, route_jsonb) values
      ('8a100000-0000-0000-0000-000000000002', '8bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'p7.test_event', 10, '{}'::jsonb);
    raise exception 'P7 FAIL: a notification route was created in a foreign facility';
  exception
    when insufficient_privilege then null; -- expected: no communications.publish on B
  end;
end;
$$;

-- Denied: add a distribution list member whose facility (A) does not match its
-- parent list's facility (B) -- the fn_assert_same_facility WITH CHECK blocks it.
do $$
begin
  begin
    insert into distribution_list_members (id, facility_id, distribution_list_id, member_type, member_ref_id) values
      ('8f100000-0000-0000-0000-000000000001', '8aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '8f000000-0000-0000-0000-0000000000f2', 'employee', '8f900000-0000-0000-0000-000000000099');
    raise exception 'P7 FAIL: a cross-facility distribution list member was allowed';
  exception
    when insufficient_privilege then null; -- expected: parent list is in facility B
  end;
end;
$$;

reset role;
rollback;
