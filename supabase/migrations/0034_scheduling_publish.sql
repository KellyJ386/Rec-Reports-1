-- ===========================================================================
-- 0034_scheduling_publish.sql
-- SC-07 (plans/SCHEDULING_PLAN.md): the publish flow's permission code and
-- write policy. Two independent pieces:
--
--   1. Permission catalog: seeds 'schedule.publish' (mirrors 0027's pattern
--      for a live database that already bootstrapped from a pre-this-migration
--      seed.sql -- the catalog insert AND the role grant both need to run
--      here, not just be added to supabase/seed.sql). schedule.manage alone
--      can build/edit a period's shifts and assignments but cannot push them
--      live; schedule.publish is its own governance surface, matching the
--      DR-05/IN-01 precedent of splitting "manage the thing" from "publish
--      the thing" (reports.template.manage vs reports.publish).
--
--      Grant target: rather than joining on role NAME (0027's approach, which
--      assumes the demo seed's system-role names are representative), this
--      grants schedule.publish to every role that already holds
--      schedule.manage -- literally "the same tiers that hold schedule.manage"
--      per the task brief, and correct across every tenant/facility
--      regardless of how its roles are named, including any custom
--      (non-system) role an admin created through the UI and granted
--      schedule.manage to. In the demo seed this resolves to Tenant Owner and
--      Ops Admin (Compliance Admin never held schedule.manage -- it is an
--      admin/reporting/incident-governance role, not a scheduling one).
--
--   2. schedule_publications (0003_scheduling.sql) has carried a SELECT-only
--      reader policy since it was created -- there has never been an INSERT
--      path, because the publish flow (this batch) is the first writer of
--      this table. Adds that INSERT policy: gated on schedule.publish, plus
--      the standard fn_assert_same_facility (0009) cross-tenant FK guard on
--      schedule_period_id, so a publisher can only record a publication
--      against a schedule period in their own facility. No UPDATE/DELETE
--      policy is added -- schedule_publications rows are an append-only
--      publish history, the same immutability posture as
--      certification_events (0031) and audit_events (0010): once inserted, a
--      publication record is never edited or removed by a client.
-- ===========================================================================

insert into permissions (code, description) values
  ('schedule.publish', 'Publish schedule periods')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Grant schedule.publish to every role that already holds schedule.manage,
-- across every tenant/facility -- see the header note on why this joins on
-- an existing grant rather than a role name.
-- ---------------------------------------------------------------------------
insert into role_permissions (role_id, permission_code)
select rp.role_id, 'schedule.publish'
from role_permissions rp
where rp.permission_code = 'schedule.manage'
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- schedule_publications: the missing INSERT policy. schedule.publish holders
-- may insert a publication row for a schedule period in their own facility;
-- fn_assert_same_facility blocks pointing schedule_period_id at another
-- tenant's period even when facility_id on the new row is spoofed to match.
-- ---------------------------------------------------------------------------
drop policy if exists "schedule publishers can insert publications" on schedule_publications;
create policy "schedule publishers can insert publications" on schedule_publications
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.publish')
    and fn_assert_same_facility(facility_id, 'schedule_periods', schedule_period_id)
  );
