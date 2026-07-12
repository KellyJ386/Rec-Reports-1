-- Verification intent: fn_audit_chain_link (0013) links every audit_events
-- insert to the previous row in its scope partition and stamps a sha256
-- row_hash that is sensitive to the row's contents, i.e. tamper-evident.
-- Runs against a migrated database; everything lives inside a transaction
-- that is rolled back, so no fixture persists.
--
-- Two setup subtleties this test accounts for:
--   * Creating the facility itself is an audited config change
--     (facilities_audit_change, 0010's fn_audit_admin_change), so the true
--     genesis row of a fresh facility's chain partition is that INSERT's own
--     audit row -- not null. The assertions below capture that seed row by
--     entity_table/entity_id rather than assuming an empty partition, which
--     is also a more faithful test: it proves fn_audit_admin_change and
--     fn_audit_chain_link compose correctly across two different triggers.
--   * Within one transaction, now() (the audit_events.created_at default)
--     returns the *transaction's* start time for every statement, not
--     wall-clock time -- so two rows inserted a moment apart in this same
--     begin/rollback block would otherwise tie on created_at, making
--     fn_audit_chain_link's "previous row" lookup (order by created_at desc,
--     id desc) pick arbitrarily rather than chronologically. Worse, that same
--     lookup is a partition-wide "latest wins", so a manually inserted row
--     must also sort after the seed row above (which is stamped with the
--     transaction's real now()) or the seed would keep winning "most recent"
--     forever. The manually inserted audit rows below therefore pass
--     explicit, strictly increasing, and deliberately far-future created_at
--     values -- what real deployments get for free since every request's
--     now() is later than the last, but that a single fixed-transaction test
--     has to fake.
begin;

insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'audit-chain@append.test')
on conflict (id) do nothing;

insert into app_users (id, full_name, email) values
  ('77777777-7777-7777-7777-777777777777', 'Audit Chain User', 'audit-chain@append.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('71111111-1111-1111-1111-111111111111', 'Org Audit (chain test)')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name) values
  ('7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '71111111-1111-1111-1111-111111111111', 'Facility Audit Chain')
on conflict (id) do nothing;

-- Two "config changed" audit rows in the same facility partition, chronological.
insert into audit_events (id, facility_id, event_type, entity_table, entity_id, event_payload, created_at) values
  (
    '7e000000-0000-0000-0000-0000000000e1',
    '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'config.changed',
    'facility_settings',
    '7f000000-0000-0000-0000-0000000000f1',
    jsonb_build_object('before', null, 'after', jsonb_build_object('locale', 'en-US')),
    '2999-01-01T00:00:00Z'::timestamptz
  );

insert into audit_events (id, facility_id, event_type, entity_table, entity_id, event_payload, created_at) values
  (
    '7e000000-0000-0000-0000-0000000000e2',
    '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'config.changed',
    'facility_settings',
    '7f000000-0000-0000-0000-0000000000f1',
    jsonb_build_object('before', jsonb_build_object('locale', 'en-US'), 'after', jsonb_build_object('locale', 'fr-FR')),
    '2999-01-01T00:00:01Z'::timestamptz
  );

-- Both rows must carry a row_hash, the first must chain onto the partition's
-- seed row (the facility-creation audit row above), and the second's
-- prev_hash must equal the first's row_hash.
do $$
declare
  v_seed audit_events%rowtype;
  v_row1 audit_events%rowtype;
  v_row2 audit_events%rowtype;
begin
  select * into v_seed from audit_events
   where entity_table = 'facilities' and entity_id = '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  select * into v_row1 from audit_events where id = '7e000000-0000-0000-0000-0000000000e1';
  select * into v_row2 from audit_events where id = '7e000000-0000-0000-0000-0000000000e2';

  if v_seed.row_hash is null then
    raise exception 'CHAIN FAIL: the facility-creation audit row has no row_hash (test setup assumption broken)';
  end if;
  if v_row1.row_hash is null then
    raise exception 'CHAIN FAIL: first audit row has no row_hash';
  end if;
  if v_row2.row_hash is null then
    raise exception 'CHAIN FAIL: second audit row has no row_hash';
  end if;
  if v_row1.prev_hash is distinct from v_seed.row_hash then
    raise exception 'CHAIN FAIL: first row prev_hash (%) does not equal the partition seed''s row_hash (%)', v_row1.prev_hash, v_seed.row_hash;
  end if;
  if v_row2.prev_hash is distinct from v_row1.row_hash then
    raise exception 'CHAIN FAIL: second row prev_hash (%) does not equal first row row_hash (%)', v_row2.prev_hash, v_row1.row_hash;
  end if;
end;
$$;

-- Recompute row 2's hash from its own stored columns using the exact formula
-- documented on fn_audit_chain_link (0013_audit_chain.sql) and mirrored in
-- src/lib/audit.mjs's computeDbRowHash. An untampered row must reproduce its
-- stored row_hash bit for bit; a row whose payload is altered after the fact
-- must NOT reproduce it -- that divergence is the tamper-evidence property
-- "verify chain integrity" relies on. (audit_events is append-only, so an
-- attacker can never actually rewrite row_hash to match a tampered payload;
-- this recomputation is what a verifier does to notice the mismatch without
-- needing to bypass that guard.)
do $$
declare
  v_row2 audit_events%rowtype;
  v_real_canonical text;
  v_real_hash text;
  v_tampered_payload jsonb := jsonb_build_object('before', jsonb_build_object('locale', 'en-US'), 'after', jsonb_build_object('locale', 'TAMPERED'));
  v_tampered_canonical text;
  v_tampered_hash text;
begin
  select * into v_row2 from audit_events where id = '7e000000-0000-0000-0000-0000000000e2';

  v_real_canonical :=
    v_row2.event_type || '|' ||
    v_row2.entity_table || '|' ||
    coalesce(v_row2.entity_id::text, '') || '|' ||
    coalesce(v_row2.event_payload::text, '') || '|' ||
    coalesce(v_row2.facility_id::text, '') || '|' ||
    coalesce(v_row2.organization_id::text, '') || '|' ||
    coalesce(to_jsonb(v_row2.created_at) #>> '{}', '');
  v_real_hash := encode(digest(coalesce(v_row2.prev_hash, '') || v_real_canonical, 'sha256'), 'hex');

  if v_real_hash <> v_row2.row_hash then
    raise exception 'CHAIN FAIL: recomputing row_hash from row 2''s own stored columns did not reproduce row_hash (% <> %)', v_real_hash, v_row2.row_hash;
  end if;

  v_tampered_canonical :=
    v_row2.event_type || '|' ||
    v_row2.entity_table || '|' ||
    coalesce(v_row2.entity_id::text, '') || '|' ||
    coalesce(v_tampered_payload::text, '') || '|' ||
    coalesce(v_row2.facility_id::text, '') || '|' ||
    coalesce(v_row2.organization_id::text, '') || '|' ||
    coalesce(to_jsonb(v_row2.created_at) #>> '{}', '');
  v_tampered_hash := encode(digest(coalesce(v_row2.prev_hash, '') || v_tampered_canonical, 'sha256'), 'hex');

  if v_tampered_hash = v_row2.row_hash then
    raise exception 'CHAIN FAIL: a tampered event_payload recomputed the same row_hash as the genuine row';
  end if;
end;
$$;

-- A row in a different facility starts its own chain, keyed off that
-- facility's own seed (its creation audit row) -- never the first facility's
-- chain -- proving the scope partition, not insertion order alone, gates
-- linkage.
insert into facilities (id, organization_id, name) values
  ('7bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '71111111-1111-1111-1111-111111111111', 'Facility Audit Chain (other)')
on conflict (id) do nothing;

insert into audit_events (id, facility_id, event_type, entity_table, entity_id, event_payload, created_at) values
  (
    '7e000000-0000-0000-0000-0000000000e3',
    '7bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'config.changed',
    'facility_settings',
    '7f000000-0000-0000-0000-0000000000f2',
    jsonb_build_object('before', null, 'after', jsonb_build_object('locale', 'en-US')),
    '2999-01-01T00:00:02Z'::timestamptz
  );

do $$
declare
  v_seed2 audit_events%rowtype;
  v_row2 audit_events%rowtype;
  v_row3 audit_events%rowtype;
begin
  select * into v_seed2 from audit_events
   where entity_table = 'facilities' and entity_id = '7bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  select * into v_row2 from audit_events where id = '7e000000-0000-0000-0000-0000000000e2';
  select * into v_row3 from audit_events where id = '7e000000-0000-0000-0000-0000000000e3';

  if v_seed2.row_hash is null then
    raise exception 'CHAIN FAIL: the second facility-creation audit row has no row_hash (test setup assumption broken)';
  end if;
  if v_row3.prev_hash is distinct from v_seed2.row_hash then
    raise exception 'CHAIN FAIL: row in the second facility''s partition prev_hash (%) does not equal that facility''s own seed row_hash (%)', v_row3.prev_hash, v_seed2.row_hash;
  end if;
  if v_row3.prev_hash = v_row2.row_hash then
    raise exception 'CHAIN FAIL: row in a different facility partition incorrectly chained onto the first facility''s last hash';
  end if;
end;
$$;

rollback;
