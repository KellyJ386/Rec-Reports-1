-- ===========================================================================
-- 0051_search_indexes.sql
-- P-8 (global search): backs GET /api/v1/search (src/lib/http/search-routes.mjs)
-- -- a fan-out of `ilike.*q*` filters across incident_reports, work_orders,
-- employees, and messages -- with a GIN trigram index per searched column so
-- each leg's substring match can use an index scan instead of a sequential
-- scan once these tables grow past a trivial row count. pg_trgm's
-- `gin_trgm_ops` operator class is what makes `ilike '%q%'` (a pattern with
-- no fixed prefix, so a plain btree index is useless for it) indexable at
-- all.
--
-- pg_trgm is a contrib extension, not a Supabase-specific one, so it exists
-- on any real Supabase project (Supabase ships the standard Postgres contrib
-- set) and on the official `postgres:16` Docker image CI runs against
-- (verified locally against that same image's Debian package layout: the
-- contrib module is present). The `do $$ ... exception ... $$` guard below
-- exists purely as a defensive fallback for a stripped-down Postgres build
-- that lacks contrib (some minimal/slim images do) -- on such a build this
-- migration degrades to a no-op (search still works, just via a sequential
-- scan on every leg -- see search-routes.mjs's LIMIT 10 per leg, which
-- keeps that degraded path bounded) rather than failing CI's replay
-- outright.
--
-- One GIN index per searched column (never a combined multi-column trgm
-- index -- PostgREST's `or=(a.ilike.*q*,b.ilike.*q*,...)` issued by each
-- search leg needs each column independently indexable, and pg_trgm has no
-- useful notion of a "combined" trigram set across unrelated text columns
-- anyway). All `if not exists`, so this migration is idempotent like every
-- other one in this tree.
-- ===========================================================================

do $$
begin
  create extension if not exists pg_trgm;
exception
  when others then
    raise notice 'pg_trgm extension unavailable (%); search trigram indexes will be skipped -- GET /api/v1/search still works via a sequential ilike scan, just without index support.', sqlerrm;
end
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    -- incident_reports (incidents.read leg: incident_no, summary, location_text)
    execute 'create index if not exists idx_incident_reports_incident_no_trgm on incident_reports using gin (incident_no gin_trgm_ops)';
    execute 'create index if not exists idx_incident_reports_summary_trgm on incident_reports using gin (summary gin_trgm_ops)';
    execute 'create index if not exists idx_incident_reports_location_text_trgm on incident_reports using gin (location_text gin_trgm_ops)';

    -- work_orders (work_orders.read leg: title, description)
    execute 'create index if not exists idx_work_orders_title_trgm on work_orders using gin (title gin_trgm_ops)';
    execute 'create index if not exists idx_work_orders_description_trgm on work_orders using gin (description gin_trgm_ops)';

    -- employees (schedule.read leg -- the code the existing employees list
    -- route (GET /facilities/:facilityId/employees, scheduling-routes.mjs)
    -- already gates on: first_name, last_name, employee_no)
    execute 'create index if not exists idx_employees_first_name_trgm on employees using gin (first_name gin_trgm_ops)';
    execute 'create index if not exists idx_employees_last_name_trgm on employees using gin (last_name gin_trgm_ops)';
    execute 'create index if not exists idx_employees_employee_no_trgm on employees using gin (employee_no gin_trgm_ops)';

    -- messages (communications.read leg: subject, body_text)
    execute 'create index if not exists idx_messages_subject_trgm on messages using gin (subject gin_trgm_ops)';
    execute 'create index if not exists idx_messages_body_text_trgm on messages using gin (body_text gin_trgm_ops)';
  else
    raise notice 'pg_trgm not installed; skipping search trigram indexes (0051_search_indexes.sql).';
  end if;
end
$$;
