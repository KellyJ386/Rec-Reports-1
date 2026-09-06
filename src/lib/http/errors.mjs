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
//   everything else                          -> 500
//
// Returns null when `error` is not a PostgrestError at all, so every call
// site can do the same thing regardless of what was thrown:
//   const translated = translatePostgrestError(error);
//   if (translated && translated.status < 500) { ...respond, don't rethrow... }
//   else { ...rethrow/report, exactly as before this function existed... }
export function translatePostgrestError(error) {
  if (!(error instanceof PostgrestError)) return null;

  if (error.status === 409) return { status: 409, body: { error: "conflict" } };
  if (error.status === 400 || error.status === 422) {
    return { status: 400, body: { error: "invalid request" } };
  }
  if (error.status === 401) return { status: 401, body: { error: "unauthorized" } };
  if (error.status === 403) return { status: 403, body: { error: "forbidden" } };
  if (error.status === 404 && error.body?.code === "PGRST205") {
    return { status: 500, body: { error: "internal server error" } };
  }
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
