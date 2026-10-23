-- Proof for WO-11/0059: the assets registry schema extension (category,
-- criticality, metadata, install_date, warranty_expires_at) sits behind the
-- SAME RLS boundary supabase/tests/work_orders_scope.sql already proves for
-- `assets`, and the new columns/index do not weaken it.
--
-- Covers:
--   1. A work_orders.read holder can SELECT an asset, including every new
--      registry column (0059's whole point -- these columns must actually
--      be readable, not just insertable).
--   2. A work_orders.manage holder can INSERT an asset carrying every new
--      column, and its own facility's `criticality` check constraint
--      accepts a valid value.
--   3. A work_orders.read holder (no work_orders.manage) CANNOT INSERT an
--      asset -- same read/manage split work_orders_scope.sql proves for
--      `assets` already, re-proven here with the new columns present in
--      the attempted row.
--   4. `criticality`'s check constraint rejects a value outside
--      low/medium/high/critical.
--   5. `unique (facility_id, asset_tag)` (0005, unchanged by 0059): a
--      second asset in the SAME facility with the SAME tag is rejected
--      (unique_violation); the SAME tag in a DIFFERENT facility is not a
--      conflict (the constraint is scoped to (facility_id, asset_tag), not
--      asset_tag alone).
--   6. Cross-facility protection for `work_orders.asset_id`, re-proven in
--      this migration's own fixture set: a Facility A work_orders.manage
--      holder cannot attach a Facility B asset (new-columns-bearing) to a
--      Facility A work order. 0059's header comment claims this is
--      enforced by 0013_audit_chain.sql's fn_assert_same_facility inside
--      the "work order managers can manage work orders" policy's WITH
--      CHECK clause -- NOT a BEFORE INSERT/UPDATE trigger the way 0035's
--      work_order_updates/work_order_attachments guard is. This test
--      empirically confirms which mechanism actually fires: querying
--      pg_trigger for any trigger on `work_orders` naming `asset_id` or
--      `fn_assert_same_facility` in its function body finds NONE (proving
--      0059's "not a trigger" claim), while the cross-facility INSERT
--      below is rejected with insufficient_privilege (an RLS/WITH CHECK
--      failure, sqlstate 42501) rather than check_violation (23514, what a
--      trigger-raised rejection would use) -- confirming the WITH CHECK
--      path, not a trigger, is what blocks it.
--
-- Runs inside begin/rollback so fixtures never persist.
begin;

insert into auth.users (id, email) values
  ('a9111111-1111-1111-1111-111111111111', 'assets-manager@test'),
  ('a9222222-2222-2222-2222-222222222222', 'assets-reader@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('a9111111-1111-1111-1111-111111111111', 'Assets Manager', 'assets-manager@test'),
  ('a9222222-2222-2222-2222-222222222222', 'Assets Reader', 'assets-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('a9000000-0000-0000-0000-0000000000b0', 'Assets Registry Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('a9000000-0000-0000-0000-0000000000c0', 'a9000000-0000-0000-0000-0000000000b0', 'Assets Facility A'),
  ('a9000000-0000-0000-0000-0000000000c1', 'a9000000-0000-0000-0000-0000000000b0', 'Assets Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('a9000000-0000-0000-0000-0000000000d0', 'a9000000-0000-0000-0000-0000000000c0', 'Assets Manager Role'),
  ('a9000000-0000-0000-0000-0000000000d1', 'a9000000-0000-0000-0000-0000000000c0', 'Assets Reader Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('a9000000-0000-0000-0000-0000000000d0', 'work_orders.manage'),
  ('a9000000-0000-0000-0000-0000000000d1', 'work_orders.read')
on conflict do nothing;

-- Both users are members of Facility A ONLY -- neither has any membership in
-- Facility B, matching work_orders_scope.sql's own fixture shape.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('a9000000-0000-0000-0000-0000000000e0', 'a9111111-1111-1111-1111-111111111111', 'a9000000-0000-0000-0000-0000000000c0', 'a9000000-0000-0000-0000-0000000000d0', 'active'),
  ('a9000000-0000-0000-0000-0000000000e1', 'a9222222-2222-2222-2222-222222222222', 'a9000000-0000-0000-0000-0000000000c0', 'a9000000-0000-0000-0000-0000000000d1', 'active')
on conflict (id) do nothing;

-- One asset per facility, seeded as superuser (RLS bypassed for fixture
-- setup, matching every other supabase/tests/*.sql file), carrying every
-- 0059 column so point 1's SELECT has something non-null to prove readable.
insert into assets (
  id, facility_id, name, asset_tag, status, category, criticality, metadata, install_date, warranty_expires_at
) values
  (
    'a9300000-0000-0000-0000-0000000000a1', 'a9000000-0000-0000-0000-0000000000c0', 'Pool Pump A', 'AR-PUMP-1',
    'active', 'mechanical', 'high', '{"manufacturer": "Acme"}'::jsonb, '2024-01-15', '2027-01-15'
  ),
  (
    'a9300000-0000-0000-0000-0000000000b1', 'a9000000-0000-0000-0000-0000000000c1', 'Pool Pump B', 'AR-PUMP-1',
    'active', 'mechanical', 'critical', '{}'::jsonb, null, null
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. work_orders.read holder can SELECT an asset, new columns included.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"a9222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  row_category text;
  row_criticality text;
  row_metadata jsonb;
  row_install_date date;
  row_warranty date;
begin
  select category, criticality, metadata, install_date, warranty_expires_at
    into row_category, row_criticality, row_metadata, row_install_date, row_warranty
    from assets where id = 'a9300000-0000-0000-0000-0000000000a1';

  if row_category is distinct from 'mechanical' then
    raise exception 'ASSETS REGISTRY FAIL: work_orders.read holder could not read category (got %)', row_category;
  end if;
  if row_criticality is distinct from 'high' then
    raise exception 'ASSETS REGISTRY FAIL: work_orders.read holder could not read criticality (got %)', row_criticality;
  end if;
  if row_metadata is distinct from '{"manufacturer": "Acme"}'::jsonb then
    raise exception 'ASSETS REGISTRY FAIL: work_orders.read holder could not read metadata (got %)', row_metadata;
  end if;
  if row_install_date is distinct from '2024-01-15'::date then
    raise exception 'ASSETS REGISTRY FAIL: work_orders.read holder could not read install_date (got %)', row_install_date;
  end if;
  if row_warranty is distinct from '2027-01-15'::date then
    raise exception 'ASSETS REGISTRY FAIL: work_orders.read holder could not read warranty_expires_at (got %)', row_warranty;
  end if;
end;
$$;

-- 3. work_orders.read holder (no manage) CANNOT insert an asset, even one
-- carrying every new column.
do $$
begin
  begin
    insert into assets (facility_id, name, asset_tag, category, criticality, metadata)
    values ('a9000000-0000-0000-0000-0000000000c0', 'Reader insert attempt', 'AR-READER-1', 'mechanical', 'low', '{}'::jsonb);
    raise exception 'ASSETS REGISTRY FAIL: a work_orders.read holder inserted an asset';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. work_orders.manage holder can INSERT an asset with every new column.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"a9111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  new_id uuid;
begin
  insert into assets (facility_id, name, asset_tag, category, criticality, metadata, install_date, warranty_expires_at)
  values (
    'a9000000-0000-0000-0000-0000000000c0', 'Filtration Pump', 'AR-PUMP-2', 'mechanical', 'critical',
    '{"manufacturer": "Zodiac"}'::jsonb, '2025-06-01', '2028-06-01'
  )
  returning id into new_id;
  if new_id is null then
    raise exception 'ASSETS REGISTRY FAIL: a work_orders.manage holder could not insert an asset with the new columns';
  end if;
end;
$$;

-- 4. criticality's check constraint rejects an out-of-enum value (a plain
-- Postgres check_violation, independent of RLS -- this must fail for the
-- authenticated manager exactly the same way it would for any role).
do $$
begin
  begin
    insert into assets (facility_id, name, criticality)
    values ('a9000000-0000-0000-0000-0000000000c0', 'Bad criticality asset', 'extreme');
    raise exception 'ASSETS REGISTRY FAIL: an asset with an out-of-enum criticality was inserted';
  exception
    when check_violation then null; -- expected
  end;
end;
$$;

-- 5. unique (facility_id, asset_tag): a second asset in the SAME facility
-- with the SAME tag is rejected.
do $$
begin
  begin
    insert into assets (facility_id, name, asset_tag)
    values ('a9000000-0000-0000-0000-0000000000c0', 'Duplicate tag asset', 'AR-PUMP-1');
    raise exception 'ASSETS REGISTRY FAIL: a duplicate (facility_id, asset_tag) asset was inserted';
  exception
    when unique_violation then null; -- expected
  end;
end;
$$;

reset role;

-- 5b. The SAME tag in a DIFFERENT facility is NOT a conflict -- the
-- constraint is scoped to (facility_id, asset_tag), proven by the two
-- fixture rows above (both tagged 'AR-PUMP-1', in Facility A and Facility B
-- respectively) having been seeded without error before this test even
-- began. Re-affirmed here with a THIRD facility, seeded as superuser
-- (matching every other fixture-setup insert in this file -- facility C has
-- no membership/role for either fixture user, so this is not testing
-- facility C's own RLS, only the unique constraint's scope).
insert into facilities (id, organization_id, name) values
  ('a9000000-0000-0000-0000-0000000000c2', 'a9000000-0000-0000-0000-0000000000b0', 'Assets Facility C')
on conflict (id) do nothing;
do $$
begin
  insert into assets (facility_id, name, asset_tag) values
    ('a9000000-0000-0000-0000-0000000000c2', 'Facility C pump reusing the tag', 'AR-PUMP-1');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Cross-facility protection for work_orders.asset_id, mechanism check.
-- ---------------------------------------------------------------------------

-- 6a. Confirm the guard is NOT a trigger on work_orders (0059's header
-- comment claim) -- no trigger on work_orders references asset_id or
-- fn_assert_same_facility in its action statement.
do $$
declare
  trigger_count int;
begin
  select count(*) into trigger_count
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'work_orders'
     and not t.tgisinternal
     and (pg_get_triggerdef(t.oid) ilike '%asset_id%' or pg_get_triggerdef(t.oid) ilike '%fn_assert_same_facility%');
  if trigger_count <> 0 then
    raise exception 'ASSETS REGISTRY FAIL: expected NO trigger guarding work_orders.asset_id (0059 claims this is a WITH CHECK, not a trigger) but found %', trigger_count;
  end if;
end;
$$;

-- 6b. The cross-facility INSERT itself: Facility A manager attaches the
-- Facility B asset fixture to a Facility A work order. Expected to fail
-- with insufficient_privilege (42501, an RLS/WITH CHECK rejection) --
-- explicitly NOT check_violation (23514), which would indicate a trigger
-- fired instead.
select set_config('request.jwt.claims', '{"sub":"a9111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into work_orders (facility_id, asset_id, title, description)
    values ('a9000000-0000-0000-0000-0000000000c0', 'a9300000-0000-0000-0000-0000000000b1', 'Cross-tenant asset injection', 'should be blocked');
    raise exception 'ASSETS REGISTRY FAIL: a Facility A manager attached a Facility B asset to a Facility A work order';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility's WITH CHECK blocked it
    when others then
      raise exception 'ASSETS REGISTRY FAIL: cross-facility asset attach failed with unexpected sqlstate % (%), expected 42501 insufficient_privilege', sqlstate, sqlerrm;
  end;
end;
$$;
reset role;

rollback;
