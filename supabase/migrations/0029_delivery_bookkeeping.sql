-- 0029_delivery_bookkeeping.sql
-- Delivery bookkeeping for the notification worker core (OP-10/OP-11): the
-- worker needs somewhere to record why a job/outbox row last failed and when
-- it is next eligible for a retry attempt, plus a terminal 'dead_letter'
-- status on notification_jobs once retries are exhausted. Idempotent
-- throughout (mirrors the 0009-0026 conventions): `add column if not exists`
-- for columns, drop-then-recreate for the status check constraint. RLS is
-- untouched -- the worker runs under the service role, which bypasses RLS.

alter table notification_jobs
  add column if not exists last_error text,
  add column if not exists next_attempt_at timestamptz;

alter table outbox_events
  add column if not exists last_error text,
  add column if not exists next_attempt_at timestamptz;

-- notification_jobs.status originally (0006) allowed
-- ('pending','processing','sent','failed','cancelled'). Add 'dead_letter' as
-- the terminal state a job lands in once the worker's configurable max-attempts
-- is exhausted, distinct from a merely-retryable 'failed' row. Drop + re-add
-- the (unnamed-in-0006, Postgres-default-named) column check constraint so
-- this file can be re-run safely.
alter table notification_jobs drop constraint if exists notification_jobs_status_check;
alter table notification_jobs
  add constraint notification_jobs_status_check
  check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled', 'dead_letter'));
