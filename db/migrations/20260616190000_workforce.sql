-- =============================================================================
-- 20260616190000_workforce.sql
-- Stream A — Workforce: Staff Certifications + Employee Scheduling.
-- Spec: MODULE_SPEC.md §4.1 (scheduling), §4.2 (certifications). Build certs first; the
-- conflict engine (§4.1.2) reads cert + job_area_required_cert.
-- RLS on every table (CLAUDE.md §6). Statuses are workflow enums via CHECK (not admin
-- config). Append-only migration (CLAUDE.md §6).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §4.2 Staff Certifications
-- ---------------------------------------------------------------------------
create table public.staff_certification (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references public.facility(id),
  user_id       uuid not null references public.user_account(id),
  cert_type_id  uuid not null references public.cert_type(id),
  issued_on     date,
  expires_on    date,
  document_url  text,                 -- Supabase Storage path; served via signed URL
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id)
);
create index staff_certification_user_idx
  on public.staff_certification (facility_id, user_id) where deleted_at is null;
create index staff_certification_expiry_idx
  on public.staff_certification (facility_id, expires_on) where deleted_at is null;
create trigger staff_certification_updated before update on public.staff_certification
  for each row execute function public.set_updated_at();

-- Auto status from expiry + the cert type's renewal window (MODULE_SPEC.md §4.2).
-- STABLE (reads current_date), not IMMUTABLE.
create or replace function public.cert_computed_status(p_expires_on date, p_renewal_window_days int)
returns text
language sql
stable
as $$
  select case
    when p_expires_on is null then 'active'
    when p_expires_on < current_date then 'expired'
    when p_expires_on <= current_date + make_interval(days => coalesce(p_renewal_window_days, 0)) then 'expiring'
    else 'active'
  end;
$$;

-- Convenience view exposing computed status + days-to-expiry (RLS is inherited from the
-- base tables; the view runs with the querying user's privileges).
create view public.staff_certification_status as
  select sc.*,
         ct.name as cert_type_name,
         ct.renewal_window_days,
         public.cert_computed_status(sc.expires_on, ct.renewal_window_days) as status,
         (sc.expires_on - current_date) as days_to_expiry
  from public.staff_certification sc
  join public.cert_type ct on ct.id = sc.cert_type_id
  where sc.deleted_at is null;

alter table public.staff_certification enable row level security;

-- Staff see/manage their OWN certs; supervisor+ manage all at the facility (§4.2).
create policy staff_certification_select on public.staff_certification
  for select using (
    deleted_at is null and (
      user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
    )
  );
create policy staff_certification_insert on public.staff_certification
  for insert with check (
    public.is_facility_member(facility_id) and (
      user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
    )
  );
create policy staff_certification_update on public.staff_certification
  for update using (
    user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
  ) with check (
    public.is_facility_member(facility_id) and (
      user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
    )
  );

-- ---------------------------------------------------------------------------
-- §4.1 Scheduling
-- ---------------------------------------------------------------------------
create table public.schedule_period (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facility(id),
  week_start_date date not null,
  week_end_date   date not null,
  status          text not null default 'draft'
                    check (status in ('draft', 'published', 'locked')),
  publish_version int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id),
  unique (facility_id, week_start_date)
);
create trigger schedule_period_updated before update on public.schedule_period
  for each row execute function public.set_updated_at();

create table public.shift_template (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facility(id),
  job_area_id      uuid not null references public.job_area(id),
  area_id          uuid references public.area(id),
  days_of_week     int[] not null default '{}',     -- 0=Sun .. 6=Sat
  start_time_local time not null,
  end_time_local   time not null,
  required_count   int not null default 1,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users(id)
);
create trigger shift_template_updated before update on public.shift_template
  for each row execute function public.set_updated_at();

create table public.shift (
  id                 uuid primary key default gen_random_uuid(),
  facility_id        uuid not null references public.facility(id),
  schedule_period_id uuid not null references public.schedule_period(id),
  job_area_id        uuid not null references public.job_area(id),
  area_id            uuid references public.area(id),
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             text not null default 'draft'
                       check (status in ('draft', 'open', 'assigned', 'published', 'cancelled')),
  source             text not null default 'manual' check (source in ('template', 'manual')),
  required_count     int not null default 1,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users(id)
);
create index shift_period_idx on public.shift (facility_id, schedule_period_id)
  where deleted_at is null;
create index shift_time_idx on public.shift (facility_id, starts_at) where deleted_at is null;
create trigger shift_updated before update on public.shift
  for each row execute function public.set_updated_at();

create table public.shift_assignment (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facility(id),
  shift_id        uuid not null references public.shift(id),
  user_id         uuid not null references public.user_account(id),
  assignment_type text not null default 'primary'
                    check (assignment_type in ('primary', 'cover')),
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'declined', 'cancelled')),
  assigned_by     uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id),
  unique (shift_id, user_id)
);
create index shift_assignment_user_idx
  on public.shift_assignment (facility_id, user_id, status) where deleted_at is null;
create trigger shift_assignment_updated before update on public.shift_assignment
  for each row execute function public.set_updated_at();

create table public.availability (
  id                 uuid primary key default gen_random_uuid(),
  facility_id        uuid not null references public.facility(id),
  user_id            uuid not null references public.user_account(id),
  weekday            int not null check (weekday between 0 and 6),
  unavailable        boolean not null default false,
  available_start    time,
  available_end      time,
  max_hours_per_day  int,
  max_hours_per_week int,
  doubles_allowed    boolean not null default true,
  effective_from     date not null default current_date,
  effective_to       date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users(id)
);
create index availability_user_idx
  on public.availability (facility_id, user_id, weekday) where deleted_at is null;
create trigger availability_updated before update on public.availability
  for each row execute function public.set_updated_at();

create table public.swap_request (
  id                     uuid primary key default gen_random_uuid(),
  facility_id            uuid not null references public.facility(id),
  offered_assignment_id  uuid not null references public.shift_assignment(id),
  requested_assignment_id uuid references public.shift_assignment(id),
  requester_user_id      uuid not null references public.user_account(id),
  target_user_id         uuid references public.user_account(id),
  swap_type              text not null default 'direct'
                           check (swap_type in ('direct', 'drop_pickup')),
  status                 text not null default 'pending'
                           check (status in ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  reason                 text,
  decided_by             uuid references auth.users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id),
  deleted_at             timestamptz,
  deleted_by             uuid references auth.users(id)
);
create trigger swap_request_updated before update on public.swap_request
  for each row execute function public.set_updated_at();

create table public.schedule_delivery (
  id                  uuid primary key default gen_random_uuid(),
  facility_id         uuid not null references public.facility(id),
  schedule_period_id  uuid not null references public.schedule_period(id),
  recipient_user_id   uuid not null references public.user_account(id),
  channel             text not null default 'email' check (channel in ('email', 'in_app')),
  status              text not null default 'queued'
                        check (status in ('queued', 'sent', 'failed')),
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index schedule_delivery_idx
  on public.schedule_delivery (facility_id, schedule_period_id);
create trigger schedule_delivery_updated before update on public.schedule_delivery
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: scheduling artifacts readable by members; managed by supervisor+.
-- availability is self-scoped (staff manage own; supervisor+ read all).
-- ---------------------------------------------------------------------------
alter table public.schedule_period   enable row level security;
alter table public.shift_template    enable row level security;
alter table public.shift             enable row level security;
alter table public.shift_assignment  enable row level security;
alter table public.availability      enable row level security;
alter table public.swap_request      enable row level security;
alter table public.schedule_delivery enable row level security;

create policy schedule_period_select on public.schedule_period
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy schedule_period_write on public.schedule_period
  for all using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));

create policy shift_template_select on public.shift_template
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy shift_template_write on public.shift_template
  for all using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));

create policy shift_select on public.shift
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy shift_write on public.shift
  for all using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));

create policy shift_assignment_select on public.shift_assignment
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy shift_assignment_write on public.shift_assignment
  for all using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));

-- availability: self-service for staff; supervisor+ may view/edit all.
create policy availability_select on public.availability
  for select using (
    deleted_at is null and (
      user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
    )
  );
create policy availability_insert on public.availability
  for insert with check (
    public.is_facility_member(facility_id) and (
      user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
    )
  );
create policy availability_update on public.availability
  for update using (
    user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
  ) with check (
    user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
  );

-- swap_request: members read; a staffer can open a swap for their OWN assignment;
-- supervisor+ approve/deny (manage).
create policy swap_request_select on public.swap_request
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy swap_request_insert on public.swap_request
  for insert with check (
    public.is_facility_member(facility_id) and requester_user_id = auth.uid()
  );
create policy swap_request_update on public.swap_request
  for update using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));

create policy schedule_delivery_select on public.schedule_delivery
  for select using (public.has_facility_role(facility_id, 'supervisor'));
create policy schedule_delivery_write on public.schedule_delivery
  for all using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));
