import { pgSelect } from "../supabase-rest.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";

// P-8: global search bounds. `q` is sanitized down to [\w\s-] (see
// sanitizeSearchQuery below) BEFORE the length check, so "2-64 characters"
// is measured on the sanitized string, not the raw query-string value --
// a caller who sends 64 raw characters that sanitize down to 1 gets a 400,
// same as a caller who sent 1 character outright.
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 64;

// Bounded per leg (WO-style list routes default to 50; search is a
// lookup/deep-link surface, not a paginated list, so every leg is capped
// tighter and unconditionally -- no ?limit= override).
const LEG_LIMIT = 10;

// One entry per search leg: the permission code gating it (checked with
// requireAuthPermission, which already honors auth.platformAdmin, 0022),
// the table, the columns fanned into the `or=(...)` ilike filter (also
// what 0051_search_indexes.sql indexes), the columns returned to the
// caller (a few display fields -- a deep-link surface, not a full record;
// the caller re-fetches the full row via each module's own GET :id route),
// and the list order each module's own list route already uses for that
// table.
//
// Permission codes, verified against each module's own route file:
//   incidents.read      -- incidents-routes.mjs (READ)
//   work_orders.read    -- work-orders-routes.mjs (READ)
//   schedule.read        -- scheduling-routes.mjs's GET
//                           /facilities/:facilityId/employees is gated on
//                           schedule.read, not a dedicated employees.read
//                           (there is no such code) or training.read --
//                           the employees table has its own broader
//                           "members can read employees" RLS reader policy,
//                           but the BFF route (and so this leg) uses the
//                           narrower schedule.read the existing list route
//                           already enforces.
//   communications.read -- communications-routes.mjs (READ)
const LEGS = [
  {
    key: "incidents",
    table: "incident_reports",
    code: "incidents.read",
    searchColumns: ["incident_no", "summary", "location_text"],
    select: "id,incident_no,summary,location_text,status,severity",
    order: "occurred_at.desc"
  },
  {
    key: "workOrders",
    table: "work_orders",
    code: "work_orders.read",
    searchColumns: ["title", "description"],
    select: "id,title,description,status,priority",
    order: "created_at.desc"
  },
  {
    key: "employees",
    table: "employees",
    code: "schedule.read",
    searchColumns: ["first_name", "last_name", "employee_no"],
    select: "id,first_name,last_name,employee_no,status",
    order: "last_name.asc"
  },
  {
    key: "messages",
    table: "messages",
    code: "communications.read",
    searchColumns: ["subject", "body_text"],
    select: "id,subject,body_text,priority,published_at",
    order: "created_at.desc"
  }
];

// PostgREST's filter grammar reserves `,`, `.`, `(`, `)` (structural inside
// an or=(...) / in.(...) list) and `*` (the ilike wildcard itself -- a
// caller-supplied `*` would let them widen their own wildcard match, not a
// security hole by itself, but not a legitimate search character either).
// q is interpolated UNQUOTED into the `or=(...)` filter below (there is no
// quoting form for a bare ilike pattern the way quoteInListValue quotes an
// in-list value in supabase-rest.mjs), so every one of those characters --
// and anything else outside [\w\s-] -- is stripped before it ever reaches
// a query string. This is deliberately conservative (rejects nothing a
// legitimate free-text term needs -- names, incident numbers, short
// phrases -- while guaranteeing no PostgREST-reserved character survives),
// not an attempt to allow-list "every safe character".
//
// Exported so the frontend's src/public/js/search.mjs can mirror the exact
// same rule for early client-side feedback -- the two are independent
// implementations (the browser file has no access to this Node module),
// this function is the source of truth the server-side 400 actually
// enforces.
export function sanitizeSearchQuery(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  // Unicode-aware: letters and digits in any script survive (an employee
  // called "José" or a location in another language must be searchable);
  // everything else -- including every character PostgREST's filter grammar
  // reserves -- is removed.
  const stripped = trimmed.replace(/[^\p{L}\p{N}_\s-]/gu, "");
  if (stripped.length < MIN_QUERY_LENGTH || stripped.length > MAX_QUERY_LENGTH) return null;
  return stripped;
}

// Builds `(col1.ilike.*q*,col2.ilike.*q*,...)` for one leg. q has already
// passed through sanitizeSearchQuery by the only call site below, so it is
// guaranteed to contain nothing outside [\w\s-] -- never re-validated here,
// this function trusts its caller the same way the rest of this file does.
function orFilterFor(columns, q) {
  return `(${columns.map((column) => `${column}.ilike.*${q}*`).join(",")})`;
}

// Registers GET /api/v1/search?facilityId=&q=: fans out over every module
// leg the caller holds read permission for, in parallel, and never lets one
// leg's failure fail the whole request -- see the Promise.allSettled below.
// Injected primitives match every other route module:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
export function registerSearchRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requireMember, queryParams } = guards;

  router.register("GET", "/search", (request, response, { env }) =>
    withAuth(request, response, env, async (auth) => {
      const qp = queryParams(request);
      const facilityId = qp.get("facilityId");
      if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
      if (!requireMember(auth, facilityId, response)) return;

      const q = sanitizeSearchQuery(qp.get("q"));
      if (!q) {
        return sendJson(response, 400, {
          error: `q must be ${MIN_QUERY_LENGTH}-${MAX_QUERY_LENGTH} characters (letters, digits, spaces, hyphens) after sanitizing`
        });
      }

      // Only the legs this caller holds the module's read permission for
      // are queried at all -- a leg the caller may not read is simply
      // absent from the response's `results`, not present-but-empty (a
      // caller cannot distinguish "no matches" from "no permission" by
      // probing this endpoint, matching how every other module's own list
      // route 403s outright rather than 200-with-[] for the same case).
      const allowedLegs = LEGS.filter((leg) => requireAuthPermission(auth, facilityId, leg.code).allowed);

      const settled = await Promise.allSettled(
        allowedLegs.map((leg) =>
          pgSelect(auth.client, leg.table, {
            filters: { facility_id: facilityId },
            extra: { or: orFilterFor(leg.searchColumns, q) },
            select: leg.select,
            order: leg.order,
            limit: LEG_LIMIT
          })
        )
      );

      const results = {};
      const errors = [];
      allowedLegs.forEach((leg, index) => {
        const outcome = settled[index];
        if (outcome.status === "fulfilled") {
          results[leg.key] = outcome.value ?? [];
        } else {
          // A failed leg never fails the request (P-8): it yields an empty
          // array plus an `errors` entry naming the leg, exactly like every
          // other leg's shape, so the caller still gets 200 with whatever
          // legs DID succeed.
          results[leg.key] = [];
          errors.push({ leg: leg.key, error: "search failed for this section" });
          console.error(`search.leg_failed/${leg.key}:`, outcome.reason);
        }
      });

      const body = { q, results };
      if (errors.length > 0) body.errors = errors;
      return sendJson(response, 200, body);
    })
  );

  return router;
}
