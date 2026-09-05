// Pure, DOM-free selection logic behind the ops app's facility switcher
// (W0-7). Mirrors src/public/admin/js/state.js's `rr_admin_context`
// persistence pattern, but for the single facility id the ops app cares
// about: app.js stores the chosen id under `rr_facility_id` on every switch
// and calls resolveInitialFacility() on load to restore it.
//
// No I/O, no DOM -- `facilities` is whatever the /me response already
// carried and `storedId` is whatever (possibly stale, possibly garbage, or
// entirely absent) value app.js read out of localStorage.
export function resolveInitialFacility(storedId, facilities) {
  const list = Array.isArray(facilities) ? facilities : [];
  if (list.length === 0) return null;

  if (typeof storedId === "string" && storedId.length > 0) {
    const stored = list.find((facility) => facility && facility.id === storedId);
    if (stored) return stored.id;
  }

  return list[0].id;
}
