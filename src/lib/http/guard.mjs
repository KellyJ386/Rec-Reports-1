import { hasPermission, canAccessFacility } from "../permissions.mjs";
import { pgSelect } from "../supabase-rest.mjs";
import { translatePostgrestError } from "./errors.mjs";

export function requirePermission(memberships, facilityId, code) {
  if (!code) return { allowed: false, reason: "permission code is required" };
  if (!facilityId) return { allowed: false, reason: "facility id is required" };
  if (hasPermission(memberships ?? [], facilityId, code)) return { allowed: true, reason: null };
  return { allowed: false, reason: `missing permission: ${code}` };
}

// deprecated (S-6, 0045_read_and_audit_policies.sql): this implements the
// pre-0019 rule -- admin.manage on ANY single facility of the org promotes
// the caller to org-wide admin authority. 0019_review_hardening.sql removed
// that rule from is_organization_admin (SQL now requires an explicit
// organization_admins row), but these two JS guards were never updated to
// match, so every admin/billing org-admin route was enforcing a stricter SQL
// rule underneath a looser JS gate. Use requireAuthOrgAdminRow below instead.
// Kept exported only because test/http-guard.test.mjs still exercises the
// membership-shape directly; no route should call these anymore.
export function requireOrgAdmin(memberships, orgFacilities) {
  const facilityIds = orgFacilities ?? [];
  if (facilityIds.length === 0) {
    return { allowed: false, reason: "organization has no facilities" };
  }
  const isAdmin = facilityIds.some((facilityId) =>
    hasPermission(memberships ?? [], facilityId, "admin.manage")
  );
  if (isAdmin) return { allowed: true, reason: null };
  return { allowed: false, reason: "missing permission: admin.manage" };
}

// --- Auth-level variants (platform super-admin aware, 0022) -----------------
// These take the whole authenticate() result instead of bare memberships and
// honor auth.platformAdmin the same way the SQL helpers do: is_platform_admin
// short-circuits has_permission and current_facility_ids, so the JS guards
// short-circuit here. Auth stubs without the flag behave exactly like the
// membership-only guards (the bypass is opt-in by construction).

export function requireAuthPermission(auth, facilityId, code) {
  if (!code) return { allowed: false, reason: "permission code is required" };
  if (!facilityId) return { allowed: false, reason: "facility id is required" };
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  return requirePermission(auth?.memberships, facilityId, code);
}

export function authCanAccessFacility(auth, facilityId) {
  if (auth?.platformAdmin === true) return true;
  return canAccessFacility(auth?.memberships ?? [], facilityId);
}

// deprecated (S-6): see requireOrgAdmin above -- same pre-0019 rule, still
// exported only for its existing test coverage. Use requireAuthOrgAdminRow.
export function requireAuthOrgAdmin(auth, orgFacilities) {
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  return requireOrgAdmin(auth?.memberships, orgFacilities);
}

// Org-admin check matching the actual SQL rule (0019: is_organization_admin
// requires an explicit organization_admins row -- admin.manage on a member
// facility no longer implies org-wide authority). Queries with the caller's
// own client (RLS "org members can read org admins", 0009:73-77, lets any
// member of the org read that org's organization_admins rows), filtered to
// the caller's own row, so a non-member simply gets zero rows back rather
// than an RLS error -- same "deny by empty result" shape as every other
// permission check in this file.
export async function requireAuthOrgAdminRow(auth, organizationId) {
  if (!organizationId) return { allowed: false, reason: "organization id is required" };
  if (auth?.platformAdmin === true) return { allowed: true, reason: null };
  const rows = await pgSelect(auth?.client, "organization_admins", {
    filters: { organization_id: organizationId, user_id: auth?.claims?.sub },
    select: "id",
    limit: 1
  });
  if ((rows ?? []).length > 0) return { allowed: true, reason: null };
  return { allowed: false, reason: "missing organization_admins row" };
}

// --- P-12: shared request-guard factory -------------------------------------
// Every route module used to hand-roll its own withAuth/requirePerm/
// requireRead/requireMember/parseJsonBody/queryParams closures over the same
// three injected primitives (authenticate, sendJson, readBody). All copies
// were behaviourally identical (verified line-by-line across all 15
// withAuth, 7 requirePerm, 6 requireRead, 4 requireMember, 14 parseJsonBody
// and 12 queryParams copies) with exactly one deliberate exception:
// attachments-routes.mjs's requirePerm accepts a `notFoundOnDeny` option (a
// denied attachments.read reads as a plain 404 "attachment not found"
// instead of a 403, so a caller can't distinguish "wrong facility" from
// "no permission" by probing another module's attachment ids). That option
// -- and its message -- is preserved here as opt-in parameters so every
// other call site is unaffected.
export function makeGuards({ authenticate, sendJson, readBody }) {
  // P-9 step 2: every route's own client is scoped to the calling user's
  // bearer token (see translatePostgrestError's doc comment for why that
  // makes this safe), so a PostgrestError any handler lets escape --
  // instead of catching it itself, the way the nine bespoke 409 sites and
  // the incidents-routes.mjs incident_no retry loop already do -- is
  // translated here and answered directly. This is what lets a route's own
  // unit tests (which call the registered handler directly, never through
  // scripts/server.mjs) see the clean 4xx without any server.mjs
  // involvement. A translation landing at 500 (or no translation at all,
  // e.g. a plain Error) rethrows unchanged, exactly as before this existed,
  // so it still reaches scripts/server.mjs's own catch to be reported.
  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    try {
      return await handler(auth);
    } catch (error) {
      const translated = translatePostgrestError(error);
      if (translated && translated.status < 500) {
        return sendJson(response, translated.status, translated.body);
      }
      throw error;
    }
  }

  function requirePerm(
    auth,
    facilityId,
    code,
    response,
    { notFoundOnDeny = false, notFoundMessage = "not found" } = {}
  ) {
    const guard = requireAuthPermission(auth, facilityId, code);
    if (!guard.allowed) {
      sendJson(
        response,
        notFoundOnDeny ? 404 : 403,
        notFoundOnDeny ? { error: notFoundMessage } : { error: guard.reason }
      );
      return false;
    }
    return true;
  }

  // requireRead(code) bakes a module's read-permission constant into a
  // requirePerm-shaped guard, matching every existing call site's
  // `requireRead(auth, facilityId, response)` shape.
  function requireRead(code) {
    return function requireReadGuard(auth, facilityId, response) {
      return requirePerm(auth, facilityId, code, response);
    };
  }

  function requireMember(auth, facilityId, response) {
    if (!authCanAccessFacility(auth, facilityId)) {
      sendJson(response, 403, { error: "not a member of this facility" });
      return false;
    }
    return true;
  }

  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

  return {
    withAuth,
    requirePerm,
    requireRead,
    requireMember,
    parseJsonBody,
    queryParams,
    parseListLimitOffset
  };
}

// P-12: shared ?limit=/?offset= parsing, replacing the two inline copies in
// reports-routes.mjs and work-orders-routes.mjs. The two copies used to
// disagree on error shape (reports-routes returned a single
// `{ error: "..." }` per bad field; work-orders-routes batched every bad
// query param, limit/offset included, into `{ errors: [...] }`) and on the
// unset-offset default (reports-routes left it `undefined`, which
// buildQuery in supabase-rest.mjs omits from the query string the same way
// PostgREST treats an absent `offset` as 0 -- so defaulting to the literal
// `0` here is behaviourally a no-op, it just now appears on the wire).
// Reconciled to always: default offset 0, and on a bad limit/offset return
// the single-field `{ error }` shape immediately (independent of whatever
// other query-param errors a caller like work-orders-routes.mjs is also
// batching) -- see that file's parseListQuery for how the two are combined.
export function parseListLimitOffset(qp, { defaultLimit = 50, maxLimit = 200 } = {}) {
  let limit = defaultLimit;
  const limitParam = qp.get("limit");
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    limit = Math.min(parsed, maxLimit);
  }

  let offset = 0;
  const offsetParam = qp.get("offset");
  if (offsetParam !== null) {
    const parsed = Number(offsetParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    offset = parsed;
  }

  return { ok: true, limit, offset };
}
