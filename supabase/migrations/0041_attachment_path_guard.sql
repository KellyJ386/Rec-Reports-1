-- ===========================================================================
-- 0041_attachment_path_guard.sql
-- Wave 1 Slice 1A, S-2. buildAttachmentPath (src/lib/storage.mjs) always
-- writes "facilities/{facilityId}/{module}/{recordId}/{uuid}-{safeName}" for
-- the row's OWN facility_id, and the BFF's signed-URL routes
-- (attachments-routes.mjs, training-routes.mjs) now call
-- assertPathInFacility() to refuse to sign a URL for a row whose stored
-- path claims a different facility than the row's own facility_id column
-- before ever calling the storage client. That JS check only runs on the
-- read path though -- nothing stops a write (a service-role worker, a
-- future admin tool, a bug) from inserting a row whose storage_path names a
-- facility other than its own facility_id, which would then be invisible to
-- the app-layer guard entirely (it trusts storage_path and facility_id to
-- already agree with each other).
--
-- This is the same "child row must agree with its own parent/self" shape
-- 0035_work_order_facility_consistency.sql closed for work_order_updates/
-- work_order_attachments' facility_id-vs-parent-work-order mismatch, and it
-- picks the same mechanism for the same reason (see that migration's header
-- for the full derivation): a BEFORE INSERT OR UPDATE TRIGGER rather than a
-- WITH CHECK clause, because the invariant must hold no matter which role
-- performs the write -- including a future service-role/background-job
-- caller that bypasses RLS (and therefore every WITH CHECK) entirely,
-- whereas a policy predicate only ever runs for RLS-subject roles.
--
-- fn_attachment_path_facility(): generic trigger function for the four
-- tables that carry both a facility_id and a path column pointing into the
-- attachments bucket. Three of them (report_submission_attachments,
-- incident_attachments, work_order_attachments) always carry a NOT NULL
-- storage_path; employee_certifications' evidence_path is nullable (a
-- certification can exist with no evidence uploaded yet), so the check is
-- skipped entirely when the column is null and only enforced once evidence
-- is attached. security definer + set search_path = public so the function
-- resolves employee_certifications/etc. correctly regardless of which role
-- fires it, matching fn_work_order_child_facility's shape in 0035.
--
-- H-1 fix: the original check was `attachment_path not like
-- ('facilities/' || new.facility_id::text || '/%')` -- a PREFIX test only.
-- A path like "facilities/<own>/work_orders/../../<other>/work_orders/x/y"
-- passes that prefix test (it does start with "facilities/<own>/") but
-- WHATWG URL parsing later collapses the ".."/".." segments, landing any
-- signed-URL request on a DIFFERENT facility entirely (src/lib/storage.mjs's
-- assertPathInFacility has the identical blind spot, fixed alongside this).
-- Replaced with a POSITIVE regex anchored on the one canonical shape every
-- legitimate row can ever have (src/lib/storage.mjs's buildAttachmentPath
-- output): `facilities/<uuid>/<module>/<recordId>/<filename>`, where the
-- module is one of the four literal module names this schema knows about
-- (reports, incidents, work_orders, certifications -- also closes L-1: the
-- old check never constrained the module segment at all, so a row could
-- legally claim a module it doesn't belong to) and every segment is
-- required to be non-empty and not "."/"..". Anything else -- a dot
-- segment, an empty segment (a leading/trailing/doubled "/"), a foreign
-- facility, an unknown module, or a path with more or fewer than five
-- segments -- fails the match and is rejected.
--
-- Idempotent (0009+/0035 convention): create-or-replace the function,
-- drop-if-exists then create each trigger.
-- ===========================================================================

create or replace function fn_attachment_path_facility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  attachment_path text;
begin
  if TG_TABLE_NAME = 'employee_certifications' then
    attachment_path := new.evidence_path;
  else
    attachment_path := new.storage_path;
  end if;

  if attachment_path is not null
    and attachment_path !~ (
      '^facilities/' || new.facility_id::text ||
      '/(reports|incidents|work_orders|certifications)/(?!\.\.?/)[^/]+/(?!\.\.?$)[^/]+$'
    )
  then
    raise exception 'attachment path % does not match facilities/%/<module>/<recordId>/<filename>', attachment_path, new.facility_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists report_submission_attachments_path_facility on report_submission_attachments;
create trigger report_submission_attachments_path_facility
  before insert or update on report_submission_attachments
  for each row execute function fn_attachment_path_facility();

drop trigger if exists incident_attachments_path_facility on incident_attachments;
create trigger incident_attachments_path_facility
  before insert or update on incident_attachments
  for each row execute function fn_attachment_path_facility();

drop trigger if exists work_order_attachments_path_facility on work_order_attachments;
create trigger work_order_attachments_path_facility
  before insert or update on work_order_attachments
  for each row execute function fn_attachment_path_facility();

drop trigger if exists employee_certifications_path_facility on employee_certifications;
create trigger employee_certifications_path_facility
  before insert or update on employee_certifications
  for each row execute function fn_attachment_path_facility();
