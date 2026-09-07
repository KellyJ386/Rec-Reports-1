-- ===========================================================================
-- 0054_report_distribution.sql
-- DR-21 (plans/DAILY_REPORTS_PLAN.md) / Slice 3A
-- (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md).
--
-- Composition, not a parallel recipient store (the cross-module note both
-- plan docs require this migration to justify explicitly):
--
--   report_distribution_lists is a TEMPLATE -> EXISTING-distribution-list
--   BINDING. It carries no member rows of its own -- recipient membership
--   (who is actually in a list, employee or role) stays exactly where 0016
--   put it: distribution_lists / distribution_list_members. This table only
--   answers "when template X is submitted, which of this facility's already-
--   defined distribution lists should hear about it, on which channel, with
--   what attach/digest policy, optionally narrowed to one department or
--   role". Recipient EXPANSION (src/lib/report-distribution.mjs
--   resolveReportRecipients) composes the existing pure helper
--   src/lib/admin/notifications.mjs's expandDistributionList against
--   CURRENT membership at drain time -- it is never re-implemented here, and
--   no report-specific member table is created. A second `report_recipients`
--   table naming employees/roles directly (mirroring distribution_lists'
--   own shape) would be dead weight: every fact it could hold already lives
--   in distribution_lists/distribution_list_members, and a facility that
--   wants a report-only audience simply creates a dedicated distribution
--   list for it (0016's tables already support that with zero schema
--   changes) rather than this migration inventing a parallel one.
--
--   report_deliveries IS new, deliberately: it is a delivery LEDGER, not a
--   recipient store -- one row per (submission, resolved recipient,
--   channel), carrying provider_message_id/attempts/last_error/status. This
--   is a different fact than "notification_deliveries" (0006) can hold: that
--   table is keyed off notification_jobs (the generic routed-event
--   pipeline, 0016), and reports need a delivery record addressable by
--   submission_id + report_distribution_list_id specifically (P-10's PATCH
--   .../deliveries readback, DR-22's per-submission summary), plus the
--   'skipped'/'bounced' vocabulary DR-22 needs for quiet-hours/digest
--   deferrals and permanent provider rejections -- neither of which
--   notification_deliveries' narrower ('queued','sent','failed','bounced')
--   constraint expresses. Reusing notification_jobs/notification_deliveries
--   for report fan-out was considered and rejected: a report submission is
--   not a routed "event" with a single facility-wide route (DR-21's
--   per-template, per-department/role, multi-binding shape has no
--   notification_routes analogue), and forcing it through that pipeline
--   would mean stuffing report-specific fields (attach_pdf, digest,
--   report_distribution_list_id) into notification_jobs.payload_jsonb by
--   convention instead of real columns RLS/indexes can see.
--
-- RLS (mirrors 0050's internal.<helper>(...) + `(select auth.uid())`
-- conventions, mandatory for every migration >= 0043):
--   * report_distribution_lists: SELECT under reports.read (facility-wide --
--     narrower department-scoped read was considered, matching 0033's
--     report_templates/report_submissions department scoping, but rejected
--     for this table specifically: distribution BINDINGS are a governance
--     surface an admin configures, not report content a department-scoped
--     filler needs hidden from them, and reports.distribution.manage itself
--     is never granted department-scoped in seed.sql). INSERT/UPDATE/DELETE
--     under reports.distribution.manage, with fn_assert_same_facility
--     guarding EVERY foreign reference this table carries (template_id
--     against report_templates, distribution_list_id against
--     distribution_lists, department_id against departments, role_id
--     against roles) so a manage holder can never point a binding at
--     another facility's template, list, department, or role -- the same
--     cross-tenant FK-injection closure every other write policy since 0009
--     applies. A single `for all` policy is used (mirroring 0016's
--     distribution_lists write policy): WITH CHECK is not evaluated for
--     DELETE, so the facility guards only ever constrain INSERT/UPDATE, and
--     USING alone (the permission check) gates DELETE -- exactly the
--     Postgres RLS semantics this needs, no separate DELETE policy required.
--   * report_deliveries: SELECT under reports.read only. NO authenticated
--     write policy of any kind -- every row is written by
--     src/lib/report-distribution.mjs's drain consumer via the
--     service-role client (RLS bypassed for service_role the same way the
--     existing notification worker already writes notification_deliveries),
--     never by an end-user request. This matches the plan's explicit
--     instruction ("readable with reports.read, written only by service
--     role -- no authenticated write policies") and the precedent
--     audit_events/incident_audit_events already set (append-only rows a
--     trigger or a service-role writer produces, never a direct client
--     write policy).
--
-- Idempotency conventions (mirroring 0009-0050): drop policy if exists
-- immediately before every create; create table/index if not exists.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) report_distribution_lists -- template -> distribution list binding.
-- ---------------------------------------------------------------------------
create table if not exists report_distribution_lists (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  template_id uuid not null references report_templates(id),
  distribution_list_id uuid not null references distribution_lists(id),
  department_id uuid references departments(id),
  role_id uuid references roles(id),
  channel text not null check (channel in ('email', 'in_app', 'push')),
  attach_pdf boolean not null default false,
  digest boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists report_distribution_lists_facility_template_idx
  on report_distribution_lists(facility_id, template_id) where active and deleted_at is null;
create index if not exists report_distribution_lists_list_idx
  on report_distribution_lists(distribution_list_id);

alter table report_distribution_lists enable row level security;

drop policy if exists "report readers can read distribution bindings" on report_distribution_lists;
create policy "report readers can read distribution bindings" on report_distribution_lists
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'reports.read') and deleted_at is null);

drop policy if exists "report distribution managers can manage bindings" on report_distribution_lists;
create policy "report distribution managers can manage bindings" on report_distribution_lists
  for all
  using (internal.has_permission((select auth.uid()), facility_id, 'reports.distribution.manage'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'reports.distribution.manage')
    and internal.fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and internal.fn_assert_same_facility(facility_id, 'distribution_lists', distribution_list_id)
    and internal.fn_assert_same_facility(facility_id, 'departments', department_id)
    and internal.fn_assert_same_facility(facility_id, 'roles', role_id)
  );

drop trigger if exists report_distribution_lists_audit_change on report_distribution_lists;
create trigger report_distribution_lists_audit_change
  after insert or update or delete on report_distribution_lists
  for each row execute function fn_audit_admin_change();

-- ---------------------------------------------------------------------------
-- (b) report_deliveries -- one row per (submission, resolved recipient,
-- channel). Ledger written exclusively by the DR-22 drain consumer
-- (src/lib/report-distribution.mjs processReportSubmittedEvents) via the
-- service-role client; see header for why no authenticated write policy
-- exists at all.
-- ---------------------------------------------------------------------------
create table if not exists report_deliveries (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  submission_id uuid not null references report_submissions(id) on delete cascade,
  report_distribution_list_id uuid not null references report_distribution_lists(id),
  recipient_employee_id uuid not null references employees(id),
  channel text not null check (channel in ('email', 'in_app', 'push')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'bounced', 'skipped')),
  provider_message_id text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists report_deliveries_facility_submission_idx
  on report_deliveries(facility_id, submission_id);
create index if not exists report_deliveries_status_idx
  on report_deliveries(facility_id, status);
-- One delivery row per (submission, binding, recipient, channel): the
-- drain's own idempotent-retry design (src/lib/report-distribution.mjs)
-- relies on this to detect "already have a row for this fan-out leg" across
-- outbox-event retries without re-inserting a duplicate.
create unique index if not exists report_deliveries_unique_leg_idx
  on report_deliveries(submission_id, report_distribution_list_id, recipient_employee_id, channel);

alter table report_deliveries enable row level security;

drop policy if exists "report readers can read deliveries" on report_deliveries;
create policy "report readers can read deliveries" on report_deliveries
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'reports.read'));

notify pgrst, 'reload schema';
