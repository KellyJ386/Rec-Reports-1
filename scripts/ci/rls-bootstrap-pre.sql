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
