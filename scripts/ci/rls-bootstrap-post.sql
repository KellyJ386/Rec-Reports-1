-- CI-only bootstrap (part 2): grants the table/sequence/function privileges
-- Supabase normally grants automatically to the `authenticated` role at
-- project-provisioning time. Runs AFTER migrations 0001-0018 have created
-- every table, so the "all tables/sequences/functions in schema public" glob
-- covers the full schema in one shot. Table-level RLS policies (created by
-- the migrations themselves) still gate what `authenticated` can actually see
-- or write -- these grants only clear Postgres's default-deny at the
-- role/schema level, the same baseline a real Supabase project ships with.

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- Same baseline for the CI-only `storage` schema shim (rls-bootstrap-pre.sql):
-- a real Supabase project grants `authenticated` table-level privileges on
-- storage.objects/storage.buckets out of the box, with RLS (0030/0040) as
-- the actual gate on what a given caller can see or write. Without this,
-- every `select ... from storage.objects` under `set local role
-- authenticated` in supabase/tests/*.sql fails at the role/schema level
-- before RLS is even evaluated ("permission denied for schema storage"),
-- rather than being filtered down to zero/some rows by the policy.
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;
