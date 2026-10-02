-- ===========================================================================
-- 0052_report_signatures.sql
-- Slice 3A, DR-17 (plans/DAILY_REPORTS_PLAN.md / plans/WAVES_1_4_IMPLEMENTATION_PLAN.md).
-- Adds report_submission_signatures: one row per role that has signed off on
-- a report_submissions row, consumed by:
--   - POST /facilities/:facilityId/reports/:id/signatures (signer = the
--     authenticated caller; signature_hash covers submission/user/role/
--     payload so a later payload change is detectable)
--   - POST /reports/:id/submit's completeness check: when the pinned
--     version's validation_json.signature_requirements.required is true,
--     every listed role must already have a row here or the submit is
--     rejected (400, DR-16/DR-17 boundary).
--
-- Every helper call below is schema-qualified internal.<name>(...) per
-- 0042's convention (mandatory for every migration >= 0043,
-- scripts/verify-migrations.mjs enforces it), and every `auth.uid()` is
-- wrapped `(select auth.uid())` per 0049's InitPlan-caching convention.
--
-- (a) Table + indexes. signer_role is a free-text label matched against the
--     pinned version's validation_json.signature_requirements.roles by the
--     route layer (not a FK/enum -- the role catalog lives in template
--     authoring data, not a DB-level lookup table, same posture as
--     incident_witness_statements.submitted_by's sibling free-text fields).
--     deleted_at is carried for shape-consistency with every other
--     report_* table (0002) but no route ever sets it in this slice -- a
--     signature is immutable once written (see (c)), so there is currently
--     no soft-delete path; kept nullable/unused rather than omitted so a
--     future moderation/correction route has the column ready without
--     another migration.
--
-- (b) RLS: SELECT under reports.read (facility-wide -- matches
--     report_submissions' own SELECT policy, which 0033's header notes was
--     NOT switched to the department-scoped 4-arg has_permission overload;
--     see reports-routes.mjs's compliance-endpoint comment for the same
--     precedent). INSERT under reports.submit (matches
--     POST /reports/:id/submit and PATCH /reports/:id's own gate, and
--     report_submission_attachments' sibling INSERT policy, 0038) AND
--     fn_assert_same_facility(facility_id, 'report_submissions',
--     submission_id) (closing the cross-tenant FK-injection path every
--     other report_*/incident_* write policy since 0009 closes) AND
--     signer_user_id = (select auth.uid()) -- a caller can only ever sign
--     as themselves, never mint a signature attributed to someone else, even
--     if they otherwise hold reports.submit on the row. No UPDATE/DELETE
--     policy exists at all (RLS-by-omission, same posture as
--     incident_witness_statements' missing DELETE policy, 0050(b)) --
--     PLUS the trigger in (c) rejects both explicitly, as defense in depth
--     independent of whatever a future policy addition might otherwise
--     admit.
--
-- (c) fn_report_submission_signature_guard(): BEFORE INSERT OR UPDATE OR
--     DELETE trigger, mirroring fn_incident_witness_statement_guard's shape
--     (0050(c)) but simpler (a signature carries no draft/append-only
--     version history to protect -- it is either absent or present):
--       - UPDATE/DELETE are rejected unconditionally: "immutable after
--         draft" (DR-17) means a signature is never edited or removed once
--         written, not just "while the submission is still a draft" -- once
--         a role has signed, that record stands even if the submission
--         somehow reverts (it cannot, today, but the trigger does not rely
--         on that to hold). In practice, with no UPDATE/DELETE policy at
--         all (see (b)), Postgres RLS already admits zero rows to either
--         command before the trigger ever gets a row to fire on -- these two
--         branches are presently unreachable, the same "belt-and-suspenders,
--         not a live hole" posture 0050's header documents for its own
--         DELETE branch; both stay in place against a future policy
--         addition ever widening write access.
--       - INSERT is rejected unless the referenced report_submissions row
--         is still status = 'draft' -- "409 if the submission is not draft"
--         (DR-17) is primarily the route's own pre-check
--         (reports-routes.mjs), but this closes the same gap RLS alone
--         cannot: a caller who otherwise passes the INSERT policy (holds
--         reports.submit, signs as themselves, points submission_id at
--         their own facility's row) could still race a submit, or call the
--         insert through some future non-route write path, after the
--         submission has already left draft. SECURITY DEFINER + fixed
--         search_path so this lookup never depends on the calling role
--         also holding reports.read on report_submissions (same rationale
--         as fn_incident_report_transition_guard, 0043).
--
-- Idempotency conventions (mirroring 0009-0051): drop policy/trigger if
-- exists immediately before every create; create or replace for functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) Table + indexes.
-- ---------------------------------------------------------------------------
create table if not exists report_submission_signatures (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  submission_id uuid not null references report_submissions(id) on delete cascade,
  signer_user_id uuid not null references app_users(id),
  signer_role text not null,
  signed_at timestamptz not null default now(),
  signature_hash text not null,
  deleted_at timestamptz
);

create index if not exists report_submission_signatures_submission_idx
  on report_submission_signatures(submission_id);
create index if not exists report_submission_signatures_facility_signed_idx
  on report_submission_signatures(facility_id, signed_at);

alter table report_submission_signatures enable row level security;

-- ---------------------------------------------------------------------------
-- (b) SELECT / INSERT policies. No UPDATE/DELETE policy exists (see header).
-- ---------------------------------------------------------------------------
drop policy if exists "report readers can read signatures" on report_submission_signatures;
create policy "report readers can read signatures" on report_submission_signatures
  for select
  using (internal.has_permission((select auth.uid()), facility_id, 'reports.read'));

drop policy if exists "report submitters can sign submissions" on report_submission_signatures;
create policy "report submitters can sign submissions" on report_submission_signatures
  for insert
  with check (
    internal.has_permission((select auth.uid()), facility_id, 'reports.submit')
    and internal.fn_assert_same_facility(facility_id, 'report_submissions', submission_id)
    and signer_user_id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- (c) fn_report_submission_signature_guard(): draft-only INSERT,
-- unconditionally-rejected UPDATE/DELETE. See header (c).
-- ---------------------------------------------------------------------------
create or replace function fn_report_submission_signature_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'report_submission_signatures %: a signature is immutable once recorded.', old.id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    raise exception 'report_submission_signatures %: a signature can never be deleted.', old.id
      using errcode = 'check_violation';
  end if;

  -- tg_op = 'INSERT' from here.
  select status into v_status from report_submissions where id = new.submission_id;
  if v_status is distinct from 'draft' then
    raise exception 'report_submission_signatures: submission % is no longer a draft (status %); signatures may only be added to a draft submission.', new.submission_id, v_status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists report_submission_signatures_guard on report_submission_signatures;
create trigger report_submission_signatures_guard
  before insert or update or delete on report_submission_signatures
  for each row execute function fn_report_submission_signature_guard();

revoke execute on function fn_report_submission_signature_guard() from public, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function fn_report_submission_signature_guard() from anon;
  end if;
end
$$;

notify pgrst, 'reload schema';
