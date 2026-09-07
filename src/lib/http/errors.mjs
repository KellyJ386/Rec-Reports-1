import { PostgrestError } from "../supabase-rest.mjs";

// P-9: central mapping from a PostgrestError -- the shape supabase-rest.mjs's
// request() throws for any non-2xx PostgREST response ({status, body}, body
// being PostgREST's own parsed JSON error: {code, message, details, hint})
// -- to the HTTP status/body an end-user caller should see.
//
// Every pgSelect/pgInsert/pgUpdate/pgDelete/pgRpc call in this codebase runs
// against a client scoped to the CALLING user's own bearer token (never a
// service-role client -- see scripts/server.mjs's buildClient), so RLS is
// always evaluated as that specific caller. That is what makes translating
// a PostgrestError into a 4xx safe here: a 409 really is a conflict on
// *this* request, a 403/42501 really is an RLS WITH CHECK denial for *this*
// caller, and so on -- it is never "the server bypassed a check and
// something went wrong regardless of caller" the way a service-role path
// (internal-routes.mjs's CRON_SECRET-gated drain/verify-all, the
// notifications worker) would be. Callers on a service-role path must NOT
// run PostgrestErrors through this function -- see scripts/server.mjs's
// request catch, which excludes /internal/* routes from translation for
// exactly that reason.
//
//   409                                      -> 409 {error: "conflict"}
//   400 or 422                               -> 400 {error: "invalid request"}
//   401                                      -> 401 {error: "unauthorized"}
//   403                                      -> 403 {error: "forbidden"}
//     (PostgREST returns 403/42501 for an INSERT/UPDATE that fails a WITH
//     CHECK policy; a filtered SELECT instead returns 200 with zero rows,
//     so a route's own "row not found for this caller" 404s are unaffected
//     and stay in the routes -- this function is never consulted for those)
//   404 with body.code === "PGRST205" (PostgREST's "could not find the
//     table/view in the schema cache" -- an unknown table, i.e. a typo or a
//     migration that never ran) -> 500 (a server bug, never a client error)
//   any status whose body.code is a QUERY-SHAPE error (below) -> 500: these
//     mean the query the route built is broken (undefined column/table/
//     function, a malformed PostgREST filter), which is never the caller's
//     fault and must stay a reported server error -- otherwise a stale
//     column name after a migration would surface as "invalid request",
//     look like the client's mistake, and never reach observability.
//   everything else                          -> 500
//
// Returns null when `error` is not a PostgrestError at all, so every call
// site can do the same thing regardless of what was thrown:
//   const translated = translatePostgrestError(error);
//   if (translated && translated.status < 500) { ...respond, don't rethrow... }
//   else { ...rethrow/report, exactly as before this function existed... }
// Postgres SQLSTATEs and PostgREST codes that indicate the route's own query
// is malformed rather than the caller's input: 42703 undefined_column,
// 42P01 undefined_table, 42883 undefined_function, 42601 syntax_error,
// 42P10 invalid_column_reference (bad ORDER/ON CONFLICT target), 42804
// datatype_mismatch, PGRST100 (unparsable filter/order/select syntax),
// PGRST102 (unparsable request body), PGRST200/201/203/204 (unknown
// embedded relationship or column in select/on_conflict), PGRST205
// (unknown table/view). PostgREST puts the code in body.code for both
// families. The list is intentionally explicit rather than "everything
// starting with 42" so a genuine caller-supplied bad value (e.g. 22P02
// invalid_text_representation for a non-uuid id) still maps to 400.
const QUERY_SHAPE_CODES = new Set([
  "42703",
  "42P01",
  "42883",
  "42601",
  "42P10",
  "42804",
  "PGRST100",
  "PGRST102",
  "PGRST200",
  "PGRST201",
  "PGRST203",
  "PGRST204",
  "PGRST205"
]);

export function isQueryShapeError(error) {
  return error instanceof PostgrestError && QUERY_SHAPE_CODES.has(String(error.body?.code ?? ""));
}

export function translatePostgrestError(error) {
  if (!(error instanceof PostgrestError)) return null;

  if (isQueryShapeError(error)) return { status: 500, body: { error: "internal server error" } };
  if (error.status === 409) return { status: 409, body: { error: "conflict" } };
  if (error.status === 400 || error.status === 422) {
    return { status: 400, body: { error: "invalid request" } };
  }
  if (error.status === 401) return { status: 401, body: { error: "unauthorized" } };
  if (error.status === 403) return { status: 403, body: { error: "forbidden" } };
  return { status: 500, body: { error: "internal server error" } };
}

// True unless the value is empty or an explicit "off" spelling -- guards
// against the "DEBUG_ERRORS=false" footgun, where the literal string
// "false" would otherwise be truthy in JS.
function isEnabled(value) {
  return Boolean(value) && value !== "false" && value !== "0";
}

// P-9 detail leak: whether the generic 500 response's `detail` field (the
// underlying error.message -- everything from a Postgres constraint name to
// a stack-trace-adjacent internal string) is safe to include. Vercel sets
// VERCEL_ENV=production automatically on a production deployment (never on
// preview or local dev, and never set at all outside Vercel), so detail
// stays hidden there by default; DEBUG_ERRORS overrides that for a
// temporary, deliberate debugging session. Every other environment shows it
// unconditionally, matching this app's behavior before DEBUG_ERRORS existed
// (there was no NODE_ENV/production concept at all).
//
// Takes a plain {VERCEL_ENV, DEBUG_ERRORS} source rather than the validated
// env object from src/lib/env.mjs's readServerEnv, since both call sites
// that need this (scripts/server.mjs's createApp catch, api/[...path].mjs)
// are last-resort nets that may be reached before -- or without -- a
// validated env is available; both call this with raw process.env.
export function includeErrorDetail(source = process.env) {
  if (isEnabled(source.DEBUG_ERRORS)) return true;
  return source.VERCEL_ENV !== "production";
}
