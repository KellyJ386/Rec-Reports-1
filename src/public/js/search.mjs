// P-8 (global search): pure helpers for the header search box in app.js.
// No I/O, no DOM -- every function here takes plain values and returns
// plain values, so it can be unit-tested without a browser and without
// mocking fetch. app.js owns the actual <input> wiring, the fetch call,
// and building result DOM nodes with el() (never innerHTML with
// interpolation -- see app.js's el() doc comment).

// Mirrors src/lib/http/search-routes.mjs's sanitizeSearchQuery EXACTLY (same
// regex, same bounds) so a query the server will accept never gets rejected
// client-side, and vice versa. The two are independent implementations (this
// file has no access to the Node module) -- keep them in lockstep by hand if
// either changes.
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 64;

// Trims, then strips every character outside [\w\s-] (PostgREST's filter
// grammar reserves `,`, `.`, `(`, `)`, `*` -- see the server-side doc
// comment for the full rationale), then enforces the length bound on the
// STRIPPED result, not the raw input. Returns the sanitized string, or null
// when it's out of bounds after stripping (too short, too long, or empty).
export function sanitizeQuery(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const stripped = trimmed.replace(/[^\w\s-]/g, "");
  if (stripped.length < MIN_QUERY_LENGTH || stripped.length > MAX_QUERY_LENGTH) return null;
  return stripped;
}

// Display order and label for each leg the search response can carry.
// Fixed order (not the order keys happen to appear in the response) so the
// rendered result groups never reshuffle from one search to the next.
export const SEARCH_LEGS = [
  { key: "incidents", label: "Incidents" },
  { key: "workOrders", label: "Work Orders" },
  { key: "employees", label: "Employees" },
  { key: "messages", label: "Messages" }
];

// Normalizes a GET /api/v1/search response body ({ q, results, errors? })
// into an ordered array of non-empty groups: [{ key, label, items }, ...].
// A leg absent from `results` (the caller lacked that module's read
// permission -- see search-routes.mjs) or present but empty (no matches) is
// left out entirely, so the UI never renders an empty "Work Orders" heading
// with nothing under it. Tolerant of a missing/malformed payload (returns
// []) so a render call never has to null-check its own input first.
export function groupResults(payload) {
  const results = payload && typeof payload === "object" ? payload.results : null;
  if (!results || typeof results !== "object") return [];
  const groups = [];
  for (const { key, label } of SEARCH_LEGS) {
    const items = results[key];
    if (Array.isArray(items) && items.length > 0) {
      groups.push({ key, label, items });
    }
  }
  return groups;
}

// Debounces `fn`: a call resets the pending timer rather than queuing a
// second invocation, so only the last call within `wait`ms of silence ever
// actually runs `fn` -- exactly what a keystroke-driven search box needs
// (P-8: "debounced fetch, >=300ms"). Returns a function with the same call
// shape as `fn` plus a `.cancel()` (clears any pending call without running
// it -- used when the search box closes or its value is cleared, so a
// stale request never lands after the UI has moved on).
export function debounce(fn, wait = 300) {
  let timer = null;
  function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
