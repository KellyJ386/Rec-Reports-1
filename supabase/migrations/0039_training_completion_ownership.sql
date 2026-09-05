-- ===========================================================================
-- 0039_training_completion_ownership.sql
-- Closes the ownership gap plans/RLS_AUDIT.md's "Escalated as decisions, not
-- fixed" section (item 1) deliberately left open: 0038's new
-- training_completions INSERT policy ("training readers can insert
-- completions") mirrored POST /training-assignments/:id/complete's actual,
-- already-decided app-layer gate at the time -- training.read alone, no
-- binding to the caller's own employee row -- so the DB would stop being
-- MORE restrictive than the app, not invent a narrower policy on its own
-- guess. That route gate has now been decided (this migration + the paired
-- route change in src/lib/http/training-routes.mjs): completion recording
-- must be either self-service (the caller completing their OWN training) or
-- a supervisor acting on someone's behalf (training.manage), never "any
-- training.read holder can complete anyone's training". Left as-is, any
-- training.read holder in a facility could mark ANY employee's mandatory
-- safety training complete -- a falsifiable-record problem in a compliance
-- product whose whole value proposition is provable training records.
--
-- CHANGE: replace the 0038 INSERT policy on training_completions with one
-- requiring EITHER:
--   (a) self-service -- training.read (the base training-module permission
--       every employee with visibility into their own training holds) PLUS
--       the completion is for the CALLER's own employee row, joined
--       training_assignments -> employees where employees.user_id =
--       auth.uid() -- the EXACT shape 0036 uses for training_progress's
--       self-service INSERT/UPDATE policies (an employee completing their
--       own assigned training), OR
--   (b) the caller holds training.manage on the facility -- a supervisor
--       recording a completion on someone else's behalf (e.g. an in-person
--       session, a proctored exam, a paper sign-off transcribed into the
--       system), the same override every other training.* table already
--       grants training.manage holders via their "for all" policy (0007).
-- training.read alone (no ownership, no training.manage) is no longer
-- sufficient -- this is the CONSERVATIVE default, matching every sibling
-- table in the training module (training_progress since 0036) rather than
-- inventing a new, more permissive shape for this one table.
--
-- The existing fn_assert_same_facility(facility_id, 'training_assignments',
-- assignment_id) guard from 0038 is kept unchanged in both branches -- this
-- migration only narrows WHO may write, not the cross-facility FK check.
--
-- FOLLOW-UP (not implemented here, per the same "don't guess" discipline
-- 0038 itself followed): if the product wants completion recording to be
-- STRICTLY supervisor-only (no self-attestation at all -- e.g. every
-- completion must be witnessed/certified by a manager), the clean way to
-- express that is a dedicated `training.certify` permission code, granted
-- only to supervisor-type roles, replacing branch (b)'s training.manage
-- check (and possibly replacing branch (a) entirely). That is a product/
-- role-design decision, not a mechanical migration, so it is flagged here
-- rather than guessed at.
--
-- Idempotent (drop policy if exists immediately precedes create policy, per
-- scripts/verify-migrations.mjs's enforced convention from migration 0009
-- onward), matching the 0026/0036/0038 conventions this migration mirrors.
-- ===========================================================================

drop policy if exists "training readers can insert completions" on training_completions;
drop policy if exists "employees can record their own training completion" on training_completions;
create policy "employees can record their own training completion" on training_completions
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'training.read')
    and fn_assert_same_facility(facility_id, 'training_assignments', assignment_id)
    and exists (
      select 1 from training_assignments ta
      join employees e on e.id = ta.employee_id
      where ta.id = training_completions.assignment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "training managers can record any completion" on training_completions;
create policy "training managers can record any completion" on training_completions
  for insert
  with check (
    has_permission(auth.uid(), facility_id, 'training.manage')
    and fn_assert_same_facility(facility_id, 'training_assignments', assignment_id)
  );
