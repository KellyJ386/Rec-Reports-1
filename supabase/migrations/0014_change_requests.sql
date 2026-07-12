-- 0014_change_requests.sql
-- Draft -> review -> publish workflow depth (idempotent throughout).
-- admin_change_requests shipped with a status check constraint but no state
-- machine (0008:70) -- any UPDATE could jump straight from 'draft' to
-- 'published'. This migration:
--   * fn_enforce_change_request_transition(): a BEFORE UPDATE trigger that
--     enforces the legal transition graph (draft -> pending_review ->
--     approved|rejected -> published), requires reviewed_by/reviewed_at on
--     approve/reject, blocks self-approval, and stamps published_at on publish
--   * pdf_templates / pdf_template_bindings (design 3.8), facility-scoped,
--     admin.manage-gated, audited the same way every other admin config table
--     is (fn_audit_admin_change from 0010)
--
-- Idempotency conventions (mirroring 0009-0013): drop policy/trigger if
-- exists before every create; create or replace for functions; DO-block
-- guards for ALTERs; create table/index if not exists.

-- ---------------------------------------------------------------------------
-- (a) fn_enforce_change_request_transition(): BEFORE UPDATE trigger on
-- admin_change_requests. Only fires when status actually changes -- an
-- UPDATE that leaves status alone (e.g. editing change_summary) passes
-- through untouched. The legal transition graph mirrors
-- src/lib/admin/change-requests.mjs's TRANSITIONS table exactly, action for
-- action, so the API and the DB can never disagree about what's legal:
--   draft          -> pending_review   (submit)
--   pending_review -> approved         (approve)
--   pending_review -> rejected         (reject)
--   approved       -> published        (publish)
-- Any other (from, to) pair raises. approve/reject additionally require
-- reviewed_by/reviewed_at to already be set on the incoming row (the API
-- layer stamps both before issuing the UPDATE); approve further requires
-- reviewed_by to differ from requested_by (no self-approval). publish stamps
-- published_at automatically when the caller didn't already set it.
-- errcode insufficient_privilege matches the append-only/system-role guard
-- convention (0010/0012) so callers/tests can distinguish this from an
-- ordinary error.
-- ---------------------------------------------------------------------------
create or replace function fn_enforce_change_request_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status = 'draft' and new.status = 'pending_review')
    or (old.status = 'pending_review' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'published')
  ) then
    raise exception 'Illegal change request transition from % to %.', old.status, new.status
      using errcode = 'insufficient_privilege';
  end if;

  if new.status in ('approved', 'rejected') then
    if new.reviewed_by is null or new.reviewed_at is null then
      raise exception 'reviewed_by and reviewed_at are required when moving a change request to %.', new.status
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.status = 'approved' and new.reviewed_by = new.requested_by then
    raise exception 'A change request cannot be self-approved (reviewed_by must differ from requested_by).'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists admin_change_requests_enforce_transition on admin_change_requests;
create trigger admin_change_requests_enforce_transition
  before update on admin_change_requests
  for each row execute function fn_enforce_change_request_transition();

-- ---------------------------------------------------------------------------
-- (b) pdf_templates / pdf_template_bindings (design 3.8). Both carry a plain
-- facility_id (rather than requiring a join through the template) so RLS and
-- fn_audit_admin_change's default branch (facility_id = row.facility_id)
-- work exactly like every other admin config table.
-- ---------------------------------------------------------------------------
create table if not exists pdf_templates (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  template_code text not null,
  version_no integer not null default 1,
  engine_type text not null default 'html',
  layout_jsonb jsonb not null default '{}'::jsonb,
  css_blob text,
  active boolean not null default true,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, template_code, version_no)
);

create table if not exists pdf_template_bindings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  template_id uuid not null references pdf_templates(id) on delete cascade,
  module_code text not null,
  document_type text not null,
  scope_type text not null default 'facility' check (scope_type in ('facility', 'department')),
  scope_id uuid,
  created_at timestamptz not null default now(),
  unique (template_id, module_code, document_type, scope_type, scope_id)
);

create index if not exists pdf_templates_facility_idx on pdf_templates(facility_id, template_code, version_no desc);
create index if not exists pdf_template_bindings_facility_idx on pdf_template_bindings(facility_id);
create index if not exists pdf_template_bindings_template_idx on pdf_template_bindings(template_id);

alter table pdf_templates enable row level security;
alter table pdf_template_bindings enable row level security;

drop policy if exists "admins can manage pdf templates" on pdf_templates;
create policy "admins can manage pdf templates" on pdf_templates
  for all using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (has_permission(auth.uid(), facility_id, 'admin.manage'));

drop policy if exists "admins can manage pdf template bindings" on pdf_template_bindings;
create policy "admins can manage pdf template bindings" on pdf_template_bindings
  for all using (has_permission(auth.uid(), facility_id, 'admin.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'admin.manage')
    and fn_assert_same_facility(facility_id, 'pdf_templates', template_id)
  );

drop trigger if exists pdf_templates_audit_change on pdf_templates;
create trigger pdf_templates_audit_change
  after insert or update or delete on pdf_templates
  for each row execute function fn_audit_admin_change();

drop trigger if exists pdf_template_bindings_audit_change on pdf_template_bindings;
create trigger pdf_template_bindings_audit_change
  after insert or update or delete on pdf_template_bindings
  for each row execute function fn_audit_admin_change();
