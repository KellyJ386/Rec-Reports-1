-- 0024_harden_function_search_path
--
-- Pins a stable search_path on the three trigger functions that were still
-- search_path-mutable (flagged by the Supabase security linter, lint 0011).
-- Every other SECURITY DEFINER / helper function in this schema already sets
-- `search_path=public` (0009+); these trigger functions predate that and were
-- missed. Setting the search_path prevents a caller from shadowing referenced
-- objects via their own session search_path.
--
-- This is a metadata-only change (ALTER FUNCTION ... SET) — it does not touch
-- the function bodies, signatures, or any RLS policy, and is idempotent.

alter function public.fn_block_audit_mutation() set search_path = public;
alter function public.fn_protect_system_role() set search_path = public;
alter function public.fn_enforce_change_request_transition() set search_path = public;
