// Browser-side session handling for the admin control center.
//
// The sign-in page (/signin/) POSTs credentials to the same-origin auth proxy
// in src/lib/http/auth-routes.mjs and stores the resulting Supabase session
// here. This module owns those storage keys, the silent refresh, and the
// redirects, so api.js and app.js never touch localStorage directly.
//
// S-11: the refresh token lives only in the HttpOnly `rr_refresh` cookie the
// server sets -- this module never reads or writes it. The one exception is
// `migrateLegacyRefreshToken`, a one-release compat path for a session that
// signed in before this change and still has a refresh token sitting in
// localStorage from the old flow.

const TOKEN_KEY = "rr_admin_token";
const LEGACY_REFRESH_TOKEN_KEY = "rr_refresh_token";
const AUTH_BASE = "/api/v1/auth";
const SIGN_IN_PATH = "/signin/";

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    // Storage may be unavailable (private browsing, blocked cookies). Treat it
    // as "no session" rather than throwing out of every API call.
    return "";
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Session simply won't persist across reloads when storage is unavailable.
  }
}

export function getToken() {
  return readStorage(TOKEN_KEY);
}

export function hasToken() {
  return getToken().length > 0;
}

export function setSession(session) {
  writeStorage(TOKEN_KEY, session?.access_token ?? "");
}

export function clearSession() {
  writeStorage(TOKEN_KEY, "");
}

// Sends the browser to the sign-in page, remembering where it was so sign-in
// can return it to the same admin page (including the #/hash route).
export function redirectToSignIn() {
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`${SIGN_IN_PATH}?next=${encodeURIComponent(here)}`);
}

// One-release compat (S-11): a session that signed in before the refresh
// token moved into the `rr_refresh` cookie may still have one sitting in
// localStorage. On load, exchange it through /auth/refresh's body fallback
// exactly once so the browser picks up the cookie, then delete the key --
// every later refresh goes through the cookie like any other session. A
// missing/empty key is the common case and a silent no-op.
export async function migrateLegacyRefreshToken() {
  const legacyToken = readStorage(LEGACY_REFRESH_TOKEN_KEY);
  if (!legacyToken) return;
  writeStorage(LEGACY_REFRESH_TOKEN_KEY, "");
  try {
    const response = await fetch(`${AUTH_BASE}/refresh`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: legacyToken })
    });
    if (!response.ok) return;
    const session = await response.json();
    if (session?.access_token) setSession(session);
  } catch {
    // Network failure: the legacy key is already gone -- the user simply
    // re-authenticates like anyone else whose session has fully expired.
  }
}

// Single-flight refresh: several API calls can 401 at once when an access
// token expires, and they must not each race the single-use refresh cookie.
// The first caller performs the exchange; the rest await the same promise.
//
// Two-tab race: this only serializes refreshes *within one tab*. Two tabs
// refreshing at nearly the same moment each send the same (single-use, at
// the time they read it) rr_refresh cookie; GoTrue's refresh-token reuse
// detection/reuse-interval is what keeps the loser from being treated as
// token theft, not anything in this file -- see S-11 in the implementation
// plan for the risk note.
let refreshInFlight = null;

async function exchangeRefreshToken() {
  let response;
  try {
    response = await fetch(`${AUTH_BASE}/refresh`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}"
    });
  } catch {
    // Network failure: keep the stored session so a later call can retry
    // instead of signing the user out over a dropped connection.
    return false;
  }
  if (!response.ok) {
    // The refresh cookie itself is rejected — the session is genuinely over.
    clearSession();
    return false;
  }
  let session;
  try {
    session = await response.json();
  } catch {
    return false;
  }
  if (!session?.access_token) return false;
  setSession(session);
  return true;
}

export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = exchangeRefreshToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Best-effort revocation of the refresh token upstream, then a local clear and
// a bounce to the sign-in page. The local clear runs even if revocation fails,
// so "Sign out" always signs the browser out. Always called -- even with no
// access token -- so the server clears the rr_refresh cookie either way.
export async function signOut() {
  const token = getToken();
  try {
    await fetch(`${AUTH_BASE}/sign-out`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json" }
    });
  } catch {
    // Ignore: revocation is a courtesy, the local clear below is what matters.
  }
  clearSession();
  window.location.assign(SIGN_IN_PATH);
}
