-- Verification intent: the Phase 7 certification policy (0017) and
-- entitlements/billing (0018) RLS gates hold.
--   * certification_role_requirements / certification_policies writes require
--     training.manage on the row's facility;
--   * a requirement whose role_id (or certification_type_id) lives in another
--     facility is blocked by the join-based fn_assert_same_facility WITH CHECK;
--   * tenant_subscriptions has NO client write policy: an authenticated insert
--     (even by an org admin) is denied -- billing state is service-role only.
-- Runs against a migrated database inside a rolled-back transaction. RLS denials
-- surface as insufficient_privilege (SQLSTATE 42501).
begin;

insert into auth.users (id, email) values
  ('99999999-9999-9999-9999-999999999999', 'cert-admin@p7.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('99999999-9999-9999-9999-999999999999', 'Cert Admin', 'cert-admin@p7.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('91111111-1111-1111-1111-111111111111', 'Org P7C A'),
  ('92222222-2222-2222-2222-222222222222', 'Org P7C B')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '91111111-1111-1111-1111-111111111111', 'P7C Facility A'),
  ('9bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '92222222-2222-2222-2222-222222222222', 'P7C Facility B')
on conflict (id) do nothing;

-- Admin A holds training.manage + admin.manage in Facility A only (admin.manage
-- makes them an org admin of Org A via is_organization_admin).
insert into roles (id, facility_id, name) values
  ('9c000000-0000-0000-0000-0000000000c1', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'P7C Admin Role A'),
  ('9c000000-0000-0000-0000-0000000000c2', '9bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'P7C Role B')
on conflict (id) do nothing;

insert into role_permissions (role_id, permission_code) values
  ('9c000000-0000-0000-0000-0000000000c1', 'training.manage'),
  ('9c000000-0000-0000-0000-0000000000c1', 'admin.manage')
on conflict do nothing;

insert into memberships (id, user_id, facility_id, role_id, status) values
  ('9d000000-0000-0000-0000-0000000000d1', '99999999-9999-9999-9999-999999999999', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '9c000000-0000-0000-0000-0000000000c1', 'active')
on conflict (id) do nothing;

-- Certification types: one in each facility (seeded as owner, bypassing RLS).
insert into certification_types (id, facility_id, code, name) values
  ('9e000000-0000-0000-0000-0000000000e1', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cpr_a', 'CPR (A)'),
  ('9e000000-0000-0000-0000-0000000000e2', '9bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cpr_b', 'CPR (B)')
on conflict (id) do nothing;

-- A plan so tenant_subscriptions has something to reference.
insert into subscription_plans (id, code, name, base_price_cents, billing_period, feature_entitlements_jsonb) values
  ('9f000000-0000-0000-0000-0000000000f1', 'p7c_enterprise', 'P7C Enterprise', 100000, 'monthly', '{"cert_policies":true}'::jsonb)
on conflict (id) do nothing;

-- A feature flag in the global catalog (seeded as owner; the catalog is
-- read-all with no client write policy).
insert into feature_flags (id, key, description, rollout_type, default_state) values
  ('9b000000-0000-0000-0000-0000000000b1', 'p7c.flag', 'P7C test flag', 'boolean', false)
on conflict (id) do nothing;

-- Act as Admin A.
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
set local role authenticated;

-- Allowed: create a role requirement entirely within Facility A.
do $$
begin
  insert into certification_role_requirements (id, facility_id, certification_type_id, role_id, enforcement_mode) values
    ('9a100000-0000-0000-0000-000000000001', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '9e000000-0000-0000-0000-0000000000e1', '9c000000-0000-0000-0000-0000000000c1', 'hard-block');
exception
  when insufficient_privilege then
    raise exception 'P7C FAIL: training manager was denied a same-facility cert requirement';
end;
$$;

-- Allowed: create a certification policy in Facility A.
do $$
begin
  insert into certification_policies (id, facility_id, trigger_type, cadence_rule_jsonb) values
    ('9a200000-0000-0000-0000-000000000001', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'expiry', '{"daysBefore":[30,7]}'::jsonb);
exception
  when insufficient_privilege then
    raise exception 'P7C FAIL: training manager was denied a certification policy in own facility';
end;
$$;

-- Denied: create a requirement in foreign Facility B (no training.manage there).
do $$
begin
  begin
    insert into certification_role_requirements (id, facility_id, certification_type_id, role_id) values
      ('9a100000-0000-0000-0000-000000000002', '9bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '9e000000-0000-0000-0000-0000000000e2', '9c000000-0000-0000-0000-0000000000c2');
    raise exception 'P7C FAIL: a cert requirement was created in a foreign facility';
  exception
    when insufficient_privilege then null; -- expected: no training.manage on B
  end;
end;
$$;

-- Denied: requirement in Facility A whose role_id lives in Facility B.
-- has_permission(A) passes, but fn_assert_same_facility(A,'roles',roleB) fails.
do $$
begin
  begin
    insert into certification_role_requirements (id, facility_id, certification_type_id, role_id) values
      ('9a100000-0000-0000-0000-000000000003', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '9e000000-0000-0000-0000-0000000000e1', '9c000000-0000-0000-0000-0000000000c2');
    raise exception 'P7C FAIL: a cross-facility requirement (foreign role) was allowed';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

-- Denied: requirement in Facility A whose certification_type_id lives in Facility B.
do $$
begin
  begin
    insert into certification_role_requirements (id, facility_id, certification_type_id, role_id) values
      ('9a100000-0000-0000-0000-000000000004', '9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '9e000000-0000-0000-0000-0000000000e2', '9c000000-0000-0000-0000-0000000000c1');
    raise exception 'P7C FAIL: a cross-facility requirement (foreign cert type) was allowed';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked it
  end;
end;
$$;

-- Denied: even an org admin cannot INSERT a tenant_subscriptions row -- there is
-- no client write policy (billing is service-role / webhook only).
do $$
begin
  begin
    insert into tenant_subscriptions (id, organization_id, plan_id, status) values
      ('9a300000-0000-0000-0000-000000000001', '91111111-1111-1111-1111-111111111111', '9f000000-0000-0000-0000-0000000000f1', 'active');
    raise exception 'P7C FAIL: an authenticated user wrote a tenant_subscriptions row';
  exception
    when insufficient_privilege then null; -- expected: no client write policy
  end;
end;
$$;

-- Allowed: an org admin may create an organization-scoped feature flag rule.
do $$
begin
  insert into feature_flag_rules (id, feature_flag_id, scope_type, scope_id, state) values
    ('9b100000-0000-0000-0000-000000000001', '9b000000-0000-0000-0000-0000000000b1', 'organization', '91111111-1111-1111-1111-111111111111', true);
exception
  when insufficient_privilege then
    raise exception 'P7C FAIL: org admin was denied an org-scoped feature flag rule';
end;
$$;

-- Denied: an org-scoped rule for a DIFFERENT organization (not an admin there).
do $$
begin
  begin
    insert into feature_flag_rules (id, feature_flag_id, scope_type, scope_id, state) values
      ('9b100000-0000-0000-0000-000000000002', '9b000000-0000-0000-0000-0000000000b1', 'organization', '92222222-2222-2222-2222-222222222222', true);
    raise exception 'P7C FAIL: a feature flag rule was created for a foreign organization';
  exception
    when insufficient_privilege then null; -- expected: not an org admin of Org B
  end;
end;
$$;

reset role;
rollback;
