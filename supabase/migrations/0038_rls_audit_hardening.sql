-- ===========================================================================
-- 0038_rls_audit_hardening.sql
-- Schema-wide RLS audit (plans/RLS_AUDIT.md): every table with RLS enabled
-- was enumerated (pg_policies), every route's pgInsert/pgUpdate/pgDelete call
-- was cross-referenced against write-policy coverage (Class A: "inert
-- feature" -- a table with a SELECT policy but no INSERT/UPDATE, so the BFF,
-- which authenticates with the CALLER's JWT, silently fails every write),
-- and every facility-scoped table's FK columns pointing at another
-- facility-scoped table were probed empirically for Class B ("cross-facility
-- reference" -- a manage policy checks the actor's permission on the CLAIMED
-- facility_id but never compares it to the referenced row's actual
-- facility_id, and plain FK enforcement bypasses RLS on the referenced
-- table). All findings below were reproduced against a live Postgres 16
-- instance before being fixed here; see plans/RLS_AUDIT.md for every probe
-- and its observed (pre-fix) result, plus the full list of what was probed
-- and found already-correct.
--
-- ---------------------------------------------------------------------------
-- PART 1 -- Class A: two inert features (missing INSERT policy entirely).
-- ---------------------------------------------------------------------------
--   (a) report_submission_attachments: created in 0002_daily_reports.sql with
--       exactly one policy, a SELECT ("report readers can read attachments").
--       POST /reports/:id/attachments (src/lib/http/attachments-routes.mjs,
--       MODULES.reports) pgInserts into this table using the caller's own
--       client -- with zero INSERT/UPDATE/DELETE policies and RLS enabled,
--       Postgres denies the write outright for every non-owner role. The
--       entire daily-reports attachment upload feature is inert. Fixed with
--       an INSERT policy mirroring the route's own writePermission
--       (reports.submit) plus fn_assert_same_facility on submission_id, the
--       same shape already used by incident_attachments/work_order_attachments's
--       sibling "manage attachments" policies.
--   (b) training_completions: created in 0007_training.sql with exactly one
--       policy, a SELECT ("training readers can read completions"). POST
--       /training-assignments/:id/complete (src/lib/http/training-routes.mjs)
--       pgInserts into this table using the caller's own client, gated at the
--       HTTP layer by requireRead (training.read) alone -- no training.manage
--       requirement and, unlike training_progress's self-service INSERT
--       (0036), no ownership check binding the assignment to the caller's own
--       employee row. Fixed with an INSERT policy matching that EXACT
--       existing app-layer gate (training.read) plus fn_assert_same_facility
--       on assignment_id -- this migration only makes the already-decided
--       app permission enforceable at the DB layer, it does not invent a new
--       one. The absence of a training_progress-style ownership check on this
--       route is flagged in plans/RLS_AUDIT.md as a product decision to
--       revisit (would require an application change), not guessed at here.
--
-- ---------------------------------------------------------------------------
-- PART 2 -- Class B: memberships.role_id (privilege escalation).
-- ---------------------------------------------------------------------------
-- memberships already carries a BEFORE INSERT OR UPDATE trigger
-- (fn_membership_department_facility, 0023) that verifies department_id
-- belongs to the membership's own facility_id, chosen as a trigger
-- specifically (per 0023's own comment) "so every write path is covered" --
-- including any future service-role/provisioning write, not just
-- authenticated-role callers. role_id never got the same treatment: the
-- INSERT/UPDATE policies' WITH CHECK only verify the ACTOR's own admin.manage
-- on the claimed facility_id, never that role_id itself names a role
-- belonging to that facility. Empirically confirmed: an admin.manage holder
-- on Facility A can grant a membership claiming facility_id = A but
-- role_id = a role that lives in Facility B, and every permission code
-- attached to that Facility B role becomes effective for the grantee within
-- Facility A (has_permission joins role_permissions by role_id alone, never
-- re-validating the role's own facility). This is a genuine privilege
-- escalation: any facility's admin.manage holder can borrow ANY other
-- facility's role definition, platform-wide. Fixed by widening the SAME
-- existing trigger (a trigger, not WITH CHECK, for the identical
-- "every write path" reason 0023 chose one for department_id) to also
-- verify role_id's facility -- not by adding a separate WITH CHECK, since
-- WITH CHECK only ever runs for the `authenticated` role.
--
-- ---------------------------------------------------------------------------
-- PART 3 -- Class B: cross-facility FK references, closed via
-- fn_assert_same_facility (0009) in WITH CHECK -- WITH CHECK, not a trigger,
-- because every write path below is an authenticated-role caller through the
-- BFF (src/lib/http/*.mjs uses the caller's own JWT for all of these routes;
-- none of these tables are written by a background job or service-role
-- process the way work_order_updates/attachments could theoretically be),
-- so a policy predicate is sufficient -- this mirrors the WITH-CHECK idiom
-- already used by the large majority of 0009-0037's own fn_assert_same_facility
-- call sites, keeping this migration's mechanism choice consistent with
-- existing precedent rather than introducing a trigger where one isn't
-- required. Every column below was empirically probed (see
-- plans/RLS_AUDIT.md): a facility-A-scoped actor holding only the relevant
-- *.manage permission was able to persist a row claiming facility_id = A
-- while the FK column pointed at a Facility-B parent row, for every single
-- one of the columns fixed below, before this migration.
--
--   department_id (nullable, references departments) on: assets,
--     communication_channels, employees, incident_reports, report_templates,
--     report_submissions, schedule_periods, schedule_shifts, shift_templates,
--     work_orders, department_settings.
--   work_orders.assigned_to_employee_id (references employees) -- together
--     with department_id above, this is the "work_orders.department_id /
--     assigned_to_employee_id" gap called out as known-outstanding (guarded
--     ONLY at the JS layer, same finding class as the 0035 work-order-child
--     fix): closed here at the DB layer for the first time.
--   course_modules.course_id, training_assignments.employee_id/course_id
--     (references courses/employees).
--   shift_assignments.employee_id/shift_id (references employees/schedule_shifts).
--   messages.channel_id/author_employee_id (references communication_channels/employees).
--   message_audiences.message_id (references messages) -- note
--     message_acknowledgements/message_receipts already guard message_id
--     (0009/0025); message_audiences was the one sibling table that never
--     got the same treatment.
--   message_acknowledgements.employee_id / message_receipts.employee_id, but
--     ONLY on the "communication publishers can manage ..." ALL policy -- the
--     self-service "employees can record/update their own ..." policies
--     (0009/0025) already bind employee_id to the caller's own employee row
--     via an EXISTS subquery and were never at risk; the publisher-acting-
--     on-behalf-of-an-employee path had no such binding at all.
--   incident_attachments/incident_escalations/incident_followup_actions/
--     incident_people/incident_audit_events.incident_id (references
--     incident_reports) -- the same gap incident_amendments had before 0032,
--     never closed on its five sibling incident_* child tables.
--
-- ---------------------------------------------------------------------------
-- PART 4 -- incidental finding, not Class A or B, surfaced by re-running the
-- full supabase/tests/*.sql suite after the Part 1-3 fixes unmasked it (see
-- plans/RLS_AUDIT.md): report_submissions' SELECT policy ("report readers
-- can read submissions") was left on the 3-arg has_permission(user, facility,
-- code) check when 0033_report_audit_and_scope.sql (DR-11) switched every
-- OTHER report_submissions policy -- and report_templates' own SELECT
-- policy -- to the 4-arg has_permission(user, facility, department, code)
-- overload. 0033's own header states the intent explicitly: "a membership
-- scoped to one department can FILE AND READ reports for that department".
-- Read never happened: a department-scoped reports.read membership can
-- never satisfy the 3-arg check (0023 requires department_id IS NULL for
-- it), so a department-scoped reader sees zero report_submissions rows, and
-- -- because Postgres re-checks the SELECT policy for any INSERT/UPDATE's
-- RETURNING clause -- a department-scoped reports.create/reports.submit
-- member's INSERT/UPDATE (POST /reports uses `returning: true`,
-- src/lib/http/reports-routes.mjs) is rejected outright with "new row
-- violates row-level security policy", even though the INSERT/UPDATE's own
-- WITH CHECK (already 4-arg since 0033) is satisfied. Net effect: filing a
-- report is completely broken for every department-scoped member, not just
-- reading one. Fixed by widening reports.read to the 4-arg overload, exactly
-- matching 0033's own stated intent and the report_templates SELECT policy
-- it already applied this to -- reports.export is left as the 3-arg check
-- (0033 never mentioned widening it, and it is the facility/audit-level
-- export permission, not a filing permission).
-- ---------------------------------------------------------------------------
drop policy if exists "report readers can read submissions" on report_submissions;
create policy "report readers can read submissions" on report_submissions
  for select
  using (
    (
      has_permission(auth.uid(), facility_id, department_id, 'reports.read')
      or has_permission(auth.uid(), facility_id, 'reports.export')
    )
    and deleted_at is null
  );

-- Idempotency conventions (mirroring 0009-0037): drop policy if exists
-- immediately precedes every create policy (required by
-- scripts/verify-migrations.mjs from migration 0009 onward); create or
-- replace for the trigger function. No existing policy's permission gate is
-- weakened anywhere in this file -- every Part 1-3 change is an added AND
-- clause (fn_assert_same_facility(...)), which can only narrow what a
-- WITH CHECK admits, never widen it; Part 4 widens exactly one already-
-- department-aware permission check (reports.read) to match its own
-- sibling policies, not a new permission.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PART 1(a): report_submission_attachments INSERT.
-- ---------------------------------------------------------------------------
drop policy if exists "report submitters can insert attachments" on report_submission_attachments;
create policy "report submitters can insert attachments" on report_submission_attachments
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'reports.submit')
    and fn_assert_same_facility(facility_id, 'report_submissions', submission_id)
  );

-- ---------------------------------------------------------------------------
-- PART 1(b): training_completions INSERT.
-- ---------------------------------------------------------------------------
drop policy if exists "training readers can insert completions" on training_completions;
create policy "training readers can insert completions" on training_completions
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'training.read')
    and fn_assert_same_facility(facility_id, 'training_assignments', assignment_id)
  );

-- ---------------------------------------------------------------------------
-- PART 2: memberships.role_id facility consistency -- widen the existing
-- 0023 trigger rather than add a second one, so both invariants are checked
-- in the same BEFORE INSERT OR UPDATE pass. roles.facility_id is NOT NULL
-- and memberships.role_id is NOT NULL, so (unlike department_id) there is no
-- "null means unscoped" case to special-case here.
-- ---------------------------------------------------------------------------
create or replace function fn_membership_department_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  department_facility_id uuid;
  role_facility_id uuid;
begin
  if new.department_id is not null then
    select facility_id into department_facility_id from departments where id = new.department_id;
    if department_facility_id is null or department_facility_id <> new.facility_id then
      raise exception 'membership department must belong to the membership facility'
        using errcode = 'check_violation';
    end if;
  end if;

  select facility_id into role_facility_id from roles where id = new.role_id;
  if role_facility_id is null or role_facility_id <> new.facility_id then
    raise exception 'membership role must belong to the membership facility'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists memberships_department_facility on memberships;
create trigger memberships_department_facility
  before insert or update on memberships
  for each row execute function fn_membership_department_facility();

-- ---------------------------------------------------------------------------
-- PART 3: department_id family (11 tables).
-- ---------------------------------------------------------------------------
drop policy if exists "work order managers can manage assets" on assets;
create policy "work order managers can manage assets" on assets
  for all
  using (has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'work_orders.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "communication publishers can manage channels" on communication_channels;
create policy "communication publishers can manage channels" on communication_channels
  for all
  using (has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "admins can insert employees" on employees;
create policy "admins can insert employees" on employees
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'admin.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "admins can update employees" on employees;
create policy "admins can update employees" on employees
  for update
  using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'admin.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "incident managers can manage reports" on incident_reports;
create policy "incident managers can manage reports" on incident_reports
  for all
  using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'incidents.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "template managers can insert report templates" on report_templates;
create policy "template managers can insert report templates" on report_templates
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "template managers can update report templates" on report_templates;
create policy "template managers can update report templates" on report_templates
  for update
  using (has_permission(auth.uid(), facility_id, 'reports.template.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "report creators can create submissions" on report_submissions;
create policy "report creators can create submissions" on report_submissions
  for insert
  with check (
    has_permission(auth.uid(), facility_id, department_id, 'reports.create')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

drop policy if exists "report submitters can update drafts" on report_submissions;
create policy "report submitters can update drafts" on report_submissions
  for update
  using (
    has_permission(auth.uid(), facility_id, department_id, 'reports.submit')
    and status = 'draft'
    and deleted_at is null
  )
  with check (
    has_permission(auth.uid(), facility_id, department_id, 'reports.submit')
    and status = any (array['draft', 'submitted'])
    and fn_assert_same_facility(facility_id, 'departments', department_id)
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

drop policy if exists "schedule managers can manage periods" on schedule_periods;
create policy "schedule managers can manage periods" on schedule_periods
  for all
  using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "schedule managers can manage shifts" on schedule_shifts;
create policy "schedule managers can manage shifts" on schedule_shifts
  for all
  using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.manage')
    and fn_assert_same_facility(facility_id, 'schedule_periods', schedule_period_id)
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "schedule managers can manage shift templates" on shift_templates;
create policy "schedule managers can manage shift templates" on shift_templates
  for all
  using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

drop policy if exists "admins can manage department settings" on department_settings;
create policy "admins can manage department settings" on department_settings
  for all
  using (has_permission(auth.uid(), facility_id, department_id, 'admin.manage'))
  with check (
    has_permission(auth.uid(), facility_id, department_id, 'admin.manage')
    and fn_assert_same_facility(facility_id, 'departments', department_id)
  );

-- work_orders: known-outstanding gap (department_id AND
-- assigned_to_employee_id were guarded ONLY at the JS layer) -- closed here
-- alongside the already-guarded asset_id check.
drop policy if exists "work order managers can manage work orders" on work_orders;
create policy "work order managers can manage work orders" on work_orders
  for all
  using (has_permission(auth.uid(), facility_id, 'work_orders.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'work_orders.manage')
    and fn_assert_same_facility(facility_id, 'assets', asset_id)
    and fn_assert_same_facility(facility_id, 'departments', department_id)
    and fn_assert_same_facility(facility_id, 'employees', assigned_to_employee_id)
  );

-- ---------------------------------------------------------------------------
-- PART 3 (continued): remaining non-department FK families.
-- ---------------------------------------------------------------------------
drop policy if exists "training managers can manage modules" on course_modules;
create policy "training managers can manage modules" on course_modules
  for all
  using (has_permission(auth.uid(), facility_id, 'training.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'courses', course_id)
  );

drop policy if exists "training managers can manage assignments" on training_assignments;
create policy "training managers can manage assignments" on training_assignments
  for all
  using (has_permission(auth.uid(), facility_id, 'training.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
    and fn_assert_same_facility(facility_id, 'courses', course_id)
  );

drop policy if exists "schedule managers can manage assignments" on shift_assignments;
create policy "schedule managers can manage assignments" on shift_assignments
  for all
  using (has_permission(auth.uid(), facility_id, 'schedule.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'schedule.manage')
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
    and fn_assert_same_facility(facility_id, 'schedule_shifts', shift_id)
  );

drop policy if exists "communication publishers can manage messages" on messages;
create policy "communication publishers can manage messages" on messages
  for all
  using (has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'communication_channels', channel_id)
    and fn_assert_same_facility(facility_id, 'employees', author_employee_id)
  );

drop policy if exists "communication publishers can manage audiences" on message_audiences;
create policy "communication publishers can manage audiences" on message_audiences
  for all
  using (has_permission(auth.uid(), facility_id, 'communications.publish') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  );

-- message_id already guarded here (0009); adding employee_id closes the
-- publisher-acting-on-behalf-of-an-employee gap. The self-service
-- "employees can record/update their own ..." policies are untouched -- they
-- already bind employee_id via an EXISTS subquery and were never at risk.
drop policy if exists "communication publishers can manage acknowledgements" on message_acknowledgements;
create policy "communication publishers can manage acknowledgements" on message_acknowledgements
  for all
  using (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  )
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

drop policy if exists "communication publishers can manage receipts" on message_receipts;
create policy "communication publishers can manage receipts" on message_receipts
  for all
  using (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
  )
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'messages', message_id)
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- incident_reports child tables: the same gap incident_amendments (0032) had
-- before it was fixed, never closed on these five siblings.
drop policy if exists "incident managers can manage attachments" on incident_attachments;
create policy "incident managers can manage attachments" on incident_attachments
  for all
  using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'incidents.manage')
    and fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

drop policy if exists "incident managers can manage escalations" on incident_escalations;
create policy "incident managers can manage escalations" on incident_escalations
  for all
  using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'incidents.manage')
    and fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

drop policy if exists "incident managers can manage followups" on incident_followup_actions;
create policy "incident managers can manage followups" on incident_followup_actions
  for all
  using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'incidents.manage')
    and fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

drop policy if exists "incident managers can manage people" on incident_people;
create policy "incident managers can manage people" on incident_people
  for all
  using (has_permission(auth.uid(), facility_id, 'incidents.manage') and deleted_at is null)
  with check (
    has_permission(auth.uid(), facility_id, 'incidents.manage')
    and fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

drop policy if exists "incident managers can write incident audit" on incident_audit_events;
create policy "incident managers can write incident audit" on incident_audit_events
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'incidents.manage')
    and fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );
