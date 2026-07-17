-- 0024: hosted Supabase installs pgcrypto in the `extensions` schema, so
-- fn_audit_chain_link() (security definer, search_path pinned to public by
-- 0019) cannot resolve digest() there. Widen the pinned search_path to
-- include `extensions`. On bare Postgres (CI), pgcrypto lives in public and
-- the extra schema entry is harmless whether or not it exists.
-- Idempotent: safe to re-run.
alter function fn_audit_chain_link() set search_path = public, extensions;
