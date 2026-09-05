-- Verification intent: auth_throttle (0046_auth_throttle.sql, S-7) is
-- service-role only -- the `authenticated` role must be able to neither read
-- nor write it, even though rls-bootstrap-post.sql's blanket "grant all on
-- all tables in schema public to authenticated" gives it the raw table
-- privilege. RLS's "for all using (false)" policy is what actually denies
-- every command. Runs against a migrated database; everything lives inside a
-- transaction that is rolled back, so no fixture persists. Each assertion
-- RAISEs on failure so psql -v ON_ERROR_STOP=1 turns any regression into a
-- non-zero exit.
begin;

insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'throttle@rls.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('77777777-7777-7777-7777-777777777777', 'Throttle User', 'throttle@rls.test')
on conflict (id) do nothing;

-- Seed one row directly (as the migration owner, RLS does not apply).
insert into auth_throttle (key, window_start, failures) values
  ('email:seed@rls.test', now(), 3)
on conflict (key) do nothing;

select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);
set local role authenticated;

-- SELECT: RLS denies every row, so this returns zero rows (not an error).
do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from auth_throttle;
  if visible_count <> 0 then
    raise exception 'AUTH_THROTTLE FAIL: authenticated could see % row(s), expected 0', visible_count;
  end if;
end;
$$;

-- INSERT must be rejected by RLS (no WITH CHECK passes -- the USING(false)
-- policy is used as the check since none is given explicitly).
do $$
begin
  begin
    insert into auth_throttle (key, window_start, failures) values ('email:attacker@rls.test', now(), 1);
    raise exception 'AUTH_THROTTLE FAIL: authenticated was able to insert into auth_throttle';
  exception
    when insufficient_privilege then null; -- expected: RLS policy violation
  end;
end;
$$;

-- UPDATE must affect zero rows (RLS filters the target row set to empty
-- before the write is even attempted -- no error, just nothing matched).
do $$
declare
  affected int;
begin
  update auth_throttle set failures = 999 where key = 'email:seed@rls.test';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'AUTH_THROTTLE FAIL: authenticated was able to update % row(s)', affected;
  end if;
end;
$$;

-- DELETE must likewise affect zero rows.
do $$
declare
  affected int;
begin
  delete from auth_throttle where key = 'email:seed@rls.test';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'AUTH_THROTTLE FAIL: authenticated was able to delete % row(s)', affected;
  end if;
end;
$$;

reset role;

-- As the migration owner (RLS bypassed), the seeded row must still be there
-- untouched -- proving the UPDATE/DELETE above were denied, not just
-- reported as affecting zero rows for some unrelated reason.
do $$
declare
  seen_failures int;
begin
  select failures into seen_failures from auth_throttle where key = 'email:seed@rls.test';
  if seen_failures is null then
    raise exception 'AUTH_THROTTLE FAIL: seed row is gone -- the denied DELETE above must not have been a no-op for the wrong reason';
  end if;
  if seen_failures <> 3 then
    raise exception 'AUTH_THROTTLE FAIL: seed row failures = %, expected unchanged 3', seen_failures;
  end if;
end;
$$;

rollback;
