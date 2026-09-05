-- ===========================================================================
-- 0026_soft_delete_policy_hardening.sql
-- Closes the soft-delete leak in every "manage"/write RLS policy that is
-- OR-ed against a reader SELECT policy 0009 (or a later migration) already
-- hardened with "and deleted_at is null".
--
-- Background (WO-07): 0009_rls_hardening.sql re-created only the READER
-- SELECT policies across the work-orders, incidents, scheduling,
-- communications and training families with "and deleted_at is null". The
-- sibling "for all" manage policies from 0003/0004/0005/0006/0007 (some later
-- touched again by 0013 for an unrelated cross-tenant FK guard, but never for
-- soft-delete) were left untouched. Because Postgres RLS OR-s every
-- permissive policy for a command, a *.manage permission holder could still
-- SELECT or UPDATE a soft-deleted row through the untouched manage policy
-- even though the reader policy correctly hid it. report_submissions has the
-- analogous gap in its lone update policy ("report submitters can update
-- drafts", last touched in 0009 for an FK guard, never for soft-delete).
--
-- Audit method: every `create table` in supabase/migrations/ that declares a
-- `deleted_at` column was enumerated, then every `for all` / `for
-- insert|update|delete` policy on those tables was traced to its LATEST
-- definition (last `create policy` of that name, walking migrations in
-- order). Twenty policies across six families were found leaking, listed
-- policy-by-policy below. (Two more tables -- employees and
-- certification_types, plus departments -- have an analogous gap in their
-- 0011 admin update policies; those are a structurally different shape
-- (split insert/update/delete policies with a real hard-DELETE policy
-- alongside, not an OR-ed for-all/reader pair) and are flagged for a
-- follow-up rather than folded into this migration.)
--
-- WITH CHECK semantics (the load-bearing decision in this migration, and the
-- one place this migration corrects a wrong initial assumption -- verified
-- empirically against a live Postgres 16 instance, not just read from docs):
--
-- The task brief's suggested shape was "USING (deleted_at is null), WITH
-- CHECK left free to allow the null -> non-null transition" -- i.e. change
-- ONLY the USING clause and leave WITH CHECK untouched. That is what this
-- migration does. But it does NOT, in fact, leave open a client-side path to
-- perform the soft delete itself, and that turns out to be unavoidable, not
-- a bug: PostgreSQL enforces -- for INSERT and UPDATE alike, independent of
-- whether the policy is `for all` or split into `for select`/`for update` --
-- that the RESULTING row must remain visible under at least one applicable
-- PERMISSIVE SELECT policy for the acting role, in addition to satisfying
-- the command's own WITH CHECK. This is verifiable with a two-line repro
-- (permissive `for update using (true) with check (true)` PLUS a separate,
-- unrelated `for select using (flag = true)` policy: `update ... set flag =
-- false` still raises "new row violates row-level security policy", even
-- though the UPDATE policy itself imposes no restriction at all) -- and it
-- reproduces identically whether the write policy is `for all` or a lone
-- `for update`. So for any role whose only SELECT-applicable policy on one
-- of these tables excludes deleted_at IS NOT NULL rows (true for every
-- manage-permission holder after this migration, and true for every reader
-- since 0009), a plain client-authenticated UPDATE that SETS deleted_at is
-- rejected by Postgres itself -- regardless of what that UPDATE's own WITH
-- CHECK says, and regardless of whether WITH CHECK repeats the deleted_at
-- predicate or not. Putting the predicate in WITH CHECK (the task brief's
-- rejected option) and leaving it out of WITH CHECK (the option taken here)
-- produce the IDENTICAL outcome for this reason.
--
-- Consequence, and the semantics actually chosen: a *.manage holder cannot
-- retarget an already soft-deleted row (the leak this migration closes), AND
-- cannot use a plain client-side UPDATE to soft-delete a currently-live row
-- either, because doing so would make the row invisible to themselves under
-- their own SELECT policy in the same statement, which Postgres refuses to
-- allow silently. Nothing regresses: grepping src/lib/http/ for "deleted_at"
-- returns zero hits, so no route performs a soft delete today. When one is
-- built (WO-24), it must go through a SECURITY DEFINER function that checks
-- the *.manage permission explicitly and then performs the UPDATE with RLS
-- bypassed by the function owner (the same pattern already used by
-- fn_assert_same_facility and fn_audit_admin_change) -- never a raw
-- client-authenticated UPDATE -- precisely because ordinary RLS cannot
-- express "you may make this row disappear from your own view" once that
-- view is restricted to live rows, which is exactly what closing the WO-07
-- leak requires. supabase/tests/work_orders_scope.sql asserts the actually-
-- true behavior: the attempt is rejected with insufficient_privilege.
--
-- WITH CHECK is otherwise left completely unchanged on every policy below
-- (still gates on the *.manage permission, plus the existing 0013
-- cross-tenant FK guard on work_orders and schedule_shifts, preserved
-- verbatim) -- only USING gains "and deleted_at is null".
--
-- Idempotency conventions (mirroring 0009-0023): drop policy if exists
-- immediately before every create policy, same name + table, no other
-- changes to policy names or the permission codes they check.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Work-orders family (0005; work_orders itself last redefined in 0013).
-- ---------------------------------------------------------------------------
drop policy if exists "work order managers can manage assets" on assets;
create policy "work order managers can manage assets" on assets
  for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));

drop policy if exists "work order managers can manage work orders" on work_orders;
create policy "work order managers can manage work orders" on work_orders
  for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'work_orders.manage')
    and fn_assert_same_facility(facility_id, 'assets', asset_id)
  );

drop policy if exists "work order managers can manage updates" on work_order_updates;
create policy "work order managers can manage updates" on work_order_updates
  for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));

drop policy if exists "work order managers can manage attachments" on work_order_attachments;
create policy "work order managers can manage attachments" on work_order_attachments
  for all using (has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'work_orders.manage'));

-- ---------------------------------------------------------------------------
-- Incidents family (0004; identical pattern flagged by the WO-07 plan note).
-- ---------------------------------------------------------------------------
drop policy if exists "incident managers can manage reports" on incident_reports;
create policy "incident managers can manage reports" on incident_reports
  for all using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));

drop policy if exists "incident managers can manage people" on incident_people;
create policy "incident managers can manage people" on incident_people
  for all using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));

drop policy if exists "incident managers can manage attachments" on incident_attachments;
create policy "incident managers can manage attachments" on incident_attachments
  for all using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));

drop policy if exists "incident managers can manage escalations" on incident_escalations;
create policy "incident managers can manage escalations" on incident_escalations
  for all using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));

drop policy if exists "incident managers can manage followups" on incident_followup_actions;
create policy "incident managers can manage followups" on incident_followup_actions
  for all using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'incidents.manage'));

-- ---------------------------------------------------------------------------
-- Reports family (0002; report_submissions is the one write-capable table
-- with a deleted_at column -- report_templates/report_template_versions have
-- no write policy at all today, so there is nothing to harden there).
-- ---------------------------------------------------------------------------
drop policy if exists "report submitters can update drafts" on report_submissions;
create policy "report submitters can update drafts" on report_submissions
  for update using (
    has_permission(auth.uid(), facility_id, 'reports.submit') and status = 'draft' and deleted_at is null
  ) with check (
    has_permission(auth.uid(), facility_id, 'reports.submit')
    and status in ('draft', 'submitted')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

-- ---------------------------------------------------------------------------
-- Scheduling family (0003; schedule_shifts itself last redefined in 0013).
-- ---------------------------------------------------------------------------
drop policy if exists "schedule managers can manage periods" on schedule_periods;
create policy "schedule managers can manage periods" on schedule_periods
  for all using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));

drop policy if exists "schedule managers can manage shift templates" on shift_templates;
create policy "schedule managers can manage shift templates" on shift_templates
  for all using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));

drop policy if exists "schedule managers can manage shifts" on schedule_shifts;
create policy "schedule managers can manage shifts" on schedule_shifts
  for all using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.manage')
    and fn_assert_same_facility(facility_id, 'schedule_periods', schedule_period_id)
  );

drop policy if exists "schedule managers can manage assignments" on shift_assignments;
create policy "schedule managers can manage assignments" on shift_assignments
  for all using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'schedule.manage'));

-- ---------------------------------------------------------------------------
-- Communications family (0006).
-- ---------------------------------------------------------------------------
drop policy if exists "communication publishers can manage channels" on communication_channels;
create policy "communication publishers can manage channels" on communication_channels
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'communications.publish'));

drop policy if exists "communication publishers can manage messages" on messages;
create policy "communication publishers can manage messages" on messages
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'communications.publish'));

drop policy if exists "communication publishers can manage audiences" on message_audiences;
create policy "communication publishers can manage audiences" on message_audiences
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'communications.publish'));

-- ---------------------------------------------------------------------------
-- Training family (0007).
-- ---------------------------------------------------------------------------
drop policy if exists "training managers can manage courses" on courses;
create policy "training managers can manage courses" on courses
  for all using (has_permission(auth.uid(), facility_id, 'training.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'training.manage'));

drop policy if exists "training managers can manage modules" on course_modules;
create policy "training managers can manage modules" on course_modules
  for all using (has_permission(auth.uid(), facility_id, 'training.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'training.manage'));

drop policy if exists "training managers can manage assignments" on training_assignments;
create policy "training managers can manage assignments" on training_assignments
  for all using (has_permission(auth.uid(), facility_id, 'training.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'training.manage'));
