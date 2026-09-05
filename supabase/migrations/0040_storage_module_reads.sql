-- ===========================================================================
-- 0040_storage_module_reads.sql
-- Wave 1 Slice 1A, S-1. 0030_storage.sql's storage.objects SELECT policy
-- ("facility members can read own facility attachments") only checks the
-- facility segment of an object's path -- ANY member of a facility, holding
-- ANY permission at all, can read every attachment in that facility via the
-- Storage REST API directly (defense-in-depth only; the BFF's own
-- module-scoped requirePerm gates are the primary control, see
-- src/lib/http/attachments-routes.mjs and training-routes.mjs). That is
-- broader than the BFF: a reports.read-only member should not be able to
-- read incident photos or certification evidence just because they share a
-- facility.
--
-- Path convention (buildAttachmentPath, src/lib/storage.mjs:191-198):
--   facilities/{facilityId}/{module}/{recordId}/{uuid}-{safeName}
-- module in (reports, incidents, work_orders, certifications). This
-- migration adds fn_storage_attachment_module() to read that third segment
-- back out (mirroring fn_storage_attachment_facility_id's shape exactly:
-- plain invoker, stable, set search_path = '', tolerates any
-- non-conforming path by returning null rather than raising) and replaces
-- the SELECT policy with a per-module check: reports/incidents/work_orders
-- attachments require that module's *.read permission on the path's
-- facility; certifications additionally allow the certification's OWN
-- employee (evidence_path = name, employees.user_id = auth.uid()) even
-- without training.read, mirroring the self-scoping GET
-- /employee-certifications/:id/evidence-url route already allows
-- (training-routes.mjs).
--
-- has_permission(uuid, uuid, text) is called unqualified (still `public` at
-- this migration number; 0042 moves it to schema `internal` but Postgres
-- resolves the function to a fixed OID at CREATE POLICY time, so that later
-- move does not require touching this policy).
--
-- Idempotency: drop-if-exists precedes every create (0009+ convention,
-- enforced by scripts/verify-migrations.mjs) -- both the OLD policy name
-- from 0030 and the new name, since this migration renames the policy to
-- describe its new, narrower semantics.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_storage_attachment_module(): pulls the module out of an attachments
-- object path ("facilities/{facilityId}/{module}/..."). Returns null (never
-- raises) for anything that doesn't match the convention -- missing
-- "facilities/" prefix or fewer than 3 segments -- exactly like
-- fn_storage_attachment_facility_id (0030) treats a malformed path as "no
-- match" rather than aborting the policy check for the whole query.
-- ---------------------------------------------------------------------------
create or replace function fn_storage_attachment_module(object_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  segments text[];
begin
  segments := storage.foldername(object_name);
  if segments is null or array_length(segments, 1) < 3 or segments[1] <> 'facilities' then
    return null;
  end if;
  return segments[3];
end;
$$;

-- ---------------------------------------------------------------------------
-- storage.objects: module-aware, defense-in-depth read-only policy. Renamed
-- from 0030's facility-only policy to describe the narrower semantics.
-- ---------------------------------------------------------------------------
drop policy if exists "facility members can read own facility attachments" on storage.objects;
drop policy if exists "facility members can read module-scoped attachments" on storage.objects;
create policy "facility members can read module-scoped attachments"
  on storage.objects
  for select
  using (
    bucket_id = 'attachments'
    and (
      (
        fn_storage_attachment_module(name) = 'reports'
        and has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'reports.read')
      )
      or (
        fn_storage_attachment_module(name) = 'incidents'
        and has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'incidents.read')
      )
      or (
        fn_storage_attachment_module(name) = 'work_orders'
        and has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'work_orders.read')
      )
      or (
        fn_storage_attachment_module(name) = 'certifications'
        and (
          has_permission(auth.uid(), fn_storage_attachment_facility_id(name), 'training.read')
          or exists (
            select 1
            from employee_certifications ec
            join employees e on e.id = ec.employee_id
            where ec.evidence_path = name
              and e.user_id = auth.uid()
          )
        )
      )
    )
  );
