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
