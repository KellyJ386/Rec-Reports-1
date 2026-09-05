-- ===========================================================================
-- 0028_report_template_writes.sql
-- DR-02 (plans/DAILY_REPORTS_PLAN.md): write-side RLS for report_templates and
-- report_template_versions (0002). Both tables have carried SELECT-only
-- policies since 0002/0009 -- there has never been an INSERT/UPDATE path for
-- either, so templates were only manageable via service-role/seed. This
-- migration closes that gap without touching report_submissions or any other
-- table.
--
--   * report_templates      -- INSERT/UPDATE gated on reports.template.manage
--                               (the existing catalog code, same one 0015's
--                               form_definitions/custom_fields already use).
--                               Archival is a plain status='archived' UPDATE
--                               (the check constraint from 0002 already allows
--                               it); there is deliberately no DELETE policy.
--   * report_template_versions -- INSERT/UPDATE gated the same way, plus a
--                               join-based fn_assert_same_facility (0009)
--                               guard on template_id so a version's
--                               facility_id can never be spoofed to disagree
--                               with its parent template's facility.
--
-- Immutability: once a version's is_published flag is true, the row is
-- immutable -- enforced with a BEFORE UPDATE trigger, not just RLS, so it
-- holds regardless of which permission the caller has (mirrors 0014's
-- fn_enforce_change_request_transition: raise with
-- errcode = 'insufficient_privilege' so callers/tests can tell this apart
-- from an ordinary error, exactly like the 0015 form_definitions draft-only
-- edit rule enforces "only drafts are editable" -- that one at the
-- application layer in src/lib/admin/forms.mjs's buildFormDraftUpdate, this
-- one at the database layer because report_template_versions has no
-- service-role-only authoring surface to lean on).
--
-- report_templates.active_version is a bare integer (version_number), not an
-- FK -- a second BEFORE INSERT OR UPDATE trigger asserts that whenever it is
-- set (non-null), it names a version_number that actually exists, belongs to
-- this template, and is published. This is what keeps "active_version always
-- points at a published version of the same template" true by construction
-- rather than by convention, the same way fn_assert_same_facility keeps
-- cross-tenant FK injection impossible by construction.
--
-- Idempotency conventions (mirroring 0009-0026): drop policy/trigger if
-- exists before every create; create or replace for functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) fn_report_template_version_immutable(): BEFORE UPDATE trigger on
-- report_template_versions. Once a row is published (old.is_published =
-- true), ANY further UPDATE raises -- including an attempt to flip
-- is_published back to false. The publish transition itself (old.is_published
-- = false -> new.is_published = true) is unaffected, since the guard only
-- looks at OLD.
-- ---------------------------------------------------------------------------
create or replace function fn_report_template_version_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.is_published then
    raise exception 'report_template_versions % is published and immutable.', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists report_template_versions_immutable on report_template_versions;
create trigger report_template_versions_immutable
  before update on report_template_versions
  for each row execute function fn_report_template_version_immutable();

-- ---------------------------------------------------------------------------
-- (b) fn_report_template_active_version_published(): BEFORE INSERT OR UPDATE
-- trigger on report_templates. When active_version is non-null, requires a
-- matching report_template_versions row (same template_id, same
-- version_number) with is_published = true. security definer + a fixed
-- search_path so the check itself is not subject to the caller's own RLS
-- visibility (mirrors fn_assert_same_facility, 0009).
-- ---------------------------------------------------------------------------
create or replace function fn_report_template_active_version_published()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.active_version is not null and not exists (
    select 1
    from report_template_versions v
    where v.template_id = new.id
      and v.version_number = new.active_version
      and v.is_published = true
  ) then
    raise exception 'active_version % for template % must name a published version of that template.', new.active_version, new.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists report_templates_active_version_published on report_templates;
create trigger report_templates_active_version_published
  before insert or update on report_templates
  for each row execute function fn_report_template_active_version_published();

-- ---------------------------------------------------------------------------
-- (c) report_templates: INSERT/UPDATE gated on reports.template.manage.
-- USING excludes soft-deleted rows (0026 convention); WITH CHECK is left free
-- of the deleted_at predicate for the same reason 0026 documents (Postgres
-- already refuses a write whose resulting row would be invisible under the
-- actor's own SELECT-applicable policy). No DELETE policy: archival is a
-- status='archived' UPDATE, not a row deletion.
-- ---------------------------------------------------------------------------
drop policy if exists "template managers can insert report templates" on report_templates;
create policy "template managers can insert report templates" on report_templates
  for insert with check (has_permission(auth.uid(), facility_id, 'reports.template.manage'));

drop policy if exists "template managers can update report templates" on report_templates;
create policy "template managers can update report templates" on report_templates
  for update using (has_permission(auth.uid(), facility_id, 'reports.template.manage') and deleted_at is null)
  with check (has_permission(auth.uid(), facility_id, 'reports.template.manage'));

-- ---------------------------------------------------------------------------
-- (d) report_template_versions: INSERT/UPDATE gated on
-- reports.template.manage, plus fn_assert_same_facility(facility_id,
-- 'report_templates', template_id) so a version can never be written with a
-- facility_id that disagrees with its parent template's. No deleted_at column
-- on this table, so no soft-delete predicate is needed. No DELETE policy.
-- ---------------------------------------------------------------------------
drop policy if exists "template managers can insert report template versions" on report_template_versions;
create policy "template managers can insert report template versions" on report_template_versions
  for insert with check (
    has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
  );

drop policy if exists "template managers can update report template versions" on report_template_versions;
create policy "template managers can update report template versions" on report_template_versions
  for update using (has_permission(auth.uid(), facility_id, 'reports.template.manage'))
  with check (
    has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
  );
