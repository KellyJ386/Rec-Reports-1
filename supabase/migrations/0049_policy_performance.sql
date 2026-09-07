-- ===========================================================================
-- 0049_policy_performance.sql
-- Advisor performance backlog (S-10), renumbered from the plan's 0048 to
-- 0049 to land after 0048_wave1b_review_fixes.sql. Source data:
-- scratchpad/advisor-performance-0039.json, a `get_advisors(performance)`
-- snapshot of the live project at migration 0039 (510 lints): 125
-- auth_rls_initplan, 78 unindexed_foreign_keys, 71 unused_index, 235
-- multiple_permissive_policies, 1 auth_db_connections_absolute.
--
-- auth_rls_initplan (125 at 0039, but 0040-0048 added more policies with a
-- bare `auth.uid()` predicate on top of that -- 130 measured by replay on
-- this branch): hand-writing 130+ drop/create policy pairs would be a huge,
-- error-prone diff and would immediately drift out of date as later slices
-- add policies of their own. Instead this migration is a DO block that
-- walks pg_policies for every policy (public and storage schemas) whose
-- qual/with_check text contains a bare `auth.uid()` not already wrapped as
-- `(select auth.uid())`, and rebuilds each one with the wrapped form via
-- `execute`-ed dynamic SQL, preserving name/table/permissive/roles/cmd and
-- both expression texts verbatim except for that one substitution. Wrapping
-- `auth.uid()` in a scalar subquery lets the planner evaluate it once per
-- query (an InitPlan) instead of re-evaluating it for every row RLS filters
-- (https://supabase.com/docs/guides/database/postgres/row-level-security
-- #call-functions-with-select). This is semantics-preserving: the row set
-- the policy admits does not change, only how many times the *same* scalar
-- value is computed. The DO block is idempotent -- its own WHERE clause
-- only matches an unwrapped `auth.uid()`, and Postgres re-normalizes
-- `(select auth.uid())` to `( SELECT auth.uid() AS uid)` in pg_get_expr
-- output once stored, so a second run finds nothing left to rewrite (proven
-- below and in the slice verification).
--
-- IMPORTANT for scripts/verify-migrations.mjs readers: the drop/create pairs
-- below are `execute`-ed as dynamic SQL text built with `format(...)`, never
-- written as literal `drop policy ... / create policy ...` statements in
-- this file. verify-migrations' "every create policy is immediately
-- preceded by a matching drop policy if exists" check (script:~215-240)
-- pattern-matches a literal double-quoted policy name followed by ON and a
-- bare table name in the file text -- a `format(...)` call whose arguments
-- are variables (%I/%s placeholders, not a literal quoted name) never
-- contains that literal shape, so the rule correctly does not apply here
-- (there is no static policy-name/table pair in this file to require a
-- preceding drop for). The DO block's own DROP-then-CREATE per policy,
-- inside this migration's single transaction, is what keeps this safe and
-- atomic -- if any CREATE POLICY fails the whole migration rolls back and
-- the original policy is unchanged.
--
-- unindexed_foreign_keys (78, confirmed by replay to still be exactly 78 at
-- 0048): a second DO block walks pg_constraint for every `contype = 'f'`
-- foreign key on a `public` table and, when no existing index's leading
-- columns already cover the FK's referencing columns (checked against
-- pg_index.indkey, the same prefix-match Postgres itself uses to decide
-- index applicability), creates a plain btree index named
-- `<table>_<col[_col...]>_idx`. This prevents the well-known Postgres
-- foreign-key locking/scan cost (a DELETE/UPDATE on the referenced row must
-- seq-scan the referencing table to enforce the constraint, and the same
-- columns are exactly what most tenant-scoped RLS policies and JS query
-- shapes join or filter on already). `create index if not exists` makes it
-- idempotent; the leading-column check also makes it idempotent (rerun
-- finds every FK already covered by the index this migration itself just
-- created).
--
-- unused_index (71): NOT dropped here. Every one of these was flagged
-- because the live project has never served real read/write traffic --
-- pg_stat_user_indexes' idx_scan is a lifetime counter since the last stats
-- reset/index creation, and "zero scans" on a project with zero production
-- queries carries no signal about whether the index will be needed once
-- Wave 2/3 traffic (and their query shapes) exist. Dropping them now on the
-- strength of that signal would very likely mean re-adding several of them
-- by hand later. Left as a listed, deferred decision -- see the comment
-- block below for the full 71 names, one per advisor `unused_index` lint,
-- for whoever revisits this after Wave 2/3 traffic exists.
--
-- multiple_permissive_policies (235): explicitly out of scope per the plan
-- -- consolidating two-or-more PERMISSIVE policies on the same table+role+
-- command into one (Postgres ORs every matching permissive policy's qual
-- together and evaluates each one, so N permissive policies cost N
-- evaluations even though only one needs to match) requires per-table
-- review to confirm the combined predicate is provably identical in every
-- case; several of these pairs come from different slices/PRs deliberately
-- separating "broad role" and "narrow role" policies for readability. Not
-- attempted here.
--
-- auth_db_connections_absolute (1): informational connection-count lint
-- about the live project's plan tier, not something a migration can act on.
-- No action.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. auth_rls_initplan: wrap every bare auth.uid() policy predicate in
--    (select auth.uid()) so Postgres computes it once per query (InitPlan)
--    instead of once per row.
-- ---------------------------------------------------------------------------
do $$
declare
  pol record;
  new_qual text;
  new_check text;
  roles_list text;
  create_sql text;
begin
  for pol in
    select p.schemaname, p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
    from pg_policies p
    where p.schemaname in ('public', 'storage')
      and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ 'auth\.uid\(\)'
      and (coalesce(p.qual, '') || coalesce(p.with_check, '')) !~* '\(\s*select\s+auth\.uid\(\)'
    order by p.schemaname, p.tablename, p.policyname
  loop
    -- pg_policies.roles already resolves polroles' 0 (PUBLIC) entry to the
    -- literal role name 'public'; quote_ident('public') leaves it
    -- unquoted, and an unquoted `to public` is accepted exactly like the
    -- PUBLIC keyword, so no special-casing is needed here.
    select string_agg(format('%I', r), ', ' order by ord)
      into roles_list
      from unnest(pol.roles) with ordinality as u(r, ord);

    new_qual := case
      when pol.qual is not null then regexp_replace(pol.qual, 'auth\.uid\(\)', '(select auth.uid())', 'g')
      else null
    end;
    new_check := case
      when pol.with_check is not null then regexp_replace(pol.with_check, 'auth\.uid\(\)', '(select auth.uid())', 'g')
      else null
    end;

    execute format('drop policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);

    -- pol.permissive is already the literal 'PERMISSIVE'/'RESTRICTIVE'
    -- keyword text and pol.cmd is already 'ALL'/'SELECT'/'INSERT'/'UPDATE'/
    -- 'DELETE' (pg_policies resolves polcmd's r/a/w/d/* codes itself), so
    -- both drop straight into the AS/FOR clauses unchanged.
    create_sql := format(
      'create policy %I on %I.%I as %s for %s to %s',
      pol.policyname, pol.schemaname, pol.tablename, pol.permissive, pol.cmd, roles_list
    );
    if new_qual is not null then
      create_sql := create_sql || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      create_sql := create_sql || format(' with check (%s)', new_check);
    end if;

    execute create_sql;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. unindexed_foreign_keys: add a covering btree index for every FK on a
--    public-schema table whose referencing column(s) are not already the
--    leading columns of some existing index.
-- ---------------------------------------------------------------------------
do $$
declare
  fk record;
  cols name[];
  col_list text;
  idx_name text;
begin
  for fk in
    select c.conrelid, t.relname as tablename, c.conkey
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f'
      and n.nspname = 'public'
    order by t.relname, c.conname
  loop
    -- Leading-column prefix match: an existing index whose first
    -- length(fk.conkey) key columns equal fk.conkey (in order) already lets
    -- Postgres use it to satisfy the FK's referencing-side scans, exactly
    -- like the advisor's own "unindexed foreign key" check.
    if exists (
      select 1
      from pg_index i
      where i.indrelid = fk.conrelid
        and (i.indkey::int2[])[0 : array_length(fk.conkey, 1) - 1] = fk.conkey
    ) then
      continue;
    end if;

    select array_agg(a.attname order by k.ord)
      into cols
      from unnest(fk.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = k.attnum;

    select string_agg(format('%I', c), ', ' order by ord)
      into col_list
      from unnest(cols) with ordinality as u(c, ord);

    idx_name := fk.tablename || '_' || array_to_string(cols, '_') || '_idx';

    execute format('create index if not exists %I on public.%I (%s)', idx_name, fk.tablename, col_list);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. unused_index (71) -- deliberately not dropped. See header. Full list
--    of the flagged index names, for whoever revisits this once Wave 2/3
--    traffic exists:
--
--   admin_change_requests_facility_status_idx
--   assets_facility_department_idx
--   audit_events_chain_scope_idx
--   audit_events_facility_created_idx
--   audit_events_organization_created_idx
--   branding_profiles_facility_idx
--   cert_role_requirements_role_idx
--   cert_role_requirements_type_idx
--   certification_events_cert_idx
--   certification_policies_facility_idx
--   certification_types_facility_code_idx
--   communication_channels_facility_idx
--   course_modules_course_idx
--   courses_facility_status_idx
--   custom_fields_facility_idx
--   department_settings_department_version_idx
--   departments_facility_idx
--   distribution_list_members_list_idx
--   distribution_lists_facility_idx
--   employee_certifications_employee_idx
--   employee_device_tokens_employee_idx
--   employee_notification_preferences_employee_idx
--   employees_facility_department_idx
--   facilities_organization_id_idx
--   facility_module_overrides_facility_idx
--   facility_settings_facility_version_idx
--   feature_flag_rules_flag_idx
--   feature_flag_rules_scope_idx
--   form_definitions_facility_idx
--   form_field_bindings_form_idx
--   incident_attachments_facility_incident_idx
--   incident_audit_events_chain_scope_idx
--   incident_audit_events_chain_seq_idx
--   incident_audit_facility_incident_idx
--   incident_escalations_facility_status_idx
--   incident_followups_facility_status_idx
--   incident_people_facility_incident_idx
--   incident_reports_facility_severity_idx
--   incident_reports_facility_status_idx
--   memberships_department_idx
--   message_acknowledgements_state_idx
--   message_audiences_message_idx
--   message_receipts_employee_idx
--   messages_channel_id_idx
--   messages_facility_created_idx
--   notification_deliveries_job_idx
--   notification_jobs_status_idx
--   notification_routes_facility_event_idx
--   organization_admins_org_idx
--   organization_admins_user_idx
--   organization_module_settings_org_idx
--   outbox_events_facility_status_idx
--   pdf_template_bindings_facility_idx
--   pdf_template_bindings_template_idx
--   pdf_templates_facility_idx
--   report_attachments_facility_submission_idx
--   report_submissions_facility_date_idx
--   report_submissions_facility_template_status_idx
--   report_templates_facility_status_idx
--   roles_facility_id_idx
--   schedule_periods_facility_week_idx
--   schedule_shifts_facility_date_idx
--   shift_assignments_facility_employee_idx
--   training_assignments_employee_due_idx
--   training_progress_assignment_idx
--   usage_counters_org_metric_idx
--   work_order_attachments_facility_order_idx
--   work_order_updates_facility_order_idx
--   work_orders_assignee_idx
--   work_orders_facility_priority_idx
--   work_orders_facility_status_idx
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. multiple_permissive_policies (235) -- out of scope. See header.
-- ---------------------------------------------------------------------------
