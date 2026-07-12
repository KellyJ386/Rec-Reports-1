-- Verification intent: audit_events is append-only and config mutations are
-- auto-audited. Runs against a migrated database; everything lives inside a
-- transaction that is rolled back, so no fixture persists. Each assertion RAISEs
-- on failure so psql -v ON_ERROR_STOP=1 turns any regression into a non-zero exit.
-- The block trigger raises with errcode insufficient_privilege; the sentinel
-- "FAIL" raises use the default class so they always propagate out.
begin;

insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'audit@append.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('66666666-6666-6666-6666-666666666666', 'Audit User', 'audit@append.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('61111111-1111-1111-1111-111111111111', 'Org Audit (append-only test)')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '61111111-1111-1111-1111-111111111111', 'Facility Audit')
on conflict (id) do nothing;

-- Seed one audit row directly (as the migration owner, the append-only trigger
-- only blocks UPDATE/DELETE, never INSERT).
insert into audit_events (id, facility_id, event_type, entity_table, entity_id) values
  ('6e000000-0000-0000-0000-0000000000e1', '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test.seed', 'facility_settings', '6f000000-0000-0000-0000-0000000000f1')
on conflict (id) do nothing;

-- UPDATE on audit_events must raise.
do $$
begin
  begin
    update audit_events set event_type = 'tampered' where id = '6e000000-0000-0000-0000-0000000000e1';
    raise exception 'APPEND-ONLY FAIL: update on audit_events was permitted';
  exception
    when insufficient_privilege then null; -- expected: fn_block_audit_mutation raised
  end;
end;
$$;

-- DELETE on audit_events must raise.
do $$
begin
  begin
    delete from audit_events where id = '6e000000-0000-0000-0000-0000000000e1';
    raise exception 'APPEND-ONLY FAIL: delete on audit_events was permitted';
  exception
    when insufficient_privilege then null; -- expected: fn_block_audit_mutation raised
  end;
end;
$$;

-- A facility_settings UPDATE must produce exactly one new config.changed audit
-- row carrying the correct before/after payload.
do $$
declare
  before_count int;
  after_count int;
  payload jsonb;
begin
  insert into facility_settings (id, facility_id, settings_jsonb, version) values
    ('6f000000-0000-0000-0000-0000000000f1', '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"locale":"en-US"}'::jsonb, 1);

  select count(*) into before_count from audit_events
    where entity_table = 'facility_settings'
      and entity_id = '6f000000-0000-0000-0000-0000000000f1'
      and event_type = 'config.changed';

  update facility_settings
    set settings_jsonb = '{"locale":"fr-FR"}'::jsonb
    where id = '6f000000-0000-0000-0000-0000000000f1';

  select count(*) into after_count from audit_events
    where entity_table = 'facility_settings'
      and entity_id = '6f000000-0000-0000-0000-0000000000f1'
      and event_type = 'config.changed';

  if after_count - before_count <> 1 then
    raise exception 'AUDIT FAIL: expected exactly one new audit row from the update, got %', after_count - before_count;
  end if;

  -- Identify the update's audit row by its after-state and check the payload.
  select event_payload into payload from audit_events
    where entity_table = 'facility_settings'
      and entity_id = '6f000000-0000-0000-0000-0000000000f1'
      and event_type = 'config.changed'
      and event_payload #>> '{after,settings_jsonb,locale}' = 'fr-FR';

  if payload is null then
    raise exception 'AUDIT FAIL: no audit row captured the updated after-state';
  end if;
  if payload #>> '{before,settings_jsonb,locale}' <> 'en-US' then
    raise exception 'AUDIT FAIL: before payload locale = %, expected en-US', payload #>> '{before,settings_jsonb,locale}';
  end if;
  if payload #>> '{after,settings_jsonb,locale}' <> 'fr-FR' then
    raise exception 'AUDIT FAIL: after payload locale = %, expected fr-FR', payload #>> '{after,settings_jsonb,locale}';
  end if;
end;
$$;

rollback;
