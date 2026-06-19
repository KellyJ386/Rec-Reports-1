-- =============================================================================
-- 20260616210000_facility.sql
-- Stream C — Facility Management: Forms & Inspections, Tasks, Utilization Counts,
-- SOPs, ERPs, Work Orders & Assets. Spec: MODULE_SPEC.md §3.
-- RLS on every table (CLAUDE.md §6). Catalog values from admin config (§5). Photos are
-- allowed on work orders only (CLAUDE.md §3.3). Append-only migration (§6).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §3.3 Forms & Inspections (dynamic, schema-driven; server-validated)
-- ---------------------------------------------------------------------------
create table public.form (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facility(id),
  form_category_id uuid references public.form_category(id),
  name             text not null,
  schema_json      jsonb not null default '[]'::jsonb,  -- ordered field definitions
  schedule         text not null default 'ad_hoc' check (schedule in ('ad_hoc','daily','weekly','event')),
  status           text not null default 'draft' check (status in ('draft','published','archived')),
  version_no       int not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users(id)
);
create index form_facility_idx on public.form (facility_id, status) where deleted_at is null;
create trigger form_updated before update on public.form for each row execute function public.set_updated_at();

create table public.form_response (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facility(id),
  form_id         uuid not null references public.form(id),
  form_version_no int not null,
  answers_json    jsonb not null default '{}'::jsonb,
  source          text not null default 'web' check (source in ('web','mobile','offline_sync')),
  submitted_by    uuid references auth.users(id),
  submitted_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id)
);
create index form_response_idx on public.form_response (facility_id, form_id, submitted_at desc) where deleted_at is null;
create trigger form_response_updated before update on public.form_response for each row execute function public.set_updated_at();

alter table public.form          enable row level security;
alter table public.form_response enable row level security;

create policy form_select on public.form
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy form_write on public.form
  for all using (public.has_facility_role(facility_id,'facility_manager'))
  with check (public.has_facility_role(facility_id,'facility_manager'));

-- Responses: author sees own; supervisor+ sees all. Any member may submit.
create policy form_response_select on public.form_response
  for select using (
    deleted_at is null and (created_by = auth.uid() or public.has_facility_role(facility_id,'supervisor'))
  );
create policy form_response_insert on public.form_response
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- §3.1 Tasks
-- ---------------------------------------------------------------------------
create table public.task (
  id                     uuid primary key default gen_random_uuid(),
  facility_id            uuid not null references public.facility(id),
  task_category_id       uuid references public.task_category(id),
  title                  text not null,
  description            text,
  priority               text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assigned_to            uuid references public.user_account(id),
  due_at                 timestamptz,
  recurrence             text not null default 'one_time' check (recurrence in ('one_time','daily','weekly','custom')),
  recurrence_rule        text,
  status                 text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  completion_notes       text,
  completion_signature_path text,
  source_type            text,
  source_ref_id          uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id),
  deleted_at             timestamptz,
  deleted_by             uuid references auth.users(id)
);
create index task_facility_idx on public.task (facility_id, status, due_at) where deleted_at is null;
create index task_assignee_idx on public.task (facility_id, assigned_to, status) where deleted_at is null;
create trigger task_updated before update on public.task for each row execute function public.set_updated_at();

alter table public.task enable row level security;
create policy task_select on public.task
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy task_insert on public.task
  for insert with check (public.has_facility_role(facility_id,'supervisor'));
-- Supervisor+ manage; the assignee may update their own task (e.g. complete).
create policy task_update on public.task
  for update using (
    public.has_facility_role(facility_id,'supervisor') or assigned_to = auth.uid()
  ) with check (
    public.has_facility_role(facility_id,'supervisor') or assigned_to = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- §3.2 Utilization Counts
-- ---------------------------------------------------------------------------
create table public.utilization_count (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references public.facility(id),
  count_area_id uuid references public.count_area(id),
  count_type_id uuid references public.count_type(id),
  counted_at    timestamptz not null default now(),
  count_value   int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id)
);
create index utilization_count_idx on public.utilization_count (facility_id, counted_at desc) where deleted_at is null;
create trigger utilization_count_updated before update on public.utilization_count for each row execute function public.set_updated_at();

alter table public.utilization_count enable row level security;
create policy utilization_count_select on public.utilization_count
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy utilization_count_insert on public.utilization_count
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());
create policy utilization_count_update on public.utilization_count
  for update using (created_by = auth.uid() or public.has_facility_role(facility_id,'supervisor'))
  with check (created_by = auth.uid() or public.has_facility_role(facility_id,'supervisor'));

-- ---------------------------------------------------------------------------
-- §3.4 SOPs
-- ---------------------------------------------------------------------------
create table public.sop (
  id                      uuid primary key default gen_random_uuid(),
  facility_id             uuid not null references public.facility(id),
  sop_category_id         uuid references public.sop_category(id),
  title                   text not null,
  current_version_no      int not null default 1,
  acknowledgment_required boolean not null default false,
  visibility_role         text not null default 'staff'
                            check (visibility_role in ('staff','supervisor','facility_manager','org_admin')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id),
  deleted_at              timestamptz,
  deleted_by              uuid references auth.users(id)
);
create trigger sop_updated before update on public.sop for each row execute function public.set_updated_at();

create table public.sop_version (
  id             uuid primary key default gen_random_uuid(),
  facility_id    uuid not null references public.facility(id),
  sop_id         uuid not null references public.sop(id),
  version_no     int not null,
  body_richtext  text,
  effective_at   timestamptz not null default now(),
  change_summary text,
  published_by   uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  unique (sop_id, version_no)
);

create table public.sop_acknowledgment (
  id             uuid primary key default gen_random_uuid(),
  facility_id    uuid not null references public.facility(id),
  sop_version_id uuid not null references public.sop_version(id),
  user_id        uuid not null references public.user_account(id),
  acknowledged_at timestamptz not null default now(),
  unique (sop_version_id, user_id)
);

alter table public.sop                enable row level security;
alter table public.sop_version        enable row level security;
alter table public.sop_acknowledgment enable row level security;

-- Visible to members whose role meets the SOP's visibility threshold.
create policy sop_select on public.sop
  for select using (
    deleted_at is null and public.has_facility_role(facility_id, visibility_role::public.facility_role)
  );
create policy sop_write on public.sop
  for all using (public.has_facility_role(facility_id,'facility_manager'))
  with check (public.has_facility_role(facility_id,'facility_manager'));

create policy sop_version_select on public.sop_version
  for select using (public.is_facility_member(facility_id));
create policy sop_version_write on public.sop_version
  for all using (public.has_facility_role(facility_id,'facility_manager'))
  with check (public.has_facility_role(facility_id,'facility_manager'));

create policy sop_ack_select on public.sop_acknowledgment
  for select using (user_id = auth.uid() or public.has_facility_role(facility_id,'supervisor'));
create policy sop_ack_insert on public.sop_acknowledgment
  for insert with check (public.is_facility_member(facility_id) and user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- §3.5 ERPs (always-accessible read-only per facility)
-- ---------------------------------------------------------------------------
create table public.erp (
  id                   uuid primary key default gen_random_uuid(),
  facility_id          uuid not null references public.facility(id),
  erp_scenario_type_id uuid references public.erp_scenario_type(id),
  erp_response_level_id uuid references public.erp_response_level(id),
  title                text not null,
  protocol_steps_json  jsonb not null default '[]'::jsonb,
  evacuation_ref       text,
  aed_ref              text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id),
  deleted_at           timestamptz,
  deleted_by           uuid references auth.users(id)
);
create trigger erp_updated before update on public.erp for each row execute function public.set_updated_at();

create table public.erp_role_assignment (
  id             uuid primary key default gen_random_uuid(),
  facility_id    uuid not null references public.facility(id),
  erp_id         uuid not null references public.erp(id) on delete cascade,
  role_label     text not null,
  responsibility text
);
create table public.erp_emergency_contact (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references public.facility(id),
  erp_id        uuid not null references public.erp(id) on delete cascade,
  name          text not null,
  phone         text,
  org           text,
  display_order int not null default 0
);

alter table public.erp                   enable row level security;
alter table public.erp_role_assignment   enable row level security;
alter table public.erp_emergency_contact enable row level security;

create policy erp_select on public.erp
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy erp_write on public.erp
  for all using (public.has_facility_role(facility_id,'facility_manager'))
  with check (public.has_facility_role(facility_id,'facility_manager'));
create policy erp_role_select on public.erp_role_assignment
  for select using (public.is_facility_member(facility_id));
create policy erp_role_write on public.erp_role_assignment
  for all using (public.has_facility_role(facility_id,'facility_manager'))
  with check (public.has_facility_role(facility_id,'facility_manager'));
create policy erp_contact_select on public.erp_emergency_contact
  for select using (public.is_facility_member(facility_id));
create policy erp_contact_write on public.erp_emergency_contact
  for all using (public.has_facility_role(facility_id,'facility_manager'))
  with check (public.has_facility_role(facility_id,'facility_manager'));

-- ---------------------------------------------------------------------------
-- §3.6 Work Orders & Assets (photos allowed here only)
-- ---------------------------------------------------------------------------
create table public.asset (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facility(id),
  asset_type_id   uuid references public.asset_type(id),
  area_id         uuid references public.area(id),
  name            text not null,
  asset_tag       text,
  pm_schedule_json jsonb not null default '{}'::jsonb,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id)
);
create trigger asset_updated before update on public.asset for each row execute function public.set_updated_at();

create table public.work_order (
  id                   uuid primary key default gen_random_uuid(),
  facility_id          uuid not null references public.facility(id),
  work_order_category_id uuid references public.work_order_category(id),
  asset_id             uuid references public.asset(id),
  title                text not null,
  description          text,
  priority             text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status               text not null default 'open'
                         check (status in ('open','assigned','in_progress','completed','closed')),
  assigned_to          uuid references public.user_account(id),
  due_at               timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id),
  deleted_at           timestamptz,
  deleted_by           uuid references auth.users(id)
);
create index work_order_idx on public.work_order (facility_id, status, priority) where deleted_at is null;
create trigger work_order_updated before update on public.work_order for each row execute function public.set_updated_at();

create table public.work_order_photo (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references public.facility(id),
  work_order_id uuid not null references public.work_order(id) on delete cascade,
  storage_path  text not null,
  checksum      text,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);

create table public.asset_inspection_history (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facility(id),
  asset_id         uuid not null references public.asset(id),
  form_response_id uuid references public.form_response(id),
  performed_at     timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

alter table public.asset                    enable row level security;
alter table public.work_order               enable row level security;
alter table public.work_order_photo         enable row level security;
alter table public.asset_inspection_history enable row level security;

create policy asset_select on public.asset
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy asset_write on public.asset
  for all using (public.has_facility_role(facility_id,'supervisor'))
  with check (public.has_facility_role(facility_id,'supervisor'));

create policy work_order_select on public.work_order
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy work_order_insert on public.work_order
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());
-- Supervisor+ manage (incl. assignment); the assignee may update their own work order.
create policy work_order_update on public.work_order
  for update using (
    public.has_facility_role(facility_id,'supervisor') or assigned_to = auth.uid()
  ) with check (
    public.has_facility_role(facility_id,'supervisor') or assigned_to = auth.uid()
  );

create policy work_order_photo_select on public.work_order_photo
  for select using (public.is_facility_member(facility_id));
create policy work_order_photo_insert on public.work_order_photo
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());

create policy asset_inspection_select on public.asset_inspection_history
  for select using (public.is_facility_member(facility_id));
create policy asset_inspection_write on public.asset_inspection_history
  for all using (public.has_facility_role(facility_id,'supervisor'))
  with check (public.has_facility_role(facility_id,'supervisor'));
