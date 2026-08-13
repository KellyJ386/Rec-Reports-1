-- Proof for WO-07/WO-08: RLS on the work-orders family (assets, work_orders,
-- work_order_updates, work_order_attachments).
--
-- Covers:
--   1. Cross-facility isolation on all four tables (a work_orders.manage
--      holder scoped to Facility A sees zero Facility B rows, and cannot
--      write into Facility B).
--   2. A work_orders.read holder cannot INSERT or UPDATE (the "for all"
--      manage policy is the only write-capable policy; a reader fails its
--      USING/WITH CHECK and the write is a silent no-op or a raised
--      insufficient_privilege, per Postgres RLS semantics for the command).
--   3. 0026 regression: a work_orders.manage holder cannot SELECT, nor
--      UPDATE, an already soft-deleted work order (the leak this migration
--      closes).
--   4. 0026 semantics check: a work_orders.manage holder CANNOT use a plain
--      client UPDATE to soft-delete a LIVE row (UPDATE ... SET deleted_at =
--      now()) either. This is intentional, not a regression: Postgres
--      requires the resulting row to remain visible under the actor's own
--      SELECT-applicable policy, and that policy (this migration's whole
--      point) now excludes deleted_at IS NOT NULL rows, so Postgres itself
--      refuses the write with insufficient_privilege -- independent of the
--      UPDATE policy's own WITH CHECK. See the 0026 migration header for the
--      full derivation. Nothing in the app performs this write today.
--   5. 0013 regression: the cross-tenant FK guard on work_orders.asset_id
--      (fn_assert_same_facility) still blocks pointing a Facility A work
--      order at a Facility B asset, after 0026 touched the same policy's
--      USING clause.
--
-- Runs inside begin/rollback so fixtures never persist.
begin;

insert into auth.users (id, email) values
  ('f1111111-1111-1111-1111-111111111111', 'wo-manager@test'),
  ('f2222222-2222-2222-2222-222222222222', 'wo-reader@test')
on conflict (id) do nothing;
insert into app_users (id, full_name, email) values
  ('f1111111-1111-1111-1111-111111111111', 'WO Manager', 'wo-manager@test'),
  ('f2222222-2222-2222-2222-222222222222', 'WO Reader', 'wo-reader@test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('f0000000-0000-0000-0000-0000000000b0', 'WO Scope Org')
on conflict (id) do nothing;
insert into facilities (id, organization_id, name) values
  ('f0000000-0000-0000-0000-0000000000c0', 'f0000000-0000-0000-0000-0000000000b0', 'WO Facility A'),
  ('f0000000-0000-0000-0000-0000000000c1', 'f0000000-0000-0000-0000-0000000000b0', 'WO Facility B')
on conflict (id) do nothing;

insert into roles (id, facility_id, name) values
  ('f0000000-0000-0000-0000-0000000000d0', 'f0000000-0000-0000-0000-0000000000c0', 'WO Manager Role'),
  ('f0000000-0000-0000-0000-0000000000d1', 'f0000000-0000-0000-0000-0000000000c0', 'WO Reader Role')
on conflict (id) do nothing;
insert into role_permissions (role_id, permission_code) values
  ('f0000000-0000-0000-0000-0000000000d0', 'work_orders.manage'),
  ('f0000000-0000-0000-0000-0000000000d1', 'work_orders.read')
on conflict do nothing;

-- Both users are members of Facility A ONLY -- neither has any membership in
-- Facility B, so every Facility B check below is a pure isolation check.
insert into memberships (id, user_id, facility_id, role_id, status) values
  ('f0000000-0000-0000-0000-0000000000e0', 'f1111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-0000000000c0', 'f0000000-0000-0000-0000-0000000000d0', 'active'),
  ('f0000000-0000-0000-0000-0000000000e1', 'f2222222-2222-2222-2222-222222222222', 'f0000000-0000-0000-0000-0000000000c0', 'f0000000-0000-0000-0000-0000000000d1', 'active')
on conflict (id) do nothing;

-- Assets: one per facility.
insert into assets (id, facility_id, name, asset_tag, status) values
  ('f3000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-0000000000c0', 'Pool Pump A', 'A-PUMP-1', 'active'),
  ('f3000000-0000-0000-0000-0000000000b1', 'f0000000-0000-0000-0000-0000000000c1', 'Pool Pump B', 'B-PUMP-1', 'active')
on conflict (id) do nothing;

-- Work orders: a live Facility A row, a SOFT-DELETED Facility A row, and a
-- live Facility B row.
insert into work_orders (id, facility_id, asset_id, title, description, priority, status) values
  ('f4000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-0000000000c0', 'f3000000-0000-0000-0000-0000000000a1', 'Fix pump A', 'Pump A is leaking', 'high', 'open'),
  ('f4000000-0000-0000-0000-0000000000a3', 'f0000000-0000-0000-0000-0000000000c0', null, 'Fix ladder A', 'Ladder A rung is loose', 'medium', 'open'),
  ('f4000000-0000-0000-0000-0000000000b1', 'f0000000-0000-0000-0000-0000000000c1', 'f3000000-0000-0000-0000-0000000000b1', 'Fix pump B', 'Pump B is leaking', 'high', 'open')
on conflict (id) do nothing;
insert into work_orders (id, facility_id, title, description, priority, status, deleted_at) values
  ('f4000000-0000-0000-0000-0000000000a2', 'f0000000-0000-0000-0000-0000000000c0', 'Already-deleted WO', 'soft-deleted before the test runs', 'low', 'cancelled', now())
on conflict (id) do nothing;

-- Child rows: comment/attachment on each live parent.
insert into work_order_updates (id, facility_id, work_order_id, update_type, body) values
  ('f5000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-0000000000c0', 'f4000000-0000-0000-0000-0000000000a1', 'comment', 'Ordered a replacement seal.'),
  ('f5000000-0000-0000-0000-0000000000b1', 'f0000000-0000-0000-0000-0000000000c1', 'f4000000-0000-0000-0000-0000000000b1', 'comment', 'Facility B comment.')
on conflict (id) do nothing;
insert into work_order_attachments (id, facility_id, work_order_id, storage_path, mime_type) values
  ('f6000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-0000000000c0', 'f4000000-0000-0000-0000-0000000000a1', 'facilities/fac-a/work-orders/a1/leak.jpg', 'image/jpeg'),
  ('f6000000-0000-0000-0000-0000000000b1', 'f0000000-0000-0000-0000-0000000000c1', 'f4000000-0000-0000-0000-0000000000b1', 'facilities/fac-b/work-orders/b1/leak.jpg', 'image/jpeg')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Cross-facility isolation, as the Facility A work_orders.manage holder.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"f1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
  visible int;
begin
  select count(*) into visible from assets where facility_id = 'f0000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'WO SCOPE FAIL: Facility A manager can read Facility B assets (% row(s))', visible;
  end if;

  select count(*) into visible from work_orders where facility_id = 'f0000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'WO SCOPE FAIL: Facility A manager can read Facility B work orders (% row(s))', visible;
  end if;

  select count(*) into visible from work_order_updates where facility_id = 'f0000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'WO SCOPE FAIL: Facility A manager can read Facility B work order updates (% row(s))', visible;
  end if;

  select count(*) into visible from work_order_attachments where facility_id = 'f0000000-0000-0000-0000-0000000000c1';
  if visible <> 0 then
    raise exception 'WO SCOPE FAIL: Facility A manager can read Facility B work order attachments (% row(s))', visible;
  end if;

  -- Same isolation, by specific id, for the child rows (parent-facility check).
  if exists (select 1 from work_order_updates where id = 'f5000000-0000-0000-0000-0000000000b1') then
    raise exception 'WO SCOPE FAIL: Facility A manager can read a specific Facility B work order update';
  end if;
  if exists (select 1 from work_order_attachments where id = 'f6000000-0000-0000-0000-0000000000b1') then
    raise exception 'WO SCOPE FAIL: Facility A manager can read a specific Facility B work order attachment';
  end if;
end;
$$;

-- Cross-facility write denial: the Facility A manager has no membership (and
-- therefore no work_orders.manage) in Facility B.
do $$
begin
  begin
    insert into work_orders (facility_id, title, description)
    values ('f0000000-0000-0000-0000-0000000000c1', 'Cross-facility insert attempt', 'should be blocked');
    raise exception 'WO SCOPE FAIL: Facility A manager inserted a work order into Facility B';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- 5. 0013 regression: fn_assert_same_facility still blocks a Facility B asset
-- from being attached to a Facility A work order, after 0026 touched the same
-- policy's USING clause.
do $$
begin
  begin
    insert into work_orders (facility_id, asset_id, title, description)
    values ('f0000000-0000-0000-0000-0000000000c0', 'f3000000-0000-0000-0000-0000000000b1', 'Cross-tenant asset injection', 'should be blocked');
    raise exception 'WO SCOPE FAIL: Facility A manager attached a Facility B asset to a Facility A work order';
  exception
    when insufficient_privilege then null; -- expected: fn_assert_same_facility blocked the write
  end;
end;
$$;

-- 3. 0026 regression: manage holder cannot SELECT a soft-deleted work order.
do $$
declare
  visible int;
begin
  select count(*) into visible from work_orders where id = 'f4000000-0000-0000-0000-0000000000a2';
  if visible <> 0 then
    raise exception 'WO SCOPE FAIL: work_orders.manage holder can SELECT an already soft-deleted work order';
  end if;
end;
$$;

-- 3. 0026 regression: manage holder cannot UPDATE (retarget) an already
-- soft-deleted work order -- the USING clause filters it out, so the UPDATE
-- silently matches zero rows.
do $$
begin
  update work_orders set title = 'resurrected' where id = 'f4000000-0000-0000-0000-0000000000a2';
end;
$$;

reset role;

-- Verify (with RLS bypassed) that the update above truly did not apply.
do $$
begin
  if exists (select 1 from work_orders where id = 'f4000000-0000-0000-0000-0000000000a2' and title = 'resurrected') then
    raise exception 'WO SCOPE FAIL: work_orders.manage holder updated an already soft-deleted work order';
  end if;
end;
$$;

-- 4. 0026 semantics check: manage holder CANNOT soft-delete a LIVE row via a
-- plain client UPDATE. Postgres itself rejects it (insufficient_privilege)
-- because the resulting row would no longer be visible under the manage
-- policy's own USING clause -- see the 0026 migration header for the full
-- derivation. This is the deliberately-chosen semantics, not a bug.
select set_config('request.jwt.claims', '{"sub":"f1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    update work_orders set deleted_at = now() where id = 'f4000000-0000-0000-0000-0000000000a1';
    raise exception 'WO SCOPE FAIL: a work_orders.manage holder soft-deleted a live row via a plain client UPDATE (expected Postgres to reject this -- see 0026 header)';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;
reset role;

-- Verify (with RLS bypassed) that the row was genuinely untouched -- the
-- rejected UPDATE above did not partially apply.
do $$
begin
  if exists (select 1 from work_orders where id = 'f4000000-0000-0000-0000-0000000000a1' and deleted_at is not null) then
    raise exception 'WO SCOPE FAIL: work_order a1 has deleted_at set despite the UPDATE being rejected';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. work_orders.read holder cannot INSERT or UPDATE.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"f2222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  -- Sanity: the reader can still read a live Facility A work order (their own
  -- SELECT policy, gated on work_orders.read). Uses a3 (a1 was the target of
  -- the rejected soft-delete attempt above and stays untouched, but a3 keeps
  -- this block independent of that one).
  if not exists (select 1 from work_orders where id = 'f4000000-0000-0000-0000-0000000000a3') then
    raise exception 'WO SCOPE FAIL: work_orders.read holder cannot read a live Facility A work order';
  end if;

  -- Denied: INSERT is governed only by the manage "for all" policy, and the
  -- reader lacks work_orders.manage, so its WITH CHECK fails outright.
  begin
    insert into work_orders (facility_id, title, description)
    values ('f0000000-0000-0000-0000-0000000000c0', 'Reader insert attempt', 'should be blocked');
    raise exception 'WO SCOPE FAIL: a work_orders.read holder inserted a work order';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Denied: UPDATE is governed only by the manage policy too. Its USING
  -- clause filters the row out for a reader, so the UPDATE silently matches
  -- zero rows rather than raising.
  update work_orders set title = 'reader-edited' where id = 'f4000000-0000-0000-0000-0000000000a3';
  if exists (select 1 from work_orders where id = 'f4000000-0000-0000-0000-0000000000a3' and title = 'reader-edited') then
    raise exception 'WO SCOPE FAIL: a work_orders.read holder updated a work order';
  end if;
end;
$$;
reset role;

rollback;
