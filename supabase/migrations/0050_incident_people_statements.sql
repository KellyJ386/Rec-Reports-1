-- ===========================================================================
-- 0050_incident_people_statements.sql
-- Slice 2B, P-6 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md) / IN-11
-- (plans/INCIDENTS_PLAN.md). Adds versioned witness/person statement
-- tracking on top of incident_people (0004_incidents.sql), which today only
-- carries a single mutable statement_text/statement_submitted_at pair per
-- person -- no history, no sign-off, no lock. This migration does NOT touch
-- those legacy columns (left as-is, unused by the new routes) and instead
-- adds a dedicated append-only table, matching IN-12's acceptance criteria:
-- "new statement versions never overwrite; signed statements immutable
-- (409 on edit)".
--
-- Every helper call below is schema-qualified internal.<name>(...) per
-- 0042's convention (mandatory for every migration >= 0043,
-- scripts/verify-migrations.mjs enforces it), and every `auth.uid()` is
-- wrapped `(select auth.uid())` per 0049's InitPlan-caching convention for
-- new policies from here forward.
--
-- (a) incident_witness_statements: one row per submitted version of a
--     person's statement. `unique (person_id, version_no)` is the
--     versioning backbone -- POST .../statements always inserts version
--     max(existing)+1, never updates a prior row. `submitted_by` follows
--     incident_amendments.amended_by's precedent (references app_users(id),
--     nullable -- a null actor is never expected from the routes but the
--     column stays nullable for the same reason amended_by is: consistency
--     with every other actor-attribution column in this module).
--
-- (b) RLS: SELECT under incidents.read (matching every other incident_*
--     table); INSERT under incidents.manage OR incidents.review (matching
--     the routes' writeAnyPerm gate) with fn_assert_same_facility guarding
--     BOTH parent references -- incident_id against incident_reports AND
--     person_id against incident_people -- closing the cross-tenant
--     FK-injection path 0009/0032/0043/etc. close for every other incident_*
--     write policy (a caller who holds the permission at facility A can
--     never point person_id/incident_id at rows that actually belong to
--     facility B, or a mismatched facility_id/incident_id/person_id triple
--     within their own reach). No DELETE policy exists at all (hard delete
--     is unconditionally unreachable, including for incidents.manage --
--     RLS denies any command with zero applicable permissive policies, the
--     same "RLS-by-omission" shape 0032's header documents for
--     incident_amendments).
--
-- (c) UPDATE is narrower than "no policy at all": the sign route
--     (POST .../statements/:id/sign) needs to flip signed_at from null to a
--     timestamp under RLS, so an UPDATE policy exists (same incidents.manage
--     OR incidents.review gate as INSERT) -- but a permissive UPDATE policy
--     alone would let a manage/review holder rewrite statement_text or
--     re-date submitted_at after the fact, which is exactly what "signed
--     statements immutable" and "new versions never overwrite" rule out.
--     fn_incident_witness_statement_guard (a BEFORE UPDATE OR DELETE
--     trigger, the same shape as fn_incident_report_transition_guard,
--     0043) closes that gap at the column level, independent of whatever
--     the RLS policy itself allows:
--       - DELETE is rejected unconditionally (no soft-delete route exists
--         for a statement in this slice either; the append-only posture
--         matches incident_amendments/incident_audit_events). Note this
--         branch is currently unreachable in practice (see (b): no DELETE
--         policy admits any row to begin with, so RLS blocks the command
--         before the trigger ever fires for any non-owner role) -- kept as
--         defense-in-depth, matching 0032's own trigger for
--         incident_amendments.
--       - once signed_at is already set, the row is fully immutable -- ANY
--         further UPDATE (including a second sign attempt or an attempted
--         "unsign") is rejected. The 409-on-re-sign the routes return is
--         backed by this at the DB layer too, not just an application check.
--       - before signing, the ONLY columns an UPDATE may change are
--         signed_at (null -> non-null, i.e. the one-time sign) and
--         deleted_at (null -> non-null, i.e. a one-time soft-delete-in-
--         reserve for a future route -- schema-complete per this
--         migration's assigned shape, but genuinely unused by any route
--         P-6 ships: no DELETE route exists for a statement, only for a
--         person). Every other column (facility_id, incident_id, person_id,
--         version_no, statement_text, submitted_by, submitted_at) is frozen
--         from the moment a row is inserted.
--     This mirrors 0043(b)'s split exactly: RLS decides WHO may attempt an
--     UPDATE, the trigger decides WHICH columns that UPDATE may actually
--     change.
--
-- (d) incident_people additive write policies: incident_people has carried
--     exactly one write policy since 0004 -- a single `for all` gated on
--     incidents.manage alone (never widened for incidents.review the way
--     incident_reports (0043(d)), incident_audit_events (0043(c)), and
--     incident_amendments (0032(a)) all were). The new people routes
--     (incidents-people-routes.mjs) gate POST/PATCH/soft-DELETE on
--     incidents.manage OR incidents.review, matching this module's
--     established "review is a distinct, narrower-than-manage governance
--     surface that can still act on case content" design -- so, following
--     that same precedent, this migration adds two ADDITIVE (not
--     replacing) permissive policies for incidents.review: INSERT and
--     UPDATE (soft-delete is a pgUpdate setting deleted_at, not a SQL
--     DELETE, so UPDATE alone covers create/edit/soft-delete; the existing
--     incidents.manage `for all` policy is untouched and still separately
--     covers INSERT/UPDATE/DELETE/SELECT). Both carry
--     fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
--     -- a guard the ORIGINAL 0004 manage policy never had and still does
--     not have after this migration (left untouched, out of this task's
--     scope; a manage holder could already point incident_id at a
--     mismatched facility before this migration and still can after it --
--     a pre-existing gap this migration does not introduce and does not
--     close, noted here for whoever picks it up next).
--
-- (e) incident_people SELECT gap found while building the soft-delete route
--     (a real bug, not speculative): the ONLY SELECT policy on
--     incident_people (0038:481-484) filters `deleted_at is null`
--     unconditionally, for every role including incidents.manage. Postgres
--     RLS requires an UPDATE's resulting row to remain visible under some
--     applicable permissive SELECT policy -- not just satisfy the UPDATE
--     policy's own WITH CHECK -- so a plain `update incident_people set
--     deleted_at = now() ...` was REJECTED ("new row violates row-level
--     security policy") for every actor, manage holders included, even
--     though (b)'s manage policy's own WITH CHECK plainly allowed it. This
--     made the soft-delete route (and the new reviewer UPDATE policy in
--     (d)) unreachable under RLS -- confirmed by reproducing the failure
--     against a minimal two-column probe table before attributing it to
--     this codebase's policies specifically. Fixed with an ADDITIVE SELECT
--     policy carrying no deleted_at filter, scoped to incidents.manage OR
--     incidents.review (matching the write-side gate exactly) -- readers
--     (incidents.read only, no manage/review) still see only
--     non-deleted rows via the original 0038 policy, untouched; the
--     GET .../people list route's own `deleted_at is.null` query filter
--     (independent of RLS) is what keeps a removed person out of a
--     manager's own listing despite this widened DB-level visibility.
--
-- Idempotency conventions (mirroring 0009-0049): drop policy/trigger if
-- exists immediately before every create; create or replace for functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) Table + indexes.
-- ---------------------------------------------------------------------------
create table if not exists incident_witness_statements (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  incident_id uuid not null references incident_reports(id) on delete cascade,
  person_id uuid not null references incident_people(id) on delete cascade,
  version_no integer not null,
  statement_text text not null,
  submitted_by uuid references app_users(id),
  submitted_at timestamptz not null default now(),
  signed_at timestamptz,
  deleted_at timestamptz,
  unique (person_id, version_no)
);

create index if not exists incident_witness_statements_facility_incident_idx
  on incident_witness_statements(facility_id, incident_id);
create index if not exists incident_witness_statements_person_version_idx
  on incident_witness_statements(person_id, version_no);

alter table incident_witness_statements enable row level security;

-- ---------------------------------------------------------------------------
-- (b) SELECT / INSERT policies.
-- ---------------------------------------------------------------------------
drop policy if exists "incident readers can read witness statements" on incident_witness_statements;
create policy "incident readers can read witness statements" on incident_witness_statements
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'incidents.read'));

drop policy if exists "incident managers can write witness statements" on incident_witness_statements;
create policy "incident managers can write witness statements" on incident_witness_statements
  for insert
  with check (
    (
      internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
      or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    )
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
    and internal.fn_assert_same_facility(facility_id, 'incident_people', person_id)
  );

-- ---------------------------------------------------------------------------
-- (c) UPDATE policy (RLS: who may attempt it) + append-only trigger
-- (which columns an attempted UPDATE may actually change; DELETE always
-- rejected). See header (c) for the full rationale.
-- ---------------------------------------------------------------------------
drop policy if exists "incident reviewers can sign witness statements" on incident_witness_statements;
create policy "incident reviewers can sign witness statements" on incident_witness_statements
  for update
  using (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
    or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
  )
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
    or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
  );

create or replace function fn_incident_witness_statement_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'incident_witness_statements %: hard delete is never permitted; statements are append-only.', old.id
      using errcode = 'check_violation';
  end if;

  -- tg_op = 'UPDATE' from here.
  if old.signed_at is not null then
    raise exception 'incident_witness_statements %: a signed statement is immutable.', old.id
      using errcode = 'check_violation';
  end if;

  if new.facility_id is distinct from old.facility_id
    or new.incident_id is distinct from old.incident_id
    or new.person_id is distinct from old.person_id
    or new.version_no is distinct from old.version_no
    or new.statement_text is distinct from old.statement_text
    or new.submitted_by is distinct from old.submitted_by
    or new.submitted_at is distinct from old.submitted_at
  then
    raise exception 'incident_witness_statements %: before signing, only signed_at (once) and deleted_at (once) may change.', old.id
      using errcode = 'check_violation';
  end if;

  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'incident_witness_statements %: deleted_at may only be set once.', old.id
      using errcode = 'check_violation';
  end if;

  -- signed_at going non-null -> anything is already caught by the
  -- "old.signed_at is not null" guard above (it raises before reaching
  -- here), so the only remaining legal signed_at transition at this point
  -- is null -> null (untouched) or null -> a timestamp (the one-time sign)
  -- -- both already permitted by construction.
  return new;
end;
$$;

drop trigger if exists incident_witness_statements_guard on incident_witness_statements;
create trigger incident_witness_statements_guard
  before update or delete on incident_witness_statements
  for each row execute function fn_incident_witness_statement_guard();

revoke execute on function fn_incident_witness_statement_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_incident_witness_statement_guard() from anon;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (d) incident_people: additive incidents.review INSERT/UPDATE policies,
-- alongside (not replacing) the existing "incident managers can manage
-- people" `for all` policy (0004_incidents.sql:126, untouched).
-- ---------------------------------------------------------------------------
drop policy if exists "incident reviewers can add people" on incident_people;
create policy "incident reviewers can add people" on incident_people
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

drop policy if exists "incident reviewers can update people" on incident_people;
create policy "incident reviewers can update people" on incident_people
  for update
  using (internal.has_permission((select auth.uid()), facility_id, 'incidents.review'))
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

-- ---------------------------------------------------------------------------
-- (e) incident_people: additive SELECT policy so a manage/review holder's
-- own soft-delete UPDATE (or the reviewer UPDATE policy in (d)) leaves the
-- resulting row visible to them -- see header (e).
-- ---------------------------------------------------------------------------
drop policy if exists "incident managers can read all people" on incident_people;
create policy "incident managers can read all people" on incident_people
  for select
  using (
    internal.has_permission((select auth.uid()), facility_id, 'incidents.manage')
    or internal.has_permission((select auth.uid()), facility_id, 'incidents.review')
  );

notify pgrst, 'reload schema';
