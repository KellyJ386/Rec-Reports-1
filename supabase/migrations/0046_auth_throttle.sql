-- ===========================================================================
-- 0046_auth_throttle.sql
-- S-7: durable brute-force throttle backing store (OP-23 follow-up).
--
-- src/lib/http/rate-limit.mjs's in-memory limiter is a per-process Map --
-- on Vercel serverless an attacker spread across cold-started instances gets
-- a fresh counter on every one. This table gives POST /auth/sign-in and
-- POST /auth/refresh (src/lib/http/auth-routes.mjs) a shared, durable
-- counter that survives across instances, written exclusively by the
-- service-role client through src/lib/http/durable-rate-limit.mjs, which
-- sits BEHIND that in-memory limiter -- the in-memory check stays the
-- first-line, no-DB-round-trip shield; this is only the backstop.
--
--   key          -- throttle bucket, e.g. "email:<normalized>",
--                    "ip:<addr>", "refresh:<sha256(token)>",
--                    "refresh-ip:<addr>".
--   window_start -- when the current sliding window for this key began.
--   failures     -- failed-attempt count within
--                    [window_start, window_start + windowMs).
--   updated_at   -- bumped on every write; drives the sweep in
--                    internal-routes.mjs's handleDrain (deletes rows older
--                    than 1 hour), which the auth_throttle_updated_at_idx
--                    index below exists to serve.
-- ---------------------------------------------------------------------------
create table if not exists auth_throttle (
  key text primary key,
  window_start timestamptz not null,
  failures integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists auth_throttle_updated_at_idx on auth_throttle (updated_at);

-- ---------------------------------------------------------------------------
-- RLS: no end user, admin, or even authenticated app role ever reads or
-- writes this table -- every access is service-role, from
-- durable-rate-limit.mjs, which is never handed a caller's JWT.
--
-- The plan describes this as "enable row level security with no policies
-- (service role only)". Enabling RLS with genuinely zero policies would
-- indeed deny every row to every RLS-checked role (Postgres's RLS default is
-- deny), which is the intended behavior -- but scripts/verify-migrations.mjs's
-- requiredRlsTables check additionally asserts that every listed table has
-- at least one `create policy` statement, precisely so a table can never
-- silently ship "RLS enabled" without anyone having ever written down what
-- it's supposed to deny (the same gap 0038_rls_audit_hardening.sql's Class A
-- findings were: RLS on, policies not covering a write path anyone
-- expected). Rather than special-case this table out of that assertion, add
-- one deliberately restrictive policy that encodes the SAME deny-all intent
-- explicitly: `using (false)` denies every row to every command for every
-- role that goes through RLS at all -- Postgres also uses `using` as the
-- `with check` for INSERT/UPDATE when no explicit `with check` is given, so
-- this covers SELECT/INSERT/UPDATE/DELETE alike. The table owner and any
-- role with BYPASSRLS (Supabase's service_role has BYPASSRLS) are entirely
-- unaffected by RLS and keep working exactly as if there were no policy at
-- all, so the service-role client's reads/writes are unchanged.
alter table auth_throttle enable row level security;

drop policy if exists "service role only" on auth_throttle;
create policy "service role only" on auth_throttle
  for all
  using (false);
