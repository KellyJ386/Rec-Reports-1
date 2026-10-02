-- ===========================================================================
-- 0055_report_lifecycle.sql
-- Wave 3, Slice 3A: DR-23 (PDF snapshot pipeline), DR-24 (lock/revise
-- lifecycle), DR-26 (template governance) -- plans/DAILY_REPORTS_PLAN.md.
--
-- Every helper call below is schema-qualified internal.<name>(...) per
-- 0042's convention (mandatory for every migration >= 0043,
-- scripts/verify-migrations.mjs enforces it), and every `auth.uid()` is
-- wrapped `(select auth.uid())` per 0049's InitPlan-caching convention for
-- new policy predicates.
--
-- ---------------------------------------------------------------------------
-- DR-23: report_submissions grows four columns for the async PDF snapshot
-- pipeline (src/lib/report-pdf.mjs + src/lib/report-pdf-worker.mjs):
--   pdf_storage_path  -- the Storage object once generated; a CHECK pins it
--                         to the exact shape the worker derives
--                         (facilities/{facility_id}/reports/{id}/
--                         snapshot-<hash8>.pdf) so a row can never claim a
--                         path belonging to a different facility/submission
--                         even for a service-role write that bypasses RLS
--                         entirely -- same "invariant regardless of role"
--                         reasoning as 0041's fn_attachment_path_facility,
--                         just expressed as a CHECK constraint here since it
--                         is a same-row invariant (facility_id/id are
--                         columns on this very row), not a cross-table
--                         lookup a CHECK can't express.
--   pdf_content_hash   -- the sha-256 hex digest report-pdf.mjs's
--                         computeReportSnapshotHash produces; also the
--                         source of pdf_storage_path's <hash8> fragment
--                         (enforced by the same CHECK).
--   pdf_attempts       -- failed-attempt counter (the worker only increments
--                         this on failure, never on success); pdf_status
--                         moves to 'failed' once it reaches 3
--                         (REPORT_PDF_MAX_ATTEMPTS).
--   pdf_error          -- last failure message (error.message only, never a
--                         raw response body -- see report-pdf-worker.mjs).
-- No new RLS write policy is needed for these columns: the worker always
-- runs as the service role (src/lib/http/internal-routes.mjs's
-- buildServiceClient), which bypasses RLS entirely, and no end-user route
-- writes them.
--
-- DR-24: report_submissions grows `revision_of`, and both the RLS UPDATE
-- policy and a new BEFORE INSERT OR UPDATE trigger
-- (fn_report_submission_transition_guard) are extended so that, past draft:
--   submitted -> locked            legal (reports.publish, no content change)
--   submitted -> revised           legal (reports.publish, no content change)
--   locked    -> revised           legal (reports.publish, no content change)
--   revised   -> (anything)        illegal -- a revised row is immutable
--   locked    -> (anything but revised, or with a content change)  illegal
--   submitted -> (anything but locked/revised, or with a content change)
--                                  illegal (a submitted report is not
--                                  otherwise editable at all -- only
--                                  lock/revise may touch it, matching
--                                  0002/0033's existing "submitted is
--                                  terminal for ordinary edits" posture)
-- RLS decides WHO may attempt an UPDATE past draft (a new permissive policy,
-- gated on reports.publish -- see the header note on that choice below); the
-- trigger decides WHICH transitions and WHICH columns that UPDATE may
-- actually touch, independent of RLS -- the same split 0043(b) and 0050(c)
-- already use for incident_reports/incident_witness_statements.
--
-- Permission choice for lock/revise (DR-24's open question): reused
-- reports.publish, NOT a new reports.lock code (the task instructs against
-- adding one). Justification: locking/revising a submitted report is the
-- same governance tier as publishing a template version -- an act that
-- turns a working draft into an official, no-longer-casually-editable
-- record -- and reports.publish is already the code the RLS layer trusts
-- for exactly that kind of "make this official and hard to undo" authority
-- on report_template_versions (0044(a)). reports.submit (the code that
-- gates ordinary draft edits/submission) is deliberately NOT sufficient on
-- its own: a submitter finishing their own shift's report should not
-- unilaterally be able to lock it against later correction or supersede it
-- with a revision -- that is a supervisory action.
--
-- DR-26: report_templates grows `sandbox` (exposed via PATCH
-- /report-templates/:id, src/lib/http/report-templates-routes.mjs;
-- src/lib/report-templates.mjs's isSandboxTemplate(template) is the
-- exported gate a future workflow/outbox builder calls at submit time to
-- suppress distribution/workflow side effects -- no such side effect exists
-- in this tree yet to wire the call site into, so this migration only adds
-- the column; report-templates-routes.mjs (this same slice) exposes it on
-- the PATCH route). Governance itself (the optional two-step publish via
-- admin_change_requests, `daily_reports.templatePublishRequiresApproval`)
-- needs no new table -- it reuses admin_change_requests end to end
-- (src/lib/admin/change-requests.mjs's createChangeRequest/
-- advanceChangeRequest, unchanged) -- but admin_change_requests has carried
-- exactly one write policy since 0008, gated on admin.manage alone, and
-- report-templates-routes.mjs's publish route is guarded by
-- reports.template.manage + reports.publish, neither of which imply
-- admin.manage. A new ADDITIVE policy (narrowly scoped to
-- entity_table = 'report_template_versions', matching 0043(b)/(c)/(d) and
-- 0050(d)'s "add a policy for a different actor set, never replace the
-- existing one" pattern) lets that actor set write change requests for
-- template-version publish specifically, without touching what admin.manage
-- can already do for every other entity_table.
--
-- M-1 (security review): DR-26's two-person governance rule had two gaps,
-- both closed by additions at the end of this migration (sections (g)-(i)):
--   (a) The approval requirement (daily_reports.
--       templatePublishRequiresApproval) was read and enforced ONLY inside
--       report-templates-routes.mjs's publish route -- the RLS policy
--       above ((0044(a), untouched) still permitted is_published=true for
--       anyone holding reports.template.manage + reports.publish, with no
--       reference to a change request at all, so the single actor set the
--       governance flow exists to constrain could simply publish through
--       PostgREST directly and skip it entirely. Closed by section (g): a
--       BEFORE UPDATE trigger on report_template_versions that reads the
--       SAME setting the BFF resolves (facility_module_overrides /
--       organization_module_settings, keyed by the 'daily_reports' module
--       row -- see (g)'s own comment for why this is resolved directly
--       against those tables rather than needing a JS-only mirror column)
--       and, when it is true, allows is_published false -> true only when
--       an approved admin_change_requests row for that exact version
--       already exists.
--   (b) Self-approval was bypassable: 0014's
--       fn_enforce_change_request_transition correctly rejects
--       reviewed_by = requested_by, but only checks it when status itself
--       changes -- a caller could UPDATE requested_by to someone else on a
--       status-unchanged statement (a no-op as far as that trigger's early
--       return is concerned), then approve as themselves against the NEW
--       requested_by. Closed by section (h): requested_by is now frozen
--       once set, checked unconditionally (before the status-unchanged
--       early return), and section (i) adds `requested_by = auth.uid()` to
--       this migration's own report_template_versions-scoped INSERT policy
--       so a request can never even be CREATED with someone else's id.
--
-- Idempotency conventions (mirroring 0009-0051): drop policy/trigger if
-- exists immediately before every create; create or replace for functions;
-- add column/constraint if not exists (guarded with a DO block where
-- `if not exists` isn't available, e.g. add constraint).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) Columns.
-- ---------------------------------------------------------------------------
alter table report_templates
  add column if not exists sandbox boolean not null default false;

alter table report_submissions
  add column if not exists revision_of uuid references report_submissions(id),
  add column if not exists pdf_storage_path text,
  add column if not exists pdf_content_hash text,
  add column if not exists pdf_attempts integer not null default 0,
  add column if not exists pdf_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'report_submissions_pdf_content_hash_format'
  ) then
    alter table report_submissions
      add constraint report_submissions_pdf_content_hash_format
      check (pdf_content_hash is null or pdf_content_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'report_submissions_pdf_storage_path_shape'
  ) then
    alter table report_submissions
      add constraint report_submissions_pdf_storage_path_shape
      check (
        pdf_storage_path is null
        or (
          pdf_content_hash is not null
          and pdf_storage_path = 'facilities/' || facility_id::text || '/reports/' || id::text ||
            '/snapshot-' || left(pdf_content_hash, 8) || '.pdf'
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'report_submissions_pdf_attempts_range') then
    alter table report_submissions
      add constraint report_submissions_pdf_attempts_range check (pdf_attempts >= 0 and pdf_attempts <= 10);
  end if;
end
$$;

create index if not exists report_submissions_revision_of_idx
  on report_submissions(revision_of) where revision_of is not null;
create index if not exists report_submissions_pdf_status_queued_idx
  on report_submissions(updated_at) where pdf_status = 'queued';

-- ---------------------------------------------------------------------------
-- (b) report_submissions INSERT: additive OR-branch letting a reports.publish
-- holder insert a revision successor (revision_of not null, status must be
-- 'draft') without needing reports.create; fn_assert_same_facility now also
-- guards revision_of the way it already guards template_id/
-- template_version_id. reports.create + revision_of is null (the existing,
-- untouched shape) stays exactly as it was.
-- ---------------------------------------------------------------------------
drop policy if exists "report creators can create submissions" on report_submissions;
create policy "report creators can create submissions" on report_submissions
  for insert
  with check (
    (
      (internal.has_permission((select auth.uid()), facility_id, department_id, 'reports.create') and revision_of is null)
      or
      (
        internal.has_permission((select auth.uid()), facility_id, department_id, 'reports.publish')
        and revision_of is not null
        and status = 'draft'
      )
    )
    and internal.fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and internal.fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
    and (revision_of is null or internal.fn_assert_same_facility(facility_id, 'report_submissions', revision_of))
  );

-- ---------------------------------------------------------------------------
-- (c) report_submissions UPDATE: the existing draft-only policy (0033(c),
-- reports.submit) is untouched. This ADDS a second permissive policy for
-- reports.publish, covering exactly the rows the draft policy's USING never
-- admits (status in ('submitted', 'locked')). Postgres OR's multiple
-- permissive policies' USING/WITH CHECK together, so a reports.submit-only
-- actor still can never reach a submitted/locked row (their USING clause
-- requires status = 'draft'), and a reports.publish-only actor can never
-- touch a draft row (this policy's USING requires status in
-- ('submitted', 'locked')). WITH CHECK only narrows the coarse "may this
-- role attempt an UPDATE at all" question to "landing on a legal target
-- status" -- the trigger below (d) is what actually pins the transition to
-- submitted->locked / {submitted,locked}->revised specifically and freezes
-- content columns; this policy alone would also permit e.g.
-- locked -> locked (a harmless no-op the trigger's content-unchanged check
-- still allows) but never locked -> submitted (not in this WITH CHECK's
-- status list at all).
-- ---------------------------------------------------------------------------
drop policy if exists "report publishers can lock or revise submissions" on report_submissions;
create policy "report publishers can lock or revise submissions" on report_submissions
  for update
  using (
    internal.has_permission((select auth.uid()), facility_id, department_id, 'reports.publish')
    and status in ('submitted', 'locked')
    and deleted_at is null
  )
  with check (
    internal.has_permission((select auth.uid()), facility_id, department_id, 'reports.publish')
    and status in ('locked', 'revised')
    and internal.fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and internal.fn_assert_same_facility(facility_id, 'report_template_versions', template_version_id)
  );

-- ---------------------------------------------------------------------------
-- (d) fn_report_submission_transition_guard(): BEFORE INSERT OR UPDATE on
-- report_submissions. No SECURITY DEFINER -- it only reads OLD/NEW and calls
-- internal.fn_assert_same_facility, which is itself SECURITY DEFINER and
-- already EXECUTE-granted to `authenticated`/`service_role` (0042), so an
-- ordinary invoker-rights trigger has everything it needs, matching 0050(c)'s
-- fn_incident_witness_statement_guard (the most recent precedent for this
-- exact "RLS decides who, trigger decides what" split) rather than 0043(b)'s
-- SECURITY DEFINER choice (that one calls internal.has_permission for its own
-- independent permission check, which this trigger does not need to do --
-- permission is entirely RLS's job here).
--
-- INSERT: only guards revision_of's cross-tenant shape (revision_of must
-- point at a submission in the same facility, or be null) -- everything else
-- about a fresh row is already governed by the INSERT policy above.
--
-- UPDATE, in order:
--   1. revision_of is immutable once set (never legal to change on any
--      UPDATE, at any status).
--   2. old.status = 'draft' falls through untouched -- governed entirely by
--      the existing (b)/0033(c) draft policies; nothing further to enforce.
--   3. A "pdf-only" UPDATE (every tracked content/lifecycle column
--      unchanged from OLD, including status) always passes -- this is what
--      lets report-pdf-worker.mjs's service-role drain stamp
--      pdf_status/pdf_storage_path/pdf_content_hash/pdf_attempts/pdf_error
--      on a submitted/locked/revised row regardless of the state machine
--      below: the PDF snapshot documents what was actually submitted, so it
--      must stay writable after a report is locked or even revised.
--   4. old.status = 'revised': always rejected -- a revised submission is
--      permanently immutable, full stop.
--   5. old.status = 'locked': only new.status = 'revised' with every
--      content column unchanged is legal.
--   6. old.status = 'submitted': only new.status in ('locked', 'revised')
--      with every content column unchanged is legal.
--   7. Anything else (a status this trigger has never heard of, e.g. a
--      future value the CHECK constraint alone would still allow) is
--      rejected by the final catch-all raise.
-- ---------------------------------------------------------------------------
create or replace function fn_report_submission_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_content_unchanged boolean;
  v_pdf_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.revision_of is not null then
      if not internal.fn_assert_same_facility(new.facility_id, 'report_submissions', new.revision_of) then
        raise exception 'report_submissions %: revision_of must reference a submission in the same facility.', new.id
          using errcode = 'check_violation';
      end if;
      -- L-8 (security review): fn_assert_same_facility only checked
      -- facility_id, so a reports.publish holder scoped to department A
      -- could mint a successor in department A claiming to revise a
      -- department B report (the INSERT policy's has_permission check runs
      -- against the NEW row's own department_id, not revision_of's) --
      -- provenance confusion, since it could never modify the B row itself
      -- (the guard below + department-scoped policies both stop that), but
      -- still wrong. A revision successor must carry the SAME department_id
      -- (including both null, i.e. two facility-wide rows) as the
      -- submission it revises.
      if not exists (
        select 1 from report_submissions
        where id = new.revision_of and department_id is not distinct from new.department_id
      ) then
        raise exception 'report_submissions %: revision_of must reference a submission in the same department.', new.id
          using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE' from here.
  if new.revision_of is distinct from old.revision_of then
    raise exception 'report_submissions %: revision_of is immutable once set.', old.id
      using errcode = 'check_violation';
  end if;

  -- L-5 (security review): the "pdf-only update always passes" fast path
  -- below (v_content_unchanged never inspects pdf_*, by design -- the async
  -- PDF worker must be able to stamp these on a submitted/locked/revised
  -- row regardless of the state machine) did not distinguish the
  -- service-role writer from an ordinary end user, so an authenticated
  -- reports.publish holder could set pdf_status/pdf_content_hash/
  -- pdf_storage_path/pdf_attempts/pdf_error on their own facility's row
  -- (proved: a forged pdf_content_hash/pdf_storage_path on a locked row).
  -- These five columns may now be changed ONLY by a session with no acting
  -- user at all (auth.uid() is null) -- exactly the service-role-
  -- authenticated shape report-pdf-worker.mjs's drain runs under, and the
  -- SAME "auth.uid() is null" test 0048's incident_reports deleted_at
  -- exemption already uses for the identical service-role-vs-authenticated
  -- distinction. Checked unconditionally, before any status-specific branch
  -- below, so it holds regardless of whether the same UPDATE also legally
  -- changes status.
  v_pdf_changed :=
    new.pdf_status is distinct from old.pdf_status
    or new.pdf_storage_path is distinct from old.pdf_storage_path
    or new.pdf_content_hash is distinct from old.pdf_content_hash
    or new.pdf_attempts is distinct from old.pdf_attempts
    or new.pdf_error is distinct from old.pdf_error;
  if v_pdf_changed and auth.uid() is not null then
    raise exception 'report_submissions %: pdf_* columns may only be changed by the service role.', old.id
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'draft' then
    -- Postgres OR's WITH CHECK across EVERY permissive UPDATE policy
    -- defined for this table, not just the one whose USING clause admitted
    -- the pre-image row -- so an actor holding BOTH reports.submit AND
    -- reports.publish (e.g. a facility admin) would otherwise be able to
    -- jump a draft straight to 'locked'/'revised': the draft-only policy's
    -- USING admits the OLD row, and the lock/revise policy's WITH CHECK
    -- (status in ('locked','revised'), reports.publish) would separately
    -- admit the NEW row, even though that same policy's OWN USING never
    -- matched this row at all. This explicit check closes that cross-policy
    -- leak at the trigger layer, which always runs regardless of which
    -- policy combination let the statement through -- 0033's draft ->
    -- {draft, submitted}-only rule is enforced HERE now, not left as an
    -- assumption about what RLS alone happens to guarantee.
    if new.status not in ('draft', 'submitted') then
      raise exception 'report_submissions %: a draft may only stay a draft or move to submitted (got %).', old.id, new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_content_unchanged :=
    new.payload_json is not distinct from old.payload_json
    and new.report_date is not distinct from old.report_date
    and new.shift_ref is not distinct from old.shift_ref
    and new.template_id is not distinct from old.template_id
    and new.template_version_id is not distinct from old.template_version_id
    and new.department_id is not distinct from old.department_id
    and new.facility_id is not distinct from old.facility_id
    and new.submitted_by is not distinct from old.submitted_by
    and new.submitted_at is not distinct from old.submitted_at
    and new.source is not distinct from old.source
    and new.validation_results is not distinct from old.validation_results;

  if v_content_unchanged and new.status is not distinct from old.status then
    return new;
  end if;

  if old.status = 'revised' then
    raise exception 'report_submissions %: a revised submission is immutable.', old.id
      using errcode = 'check_violation';
  end if;

  if old.status = 'locked' then
    if new.status = 'revised' and v_content_unchanged then
      return new;
    end if;
    raise exception 'report_submissions %: a locked submission only allows the locked -> revised transition, with no content change.', old.id
      using errcode = 'check_violation';
  end if;

  if old.status = 'submitted' then
    if new.status in ('locked', 'revised') and v_content_unchanged then
      return new;
    end if;
    raise exception 'report_submissions %: illegal transition from % to % (or a disallowed content change).', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  raise exception 'report_submissions %: illegal status transition from % to %.', old.id, old.status, new.status
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists report_submissions_transition_guard on report_submissions;
create trigger report_submissions_transition_guard
  before insert or update on report_submissions
  for each row execute function fn_report_submission_transition_guard();

revoke execute on function fn_report_submission_transition_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_report_submission_transition_guard() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (e) fn_report_submission_audit() (0033): extend the UPDATE branch with the
-- two new lifecycle events. Every other branch (INSERT, draft->submitted,
-- draft->draft, the attachments branch) is carried over byte-for-byte.
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
      elsif old.status = 'submitted' and new.status = 'locked' then
        v_event_type := 'report.locked';
      elsif old.status in ('submitted', 'locked') and new.status = 'revised' then
        v_event_type := 'report.revised';
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

-- Trigger definition unchanged (still fires on the same events, same
-- function) -- re-asserted here only so this migration is self-contained to
-- read; drop/create keeps the idempotency convention intact.
drop trigger if exists report_submissions_audit on report_submissions;
create trigger report_submissions_audit
  after insert or update on report_submissions
  for each row execute function fn_report_submission_audit();

-- ---------------------------------------------------------------------------
-- (f) admin_change_requests: additive SELECT/INSERT/UPDATE policies (never
-- DELETE -- deliberately narrower than 0008's admin.manage `for all`, since
-- no route this slice ships ever deletes a change request) for DR-26's
-- template-publish governance actor set (reports.template.manage +
-- reports.publish), scoped to entity_table = 'report_template_versions'
-- only. The original admin.manage `for all` policy (0008:114) is untouched
-- and still covers every other entity_table (branding, etc.) exactly as
-- before.
-- ---------------------------------------------------------------------------
drop policy if exists "template governors can read publish change requests" on admin_change_requests;
create policy "template governors can read publish change requests" on admin_change_requests
  for select
  using (
    entity_table = 'report_template_versions'
    and internal.has_permission((select auth.uid()), facility_id, 'reports.template.manage')
    and internal.has_permission((select auth.uid()), facility_id, 'reports.publish')
  );

-- M-1(b): requested_by = (select auth.uid()) closes the INSERT-side half of
-- the self-approval bypass -- a request can never even be CREATED under
-- someone else's identity (section (h) below closes the UPDATE-side half:
-- requested_by can never be REASSIGNED after the fact either).
drop policy if exists "template governors can create publish change requests" on admin_change_requests;
create policy "template governors can create publish change requests" on admin_change_requests
  for insert
  with check (
    entity_table = 'report_template_versions'
    and internal.has_permission((select auth.uid()), facility_id, 'reports.template.manage')
    and internal.has_permission((select auth.uid()), facility_id, 'reports.publish')
    and requested_by = (select auth.uid())
  );

drop policy if exists "template governors can advance publish change requests" on admin_change_requests;
create policy "template governors can advance publish change requests" on admin_change_requests
  for update
  using (
    entity_table = 'report_template_versions'
    and internal.has_permission((select auth.uid()), facility_id, 'reports.template.manage')
    and internal.has_permission((select auth.uid()), facility_id, 'reports.publish')
  )
  with check (
    entity_table = 'report_template_versions'
    and internal.has_permission((select auth.uid()), facility_id, 'reports.template.manage')
    and internal.has_permission((select auth.uid()), facility_id, 'reports.publish')
  );

-- ---------------------------------------------------------------------------
-- (g) M-1(a): fn_report_template_version_publish_guard() -- BEFORE INSERT OR
-- UPDATE trigger on report_template_versions. Enforces DR-26's governance
-- rule AT THE DATABASE LAYER: when this version's facility has
-- daily_reports.templatePublishRequiresApproval enabled, a version becoming
-- published -- an UPDATE flipping is_published false -> true, OR an INSERT
-- that arrives with is_published = true already set (without the INSERT arm
-- an actor could skip the guarded transition entirely by inserting the new
-- version pre-published and then pointing report_templates.active_version at
-- it) -- is only legal when an admin_change_requests row
-- for this exact (entity_table='report_template_versions', entity_id=this
-- version) exists with status 'approved' (the status the row carries the
-- moment applyTemplatePublish flips is_published -- see
-- report-templates-routes.mjs's publish/approve route: approve, THEN
-- publish, THEN advance to 'published') or 'published', and a reviewer that
-- differs from the requester (redundant with 0014's trigger + section (h)
-- below, which both already prevent a mismatched reviewed_by/requested_by
-- pair from ever reaching 'approved' -- kept here anyway as a self-
-- contained, defense-in-depth predicate rather than trusting a upstream
-- invariant to hold).
--
-- Setting resolution: `loadModuleConfig` (src/lib/http/module-config.mjs)
-- resolves a facility's effective config as facility_module_overrides.
-- config_patch_jsonb, falling back to organization_module_settings.
-- config_jsonb, falling back to the registry default (settings-registry.mjs
-- -- false for this key) -- both tables store a FLAT map keyed by the
-- setting's own dotted string ("daily_reports.templatePublishRequiresApproval"),
-- keyed by module_id (looked up once via modules.code = 'daily_reports').
-- That flat-map shape is directly resolvable in SQL with no JS-only
-- registry logic to duplicate or mirror onto another column, so this
-- trigger reads the SAME two tables the BFF resolution reads, in the SAME
-- facility-overrides-organization-overrides-default order -- there is
-- exactly one source of truth for this setting, not two that could drift.
-- SECURITY DEFINER (fixed search_path) since the actor set this trigger
-- fires for (reports.template.manage + reports.publish) is not guaranteed
-- to hold admin.manage, which is what gates SELECT on
-- facility_module_overrides/organization_module_settings/
-- admin_change_requests directly.
-- ---------------------------------------------------------------------------
create or replace function fn_report_template_version_publish_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module_id uuid;
  v_org_id uuid;
  v_facility_layer jsonb;
  v_org_layer jsonb;
  v_requires_approval boolean := false;
  v_approved boolean;
begin
  if new.is_published = true and (tg_op = 'INSERT' or old.is_published = false) then
    select id into v_module_id from modules where code = 'daily_reports';

    if v_module_id is not null then
      select config_patch_jsonb into v_facility_layer
        from facility_module_overrides
        where facility_id = new.facility_id and module_id = v_module_id;

      if v_facility_layer is not null and v_facility_layer ? 'daily_reports.templatePublishRequiresApproval' then
        v_requires_approval := coalesce((v_facility_layer ->> 'daily_reports.templatePublishRequiresApproval')::boolean, false);
      else
        select organization_id into v_org_id from facilities where id = new.facility_id;
        if v_org_id is not null then
          select config_jsonb into v_org_layer
            from organization_module_settings
            where organization_id = v_org_id and module_id = v_module_id;
          if v_org_layer is not null and v_org_layer ? 'daily_reports.templatePublishRequiresApproval' then
            v_requires_approval := coalesce((v_org_layer ->> 'daily_reports.templatePublishRequiresApproval')::boolean, false);
          end if;
        end if;
      end if;
    end if;

    if v_requires_approval then
      select exists (
        select 1 from admin_change_requests
        where entity_table = 'report_template_versions'
          and entity_id = new.id
          and status in ('approved', 'published')
          and reviewed_by is not null
          and reviewed_by is distinct from requested_by
      ) into v_approved;

      if not v_approved then
        raise exception 'report_template_versions %: publishing this version requires an approved admin_change_requests row (daily_reports.templatePublishRequiresApproval is enabled for this facility).', new.id
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists report_template_versions_publish_guard on report_template_versions;
create trigger report_template_versions_publish_guard
  before insert or update on report_template_versions
  for each row execute function fn_report_template_version_publish_guard();

revoke execute on function fn_report_template_version_publish_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_report_template_version_publish_guard() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (h) M-1(b): fn_enforce_change_request_transition (0014) -- recreated whole
-- (CREATE OR REPLACE preserves the existing trigger binding/OID) to freeze
-- requested_by. The prior body only ever inspected requested_by inside the
-- `status = 'approved'` branch, and short-circuited entirely on
-- `new.status = old.status` -- so a caller could UPDATE requested_by to a
-- DIFFERENT user on a status-unchanged statement (a legal no-op as far as
-- the early return was concerned), then separately approve the request
-- under their own identity as reviewer, satisfying reviewed_by <>
-- requested_by against the now-reassigned requested_by. Proved: `update ...
-- set requested_by = <other user>` succeeded silently before this change.
-- The freeze is checked FIRST, before the status-unchanged early return, so
-- it applies to every UPDATE regardless of whether status also changes in
-- the same statement. Every other branch is carried over byte-for-byte from
-- 0014.
-- ---------------------------------------------------------------------------
create or replace function fn_enforce_change_request_transition()
returns trigger
language plpgsql
as $$
begin
  if new.requested_by is distinct from old.requested_by then
    raise exception 'admin_change_requests %: requested_by is immutable once set.', old.id
      using errcode = 'insufficient_privilege';
  end if;

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

-- Trigger/grants unchanged from 0014 (CREATE OR REPLACE above preserves the
-- function's OID, so the existing trigger binding is untouched); re-asserted
-- here only for idempotent re-runnability.
drop trigger if exists admin_change_requests_enforce_transition on admin_change_requests;
create trigger admin_change_requests_enforce_transition
  before update on admin_change_requests
  for each row execute function fn_enforce_change_request_transition();

-- ---------------------------------------------------------------------------
-- (i) M-1(b): admin_change_requests carries no dedicated table-level guard
-- of its own beyond the trigger above -- the requested_by freeze in (h)
-- covers every entity_table this table serves, not just
-- report_template_versions, so nothing further is needed here.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
