-- =============================================================================
-- db/tests/0001_tenancy_rls_test.sql
-- Phase 0.2 acceptance (BUILD_PLAN.md): prove cross-facility reads are blocked and the
-- 5-tier role gate holds (no privilege escalation).
--
-- Run with the Supabase local stack:  `supabase test db`
-- Requires the standard test-helper extension for simulating authenticated users.
-- =============================================================================
begin;

create extension if not exists "basejump-supabase_test_helpers";

select plan(8);

-- ---------------------------------------------------------------------------
-- Seed as the migration/postgres role (RLS bypassed). auth.uid() is NULL here, so the
-- membership escalation guard treats these as bootstrap provisioning (allowed).
-- ---------------------------------------------------------------------------
select tests.create_supabase_user('mgr1');
select tests.create_supabase_user('staff1');
select tests.create_supabase_user('staff2');

insert into public.organization (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Org One'),
  ('00000000-0000-0000-0000-0000000000a2', 'Org Two');

insert into public.facility (id, org_id, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Facility One'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a2', 'Facility Two');

insert into public.user_account (id, email) values
  (tests.get_supabase_uid('mgr1'),   'mgr1@example.com'),
  (tests.get_supabase_uid('staff1'), 'staff1@example.com'),
  (tests.get_supabase_uid('staff2'), 'staff2@example.com');

insert into public.facility_membership (facility_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f1', tests.get_supabase_uid('mgr1'),   'facility_manager'),
  ('00000000-0000-0000-0000-0000000000f1', tests.get_supabase_uid('staff1'), 'staff'),
  ('00000000-0000-0000-0000-0000000000f2', tests.get_supabase_uid('staff2'), 'staff');

-- ---------------------------------------------------------------------------
-- As staff1 (member of Facility One only)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('staff1');

select is(
  (select count(*) from public.facility where id = '00000000-0000-0000-0000-0000000000f1'),
  1::bigint, 'staff1 can read their own facility');

select is(
  (select count(*) from public.facility where id = '00000000-0000-0000-0000-0000000000f2'),
  0::bigint, 'staff1 CANNOT read another facility (RLS isolation)');

select is(
  (select count(*) from public.facility_membership
     where facility_id = '00000000-0000-0000-0000-0000000000f2'),
  0::bigint, 'staff1 CANNOT read another facility''s memberships');

select is(
  public.current_user_role_at('00000000-0000-0000-0000-0000000000f1'),
  'staff'::facility_role, 'current_user_role_at resolves staff at own facility');

select is(
  public.has_facility_role('00000000-0000-0000-0000-0000000000f1', 'supervisor'),
  false, 'staff does not satisfy the supervisor gate');

-- staff may not write memberships at all (RLS insert requires facility_manager+)
select throws_ok(
  $$ insert into public.facility_membership (facility_id, user_id, role)
     values ('00000000-0000-0000-0000-0000000000f1',
             tests.get_supabase_uid('staff2'), 'supervisor') $$,
  'staff cannot create memberships (role gate)');

-- ---------------------------------------------------------------------------
-- As mgr1 (facility_manager at Facility One)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('mgr1');

select is(
  public.has_facility_role('00000000-0000-0000-0000-0000000000f1', 'facility_manager'),
  true, 'facility_manager satisfies the manager gate');

-- A manager CANNOT grant a role above their own rank (escalation guard).
select throws_ok(
  $$ insert into public.facility_membership (facility_id, user_id, role)
     values ('00000000-0000-0000-0000-0000000000f1',
             tests.get_supabase_uid('staff2'), 'org_admin') $$,
  'facility_manager cannot grant org_admin (no privilege escalation)');

select * from finish();
rollback;
