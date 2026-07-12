-- Verification intent: fn_audit_chain_link (0013) links every audit_events
-- insert to the previous row in its facility partition and stamps a sha256
-- row_hash that is sensitive to the row's contents, i.e. tamper-evident.
-- Runs against a migrated database; everything lives inside a transaction
-- that is rolled back, so no fixture persists.
--
-- Note on timestamps: within one transaction, now() (the audit_events.
-- created_at default) returns the *transaction's* start time for every
-- statement, not wall-clock time -- so two rows inserted a moment apart in
-- this same begin/rollback block would otherwise tie on created_at, making
-- fn_audit_chain_link's "previous row" lookup (order by created_at desc, id
-- desc) pick arbitrarily rather than chronologically. The two audit rows
-- below therefore pass explicit, strictly increasing created_at values, the
-- same way a real deployment's two separate requests naturally would.
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
    '2026-01-01T00:00:00Z'::timestamptz
  );

insert into audit_events (id, facility_id, event_type, entity_table, entity_id, event_payload, created_at) values
  (
    '7e000000-0000-0000-0000-0000000000e2',
    '7aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'config.changed',
    'facility_settings',
    '7f000000-0000-0000-0000-0000000000f1',
    jsonb_build_object('before', jsonb_build_object('locale', 'en-US'), 'after', jsonb_build_object('locale', 'fr-FR')),
    '2026-01-01T00:00:01Z'::timestamptz
  );

-- Both rows must carry a row_hash, and the second's prev_hash must equal the
-- first's row_hash -- the chain link fn_audit_chain_link is responsible for.
do $$
declare
  v_row1 audit_events%rowtype;
  v_row2 audit_events%rowtype;
begin
  select * into v_row1 from audit_events where id = '7e000000-0000-0000-0000-0000000000e1';
  select * into v_row2 from audit_events where id = '7e000000-0000-0000-0000-0000000000e2';

  if v_row1.row_hash is null then
    raise exception 'CHAIN FAIL: first audit row has no row_hash';
  end if;
  if v_row2.row_hash is null then
    raise exception 'CHAIN FAIL: second audit row has no row_hash';
  end if;
  if v_row1.prev_hash is not null then
    raise exception 'CHAIN FAIL: first audit row in a fresh partition should have a null prev_hash, got %', v_row1.prev_hash;
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

-- A row in a different facility partition starts its own chain (null prev_hash),
-- proving the partition key -- not insertion order alone -- gates linkage.
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
    '2026-01-01T00:00:02Z'::timestamptz
  );

do $$
declare
  v_row3 audit_events%rowtype;
begin
  select * into v_row3 from audit_events where id = '7e000000-0000-0000-0000-0000000000e3';
  if v_row3.prev_hash is not null then
    raise exception 'CHAIN FAIL: a row in a fresh facility partition should have a null prev_hash, got %', v_row3.prev_hash;
  end if;
end;
$$;

rollback;
