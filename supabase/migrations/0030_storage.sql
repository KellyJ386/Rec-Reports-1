-- ===========================================================================
-- 0030_storage.sql
-- OP-15 (plans/PLATFORM_OPS_PLAN.md): the platform file-storage primitive
-- that reports/incidents/work-orders/training attachments (OP-17) will all
-- sit on top of, via src/lib/storage.mjs (OP-16).
--
-- Two things:
--   1. A private `attachments` bucket in storage.buckets (public = false,
--      idempotent via on conflict).
--   2. storage.objects RLS policies that are defense-in-depth ONLY: all
--      normal reads/writes go through the BFF (src/lib/storage.mjs) using
--      the service-role key, which bypasses RLS entirely. These policies
--      exist for the case where a client somehow ends up with an
--      anon/authenticated Supabase session and hits the Storage REST API
--      directly -- they must NOT be relied on as the primary access
--      control, only as a backstop that mirrors the app's own facility
--      scoping.
--
-- Object paths are always of the shape (see buildAttachmentPath in
-- src/lib/storage.mjs):
--   facilities/{facilityId}/{module}/{recordId}/{uuid}-{safeName}
-- so the facility a path belongs to is always the second folder segment.
-- fn_storage_attachment_facility_id() below parses that back out, tolerating
-- any object that does NOT follow the convention by returning null (never
-- raising) so a malformed/foreign path just fails the policy instead of
-- blowing up the query for every other row.
--
-- Grant shape: only SELECT is granted, and only for paths whose facility
-- segment is one of the caller's current_facility_ids() (0001). No
-- insert/update/delete policy is created at all -- with RLS enabled and no
-- permissive policy for those commands, Postgres denies them outright for
-- anon/authenticated, exactly like the "deny by omission" write posture
-- already used elsewhere in this schema.
--
-- Idempotency conventions (mirroring 0009-0029): drop policy if exists
-- immediately precedes every create policy, required from 0009 onward by
-- scripts/verify-migrations.mjs; insert ... on conflict for the bucket row;
-- create or replace function for the helper.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Bucket: private, idempotent upsert. No file_size_limit/allowed_mime_types
-- set here on purpose -- those caps are enforced app-side (configurable, see
-- assertMimeAllowed/assertWithinSizeCap in src/lib/storage.mjs) so they stay
-- adjustable without a migration, and so a bucket-level mime allow-list here
-- can't silently fall out of sync with the app-side one and start rejecting
-- content types a later module legitimately needs (e.g. training's video
-- evidence, TR-08).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do update set name = excluded.name, public = excluded.public;

-- ---------------------------------------------------------------------------
-- fn_storage_attachment_facility_id(): pulls the facility id out of an
-- attachments-bucket object path ("facilities/{facilityId}/..."). Returns
-- null (never raises) for anything that doesn't match the convention --
-- missing "facilities/" prefix, too few segments, or a non-uuid second
-- segment -- so a malformed path simply reads as "no facility match" rather
-- than aborting the policy check for the whole query.
--
-- search_path pinned to '' (0024 convention for self-contained functions):
-- the body only calls storage.foldername (schema-qualified) and builtin
-- casts/exception handling, so nothing needs schema resolution.
-- ---------------------------------------------------------------------------
create or replace function fn_storage_attachment_facility_id(object_name text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  segments text[];
begin
  segments := storage.foldername(object_name);
  if segments is null or array_length(segments, 1) < 2 or segments[1] <> 'facilities' then
    return null;
  end if;
  begin
    return segments[2]::uuid;
  exception when invalid_text_representation then
    return null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- storage.objects: defense-in-depth read-only policy, scoped to the
-- attachments bucket and the caller's own facilities. Table-qualified as
-- "storage.objects" throughout, per the note in the plan that policies on
-- this table live in the storage schema, not public.
-- ---------------------------------------------------------------------------
drop policy if exists "facility members can read own facility attachments" on storage.objects;
create policy "facility members can read own facility attachments"
  on storage.objects
  for select
  using (
    bucket_id = 'attachments'
    and fn_storage_attachment_facility_id(name) in (select current_facility_ids())
  );
