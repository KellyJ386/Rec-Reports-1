-- Proof for 0051 (P-8, global search): the GIN trigram indexes backing
-- GET /api/v1/search actually exist, on the right table, for the right
-- column. This is a structural check (pg_indexes), not a behavioral RLS
-- proof -- there is no new RLS surface here (no new table, no new policy),
-- just index coverage the search fan-out (search-routes.mjs) relies on for
-- performance once these tables have real row counts.
--
-- Guarded the same way 0051 itself is guarded: on a stripped-down Postgres
-- build with no pg_trgm contrib module available, 0051 skips creating the
-- indexes (raising a NOTICE, not failing), so this test skips its
-- assertions too rather than failing a replay that 0051 itself tolerated.
begin;

do $$
declare
  v_missing text[];
  v_expected text[] := array[
    'idx_incident_reports_incident_no_trgm',
    'idx_incident_reports_summary_trgm',
    'idx_incident_reports_location_text_trgm',
    'idx_work_orders_title_trgm',
    'idx_work_orders_description_trgm',
    'idx_employees_first_name_trgm',
    'idx_employees_last_name_trgm',
    'idx_employees_employee_no_trgm',
    'idx_messages_subject_trgm',
    'idx_messages_body_text_trgm'
  ];
  v_name text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    raise notice 'SEARCH_INDEXES SKIP: pg_trgm is not installed on this Postgres build; 0051 skipped creating the trigram indexes, so this test skips its assertions too.';
    return;
  end if;

  foreach v_name in array v_expected loop
    if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = v_name) then
      v_missing := array_append(v_missing, v_name);
    end if;
  end loop;

  if v_missing is not null then
    raise exception 'SEARCH_INDEXES FAIL: missing trigram index(es): %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

-- Each index is GIN, uses gin_trgm_ops, and sits on the table/column
-- search-routes.mjs actually queries -- a name matching the convention
-- above but pointed at the wrong table/column (a copy-paste slip) would
-- pass the existence check alone but not this one.
do $$
declare
  v_bad text[];
  rec record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    return; -- already reported by the block above
  end if;

  for rec in
    select * from (values
      ('idx_incident_reports_incident_no_trgm', 'incident_reports', 'incident_no'),
      ('idx_incident_reports_summary_trgm', 'incident_reports', 'summary'),
      ('idx_incident_reports_location_text_trgm', 'incident_reports', 'location_text'),
      ('idx_work_orders_title_trgm', 'work_orders', 'title'),
      ('idx_work_orders_description_trgm', 'work_orders', 'description'),
      ('idx_employees_first_name_trgm', 'employees', 'first_name'),
      ('idx_employees_last_name_trgm', 'employees', 'last_name'),
      ('idx_employees_employee_no_trgm', 'employees', 'employee_no'),
      ('idx_messages_subject_trgm', 'messages', 'subject'),
      ('idx_messages_body_text_trgm', 'messages', 'body_text')
    ) as expected(idx_name, tbl_name, col_name)
  loop
    if not exists (
      select 1
        from pg_index i
        join pg_class ic on ic.oid = i.indexrelid
        join pg_class tc on tc.oid = i.indrelid
        join pg_am am on am.oid = ic.relam
        join pg_attribute a on a.attrelid = tc.oid and a.attnum = i.indkey[0]
       where ic.relname = rec.idx_name
         and tc.relname = rec.tbl_name
         and am.amname = 'gin'
         and a.attname = rec.col_name
    ) then
      v_bad := array_append(v_bad, rec.idx_name);
    end if;
  end loop;

  if v_bad is not null then
    raise exception 'SEARCH_INDEXES FAIL: index(es) not GIN on the expected table/column: %', array_to_string(v_bad, ', ');
  end if;
end;
$$;

rollback;
