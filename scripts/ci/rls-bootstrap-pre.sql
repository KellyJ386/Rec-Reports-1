-- CI-only bootstrap: recreates the Supabase-managed primitives that
-- supabase/migrations/*.sql assume already exist on a real Supabase project
-- (the `authenticated` role, the `auth` schema, `auth.users`, and
-- `auth.uid()`). Runs once against the throwaway postgres:16 service
-- container in .github/workflows/ci.yml BEFORE migrations 0001-0018 are
-- applied (0001_foundation.sql has an `auth.users` foreign key), so the RLS
-- suite (supabase/tests/*.sql) can execute in CI. Never applied to a real
-- Supabase project -- Supabase already provides all of this out of the box.
--
-- auth.users.id has no default: every supabase/tests/*.sql fixture inserts
-- an explicit id, and gen_random_uuid() (pgcrypto) isn't installed yet at
-- this point in the bootstrap -- that happens in 0001_foundation.sql.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Supabase's auth.uid() reads the caller's JWT claims out of the
-- request.jwt.claims GUC. supabase/tests/*.sql fixtures set this per
-- transaction via set_config('request.jwt.claims', '{"sub":"...",...}', true)
-- and then `set local role authenticated;`, exactly mirroring a real
-- PostgREST/Supabase request.
create or replace function auth.uid() returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

-- CI-only storage schema shim: minimal `storage` schema that
-- 0030_storage.sql expects to exist on a real Supabase project.
-- Supabase manages this out of the box; we recreate just enough for
-- CI migrations to apply against bare Postgres. The `storage.objects`
-- table only gets RLS policies (created by 0030), not any app logic.

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table storage.objects enable row level security;

-- storage.foldername(object_name): splits an object path into folder
-- segments, matching Supabase's real storage.foldername (storage-api's
-- migrations): split on '/' with NO trimming of leading/trailing slashes,
-- then drop the LAST element (the object's own filename is not a
-- "folder"). M-2 fix: the previous shim trimmed leading/trailing '/' and
-- returned every component including the filename, which is MORE
-- permissive than production -- it happily parsed a leading-slash path
-- ("/facilities/.../x.jpg") or a root-level file ("facilities/.../certs")
-- into a folder array that real Supabase's storage.foldername would
-- instead return NULL (or a shorter array) for, so this shim's version of
-- the S-1 proof (supabase/tests/storage_module_reads.sql) validated a
-- different, laxer function than the one that actually runs in
-- production. Returns null for an empty/null path (string_to_array's own
-- behavior on '' would be {''}; guarded explicitly below to match the
-- "no match" contract fn_storage_attachment_facility_id/
-- fn_storage_attachment_module already rely on).
create or replace function storage.foldername(object_name text)
returns text[]
language plpgsql
stable
as $$
declare
  _parts text[];
begin
  if object_name is null or object_name = '' then
    return null;
  end if;
  _parts := string_to_array(object_name, '/');
  return _parts[1:array_length(_parts, 1) - 1];
end;
$$;
