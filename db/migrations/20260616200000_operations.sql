-- =============================================================================
-- 20260616200000_operations.sql
-- Stream B — Operations Core: Injury/Illness, Incident, Daily Log, Memo Board, EOD.
-- Spec: MODULE_SPEC.md §2. Report status machine Draft->Submitted->Reviewed->Closed
-- (CLAUDE.md §7) with lock-on-submit + immutable audit (§8). NO photos on injury/incident
-- (CLAUDE.md §3.3). Polymorphic person/witness children resolve the parent's facility.
-- Append-only migration (CLAUDE.md §6). Injury/incident retained >=7yr: no delete policy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Injury / Illness reports (§2.1) and Incident reports (§2.2)
-- Both share the report status columns so one trigger governs the state machine.
-- ---------------------------------------------------------------------------
create table public.injury_report (
  id                uuid primary key default gen_random_uuid(),
  facility_id       uuid not null references public.facility(id),
  incident_no       text not null,
  report_type       text not null default 'injury' check (report_type in ('injury', 'illness')),
  severity_level_id uuid references public.severity_level(id),
  area_id           uuid references public.area(id),
  occurred_at       timestamptz,
  reported_at       timestamptz not null default now(),
  summary           text,
  immediate_actions text,
  status            text not null default 'draft'
                      check (status in ('draft', 'submitted', 'reviewed', 'closed')),
  submitted_by      uuid references auth.users(id),
  submitted_at      timestamptz,
  reviewed_by       uuid references auth.users(id),
  reviewed_at       timestamptz,
  closed_at         timestamptz,
  legal_hold        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id),
  deleted_at        timestamptz,
  deleted_by        uuid references auth.users(id),
  unique (facility_id, incident_no)
);
create index injury_report_facility_idx
  on public.injury_report (facility_id, status, occurred_at desc) where deleted_at is null;
create trigger injury_report_updated before update on public.injury_report
  for each row execute function public.set_updated_at();

create table public.incident_report (
  id                  uuid primary key default gen_random_uuid(),
  facility_id         uuid not null references public.facility(id),
  incident_no         text not null,
  incident_category_id uuid references public.incident_category(id),
  severity_level_id   uuid references public.severity_level(id),
  area_id             uuid references public.area(id),
  occurred_at         timestamptz,
  reported_at         timestamptz not null default now(),
  summary             text,
  immediate_actions   text,
  status              text not null default 'draft'
                        check (status in ('draft', 'submitted', 'reviewed', 'closed')),
  submitted_by        uuid references auth.users(id),
  submitted_at        timestamptz,
  reviewed_by         uuid references auth.users(id),
  reviewed_at         timestamptz,
  closed_at           timestamptz,
  legal_hold          boolean not null default false,
  follow_up_required  boolean not null default false,
  follow_up_task_id   uuid,  -- stub FK -> task; wired in Phase 5 (nullable, no constraint yet)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),
  deleted_at          timestamptz,
  deleted_by          uuid references auth.users(id),
  unique (facility_id, incident_no)
);
create index incident_report_facility_idx
  on public.incident_report (facility_id, status, occurred_at desc) where deleted_at is null;
create trigger incident_report_updated before update on public.incident_report
  for each row execute function public.set_updated_at();

-- Polymorphic children. facility_id is derived from the parent by a trigger (never trusted
-- from the client); RLS resolves access via the parent (CLAUDE.md §6).
create table public.report_person (
  id          uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facility(id),
  parent_id   uuid not null,
  parent_type text not null check (parent_type in ('injury_report', 'incident_report')),
  person_role text not null default 'involved'
                check (person_role in ('injured', 'involved', 'completing')),
  full_name   text not null,
  contact     jsonb not null default '{}'::jsonb,  -- PII (encrypted at rest); minimized
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references auth.users(id)
);
create index report_person_parent_idx on public.report_person (parent_type, parent_id)
  where deleted_at is null;
create trigger report_person_updated before update on public.report_person
  for each row execute function public.set_updated_at();

create table public.report_witness (
  id          uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facility(id),
  parent_id   uuid not null,
  parent_type text not null check (parent_type in ('injury_report', 'incident_report')),
  full_name   text not null,
  contact     jsonb not null default '{}'::jsonb,  -- PII (encrypted at rest); minimized
  statement   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references auth.users(id)
);
create index report_witness_parent_idx on public.report_witness (parent_type, parent_id)
  where deleted_at is null;
create trigger report_witness_updated before update on public.report_witness
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Report status machine + lock-on-submit + audit (CLAUDE.md §7, §8).
-- SECURITY DEFINER justification (§3.6): writes immutable audit_event rows (RLS blocks
-- direct writes) and reads role via helpers. Governs injury_report + incident_report.
-- ---------------------------------------------------------------------------
create or replace function public.guard_report_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor  uuid := auth.uid();
  is_sup boolean;
  is_mgr boolean;
begin
  is_sup := public.has_facility_role(coalesce(new.facility_id, old.facility_id), 'supervisor');
  is_mgr := public.has_facility_role(coalesce(new.facility_id, old.facility_id), 'facility_manager');

  if tg_op = 'INSERT' then
    if new.status is null then new.status := 'draft'; end if;
    insert into public.audit_event (facility_id, actor_user_id, entity_type, entity_id, action, before, after)
      values (new.facility_id, actor, tg_table_name, new.id, 'create', null, to_jsonb(new));
    return new;
  end if;

  -- UPDATE: facility never changes.
  if new.facility_id <> old.facility_id then
    raise exception 'facility_id is immutable on a report';
  end if;

  if not is_sup then
    -- Author path: editable only while draft (lock-on-submit), may submit.
    if old.status <> 'draft' then
      raise exception 'report is locked (status %): edits require a supervisor', old.status;
    end if;
    if new.status not in ('draft', 'submitted') then
      raise exception 'staff may only submit a draft, not set status %', new.status;
    end if;
  else
    -- Supervisor+ transitions.
    if old.status = 'draft' and new.status not in ('draft', 'submitted') then
      raise exception 'invalid transition draft -> %', new.status;
    elsif old.status = 'submitted' and new.status not in ('submitted', 'reviewed') then
      raise exception 'invalid transition submitted -> %', new.status;
    elsif old.status = 'reviewed' and new.status not in ('reviewed', 'closed') then
      raise exception 'invalid transition reviewed -> %', new.status;
    elsif old.status = 'closed' and new.status <> 'closed' then
      if not is_mgr then
        raise exception 'reopening a closed report requires a facility manager';
      end if;
      if new.status <> 'reviewed' then
        raise exception 'a closed report can only be reopened to reviewed';
      end if;
    end if;
  end if;

  -- Stamp transition metadata.
  if new.status = 'submitted' and old.status = 'draft' then
    new.submitted_at := now(); new.submitted_by := actor;
  end if;
  if new.status = 'reviewed' and old.status is distinct from 'reviewed' then
    new.reviewed_at := now(); new.reviewed_by := actor;
  end if;
  if new.status = 'closed' and old.status is distinct from 'closed' then
    new.closed_at := now();
  end if;

  insert into public.audit_event (facility_id, actor_user_id, entity_type, entity_id, action, before, after)
    values (
      new.facility_id, actor, tg_table_name, new.id,
      case when new.status is distinct from old.status then 'status_change' else 'edit' end,
      to_jsonb(old), to_jsonb(new)
    );
  return new;
end;
$$;

create trigger injury_report_guard
  before insert or update on public.injury_report
  for each row execute function public.guard_report_state();
create trigger incident_report_guard
  before insert or update on public.incident_report
  for each row execute function public.guard_report_state();

-- ---------------------------------------------------------------------------
-- Polymorphic access helpers + facility derivation.
-- ---------------------------------------------------------------------------
-- Reliable parent facility lookup (DEFINER: needed by the child facility-derivation
-- trigger regardless of RLS visibility; read-only, single uuid out).
create or replace function public.report_parent_facility(p_parent_id uuid, p_parent_type text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare fid uuid;
begin
  if p_parent_type = 'injury_report' then
    select facility_id into fid from public.injury_report where id = p_parent_id;
  elsif p_parent_type = 'incident_report' then
    select facility_id into fid from public.incident_report where id = p_parent_id;
  end if;
  return fid;
end;
$$;

-- Can the caller READ the parent report? (INVOKER: relies on the parent's own RLS — a
-- hidden draft simply returns no row, so access follows the parent exactly.)
create or replace function public.can_read_report(p_parent_id uuid, p_parent_type text)
returns boolean
language plpgsql
stable
as $$
declare r record;
begin
  if p_parent_type = 'injury_report' then
    select facility_id, created_by, status into r from public.injury_report where id = p_parent_id;
  elsif p_parent_type = 'incident_report' then
    select facility_id, created_by, status into r from public.incident_report where id = p_parent_id;
  else
    return false;
  end if;
  if not found then return false; end if;
  return r.created_by = auth.uid()
      or (r.status <> 'draft' and public.has_facility_role(r.facility_id, 'supervisor'));
end;
$$;

-- Can the caller WRITE children of the parent? (author while draft, or supervisor+).
create or replace function public.can_write_report(p_parent_id uuid, p_parent_type text)
returns boolean
language plpgsql
stable
as $$
declare r record;
begin
  if p_parent_type = 'injury_report' then
    select facility_id, created_by, status into r from public.injury_report where id = p_parent_id;
  elsif p_parent_type = 'incident_report' then
    select facility_id, created_by, status into r from public.incident_report where id = p_parent_id;
  else
    return false;
  end if;
  if not found then return false; end if;
  return (r.created_by = auth.uid() and r.status = 'draft')
      or public.has_facility_role(r.facility_id, 'supervisor');
end;
$$;

-- Derive the child's facility_id from its parent (never trusted from client).
create or replace function public.set_report_child_facility()
returns trigger
language plpgsql
as $$
begin
  new.facility_id := public.report_parent_facility(new.parent_id, new.parent_type);
  if new.facility_id is null then
    raise exception 'invalid report parent %/%', new.parent_type, new.parent_id;
  end if;
  return new;
end;
$$;

create trigger report_person_facility before insert or update on public.report_person
  for each row execute function public.set_report_child_facility();
create trigger report_witness_facility before insert or update on public.report_witness
  for each row execute function public.set_report_child_facility();

-- ---------------------------------------------------------------------------
-- RLS: injury_report / incident_report
--   read: author, or supervisor+ once it leaves draft (Draft invisible to reviewers, §7).
--   insert: any member, authoring their own draft.
--   update: author or supervisor+ (the trigger enforces lock + valid transitions).
--   (no delete policy — >=7yr retention, CLAUDE.md §8.)
-- ---------------------------------------------------------------------------
alter table public.injury_report   enable row level security;
alter table public.incident_report enable row level security;
alter table public.report_person   enable row level security;
alter table public.report_witness  enable row level security;

create policy injury_report_select on public.injury_report
  for select using (
    deleted_at is null and (
      created_by = auth.uid()
      or (status <> 'draft' and public.has_facility_role(facility_id, 'supervisor'))
    )
  );
create policy injury_report_insert on public.injury_report
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());
create policy injury_report_update on public.injury_report
  for update using (
    deleted_at is null and (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'))
  ) with check (
    public.is_facility_member(facility_id) and (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'))
  );

create policy incident_report_select on public.incident_report
  for select using (
    deleted_at is null and (
      created_by = auth.uid()
      or (status <> 'draft' and public.has_facility_role(facility_id, 'supervisor'))
    )
  );
create policy incident_report_insert on public.incident_report
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());
create policy incident_report_update on public.incident_report
  for update using (
    deleted_at is null and (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'))
  ) with check (
    public.is_facility_member(facility_id) and (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'))
  );

-- Children: access strictly follows the parent (facility derived by trigger).
create policy report_person_select on public.report_person
  for select using (deleted_at is null and public.can_read_report(parent_id, parent_type));
create policy report_person_insert on public.report_person
  for insert with check (public.can_write_report(parent_id, parent_type));
create policy report_person_update on public.report_person
  for update using (public.can_write_report(parent_id, parent_type))
  with check (public.can_write_report(parent_id, parent_type));

create policy report_witness_select on public.report_witness
  for select using (deleted_at is null and public.can_read_report(parent_id, parent_type));
create policy report_witness_insert on public.report_witness
  for insert with check (public.can_write_report(parent_id, parent_type));
create policy report_witness_update on public.report_witness
  for update using (public.can_write_report(parent_id, parent_type))
  with check (public.can_write_report(parent_id, parent_type));

-- ---------------------------------------------------------------------------
-- §2.3 Daily Log
-- ---------------------------------------------------------------------------
create table public.daily_log_entry (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facility(id),
  log_date        date not null default current_date,
  area_id         uuid references public.area(id),
  task_category_id uuid references public.task_category(id),
  body            text not null,
  entry_at        timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id)
);
create index daily_log_entry_idx on public.daily_log_entry (facility_id, log_date desc)
  where deleted_at is null;
create trigger daily_log_entry_updated before update on public.daily_log_entry
  for each row execute function public.set_updated_at();

create table public.daily_log_entry_tag (
  id                 uuid primary key default gen_random_uuid(),
  facility_id        uuid not null references public.facility(id),
  daily_log_entry_id uuid not null references public.daily_log_entry(id) on delete cascade,
  user_id            uuid not null references public.user_account(id),
  created_at         timestamptz not null default now(),
  unique (daily_log_entry_id, user_id)
);

alter table public.daily_log_entry     enable row level security;
alter table public.daily_log_entry_tag enable row level security;

-- Daily Log is a shared operational log (facility-wide read for members); authors/supervisors edit.
create policy daily_log_select on public.daily_log_entry
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy daily_log_insert on public.daily_log_entry
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());
create policy daily_log_update on public.daily_log_entry
  for update using (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'))
  with check (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'));

create policy daily_log_tag_select on public.daily_log_entry_tag
  for select using (public.is_facility_member(facility_id));
create policy daily_log_tag_write on public.daily_log_entry_tag
  for all using (public.is_facility_member(facility_id))
  with check (public.is_facility_member(facility_id));

-- ---------------------------------------------------------------------------
-- §2.5 Memo Board
-- ---------------------------------------------------------------------------
create table public.memo (
  id             uuid primary key default gen_random_uuid(),
  facility_id    uuid not null references public.facility(id),
  to_group_id    uuid references public.recipient_group(id),
  from_user_id   uuid not null references public.user_account(id),
  subject        text not null,
  body_richtext  text,
  priority       text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  optional_email boolean not null default false,
  posted_at      timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by     uuid references auth.users(id)
);
create index memo_idx on public.memo (facility_id, posted_at desc) where deleted_at is null;
create trigger memo_updated before update on public.memo
  for each row execute function public.set_updated_at();

create table public.memo_receipt (
  id          uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facility(id),
  memo_id     uuid not null references public.memo(id) on delete cascade,
  user_id     uuid not null references public.user_account(id),
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (memo_id, user_id)
);

alter table public.memo         enable row level security;
alter table public.memo_receipt enable row level security;

create policy memo_select on public.memo
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy memo_write on public.memo
  for all using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));

-- A member reads/writes their OWN receipts (mark-as-read); supervisor+ may read all.
create policy memo_receipt_select on public.memo_receipt
  for select using (
    user_id = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
  );
create policy memo_receipt_insert on public.memo_receipt
  for insert with check (public.is_facility_member(facility_id) and user_id = auth.uid());
create policy memo_receipt_update on public.memo_receipt
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- §2.4 EOD Report (one per facility per day; auto-lock at configurable cutoff)
-- ---------------------------------------------------------------------------
create table public.eod_report (
  id                 uuid primary key default gen_random_uuid(),
  facility_id        uuid not null references public.facility(id),
  report_date        date not null default current_date,
  summary            text,
  fields             jsonb not null default '{}'::jsonb,
  incidents_occurred boolean not null default false,
  equipment_issues   boolean not null default false,
  status             text not null default 'draft' check (status in ('draft', 'submitted', 'locked')),
  submitted_by       uuid references auth.users(id),
  submitted_at       timestamptz,
  locked_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users(id),
  unique (facility_id, report_date)
);
create trigger eod_report_updated before update on public.eod_report
  for each row execute function public.set_updated_at();

alter table public.eod_report enable row level security;
create policy eod_select on public.eod_report
  for select using (deleted_at is null and public.is_facility_member(facility_id));
create policy eod_insert on public.eod_report
  for insert with check (public.is_facility_member(facility_id) and created_by = auth.uid());
create policy eod_update on public.eod_report
  for update using (
    deleted_at is null and status <> 'locked'
    and (created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor'))
  ) with check (
    created_by = auth.uid() or public.has_facility_role(facility_id, 'supervisor')
  );
