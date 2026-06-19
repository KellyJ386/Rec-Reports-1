-- =============================================================================
-- db/tests/0002_module_rls_test.sql
-- Phase 6 security audit coverage: module-level RLS — cross-facility isolation,
-- report lock-on-submit, polymorphic child isolation, and SOP visibility gating.
-- Run with: `supabase test db`
-- =============================================================================
begin;
create extension if not exists "basejump-supabase_test_helpers";
select plan(11);

-- ---- seed (as postgres; RLS bypassed; auth.uid() null => bootstrap) ----
select tests.create_supabase_user('mgr1');
select tests.create_supabase_user('sup1');
select tests.create_supabase_user('staff1');
select tests.create_supabase_user('staff2');

insert into public.organization (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Org One'),
  ('00000000-0000-0000-0000-0000000000a2', 'Org Two');
insert into public.facility (id, org_id, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'F1'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a2', 'F2');
insert into public.user_account (id, email) values
  (tests.get_supabase_uid('mgr1'), 'mgr1@x.com'),
  (tests.get_supabase_uid('sup1'), 'sup1@x.com'),
  (tests.get_supabase_uid('staff1'), 'staff1@x.com'),
  (tests.get_supabase_uid('staff2'), 'staff2@x.com');
insert into public.facility_membership (facility_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000f1', tests.get_supabase_uid('mgr1'), 'facility_manager'),
  ('00000000-0000-0000-0000-0000000000f1', tests.get_supabase_uid('sup1'), 'supervisor'),
  ('00000000-0000-0000-0000-0000000000f1', tests.get_supabase_uid('staff1'), 'staff'),
  ('00000000-0000-0000-0000-0000000000f2', tests.get_supabase_uid('staff2'), 'staff');

-- ---- staff1 creates an incident draft + a person involved ----
select tests.authenticate_as('staff1');
insert into public.incident_report (id, facility_id, incident_no, created_by)
  values ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000f1', 'INC-1', tests.get_supabase_uid('staff1'));
insert into public.report_person (parent_id, parent_type, full_name, created_by)
  values ('00000000-0000-0000-0000-00000000c001', 'incident_report', 'Pat Doe', tests.get_supabase_uid('staff1'));

select is((select count(*) from public.incident_report where id = '00000000-0000-0000-0000-00000000c001'),
  1::bigint, 'author sees their own draft incident');

-- ---- staff2 (other facility) sees nothing ----
select tests.authenticate_as('staff2');
select is((select count(*) from public.incident_report where facility_id = '00000000-0000-0000-0000-0000000000f1'),
  0::bigint, 'cross-facility incident read blocked');
select is((select count(*) from public.report_person where parent_id = '00000000-0000-0000-0000-00000000c001'),
  0::bigint, 'polymorphic child isolated across facilities');

-- ---- sup1 cannot see another author's DRAFT (Draft invisible to reviewers) ----
select tests.authenticate_as('sup1');
select is((select count(*) from public.incident_report where id = '00000000-0000-0000-0000-00000000c001'),
  0::bigint, 'draft hidden from reviewers');

-- ---- staff1 submits, then is locked out of edits ----
select tests.authenticate_as('staff1');
select lives_ok(
  $$ update public.incident_report set status = 'submitted' where id = '00000000-0000-0000-0000-00000000c001' $$,
  'author can submit own draft');
select throws_ok(
  $$ update public.incident_report set summary = 'late edit' where id = '00000000-0000-0000-0000-00000000c001' $$,
  'author is locked out after submit');

-- ---- sup1 now sees the submitted report + its child ----
select tests.authenticate_as('sup1');
select is((select count(*) from public.incident_report where id = '00000000-0000-0000-0000-00000000c001'),
  1::bigint, 'supervisor sees submitted report');
select is((select count(*) from public.report_person where parent_id = '00000000-0000-0000-0000-00000000c001'),
  1::bigint, 'supervisor sees child of a visible report');

-- ---- SOP visibility gating ----
select tests.authenticate_as('mgr1');
insert into public.sop (id, facility_id, title, visibility_role, created_by)
  values ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000f1', 'Mgr SOP', 'supervisor', tests.get_supabase_uid('mgr1'));
insert into public.sop_version (facility_id, sop_id, version_no, published_by)
  values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000d001', 1, tests.get_supabase_uid('mgr1'));

select tests.authenticate_as('staff1');
select is((select count(*) from public.sop where id = '00000000-0000-0000-0000-00000000d001'),
  0::bigint, 'staff cannot see a supervisor-only SOP');
select is((select count(*) from public.sop_version where sop_id = '00000000-0000-0000-0000-00000000d001'),
  0::bigint, 'staff cannot see versions of a hidden SOP');

select tests.authenticate_as('sup1');
select is((select count(*) from public.sop where id = '00000000-0000-0000-0000-00000000d001'),
  1::bigint, 'supervisor can see the supervisor-only SOP');

select * from finish();
rollback;
