-- ===========================================================================
-- 0033_report_audit_and_scope.sql
-- DR-10 + DR-11 (plans/DAILY_REPORTS_PLAN.md).
--
-- DR-10: submission lifecycle audit events. A DB trigger (not a route-level
-- write) is used deliberately, mirroring fn_audit_admin_change (0010): a
-- trigger covers every write path (the end-user API in reports-routes.mjs,
-- any future service-role import, any future offline-sync writer, DR-25)
-- with a single source of truth, and its INSERT into audit_events runs
-- through the SAME hash-chain trigger (fn_audit_chain_link, 0013/0019) that
-- already links every other audit row, so a submission's lifecycle becomes
-- part of the tamper-evident chain for free instead of a second, parallel
-- audit mechanism the route layer would have to keep in sync by hand.
--
-- DR-11: department-scoped reports RLS. Switches report_templates' SELECT
-- policy and report_submissions' INSERT/UPDATE policies from the 3-arg
-- has_permission(user, facility, code) to the 4-arg
-- has_permission(user, facility, department_id, code) overload (0023), so a
-- membership scoped to one department can file and read reports for that
-- department without being a facility-wide member. Every other predicate
-- already on these policies (deleted_at guards, fn_assert_same_facility
-- cross-tenant checks, the draft-only/legal-transition status checks) is
-- carried over unchanged -- only the has_permission call is widened to
-- consult the row's own department_id. Facility-wide memberships
-- (department_id is null) are unaffected: the 4-arg overload passes for them
-- exactly like the 3-arg one did (0023's own doc comment).
--
-- Idempotency conventions (mirroring 0009-0031): drop policy/trigger if
-- exists before every create; create or replace for functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) report_templates SELECT: reports.read, department-scoped via the
-- template's own department_id (0009's latest definition, deleted_at guard
-- carried over verbatim).
-- ---------------------------------------------------------------------------
drop policy if exists "report readers can read templates" on report_templates;
create policy "report readers can read templates" on report_templates
  for select using (
    has_permission(auth.uid(), facility_id, department_id, 'reports.read') and deleted_at is null
  );

-- ---------------------------------------------------------------------------
-- (b) report_submissions INSERT: reports.create, department-scoped via the
-- submission's own department_id (0009's fn_assert_same_facility guards
-- carried over verbatim).
-- ---------------------------------------------------------------------------
drop policy if exists "report creators can create submissions" on report_submissions;
create policy "report creators can create submissions" on report_submissions
  for insert with check (
    has_permission(auth.uid(), facility_id, department_id, 'reports.create')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

-- ---------------------------------------------------------------------------
-- (c) report_submissions UPDATE: reports.submit, department-scoped via the
-- submission's own department_id (0026's latest definition -- draft-only
-- USING, legal draft->submitted WITH CHECK, deleted_at guard, and both
-- fn_assert_same_facility checks -- all carried over verbatim).
-- ---------------------------------------------------------------------------
drop policy if exists "report submitters can update drafts" on report_submissions;
create policy "report submitters can update drafts" on report_submissions
  for update using (
    has_permission(auth.uid(), facility_id, department_id, 'reports.submit')
    and status = 'draft'
    and deleted_at is null
  ) with check (
    has_permission(auth.uid(), facility_id, department_id, 'reports.submit')
    and status in ('draft', 'submitted')
    and fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

-- ---------------------------------------------------------------------------
-- (d) fn_report_submission_audit(): one function shared by report_submissions
-- (AFTER INSERT OR UPDATE) and report_submission_attachments (AFTER INSERT),
-- branching on tg_table_name exactly like fn_audit_chain_link (0013/0019)
-- does for its two tables. SECURITY DEFINER + fixed search_path: both source
-- tables are written under the caller's own RLS-scoped session (holding only
-- reports.create/reports.submit, not admin.manage), so a SECURITY INVOKER
-- insert into audit_events would be rejected outright by "admins can write
-- audit events" (0019). Running as the function owner (the migration role,
-- which bypasses RLS) is what lets an ordinary report filer's action still
-- produce an audit row, the same way fn_audit_admin_change already does for
-- config writes made under a caller's own session.
--
-- entity_table is always 'report_submissions' and entity_id is always the
-- submission's own id -- including for the attachment_added event, where
-- entity_id is the attachment's submission_id (not the attachment's own id).
-- An attachment is part of its submission's story, not a separate audited
-- entity, so its event is filed against the submission exactly like
-- draft_created/draft_updated/submitted are.
--
-- event_type resolution:
--   report_submissions INSERT  -> 'report.submitted' if the row already
--                                  arrives in 'submitted' status (a future
--                                  service-role/import path), else
--                                  'report.draft_created' (the normal
--                                  POST /facilities/:id/reports path, which
--                                  always inserts status = 'draft').
--   report_submissions UPDATE  -> draft -> submitted : 'report.submitted'
--                                  draft -> draft     : 'report.draft_updated'
--                                  anything else (e.g. a future lock/revise
--                                  transition, DR-24) is left unaudited by
--                                  this trigger rather than guessed at; a
--                                  later migration adds those event types
--                                  when the transition itself is built.
--   report_submission_attachments INSERT -> 'report.attachment_added'.
--
-- event_payload is always {before, after} (fn_audit_admin_change's shape, so
-- every audit row -- config changes and report lifecycle alike -- shares one
-- envelope); before is null on INSERT, to_jsonb(old) on UPDATE.
-- ---------------------------------------------------------------------------
create or replace function fn_report_submission_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_type text;
  v_entity_id uuid;
  v_facility_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_actor uuid;
begin
  if tg_table_name = 'report_submissions' then
    v_facility_id := new.facility_id;
    v_entity_id := new.id;
    if tg_op = 'INSERT' then
      v_before := null;
      v_after := to_jsonb(new);
      v_event_type := case when new.status = 'submitted' then 'report.submitted' else 'report.draft_created' end;
    else
      if old.status = 'draft' and new.status = 'submitted' then
        v_event_type := 'report.submitted';
      elsif old.status = 'draft' and new.status = 'draft' then
        v_event_type := 'report.draft_updated';
      else
        return new;
      end if;
      v_before := to_jsonb(old);
      v_after := to_jsonb(new);
    end if;
  elsif tg_table_name = 'report_submission_attachments' then
    v_facility_id := new.facility_id;
    v_entity_id := new.submission_id;
    v_before := null;
    v_after := to_jsonb(new);
    v_event_type := 'report.attachment_added';
  else
    raise exception 'fn_report_submission_audit: unsupported table %', tg_table_name;
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not exists (select 1 from app_users where id = v_actor) then
    v_actor := null;
  end if;

  insert into audit_events (
    facility_id, actor_user_id, event_type, entity_table, entity_id, event_payload
  ) values (
    v_facility_id,
    v_actor,
    v_event_type,
    'report_submissions',
    v_entity_id,
    jsonb_build_object('before', v_before, 'after', v_after)
  );

  return new;
end;
$$;

drop trigger if exists report_submissions_audit on report_submissions;
create trigger report_submissions_audit
  after insert or update on report_submissions
  for each row execute function fn_report_submission_audit();

drop trigger if exists report_submission_attachments_audit on report_submission_attachments;
create trigger report_submission_attachments_audit
  after insert on report_submission_attachments
  for each row execute function fn_report_submission_audit();
