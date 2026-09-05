-- 0009_rls_hardening.sql
-- Forward-only RLS and tenant-isolation hardening (idempotent throughout).
-- Fixes shipped policies from 0001-0008 without editing those files:
--   * organizations become readable/updatable within the caller's org
--   * tenant SELECT policies exclude soft-deleted rows
--   * report_submissions draft->submitted transition is legal and FK-safe
--   * cross-tenant FK injection is blocked via fn_assert_same_facility
--   * org-level admin becomes structurally expressible (organization_admins + is_organization_admin)
--   * message receipts/acknowledgements become writable by their owning employee
--   * low-severity data-integrity constraints and a covering index

-- ---------------------------------------------------------------------------
-- Helper: cross-tenant FK guard. Returns true when the referenced parent row
-- shares the child's facility_id (or when parent_id is null, i.e. no reference).
-- ---------------------------------------------------------------------------
create or replace function fn_assert_same_facility(child_facility_id uuid, parent_table text, parent_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  parent_facility_id uuid;
begin
  if parent_id is null then
    return true;
  end if;
  execute format('select facility_id from %I where id = $1', parent_table)
    into parent_facility_id
    using parent_id;
  return parent_facility_id is not null and parent_facility_id = child_facility_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Org-scope primitive: organization_admins + is_organization_admin.
-- Org provisioning stays service-role-only (no client write policies here).
-- ---------------------------------------------------------------------------
create table if not exists organization_admins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists organization_admins_org_idx on organization_admins(organization_id);
create index if not exists organization_admins_user_idx on organization_admins(user_id);

alter table organization_admins enable row level security;

create or replace function is_organization_admin(check_user_id uuid, check_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from organization_admins oa
    where oa.user_id = check_user_id
      and oa.organization_id = check_organization_id
  ) or exists (
    select 1
    from facilities f
    where f.organization_id = check_organization_id
      and has_permission(check_user_id, f.id, 'admin.manage')
  );
$$;

drop policy if exists "org members can read org admins" on organization_admins;
create policy "org members can read org admins" on organization_admins
  for select using (
    organization_id in (select organization_id from facilities where id in (select current_facility_ids()))
  );

-- ---------------------------------------------------------------------------
-- (a) organizations: readable within the caller's org; updatable by org admins.
-- ---------------------------------------------------------------------------
drop policy if exists "members can read their organization" on organizations;
create policy "members can read their organization" on organizations
  for select using (
    id in (select organization_id from facilities where id in (select current_facility_ids()))
  );

drop policy if exists "org admins can update their organization" on organizations;
create policy "org admins can update their organization" on organizations
  for update using (is_organization_admin(auth.uid(), id))
  with check (is_organization_admin(auth.uid(), id));

-- ---------------------------------------------------------------------------
-- (h) facilities: org admins can create/rename facilities in their org.
-- ---------------------------------------------------------------------------
drop policy if exists "org admins can insert facilities" on facilities;
create policy "org admins can insert facilities" on facilities
  for insert with check (is_organization_admin(auth.uid(), organization_id));

drop policy if exists "org admins can update facilities" on facilities;
create policy "org admins can update facilities" on facilities
  for update using (is_organization_admin(auth.uid(), organization_id))
  with check (is_organization_admin(auth.uid(), organization_id));

-- ---------------------------------------------------------------------------
-- (g) organization_module_settings: org admins get the write path (the flagship
-- gap), mirroring facility_module_overrides. The existing SELECT policy stays.
-- ---------------------------------------------------------------------------
drop policy if exists "org admins can manage org module settings" on organization_module_settings;
create policy "org admins can manage org module settings" on organization_module_settings
  for all using (is_organization_admin(auth.uid(), organization_id))
  with check (is_organization_admin(auth.uid(), organization_id));

-- ---------------------------------------------------------------------------
-- (b) Soft-delete leakage: recreate every tenant SELECT policy on a table that
-- has a deleted_at column so it excludes soft-deleted rows. Same policy names.
-- ---------------------------------------------------------------------------

-- 0002 daily reports
drop policy if exists "members can read departments" on departments;
create policy "members can read departments" on departments
  for select using (facility_id in (select current_facility_ids()) and deleted_at is null);

drop policy if exists "report readers can read templates" on report_templates;
create policy "report readers can read templates" on report_templates
  for select using (has_permission(auth.uid(), facility_id, 'reports.read') and deleted_at is null);

drop policy if exists "report readers can read submissions" on report_submissions;
create policy "report readers can read submissions" on report_submissions
  for select using (has_permission(auth.uid(), facility_id, 'reports.read') and deleted_at is null);

-- 0003 scheduling
drop policy if exists "members can read employees" on employees;
create policy "members can read employees" on employees
  for select using (facility_id in (select current_facility_ids()) and deleted_at is null);

drop policy if exists "members can read certification types" on certification_types;
create policy "members can read certification types" on certification_types
  for select using (facility_id in (select current_facility_ids()) and deleted_at is null);

drop policy if exists "members can read employee certifications" on employee_certifications;
create policy "members can read employee certifications" on employee_certifications
  for select using (facility_id in (select current_facility_ids()) and deleted_at is null);

drop policy if exists "schedule readers can read periods" on schedule_periods;
create policy "schedule readers can read periods" on schedule_periods
  for select using (has_permission(auth.uid(), facility_id, 'schedule.read') and deleted_at is null);

drop policy if exists "schedule readers can read shift templates" on shift_templates;
create policy "schedule readers can read shift templates" on shift_templates
  for select using (has_permission(auth.uid(), facility_id, 'schedule.read') and deleted_at is null);

drop policy if exists "schedule readers can read shifts" on schedule_shifts;
create policy "schedule readers can read shifts" on schedule_shifts
  for select using (has_permission(auth.uid(), facility_id, 'schedule.read') and deleted_at is null);

drop policy if exists "schedule readers can read assignments" on shift_assignments;
create policy "schedule readers can read assignments" on shift_assignments
  for select using (has_permission(auth.uid(), facility_id, 'schedule.read') and deleted_at is null);

-- 0004 incidents
drop policy if exists "incident readers can read reports" on incident_reports;
create policy "incident readers can read reports" on incident_reports
  for select using (has_permission(auth.uid(), facility_id, 'incidents.read') and deleted_at is null);

drop policy if exists "incident readers can read people" on incident_people;
create policy "incident readers can read people" on incident_people
  for select using (has_permission(auth.uid(), facility_id, 'incidents.read') and deleted_at is null);

drop policy if exists "incident readers can read attachments" on incident_attachments;
create policy "incident readers can read attachments" on incident_attachments
  for select using (has_permission(auth.uid(), facility_id, 'incidents.read') and deleted_at is null);

drop policy if exists "incident readers can read escalations" on incident_escalations;
create policy "incident readers can read escalations" on incident_escalations
  for select using (has_permission(auth.uid(), facility_id, 'incidents.read') and deleted_at is null);

drop policy if exists "incident readers can read followups" on incident_followup_actions;
create policy "incident readers can read followups" on incident_followup_actions
  for select using (has_permission(auth.uid(), facility_id, 'incidents.read') and deleted_at is null);

-- 0005 work orders
drop policy if exists "work order readers can read assets" on assets;
create policy "work order readers can read assets" on assets
  for select using (has_permission(auth.uid(), facility_id, 'work_orders.read') and deleted_at is null);

drop policy if exists "work order readers can read work orders" on work_orders;
create policy "work order readers can read work orders" on work_orders
  for select using (has_permission(auth.uid(), facility_id, 'work_orders.read') and deleted_at is null);

drop policy if exists "work order readers can read updates" on work_order_updates;
create policy "work order readers can read updates" on work_order_updates
  for select using (has_permission(auth.uid(), facility_id, 'work_orders.read') and deleted_at is null);

drop policy if exists "work order readers can read attachments" on work_order_attachments;
create policy "work order readers can read attachments" on work_order_attachments
  for select using (has_permission(auth.uid(), facility_id, 'work_orders.read') and deleted_at is null);

-- 0006 communications
drop policy if exists "communication readers can read channels" on communication_channels;
create policy "communication readers can read channels" on communication_channels
  for select using (has_permission(auth.uid(), facility_id, 'communications.read') and deleted_at is null);

drop policy if exists "communication readers can read messages" on messages;
create policy "communication readers can read messages" on messages
  for select using (has_permission(auth.uid(), facility_id, 'communications.read') and deleted_at is null);

drop policy if exists "communication readers can read audiences" on message_audiences;
create policy "communication readers can read audiences" on message_audiences
  for select using (has_permission(auth.uid(), facility_id, 'communications.read') and deleted_at is null);

-- 0007 training
drop policy if exists "training readers can read courses" on courses;
create policy "training readers can read courses" on courses
  for select using (has_permission(auth.uid(), facility_id, 'training.read') and deleted_at is null);

drop policy if exists "training readers can read modules" on course_modules;
create policy "training readers can read modules" on course_modules
  for select using (has_permission(auth.uid(), facility_id, 'training.read') and deleted_at is null);

drop policy if exists "training readers can read assignments" on training_assignments;
create policy "training readers can read assignments" on training_assignments
  for select using (has_permission(auth.uid(), facility_id, 'training.read') and deleted_at is null);

-- ---------------------------------------------------------------------------
-- (c)+(d) report_submissions: legal draft->submitted transition and cross-tenant
-- FK guard on template_id/template_version_id. The insert path is also guarded.
-- ---------------------------------------------------------------------------
drop policy if exists "report creators can create submissions" on report_submissions;
create policy "report creators can create submissions" on report_submissions
  for insert with check (
    has_permission(auth.uid(), facility_id, 'reports.create')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

drop policy if exists "report submitters can update drafts" on report_submissions;
create policy "report submitters can update drafts" on report_submissions
  for update using (
    has_permission(auth.uid(), facility_id, 'reports.submit') and status = 'draft'
  ) with check (
    has_permission(auth.uid(), facility_id, 'reports.submit')
    and status in ('draft', 'submitted')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

-- ---------------------------------------------------------------------------
-- (i) Message receipts/acknowledgements: an employee may write only their own
-- rows in facilities they can access with communications.read.
-- ---------------------------------------------------------------------------
drop policy if exists "employees can record their own receipts" on message_receipts;
create policy "employees can record their own receipts" on message_receipts
  for insert with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = message_receipts.employee_id
        and e.facility_id = message_receipts.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "employees can update their own receipts" on message_receipts;
create policy "employees can update their own receipts" on message_receipts
  for update using (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = message_receipts.employee_id
        and e.facility_id = message_receipts.facility_id
        and e.user_id = auth.uid()
    )
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = message_receipts.employee_id
        and e.facility_id = message_receipts.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "employees can record their own acknowledgements" on message_acknowledgements;
create policy "employees can record their own acknowledgements" on message_acknowledgements
  for insert with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = message_acknowledgements.employee_id
        and e.facility_id = message_acknowledgements.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "employees can update their own acknowledgements" on message_acknowledgements;
create policy "employees can update their own acknowledgements" on message_acknowledgements
  for update using (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = message_acknowledgements.employee_id
        and e.facility_id = message_acknowledgements.facility_id
        and e.user_id = auth.uid()
    )
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.read')
    and exists (
      select 1 from employees e
      where e.id = message_acknowledgements.employee_id
        and e.facility_id = message_acknowledgements.facility_id
        and e.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- (j) Data-integrity constraints and covering index (guarded for re-runs).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_periods_week_range_check'
  ) then
    alter table schedule_periods
      add constraint schedule_periods_week_range_check check (week_start_date <= week_end_date);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employee_certifications_valid_range_check'
  ) then
    alter table employee_certifications
      add constraint employee_certifications_valid_range_check check (issued_at <= expires_at);
  end if;
end;
$$;

create index if not exists messages_channel_id_idx on messages(channel_id);
