// Pure, DOM-free helpers behind the sign-in page's post-login redirect
// (W0-6). Kept as `.js` (not `.mjs`) to match the signin page's own
// `app.js` -- the static server's MIME handling for `.mjs` is being fixed
// separately, so anything the signin page imports has to stay `.js` for now.

const ADMIN_PERMISSION_PREFIX = "admin.";

// Only a same-origin, path-only `next` is honoured: it comes straight off
// the query string, so an absolute URL (or a protocol-relative "//host/...")
// there would turn this page into an open redirect.
export function isSafeNextPath(next) {
  return typeof next === "string" && next.length > 0 && next.startsWith("/") && !next.startsWith("//");
}

// True when at least one facility membership in the /me response carries a
// permission outside the admin.* family (see src/lib/permissions.mjs) --
// i.e. this user actually does operational work somewhere, so the ops app
// is their natural landing page rather than the admin console.
function hasOperationalPermission(meResponse) {
  const facilities = meResponse && Array.isArray(meResponse.facilities) ? meResponse.facilities : [];
  return facilities.some(
    (facility) =>
      facility &&
      Array.isArray(facility.permissions) &&
      facility.permissions.some(
        (code) => typeof code === "string" && !code.startsWith(ADMIN_PERMISSION_PREFIX)
      )
  );
}

// Decides where a successful sign-in should land:
//   - A valid `?next=` always wins, unchanged.
//   - Otherwise, a user holding any non-admin permission in any facility
//     lands on the ops app ("/"); a pure admin or a platform admin with no
//     operational permissions lands on "/admin/".
//   - A missing/failed /me lookup (falsy `meResponse`) falls back to "/"
//     rather than assuming admin intent.
export function chooseDestination(nextParam, meResponse) {
  if (isSafeNextPath(nextParam)) return nextParam;
  if (!meResponse) return "/";
  return hasOperationalPermission(meResponse) ? "/" : "/admin/";
}
