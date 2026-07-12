-- 0015_forms.sql
-- Forms & Fields (lite) -- design 3.4 (idempotent throughout).
-- Three facility-scoped tables that let an admin register reusable custom
-- fields, version a form definition (draft -> published -> retired), and bind
-- fields into a form by key:
--   * custom_fields         -- the per-facility field registry
--   * form_definitions      -- a versioned form (unique per facility+form_code+version)
--   * form_field_bindings   -- ordered field references inside one form version
--
-- Writes are gated on the EXISTING 'reports.template.manage' permission code
-- (the report-template governance code from the 16-code catalog); reads are
-- open to any facility member. Every table carries fn_audit_admin_change
-- (0010) so config mutations land in the append-only audit trail exactly like
-- every other admin config table.
--
-- form_field_bindings reference fields by key (a plain text field_key), so no
-- cross-facility FK guard to custom_fields is required -- but the binding's own
-- facility_id must match its parent form_definition's, which is enforced with a
-- join-based WITH CHECK via fn_assert_same_facility (0009).
--
-- Idempotency conventions (mirroring 0009-0014): drop policy/trigger if exists
-- before every create; create table/index if not exists.

-- ---------------------------------------------------------------------------
-- (a) custom_fields -- the facility-scoped field registry. entity_type scopes
-- a key to a domain (e.g. 'report', 'incident'); (facility_id, entity_type,
-- key) is unique so a key means one thing within its entity domain.
-- ---------------------------------------------------------------------------
create table if not exists custom_fields (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  entity_type text not null default 'report',
  key text not null,
  label text not null,
  data_type text not null default 'text',
  validation_jsonb jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, entity_type, key)
);

-- ---------------------------------------------------------------------------
-- (b) form_definitions -- a versioned form. status is a plain enum-by-check
-- (draft|published|retired); (facility_id, form_code, version_no) is unique so
-- publishing a new draft always lands on version n+1 for that form_code.
-- ---------------------------------------------------------------------------
create table if not exists form_definitions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  module_code text not null,
  form_code text not null,
  version_no integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  schema_jsonb jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, form_code, version_no)
);

-- ---------------------------------------------------------------------------
-- (c) form_field_bindings -- ordered field references inside one form version.
-- Carries facility_id (rather than resolving it through the parent) so RLS and
-- fn_audit_admin_change's default branch work like every other config table;
-- the WITH CHECK below asserts that facility_id matches the parent
-- form_definition's facility.
-- ---------------------------------------------------------------------------
create table if not exists form_field_bindings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  form_definition_id uuid not null references form_definitions(id) on delete cascade,
  field_key text not null,
  display_order integer not null default 0,
  required boolean not null default false,
  conditional_rule_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (form_definition_id, field_key)
);

create index if not exists custom_fields_facility_idx on custom_fields(facility_id, entity_type) where active;
create index if not exists form_definitions_facility_idx on form_definitions(facility_id, module_code, form_code);
create index if not exists form_field_bindings_form_idx on form_field_bindings(form_definition_id, display_order);

alter table custom_fields enable row level security;
alter table form_definitions enable row level security;
alter table form_field_bindings enable row level security;

-- Reads: any facility member. Writes: reports.template.manage on the facility.
drop policy if exists "members can read custom fields" on custom_fields;
create policy "members can read custom fields" on custom_fields
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "template managers can manage custom fields" on custom_fields;
create policy "template managers can manage custom fields" on custom_fields
  for all using (has_permission(auth.uid(), facility_id, 'reports.template.manage'))
  with check (has_permission(auth.uid(), facility_id, 'reports.template.manage'));

drop policy if exists "members can read form definitions" on form_definitions;
create policy "members can read form definitions" on form_definitions
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "template managers can manage form definitions" on form_definitions;
create policy "template managers can manage form definitions" on form_definitions
  for all using (has_permission(auth.uid(), facility_id, 'reports.template.manage'))
  with check (has_permission(auth.uid(), facility_id, 'reports.template.manage'));

drop policy if exists "members can read form field bindings" on form_field_bindings;
create policy "members can read form field bindings" on form_field_bindings
  for select using (facility_id in (select current_facility_ids()));

-- Join-based WITH CHECK: a binding may only be written when its facility_id
-- matches the parent form_definition's facility (fn_assert_same_facility joins
-- through form_definitions), closing the cross-facility injection path.
drop policy if exists "template managers can manage form field bindings" on form_field_bindings;
create policy "template managers can manage form field bindings" on form_field_bindings
  for all using (has_permission(auth.uid(), facility_id, 'reports.template.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and fn_assert_same_facility(facility_id, 'form_definitions', form_definition_id)
  );

drop trigger if exists custom_fields_audit_change on custom_fields;
create trigger custom_fields_audit_change
  after insert or update or delete on custom_fields
  for each row execute function fn_audit_admin_change();

drop trigger if exists form_definitions_audit_change on form_definitions;
create trigger form_definitions_audit_change
  after insert or update or delete on form_definitions
  for each row execute function fn_audit_admin_change();

drop trigger if exists form_field_bindings_audit_change on form_field_bindings;
create trigger form_field_bindings_audit_change
  after insert or update or delete on form_field_bindings
  for each row execute function fn_audit_admin_change();
