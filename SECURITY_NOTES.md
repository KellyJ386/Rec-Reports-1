# Security notes — Supabase advisor findings

Status of the Supabase security linter findings for the `rec-reports` project, and
the decisions taken for each. Re-run with the Supabase advisors (security) tool.

## Resolved

### `function_search_path_mutable` (3 trigger functions) — FIXED
`fn_block_audit_mutation`, `fn_protect_system_role`, and
`fn_enforce_change_request_transition` now set `search_path = public`
(migration `0024_harden_function_search_path.sql`, applied live). The warnings
clear on re-scan. Every other helper already set this; these three predated the
convention.

## Accepted risk (documented, not auto-fixed)

### `{anon,authenticated}_security_definer_function_executable`
The RLS helper functions — `has_permission`, `current_facility_ids`,
`is_platform_admin`, `is_organization_admin`, `fn_assert_same_facility`,
`fn_membership_department_facility`, and the audit trigger helpers — are
`SECURITY DEFINER` and callable via PostgREST RPC (`/rest/v1/rpc/...`) by the
`anon` and `authenticated` roles.

**Why the advisor's suggested remediation (revoke EXECUTE / make SECURITY INVOKER)
is NOT applied:** these functions are called *inside the RLS policies* on nearly
every table. In PostgreSQL an RLS policy expression is evaluated with the
privileges of the role running the query, and `EXECUTE` on a referenced function
is checked against that role even for `SECURITY DEFINER` functions. Revoking
`EXECUTE` from `authenticated` would therefore make every RLS-protected query by a
signed-in user fail with "permission denied for function" — it would break the
entire app, not harden it. Switching them to `SECURITY INVOKER` breaks them too
(they intentionally read membership/permission tables the caller can't see).

**Actual exposure:** low. The functions return booleans / the caller's own
facility ids. `current_facility_ids()` keys off `auth.uid()`, so `anon` learns
nothing. `has_permission(user, facility, code)` and `is_platform_admin(user)` let
a caller probe permission bits for a *guessed* user UUID — an information-only
signal, not data access; all table data stays protected by RLS regardless.

**Proper long-term fix (deferred, needs the RLS test suite run against the target
DB):** move these helpers into a dedicated schema that PostgREST does **not**
expose (e.g. `private`), and reference them as `private.has_permission(...)` from
the policies. That removes the RPC surface without touching policy semantics. It
is a broad, security-sensitive migration touching every policy, so it should land
as its own change with `npm run db:test:rls` green against the live project —
not as a drive-by. Reducing exposure by revoking `EXECUTE` from `anon` only (while
keeping `authenticated`) is a smaller option, but still must be verified against
the RLS suite first, since it changes the tested security model.

### `auth_leaked_password_protection` — enable in the dashboard
Because the app uses email + password, turn this on: Supabase dashboard →
Authentication → Policies (Password) → enable **"Leaked password protection"**
(checks new passwords against HaveIBeenPwned). It is a project auth setting, not
schema, so it is not in a migration and cannot be set via MCP.
