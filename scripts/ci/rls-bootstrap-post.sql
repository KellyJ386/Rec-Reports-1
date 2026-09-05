-- CI-only bootstrap (part 2): grants the table/sequence privileges Supabase
-- normally grants automatically to the `authenticated` role at
-- project-provisioning time. Runs AFTER migrations 0001-0018 have created
-- every table, so the "all tables/sequences in schema public" glob covers the
-- full schema in one shot. Table-level RLS policies (created by the
-- migrations themselves) still gate what `authenticated` can actually see or
-- write -- these grants only clear Postgres's default-deny at the
-- role/schema level, the same baseline a real Supabase project ships with.
--
-- Deliberately no `grant execute on all functions in schema public to
-- authenticated` here: plain Postgres already grants EXECUTE to PUBLIC on
-- function creation (the same implicit-exposure baseline a real Supabase
-- project ships with), and 0042_internal_helpers.sql explicitly revokes
-- EXECUTE on the ten trigger functions that must not be directly callable.
-- Since this bootstrap script runs AFTER all migrations, re-granting execute
-- here would silently undo those revokes on every CI run.

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;
